#![cfg(target_arch = "wasm32")]

use aurora_voice_core::{
    BoundedPcmBuffer, BufferPush, CancellationToken, Generation, PcmFrame, RouteRevision,
    TimestampMicros,
};
use aurora_voice_engine::{
    create_lifecycle_snapshot, file_storage_key, select_verified_variant, verify_manifest,
    AbiRequirements, BrowserFeature, CapabilityFlags, Compatibility, CompressionKind, DeviceClass,
    DownloadTask, EngineKind, InstallState, LanguageSupport, LicenseGrant, LicenseInfo,
    ManifestSignature, ModelPackError, ModelPackFile, ModelPackManifest, ModelStore,
    ModelStoreScope, PackTask, ProcessingMetadata, Provenance, ResourceBudget, RuntimeGates,
    RuntimeSelection, RuntimeTarget, ShapeMetadata, SignatureVerifier, StoredFile, TargetArch,
    TargetOs, TrustPolicy, VerifiedManifest,
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
        .activate_pack(scope(), &manifest, &selection)
        .await
        .expect("activate pack");
    assert_eq!(
        store
            .active_pack(scope())
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
        .activate_pack(scope(), &manifest, &selection)
        .await
        .expect("activate before revocation");
    store
        .signal_recovery("pack", WebRecoverySignal::Revoked)
        .await
        .expect("signal revocation");
    assert!(store
        .active_pack(scope())
        .await
        .expect("active lookup")
        .is_none());
    assert!(store
        .lifecycle("pack", "1", selection.variant_id())
        .await
        .expect("revoked lifecycle")
        .is_none());
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
async fn reservation_quota_deduplicates_proposed_content_identity() {
    let body = b"same-bytes".to_vec();
    let hash = sha256(&body);
    let first = verified("first-pack", "1", &hash, body.len() as u64);
    let second = verified("second-pack", "1", &hash, body.len() as u64);
    let first_selection = selection_for(&first);
    let second_selection = selection_for(&second);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(body.len() as u64)));

    install_ready(&mut store, &first, body.clone()).await;
    store
        .reserve_file(&second, &second_selection, &second.manifest().files[0])
        .await
        .expect("promoted content identity fits tight quota");

    let mut reserved = WebModelStore::new(InMemoryWebHost::new(Some(body.len() as u64)));
    reserved
        .reserve_file(&first, &first_selection, &first.manifest().files[0])
        .await
        .expect("first reserve fits tight quota");
    reserved
        .reserve_file(&second, &second_selection, &second.manifest().files[0])
        .await
        .expect("duplicate reservation fits tight quota");
    assert_eq!(
        reserved.status().await.unwrap().bytes_reserved,
        body.len() as u64
    );
}

#[wasm_bindgen_test(async)]
async fn reserved_download_can_fill_exact_quota() {
    let body = b"exact-quota".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(body.len() as u64)));
    let task = store
        .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("reserve exact quota");

    let receipt = download_body_with_chunk(&mut store, &task, body, 2).await;
    assert_eq!(receipt.byte_size, task.expected_bytes);
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
        .activate_pack(scope(), &first, &selection)
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
        .activate_pack(scope(), &first, &first_selection)
        .await
        .expect("activate first");
    store.host_mut().fail_next_write();
    assert_eq!(
        store
            .activate_pack(scope(), &second, &second_selection)
            .await,
        Err(ModelPackError::Store {
            code: "persistence"
        })
    );
    assert_eq!(
        store
            .active_pack(scope())
            .await
            .expect("active after failed activation")
            .map(|active| active.pack_id),
        Some("pack-a".to_owned())
    );

    store
        .activate_pack(scope(), &second, &second_selection)
        .await
        .expect("activate second");
    assert_eq!(
        store
            .active_pack(scope())
            .await
            .expect("active after second")
            .map(|active| active.pack_id),
        Some("pack-b".to_owned())
    );
    store.host_mut().fail_next_write();
    assert_eq!(
        store.rollback_active(scope()).await,
        Err(ModelPackError::Store {
            code: "persistence"
        })
    );
    assert_eq!(
        store
            .active_pack(scope())
            .await
            .expect("active after failed rollback")
            .map(|active| active.pack_id),
        Some("pack-b".to_owned())
    );
    assert_eq!(
        store
            .rollback_active(scope())
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
    assert!(store
        .lifecycle("pack", "1", selection.variant_id())
        .await
        .expect("ready lifecycle before eviction")
        .is_some());
    store.host_mut().set_evicted(true);
    assert!(store
        .lifecycle("pack", "1", selection.variant_id())
        .await
        .expect("ready lifecycle after host eviction")
        .is_none());
    store.host_mut().set_evicted(false);
    store
        .activate_pack(scope(), &manifest, &selection)
        .await
        .expect("activate pack");
    assert!(store
        .lifecycle("pack", "1", selection.variant_id())
        .await
        .expect("active lifecycle before eviction")
        .is_some());
    store.host_mut().set_evicted(true);
    assert!(store
        .lifecycle("pack", "1", selection.variant_id())
        .await
        .expect("active lifecycle after host eviction")
        .is_none());
    store.host_mut().set_evicted(false);
    store
        .signal_recovery("pack", WebRecoverySignal::Evicted)
        .await
        .expect("signal eviction");
    assert!(store
        .lifecycle("pack", "1", selection.variant_id())
        .await
        .expect("lifecycle after eviction")
        .is_none());
    assert!(store
        .active_pack(scope())
        .await
        .expect("active lookup")
        .is_none());
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

#[wasm_bindgen_test(async)]
async fn promotion_crash_recovers_from_journal() {
    let body = b"journal-model".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    let task = store
        .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("reserve");
    let receipt = download_body(&mut store, &task, body).await;
    store.host_mut().fail_next_write_after_promote();
    assert_eq!(
        store
            .promote_file(&task.storage_key, &receipt.sha256, receipt.byte_size)
            .await,
        Err(ModelPackError::Store {
            code: "persistence"
        })
    );
    let host = store.host().clone();
    let mut recreated = WebModelStore::new(host);
    recreated
        .recover_promotions()
        .await
        .expect("recover journaled promotion");
    assert!(recreated
        .resume_metadata(&task.storage_key)
        .await
        .unwrap()
        .is_none());
    assert!(recreated
        .open_immutable_file(&selection, "model")
        .await
        .is_ok());
}

#[wasm_bindgen_test(async)]
async fn scope_mutation_journal_hides_and_recovers_incomplete_activation() {
    let first_body = b"journal-first".to_vec();
    let second_body = b"journal-second".to_vec();
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
        .activate_pack(scope(), &first, &first_selection)
        .await
        .expect("activate first");
    let active_key = "aurora.voice.web-store.v1:active:stt:default";
    let old_active = store
        .host()
        .read_json(active_key)
        .await
        .expect("read active key")
        .expect("active record exists");

    store
        .activate_pack(scope(), &second, &second_selection)
        .await
        .expect("activate second");
    store.host_mut().insert_json(
        "aurora.voice.web-store.v1:mutation:stt:default",
        serde_json::json!({
            "restore": {
                active_key: old_active,
            }
        })
        .to_string(),
    );
    assert!(store
        .active_pack(scope())
        .await
        .expect("active hidden by pending journal")
        .is_none());

    let mut recreated = WebModelStore::new(store.host().clone());
    recreated
        .recover_scope_transactions()
        .await
        .expect("recover journal");
    assert_eq!(
        recreated
            .active_pack(scope())
            .await
            .expect("active after recovery")
            .map(|active| active.pack_id),
        Some("pack-a".to_owned())
    );
}

#[wasm_bindgen_test(async)]
async fn forged_metadata_and_activation_rehash_fail_closed() {
    let body = b"truth-model".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let storage_key = file_storage_key("pack", "1", selection.variant_id(), "model");
    let mut host = InMemoryWebHost::new(Some(1000));
    host.insert_promoted(storage_key.clone(), b"tampered".to_vec());
    host.forge_stored_file(
        &storage_key,
        &StoredFile {
            storage_key: storage_key.clone(),
            pack_id: "pack".to_owned(),
            pack_version: "1".to_owned(),
            file_id: "model".to_owned(),
            variant_id: selection.variant_id().to_owned(),
            sha256: sha256(&body),
            byte_size: body.len() as u64,
            state: InstallState::Ready,
            stored_at: 0,
        },
    );
    let mut store = WebModelStore::new(host);
    store
        .set_lifecycle(create_lifecycle_snapshot(
            "pack",
            "1",
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    assert_eq!(
        store.activate_pack(scope(), &manifest, &selection).await,
        Err(ModelPackError::Store { code: "corrupt" })
    );
    assert_eq!(
        store.open_immutable_file(&selection, "model").await,
        Err(ModelPackError::Store { code: "corrupt" })
    );
}

#[wasm_bindgen_test(async)]
async fn persistent_withdrawal_survives_recreation_and_removal_clears_all_pack_state() {
    let body = b"remove-model".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_ready(&mut store, &manifest, body).await;
    store
        .activate_pack(scope(), &manifest, &selection)
        .await
        .expect("activate");
    store
        .signal_recovery("pack", WebRecoverySignal::Corrupt)
        .await
        .expect("persist corruption");

    let mut recreated = WebModelStore::new(store.host().clone());
    assert_eq!(
        recreated.open_immutable_file(&selection, "model").await,
        Err(ModelPackError::Store { code: "corrupt" })
    );
    assert!(recreated
        .lifecycle("pack", "1", selection.variant_id())
        .await
        .expect("withdrawn lifecycle")
        .is_none());
    recreated.remove_pack("pack").await.expect("remove pack");
    assert!(recreated
        .active_pack(scope())
        .await
        .expect("active")
        .is_none());
    assert_eq!(
        recreated.open_immutable_file(&selection, "model").await,
        Err(ModelPackError::Store {
            code: "missing_file"
        })
    );
}

#[wasm_bindgen_test(async)]
async fn bounded_reads_timeout_cancel_and_idempotent_quota_hold() {
    let body = b"bounded-read-model".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    let task = store
        .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("reserve");
    let duplicate = store
        .reserve_file(&manifest, &selection, &manifest.manifest().files[0])
        .await
        .expect("idempotent reserve");
    assert_eq!(duplicate.storage_key, task.storage_key);
    assert_eq!(
        store.status().await.unwrap().bytes_reserved,
        body.len() as u64
    );

    let mut network = InMemoryNetworkHost::new(4);
    network.insert(task.url.clone(), body.clone());
    network.timeout_next();
    assert_eq!(
        WebModelDownloader::new(WebDownloadPolicy::bounded(4).unwrap())
            .download(
                &mut network,
                store.host_mut(),
                &task,
                &CancellationToken::new(),
                |_downloaded, _expected| {}
            )
            .await,
        Err(WebHostError::Timeout)
    );
    assert_eq!(
        store.host().staging_len(&task.storage_key).await.unwrap(),
        0
    );

    network.clear_failure();
    network.cancel_after_start();
    assert_eq!(
        WebModelDownloader::new(WebDownloadPolicy::bounded(4).unwrap())
            .download(
                &mut network,
                store.host_mut(),
                &task,
                &CancellationToken::new(),
                |_downloaded, _expected| {}
            )
            .await,
        Err(WebHostError::Cancelled)
    );
    assert_eq!(
        store.host().staging_len(&task.storage_key).await.unwrap(),
        0
    );
    assert_eq!(network.chunks_served(), 0);

    let receipt = download_body_with_chunk(&mut store, &task, body, 3).await;
    assert!(store.host().max_observed_read_request() <= 3);
    store
        .promote_file(&task.storage_key, &receipt.sha256, receipt.byte_size)
        .await
        .expect("promote");
}

#[wasm_bindgen_test(async)]
async fn quota_deduplicates_reserved_hashes_and_rejects_conflicting_sizes() {
    let mut host = InMemoryWebHost::new(Some(1000));
    let first = DownloadTask {
        storage_key: "first-key".to_owned(),
        pack_id: "pack".to_owned(),
        pack_version: "1".to_owned(),
        file_id: "model-a".to_owned(),
        url: "https://example.test/a".to_owned(),
        expected_sha256: HASH_A.to_owned(),
        expected_bytes: 10,
        variant_id: "wasm-simd".to_owned(),
    };
    let second = DownloadTask {
        storage_key: "second-key".to_owned(),
        file_id: "model-b".to_owned(),
        url: "https://example.test/b".to_owned(),
        ..first.clone()
    };
    host.insert_json(
        "aurora.voice.web-store.v1:reserved:first-key",
        serde_json::to_string(&first).unwrap(),
    );
    host.insert_json(
        "aurora.voice.web-store.v1:reserved:second-key",
        serde_json::to_string(&second).unwrap(),
    );
    let store = WebModelStore::new(host.clone());
    assert_eq!(store.status().await.unwrap().bytes_reserved, 10);

    let conflicting = DownloadTask {
        storage_key: "conflicting-key".to_owned(),
        file_id: "model-c".to_owned(),
        url: "https://example.test/c".to_owned(),
        expected_bytes: 11,
        ..first
    };
    host.insert_json(
        "aurora.voice.web-store.v1:reserved:conflicting-key",
        serde_json::to_string(&conflicting).unwrap(),
    );
    assert_eq!(
        WebModelStore::new(host).status().await,
        Err(ModelPackError::Store { code: "quota" })
    );
}

#[wasm_bindgen_test(async)]
async fn scoped_activation_keeps_independent_maps_and_variant_rollback() {
    let first_body = b"variant-one".to_vec();
    let second_body = b"variant-two".to_vec();
    let first = verified("pack", "1", &sha256(&first_body), first_body.len() as u64);
    let mut second_raw = manifest("pack", "1", &sha256(&second_body), second_body.len() as u64);
    second_raw.files = vec![model_file(
        "model-b",
        &sha256(&second_body),
        second_body.len() as u64,
    )];
    second_raw.variants = vec![variant(
        "wasm-alt",
        RuntimeTarget::Web,
        TargetOs::Web,
        TargetArch::Wasm32,
        "model-b",
        second_body.len() as u64,
    )];
    let second = verify_manifest(
        second_raw,
        &TrustPolicy::default(),
        Some(&AcceptingVerifier),
    )
    .unwrap();
    let first_selection = selection_for(&first);
    let second_selection = selection_for(&second);
    let scope_a = ModelStoreScope::new(PackTask::Stt, "slot-a").unwrap();
    let scope_b = ModelStoreScope::new(PackTask::Stt, "slot-b").unwrap();
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_ready(&mut store, &first, first_body).await;
    install_ready(&mut store, &second, second_body).await;

    store
        .activate_pack(scope_a.clone(), &first, &first_selection)
        .await
        .expect("activate slot a first");
    store
        .activate_pack(scope_b.clone(), &first, &first_selection)
        .await
        .expect("activate slot b first");
    store
        .activate_pack(scope_a.clone(), &second, &second_selection)
        .await
        .expect("activate alternate variant");
    assert_eq!(
        store
            .lifecycle("pack", "1", first_selection.variant_id())
            .await
            .expect("shared variant lifecycle")
            .map(|snapshot| snapshot.state),
        Some(InstallState::Active)
    );
    assert_eq!(
        store
            .active_pack(scope_b.clone())
            .await
            .unwrap()
            .map(|active| active.variant_id),
        Some("wasm-simd".to_owned())
    );
    assert_eq!(
        store
            .rollback_active(scope_a)
            .await
            .unwrap()
            .map(|snapshot| snapshot.variant_id),
        Some("wasm-simd".to_owned())
    );
}

#[wasm_bindgen_test(async)]
async fn dependency_files_do_not_have_to_match_scope_task_but_wrong_scope_rejects() {
    let primary = b"primary-model".to_vec();
    let tokenizer = b"tokenizer-data".to_vec();
    let mut raw = manifest("pack", "1", &sha256(&primary), primary.len() as u64);
    raw.tasks = vec![PackTask::Stt, PackTask::Tokenizer];
    raw.files = vec![
        model_file("model", &sha256(&primary), primary.len() as u64),
        {
            let mut file = model_file("tokenizer", &sha256(&tokenizer), tokenizer.len() as u64);
            file.task = PackTask::Tokenizer;
            file
        },
    ];
    raw.variants[0].file_ids = vec!["model".to_owned(), "tokenizer".to_owned()];
    raw.variants[0].resource_budget.max_download_bytes = (primary.len() + tokenizer.len()) as u64;
    raw.variants[0].resource_budget.max_installed_bytes = (primary.len() + tokenizer.len()) as u64;
    let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
        .expect("verify mixed-task pack");
    let selection = selection_for(&verified);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_file(&mut store, &verified, &selection, 0, primary).await;
    install_file(&mut store, &verified, &selection, 1, tokenizer).await;
    store
        .set_lifecycle(create_lifecycle_snapshot(
            "pack",
            "1",
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    assert!(store
        .activate_pack(scope(), &verified, &selection)
        .await
        .is_ok());
    assert_eq!(
        store
            .activate_pack(
                ModelStoreScope::default_for_task(PackTask::Tts),
                &verified,
                &selection
            )
            .await,
        Err(ModelPackError::Store { code: "task" })
    );

    let kws_only = b"kws-only".to_vec();
    let mut raw = manifest("task-pack", "1", &sha256(&kws_only), kws_only.len() as u64);
    raw.tasks = vec![PackTask::Stt, PackTask::Kws];
    raw.files = vec![{
        let mut file = model_file("kws", &sha256(&kws_only), kws_only.len() as u64);
        file.task = PackTask::Kws;
        file
    }];
    raw.variants[0].file_ids = vec!["kws".to_owned()];
    raw.variants[0].resource_budget.max_download_bytes = kws_only.len() as u64;
    raw.variants[0].resource_budget.max_installed_bytes = kws_only.len() as u64;
    let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
        .expect("verify kws-only selection");
    let selection = selection_for(&verified);
    assert_eq!(
        WebModelStore::new(InMemoryWebHost::new(Some(1000)))
            .activate_pack(scope(), &verified, &selection)
            .await,
        Err(ModelPackError::Store { code: "task" })
    );

    let primary = b"transitive-primary".to_vec();
    let direct = b"transitive-direct".to_vec();
    let shared = b"transitive-shared".to_vec();
    let mut raw = manifest(
        "transitive-pack",
        "1",
        &sha256(&primary),
        primary.len() as u64,
    );
    raw.tasks = vec![PackTask::Stt, PackTask::Frontend, PackTask::Tokenizer];
    raw.files = vec![
        {
            let mut file = model_file("model", &sha256(&primary), primary.len() as u64);
            file.dependencies = vec!["frontend".to_owned()];
            file
        },
        {
            let mut file = model_file("frontend", &sha256(&direct), direct.len() as u64);
            file.task = PackTask::Frontend;
            file.dependencies = vec!["shared".to_owned()];
            file
        },
        {
            let mut file = model_file("shared", &sha256(&shared), shared.len() as u64);
            file.task = PackTask::Tokenizer;
            file
        },
    ];
    raw.variants[0].file_ids = vec!["model".to_owned()];
    raw.variants[0].resource_budget.max_download_bytes =
        (primary.len() + direct.len() + shared.len()) as u64;
    raw.variants[0].resource_budget.max_installed_bytes =
        (primary.len() + direct.len() + shared.len()) as u64;
    let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
        .expect("verify transitive dependency pack");
    let selection = selection_for(&verified);
    assert!(selection.file_ids().contains("shared"));
    assert_eq!(selection.file_ids().len(), 3);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_file(&mut store, &verified, &selection, 0, primary).await;
    install_file(&mut store, &verified, &selection, 1, direct).await;
    store
        .set_lifecycle(create_lifecycle_snapshot(
            "transitive-pack",
            "1",
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    assert_eq!(
        store.activate_pack(scope(), &verified, &selection).await,
        Err(ModelPackError::Store {
            code: "missing_file"
        })
    );
}

#[wasm_bindgen_test(async)]
async fn duplicate_blobs_orphans_and_stale_active_bytes_fail_closed() {
    let body = b"shared-blob".to_vec();
    let hash = sha256(&body);
    let key_a = file_storage_key("pack", "1", "wasm-simd", "model");
    let key_b = file_storage_key("other", "1", "wasm-simd", "model");
    let mut host = InMemoryWebHost::new(Some(1000));
    host.insert_promoted(key_a.clone(), body.clone());
    host.insert_promoted(key_b.clone(), body.clone());
    let store = WebModelStore::new(host);
    assert_eq!(store.status().await.unwrap().bytes_used, body.len() as u64);

    let manifest = verified("pack", "1", &hash, body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(store.host().clone());
    store.host_mut().forge_stored_file(
        &key_a,
        &StoredFile {
            storage_key: key_a.clone(),
            pack_id: "pack".to_owned(),
            pack_version: "1".to_owned(),
            file_id: "model".to_owned(),
            variant_id: "wasm-simd".to_owned(),
            sha256: hash,
            byte_size: body.len() as u64,
            state: InstallState::Ready,
            stored_at: 0,
        },
    );
    store
        .set_lifecycle(create_lifecycle_snapshot(
            "pack",
            "1",
            "wasm-simd",
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    store
        .activate_pack(scope(), &manifest, &selection)
        .await
        .expect("activate");
    store.host_mut().delete_promoted(&key_a).await.unwrap();
    assert!(store.active_pack(scope()).await.unwrap().is_none());
    assert!(store
        .lifecycle("pack", "1", "wasm-simd")
        .await
        .expect("stale lifecycle")
        .is_none());

    let mut cleanup = WebModelStore::new(store.host().clone());
    cleanup.recover_promotions().await.unwrap();
    assert!(!cleanup.host().promoted_contains(&key_b));
}

#[wasm_bindgen_test(async)]
async fn ready_lifecycle_requires_complete_persisted_file_closure() {
    let primary = b"ready-primary".to_vec();
    let tokenizer = b"ready-tokenizer".to_vec();
    let mut raw = manifest("ready-pack", "1", &sha256(&primary), primary.len() as u64);
    raw.tasks = vec![PackTask::Stt, PackTask::Tokenizer];
    raw.files = vec![
        {
            let mut file = model_file("model", &sha256(&primary), primary.len() as u64);
            file.dependencies = vec!["tokenizer".to_owned()];
            file
        },
        {
            let mut file = model_file("tokenizer", &sha256(&tokenizer), tokenizer.len() as u64);
            file.task = PackTask::Tokenizer;
            file
        },
    ];
    raw.variants[0].file_ids = vec!["model".to_owned()];
    raw.variants[0].resource_budget.max_download_bytes = (primary.len() + tokenizer.len()) as u64;
    raw.variants[0].resource_budget.max_installed_bytes = (primary.len() + tokenizer.len()) as u64;
    let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
        .expect("verify dependency-backed pack");
    let selection = selection_for(&verified);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_file(&mut store, &verified, &selection, 0, primary.clone()).await;
    install_file(&mut store, &verified, &selection, 1, tokenizer.clone()).await;
    store
        .set_lifecycle(create_lifecycle_snapshot(
            "ready-pack",
            "1",
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    assert!(store
        .lifecycle("ready-pack", "1", selection.variant_id())
        .await
        .expect("complete ready lifecycle")
        .is_some());

    let tokenizer_key = file_storage_key("ready-pack", "1", selection.variant_id(), "tokenizer");
    store
        .host_mut()
        .delete_json(&format!("aurora.voice.web-store.v1:file:{tokenizer_key}"))
        .await
        .expect("delete tokenizer metadata");
    assert!(store
        .lifecycle("ready-pack", "1", selection.variant_id())
        .await
        .expect("metadata loss hides ready lifecycle")
        .is_none());

    let mut file_loss = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_file(&mut file_loss, &verified, &selection, 0, primary.clone()).await;
    install_file(&mut file_loss, &verified, &selection, 1, tokenizer.clone()).await;
    file_loss
        .set_lifecycle(create_lifecycle_snapshot(
            "ready-pack",
            "1",
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    file_loss
        .host_mut()
        .delete_promoted(&tokenizer_key)
        .await
        .expect("delete tokenizer bytes");
    assert!(file_loss
        .lifecycle("ready-pack", "1", selection.variant_id())
        .await
        .expect("file loss hides ready lifecycle")
        .is_none());

    let mut active_loss = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_file(&mut active_loss, &verified, &selection, 0, primary.clone()).await;
    install_file(
        &mut active_loss,
        &verified,
        &selection,
        1,
        tokenizer.clone(),
    )
    .await;
    active_loss
        .set_lifecycle(create_lifecycle_snapshot(
            "ready-pack",
            "1",
            selection.variant_id().to_owned(),
            0,
            InstallState::Ready,
        ))
        .await
        .expect("ready lifecycle");
    active_loss
        .activate_pack(scope(), &verified, &selection)
        .await
        .expect("activate complete closure");
    active_loss
        .host_mut()
        .delete_json(&format!("aurora.voice.web-store.v1:file:{tokenizer_key}"))
        .await
        .expect("delete active tokenizer metadata");
    assert!(active_loss
        .active_pack(scope())
        .await
        .expect("active lookup after metadata loss")
        .is_none());
    assert!(active_loss
        .lifecycle("ready-pack", "1", selection.variant_id())
        .await
        .expect("active lifecycle after metadata loss")
        .is_none());
}

#[wasm_bindgen_test(async)]
async fn active_record_scope_mismatch_fails_closed() {
    let body = b"scope-mismatch".to_vec();
    let manifest = verified("pack", "1", &sha256(&body), body.len() as u64);
    let selection = selection_for(&manifest);
    let mut store = WebModelStore::new(InMemoryWebHost::new(Some(1000)));
    install_ready(&mut store, &manifest, body).await;
    store
        .activate_pack(scope(), &manifest, &selection)
        .await
        .expect("activate");
    let active_key = "aurora.voice.web-store.v1:active:stt:default";
    let mut active: serde_json::Value = serde_json::from_str(
        &store
            .host()
            .read_json(active_key)
            .await
            .expect("read active key")
            .expect("active record"),
    )
    .expect("active json");
    active["identity"]["scope"]["slot_id"] = serde_json::Value::String("other".to_owned());
    store.host_mut().insert_json(active_key, active.to_string());

    assert!(store
        .active_pack(scope())
        .await
        .expect("scope mismatch active lookup")
        .is_none());
}

#[wasm_bindgen_test]
fn debug_and_errors_do_not_include_raw_data_urls_or_hashes() {
    let mut host = InMemoryWebHost::new(Some(1000));
    host.set_evicted(true);
    let chunk = aurora_voice_wasm::WebFetchedChunk {
        bytes: b"raw-model-bytes".to_vec(),
        finished: false,
    };
    let request = aurora_voice_wasm::WebFetchRequest {
        url: "https://example.test/models/model?secret=token".to_owned(),
        offset: 0,
        max_bytes: 8,
        timeout_millis: 1,
    };
    let receipt = aurora_voice_wasm::WebDownloadReceipt {
        byte_size: 10,
        sha256: HASH_A.to_owned(),
        resumed_from: 0,
    };
    let rendered = format!(
        "{host:?} {chunk:?} {request:?} {receipt:?} {:?} {}",
        WebHostError::Network {
            code: "interrupted"
        },
        WebHostError::Integrity { code: "hash" }
    );
    assert!(!rendered.contains("raw-model-bytes"));
    assert!(!rendered.contains("https://example.test"));
    assert!(!rendered.contains("secret"));
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

async fn install_file(
    store: &mut WebModelStore<InMemoryWebHost>,
    manifest: &VerifiedManifest,
    selection: &aurora_voice_engine::SelectedVariant,
    file_index: usize,
    body: Vec<u8>,
) {
    let file = &manifest.manifest().files[file_index];
    let task = store
        .reserve_file(manifest, selection, file)
        .await
        .expect("reserve file");
    let receipt = download_body(store, &task, body).await;
    store
        .promote_file(&task.storage_key, &receipt.sha256, receipt.byte_size)
        .await
        .expect("promote file");
}

async fn download_body(
    store: &mut WebModelStore<InMemoryWebHost>,
    task: &aurora_voice_engine::DownloadTask,
    body: Vec<u8>,
) -> aurora_voice_wasm::WebDownloadReceipt {
    download_body_with_chunk(store, task, body, 64).await
}

async fn download_body_with_chunk(
    store: &mut WebModelStore<InMemoryWebHost>,
    task: &aurora_voice_engine::DownloadTask,
    body: Vec<u8>,
    chunk_size: u64,
) -> aurora_voice_wasm::WebDownloadReceipt {
    let mut network = InMemoryNetworkHost::new(chunk_size as usize);
    network.insert(task.url.clone(), body);
    WebModelDownloader::new(WebDownloadPolicy::bounded(chunk_size).expect("policy"))
        .download(
            &mut network,
            store.host_mut(),
            task,
            &CancellationToken::new(),
            |_downloaded, _expected| {},
        )
        .await
        .expect("download")
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

fn scope() -> ModelStoreScope {
    ModelStoreScope::default_for_task(PackTask::Stt)
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
