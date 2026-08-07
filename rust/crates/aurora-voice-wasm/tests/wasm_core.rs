#![cfg(target_arch = "wasm32")]

use aurora_voice_core::{
    BoundedPcmBuffer, BufferPush, CancellationToken, Generation, PcmFrame, RouteRevision,
    TimestampMicros,
};
use aurora_voice_engine::{
    create_lifecycle_snapshot, select_verified_variant, verify_manifest, AbiRequirements,
    BrowserFeature, CapabilityFlags, Compatibility, CompressionKind, DeviceClass, EngineKind,
    InstallState, LanguageSupport, LicenseGrant, LicenseInfo, ManifestSignature, ModelPackError,
    ModelPackFile, ModelPackManifest, ModelStore, PackTask, ProcessingMetadata, Provenance,
    ResourceBudget, RuntimeGates, RuntimeSelection, RuntimeTarget, ShapeMetadata,
    SignatureVerifier, TargetArch, TargetOs, TrustPolicy, VerifiedManifest,
};
use aurora_voice_wasm::{
    BrowserPersistenceKind, InMemoryNetworkHost, InMemoryWebHost, WebDownloadPolicy, WebHostError,
    WebModelDownloader, WebModelStore, WebModelStoreHost, WebRecoverySignal,
};
use wasm_bindgen_test::wasm_bindgen_test;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[wasm_bindgen_test]
fn shared_pcm_and_bounded_buffer_execute_inside_wasm() {
    let generation = Generation(7);
    let frame = PcmFrame::new(
        vec![0.0, 0.25, -0.25, 1.0, -1.0],
        TimestampMicros(10),
        1,
        false,
        RouteRevision(2),
        generation,
    )
    .expect("valid normalized PCM");
    let buffer = BoundedPcmBuffer::nonblocking_queue(2, 10, generation);

    assert_eq!(buffer.push(frame), Ok(BufferPush::Accepted));
    let received = buffer.pop().expect("read buffer").expect("one frame");
    assert_eq!(received.generation(), generation);
    assert_eq!(received.samples(), &[0.0, 0.25, -0.25, 1.0, -1.0]);
}

#[wasm_bindgen_test]
fn shared_cancellation_token_executes_inside_wasm() {
    let cancellation = CancellationToken::new();
    assert!(cancellation.check().is_ok());
    cancellation.cancel();
    assert!(cancellation.check().is_err());
}

#[wasm_bindgen_test(async)]
async fn interrupted_install_resumes_from_staged_chunks() {
    let body = b"aurora-web-model".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    let task = store
        .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("reserve web file");
    let downloader = WebModelDownloader::new(WebDownloadPolicy::bounded(4).expect("policy"));
    let mut network = InMemoryNetworkHost::new(4);
    network.insert(task.url.clone(), body.clone());
    network.fail_after_chunks(1);

    assert_eq!(
        downloader
            .download(
                &mut network,
                store.host_mut(),
                &task,
                &CancellationToken::new(),
                |_downloaded, _expected| {}
            )
            .await,
        Err(WebHostError::Network {
            code: "interrupted"
        })
    );

    network.clear_failure();
    let receipt = downloader
        .download(
            &mut network,
            store.host_mut(),
            &task,
            &CancellationToken::new(),
            |_downloaded, _expected| {},
        )
        .await
        .expect("resume staged download");
    assert_eq!(receipt.resumed_from, 4);
    assert_eq!(receipt.byte_size, body.len() as u64);
    store
        .promote_file(&task.storage_key, &receipt.sha256, receipt.byte_size)
        .await
        .expect("promote verified bytes");
    store
        .set_lifecycle(create_lifecycle_snapshot(
            manifest.manifest().pack_id.clone(),
            manifest.manifest().pack_version.clone(),
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    store
        .activate_pack(&manifest, &selection)
        .await
        .expect("activate pack");
    assert_eq!(
        store
            .active_pack()
            .await
            .expect("active lookup")
            .map(|active| active.pack_id),
        Some("pack".to_owned())
    );
}

#[wasm_bindgen_test(async)]
async fn hash_mismatch_and_revocation_fail_closed() {
    let good = b"good-model".to_vec();
    let bad = b"bad-model!".to_vec();
    let manifest = verified("pack", "1", &sha256(&good), good.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    let task = store
        .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("reserve web file");
    let mut network = InMemoryNetworkHost::new(64);
    network.insert(task.url.clone(), bad);

    assert_eq!(
        WebModelDownloader::new(WebDownloadPolicy::bounded(64).expect("policy"))
            .download(
                &mut network,
                store.host_mut(),
                &task,
                &CancellationToken::new(),
                |_downloaded, _expected| {}
            )
            .await,
        Err(WebHostError::Integrity { code: "hash" })
    );

    install_ready(&mut store, &manifest, good).await;
    store
        .activate_pack(&manifest, &selection)
        .await
        .expect("activate before revocation");
    store
        .signal_recovery("pack", WebRecoverySignal::Revoked)
        .await
        .expect("signal revocation");
    assert!(store.active_pack().await.expect("active lookup").is_none());
    assert_eq!(
        store.open_immutable_file(&selection, "model").await,
        Err(ModelPackError::Store { code: "revoked" })
    );
}

#[wasm_bindgen_test(async)]
async fn quota_rejection_reports_persistence_kind() {
    let body = b"quota-model".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(4)).indexed_db_fallback());

    assert_eq!(
        store
            .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
            .await,
        Err(ModelPackError::QuotaExceeded)
    );
    let report = store
        .host()
        .persistence_report()
        .await
        .expect("persistence report");
    assert_eq!(report.kind, BrowserPersistenceKind::IndexedDbFallback);
    assert_eq!(report.status.bytes_available, Some(4));
}

#[wasm_bindgen_test(async)]
async fn variants_and_versions_are_isolated() {
    let web_body = b"web-model".to_vec();
    let other_body = b"desktop-model".to_vec();
    let mut raw = manifest("pack", "1", &sha256(&web_body), web_body.len() as u64);
    raw.files = vec![
        model_file("web-model", &sha256(&web_body), web_body.len() as u64),
        model_file(
            "desktop-model",
            &sha256(&other_body),
            other_body.len() as u64,
        ),
    ];
    raw.variants = vec![
        variant(
            "wasm-simd",
            RuntimeTarget::Web,
            TargetOs::Web,
            TargetArch::Wasm32,
            "web-model",
            web_body.len() as u64,
        ),
        variant(
            "desktop",
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
            "desktop-model",
            other_body.len() as u64,
        ),
    ];
    let first = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
        .expect("verify manifest");
    let second_body = b"web-model-v2".to_vec();
    let second = verified("pack", "2", &sha256(&second_body), second_body.len() as u64);
    let selection = selection_for(&first);
    let desktop_selection = select_verified_variant(
        &first,
        &runtime_selection(RuntimeTarget::Desktop, TargetOs::Linux, TargetArch::X86_64),
    )
    .expect("desktop selection");
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));

    assert_eq!(
        store
            .reserve_file(&first, &selection, &first.manifest().files[1])
            .await,
        Err(ModelPackError::Store { code: "selection" })
    );
    install_ready(&mut store, &first, web_body).await;
    install_ready(&mut store, &second, second_body).await;
    store
        .activate_pack(&first, &selection)
        .await
        .expect("activate web variant");
    assert_eq!(
        store
            .open_immutable_file(&selection, "web-model")
            .await
            .expect("open selected web file")
            .variant_id,
        "wasm-simd"
    );
    assert_eq!(
        store
            .open_immutable_file(&desktop_selection, "desktop-model")
            .await,
        Err(ModelPackError::Store {
            code: "missing_file"
        })
    );
    assert!(store
        .lifecycle("pack", "1", "wasm-simd")
        .await
        .expect("v1 lifecycle")
        .is_some());
    assert!(store
        .lifecycle("pack", "2", "wasm-simd")
        .await
        .expect("v2 lifecycle")
        .is_some());
}

#[wasm_bindgen_test(async)]
async fn activation_records_rollback_and_failed_activation_restores_active() {
    let first_body = b"first-model".to_vec();
    let second_body = b"second-model".to_vec();
    let first = verified("pack-a", "1", &sha256(&first_body), first_body.len() as u64);
    let second = verified(
        "pack-b",
        "1",
        &sha256(&second_body),
        second_body.len() as u64,
    );
    let first_selection = selection_for(&first);
    let second_selection = selection_for(&second);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_ready(&mut store, &first, first_body).await;
    install_ready(&mut store, &second, second_body).await;

    store
        .activate_pack(&first, &first_selection)
        .await
        .expect("activate first");
    store.host_mut().fail_next_write();
    assert_eq!(
        store.activate_pack(&second, &second_selection).await,
        Err(ModelPackError::Store {
            code: "persistence"
        })
    );
    assert_eq!(
        store
            .active_pack()
            .await
            .expect("active after failed activation")
            .map(|active| active.pack_id),
        Some("pack-a".to_owned())
    );

    store
        .activate_pack(&second, &second_selection)
        .await
        .expect("activate second");
    assert_eq!(
        store
            .active_pack()
            .await
            .expect("active after second")
            .map(|active| active.pack_id),
        Some("pack-b".to_owned())
    );
    assert_eq!(
        store
            .rollback_active()
            .await
            .expect("rollback")
            .map(|snapshot| snapshot.pack_id),
        Some("pack-a".to_owned())
    );
}

#[wasm_bindgen_test(async)]
async fn eviction_recovery_and_cancellation_are_explicit() {
    let body = b"cancel-model".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    let task = store
        .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("reserve web file");
    let mut network = InMemoryNetworkHost::new(4);
    network.insert(task.url.clone(), body.clone());
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    assert_eq!(
        WebModelDownloader::new(WebDownloadPolicy::bounded(4).expect("policy"))
            .download(
                &mut network,
                store.host_mut(),
                &task,
                &cancellation,
                |_downloaded, _expected| {}
            )
            .await,
        Err(WebHostError::Cancelled)
    );

    install_ready(&mut store, &manifest, body).await;
    store
        .activate_pack(&manifest, &selection)
        .await
        .expect("activate pack");
    store
        .signal_recovery("pack", WebRecoverySignal::Evicted)
        .await
        .expect("signal eviction");
    assert!(store.active_pack().await.expect("active lookup").is_none());
    assert_eq!(
        store.open_immutable_file(&selection, "model").await,
        Err(ModelPackError::Store { code: "corrupt" })
    );
    store
        .signal_recovery("pack", WebRecoverySignal::Recovered)
        .await
        .expect("signal recovery");
    assert!(store.open_immutable_file(&selection, "model").await.is_ok());
}

#[wasm_bindgen_test]
fn debug_and_errors_do_not_include_raw_data_urls_or_hashes() {
    let mut host = InMemoryWebHost::new(Some(1000));
    host.set_evicted(true);
    let chunk = aurora_voice_wasm::WebFetchedChunk {
        bytes: b"raw-model-bytes".to_vec(),
        finished: false,
    };
    let rendered = format!(
        "{host:?} {chunk:?} {:?} {}",
        WebHostError::Network {
            code: "interrupted"
        },
        WebHostError::Integrity { code: "hash" }
    );
    assert!(!rendered.contains("raw-model-bytes"));
    assert!(!rendered.contains("https://example.test"));
    assert!(!rendered.contains(HASH_A));
}

async fn install_ready(
    store: &mut WebModelStore<InMemoryWebHost>,
    manifest: &VerifiedManifest,
    body: Vec<u8>,
) {
    let selection = selection_for(manifest);
    let task = store
        .reserve_file(manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("reserve file");
    let mut network = InMemoryNetworkHost::new(64);
    network.insert(task.url.clone(), body);
    let receipt = WebModelDownloader::new(WebDownloadPolicy::bounded(64).expect("policy"))
        .download(
            &mut network,
            store.host_mut(),
            &task,
            &CancellationToken::new(),
            |_downloaded, _expected| {},
        )
        .await
        .expect("download");
    store
        .promote_file(&task.storage_key, &receipt.sha256, receipt.byte_size)
        .await
        .expect("promote file");
    store
        .set_lifecycle(create_lifecycle_snapshot(
            manifest.manifest().pack_id.clone(),
            manifest.manifest().pack_version.clone(),
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
}

struct AcceptingVerifier;

impl SignatureVerifier for AcceptingVerifier {
    fn verify(
        &self,
        _canonical_json: &str,
        signature: &ManifestSignature,
    ) -> Result<bool, ModelPackError> {
        Ok(signature.value == "signed")
    }
}

fn verified(id: &str, version: &str, hash: &str, size: u64) -> VerifiedManifest {
    verify_manifest(
        manifest(id, version, hash, size),
        &TrustPolicy::default(),
        Some(&AcceptingVerifier),
    )
    .expect("fixture manifest verifies")
}

fn selection_for(manifest: &VerifiedManifest) -> aurora_voice_engine::SelectedVariant {
    select_verified_variant(
        manifest,
        &runtime_selection(RuntimeTarget::Web, TargetOs::Web, TargetArch::Wasm32),
    )
    .expect("fixture selection resolves")
}

fn runtime_selection(target: RuntimeTarget, os: TargetOs, arch: TargetArch) -> RuntimeSelection {
    RuntimeSelection {
        target,
        os,
        arch,
        browser_features: [BrowserFeature::Simd].into_iter().collect(),
        device_memory_mb: Some(4096),
        max_download_bytes: u64::MAX,
        max_installed_bytes: u64::MAX,
        max_memory_bytes: u64::MAX,
        cpu_threads: 4,
        max_rtf_millis_per_second: 1_000,
        device_class: DeviceClass::Balanced,
        require_interoperable: false,
    }
}

fn manifest(id: &str, version: &str, hash: &str, size: u64) -> ModelPackManifest {
    ModelPackManifest {
        schema_version: 1,
        pack_id: id.to_owned(),
        pack_version: version.to_owned(),
        display_name: "Pack".to_owned(),
        tasks: vec![PackTask::Stt],
        license: license(),
        languages: vec![LanguageSupport {
            language: "en".to_owned(),
            locale: Some("en-US".to_owned()),
            fixed_language: true,
            auto_detect: false,
        }],
        capabilities: CapabilityFlags {
            streaming: true,
            cancellation: true,
        },
        provenance: provenance(),
        files: vec![model_file("model", hash, size)],
        variants: vec![variant(
            "wasm-simd",
            RuntimeTarget::Web,
            TargetOs::Web,
            TargetArch::Wasm32,
            "model",
            size,
        )],
        rollback_from: None,
        supersedes_pack_id: None,
        revocation: None,
        signature: Some(ManifestSignature {
            key_id: "key".to_owned(),
            algorithm: "ed25519".to_owned(),
            value: "signed".to_owned(),
        }),
    }
}

fn model_file(file_id: &str, hash: &str, size: u64) -> ModelPackFile {
    ModelPackFile {
        file_id: file_id.to_owned(),
        asset_id: file_id.to_owned(),
        task: PackTask::Stt,
        byte_size: size,
        sha256: hash.to_owned(),
        url: format!("https://example.test/models/{file_id}"),
        compression: CompressionKind::None,
        installed_size: size,
        install_order: 0,
        dependencies: Vec::new(),
        license: license(),
        provenance: provenance(),
        processing: processing(),
        raven: None,
        revocation: None,
    }
}

fn variant(
    variant_id: &str,
    target: RuntimeTarget,
    os: TargetOs,
    arch: TargetArch,
    file_id: &str,
    size: u64,
) -> aurora_voice_engine::ModelPackVariant {
    aurora_voice_engine::ModelPackVariant {
        variant_id: variant_id.to_owned(),
        target,
        os,
        arch,
        engine: EngineKind::SherpaOnnx,
        required_browser_features: if target == RuntimeTarget::Web {
            vec![BrowserFeature::Simd]
        } else {
            Vec::new()
        },
        min_device_memory_mb: None,
        runtime_gates: RuntimeGates {
            min_cpu_threads: 1,
            max_rtf_millis_per_second: 1_000,
            min_device_class: DeviceClass::Low,
        },
        resource_budget: ResourceBudget {
            max_download_bytes: size,
            max_installed_bytes: size,
            max_memory_bytes: 1024,
        },
        compatibility: Compatibility {
            group_id: "group".to_owned(),
            voice_state_group_id: "voice-state".to_owned(),
            preprocessing_abi: "pre".to_owned(),
            postprocessing_abi: "post".to_owned(),
            sample_rate_hz: 16_000,
            channels: 1,
            frame_size: 512,
            interoperable: false,
        },
        file_ids: vec![file_id.to_owned()],
        abi: AbiRequirements {
            min_aurora_version: "1".to_owned(),
            min_runtime_version: "1".to_owned(),
            min_engine_version: "1".to_owned(),
            engine_source_revision: "rev".to_owned(),
            build_flags: Vec::new(),
        },
        revocation: None,
    }
}

fn provenance() -> Provenance {
    Provenance {
        upstream_source: "https://example.test/source".to_owned(),
        upstream_revision: "rev1".to_owned(),
        build_recipe_sha256: HASH_A.to_owned(),
    }
}

fn license() -> LicenseInfo {
    LicenseInfo {
        identifier: "Apache-2.0".to_owned(),
        text_url: "https://example.test/license".to_owned(),
        text_sha256: HASH_A.to_owned(),
        commercial_use: true,
        redistribution: LicenseGrant::RedistributionAllowed,
        attribution: "Aurora".to_owned(),
    }
}

fn processing() -> ProcessingMetadata {
    ProcessingMetadata {
        tokenizer_sha256: None,
        operator_inventory_sha256: HASH_A.to_owned(),
        preprocessing_abi: "pre".to_owned(),
        postprocessing_abi: "post".to_owned(),
        shapes: ShapeMetadata {
            sample_rate_hz: 16_000,
            channels: 1,
            frame_size: 512,
            window_size: 1024,
            cache_state: vec!["hidden".to_owned()],
        },
    }
}

fn sha256(bytes: &[u8]) -> String {
    aurora_voice_engine::sha256_hex(bytes)
}
