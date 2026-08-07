use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use aurora_voice_engine::{
    verify_manifest, ModelPackManifest, PackTask, TrustPolicy, VerificationMode,
};
use aurora_voice_native::Ed25519TrustStore;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("crate lives under rust/crates")
        .to_path_buf()
}

fn candidates_dir() -> PathBuf {
    repo_root().join("tools/voice-runtime/model-packs/candidates")
}

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).expect("read json")).expect("valid json")
}

fn sha256_file(path: impl AsRef<Path>) -> String {
    let bytes = std::fs::read(path).expect("read sha256 input");
    format!("{:x}", Sha256::digest(bytes))
}

fn string_set(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn dependency_closure(manifest: &ModelPackManifest) -> BTreeSet<String> {
    let files: BTreeMap<_, _> = manifest
        .files
        .iter()
        .map(|file| (file.file_id.as_str(), file))
        .collect();
    let mut selected: BTreeSet<String> = manifest
        .variants
        .iter()
        .flat_map(|variant| variant.file_ids.iter().cloned())
        .collect();
    let mut changed = true;
    while changed {
        changed = false;
        for file_id in selected.clone() {
            let file = files
                .get(file_id.as_str())
                .expect("variant/dependency file id exists");
            for dependency in &file.dependencies {
                if selected.insert(dependency.clone()) {
                    changed = true;
                }
            }
        }
    }
    selected
}

#[test]
fn phase6_candidate_manifests_verify_with_candidate_ed25519_trust() {
    let candidates = candidates_dir();
    let trust_json = read_json(candidates.join("signed-candidate-trust.json"));

    assert_eq!(
        trust_json["trust_label"],
        "non-production signed-candidate trust only"
    );
    let key_id = trust_json["key_id"].as_str().expect("key id");
    let public_key = trust_json["public_key_base64"]
        .as_str()
        .expect("public key");
    let mut trust = Ed25519TrustStore::new();
    trust
        .add_base64_key(key_id, public_key)
        .expect("register candidate public key");

    for (file_name, task) in [
        ("silero-vad-v4.candidate.manifest.json", PackTask::Vad),
        (
            "sherpa-gigaspeech-kws-en.candidate.manifest.json",
            PackTask::Kws,
        ),
        (
            "moonshine-tiny-en-stt.candidate.manifest.json",
            PackTask::Stt,
        ),
    ] {
        let manifest: ModelPackManifest = serde_json::from_str(
            &std::fs::read_to_string(candidates.join(file_name)).expect("read manifest"),
        )
        .expect("manifest json");
        let verified = verify_manifest(manifest, &TrustPolicy::default(), Some(&trust))
            .expect("candidate manifest verifies");

        assert_eq!(verified.mode(), VerificationMode::Signature);
        assert_eq!(verified.key_id(), Some(key_id));
        assert_eq!(verified.manifest().tasks, vec![task]);
        if task == PackTask::Vad {
            assert!(
                verified.manifest().languages.iter().all(|language| {
                    language.language == "und"
                        && language.locale.is_none()
                        && language.fixed_language
                        && !language.auto_detect
                }),
                "{file_name} must stay language-neutral without locale claims"
            );
            assert!(
                verified.manifest().variants.iter().all(|variant| variant
                    .abi
                    .build_flags
                    .iter()
                    .any(|flag| flag == "language-neutral")),
                "{file_name} must declare the language-neutral candidate flag"
            );
        } else {
            assert!(
                verified.manifest().languages.iter().all(|language| {
                    language.language == "en"
                        && language.locale.as_deref() == Some("en-US")
                        && language.fixed_language
                        && !language.auto_detect
                }),
                "{file_name} must stay English-only without auto-language claims"
            );
            assert!(
                verified.manifest().variants.iter().all(|variant| variant
                    .abi
                    .build_flags
                    .iter()
                    .any(|flag| flag == "english-only")),
                "{file_name} must keep the English-only candidate flag"
            );
        }
        assert!(
            verified
                .manifest()
                .variants
                .iter()
                .all(|variant| !variant.compatibility.interoperable),
            "{file_name} must remain non-interoperable until parity gates land"
        );
        assert!(
            verified.manifest().variants.iter().all(|variant| {
                variant.target == aurora_voice_engine::RuntimeTarget::Desktop
                    && variant.os == aurora_voice_engine::TargetOs::Linux
                    && variant.arch == aurora_voice_engine::TargetArch::X86_64
            }),
            "{file_name} must not claim Android, iOS, or physical-device support"
        );
        assert!(
            verified.manifest().files.iter().all(|file| file
                .url
                .starts_with("/aurora/model-packs/candidates/sha256/")),
            "{file_name} must use content-addressed candidate URLs"
        );
        assert!(
            verified.manifest().files.iter().all(|file| {
                let rendered = format!(
                    "{} {} {} {:?}",
                    file.file_id, file.asset_id, file.url, file.dependencies
                )
                .to_lowercase();
                !rendered.contains("test") && !rendered.contains("training")
            }),
            "{file_name} selectable install closure must not contain test/training assets"
        );
        assert!(
            dependency_closure(verified.manifest())
                .iter()
                .all(|file_id| !file_id.contains("test") && !file_id.contains("training")),
            "{file_name} dependency closure must exclude test/training assets"
        );
        for file in &verified.manifest().files {
            assert_eq!(
                file.processing.operator_inventory_sha256,
                sha256_file(candidates.join(match task {
                    PackTask::Vad => "silero-vad-v4.operator-inventory.json",
                    PackTask::Kws => "sherpa-gigaspeech-kws.operator-inventory.json",
                    PackTask::Stt => "moonshine-tiny-en.operator-inventory.json",
                    _ => unreachable!("candidate task"),
                })),
                "{file_name} must reference the current operator inventory hash"
            );
            if let Some(tokenizer_sha256) = &file.processing.tokenizer_sha256 {
                let tokenizer_file = match task {
                    PackTask::Kws => "sherpa-gigaspeech-kws.tokenizer-inventory.json",
                    PackTask::Stt => "moonshine-tiny-en.tokenizer-inventory.json",
                    _ => unreachable!("unexpected tokenizer task"),
                };
                assert_eq!(
                    tokenizer_sha256,
                    &sha256_file(candidates.join(tokenizer_file)),
                    "{file_name} must reference the current tokenizer inventory hash"
                );
            }
        }
    }
}

#[test]
fn phase6_candidate_state_and_inventory_metadata_are_exact() {
    let candidates = candidates_dir();

    let silero: ModelPackManifest = serde_json::from_str(
        &std::fs::read_to_string(candidates.join("silero-vad-v4.candidate.manifest.json"))
            .expect("read Silero manifest"),
    )
    .expect("Silero manifest json");
    let silero_file = silero
        .files
        .iter()
        .find(|file| file.file_id == "silero-vad-v4.0.onnx")
        .expect("Silero model file");
    assert_eq!(
        silero_file.processing.shapes.cache_state,
        vec!["h", "c", "hn", "cn"],
        "Silero VAD must carry exact recurrent input/output state names"
    );
    let silero_inventory = read_json(candidates.join("silero-vad-v4.operator-inventory.json"));
    assert!(silero_inventory["metadata"]["ir_version"].is_number());
    assert!(silero_inventory["metadata"]["opset_imports"]
        .as_array()
        .is_some_and(|imports| !imports.is_empty()));
    assert!(
        silero_inventory["operator_inventory"]["operator_counts"]["LSTM"]
            .as_u64()
            .is_some_and(|count| count > 0),
        "Silero recursive inventory must preserve subgraph operator counts"
    );

    let kws: ModelPackManifest = serde_json::from_str(
        &std::fs::read_to_string(
            candidates.join("sherpa-gigaspeech-kws-en.candidate.manifest.json"),
        )
        .expect("read KWS manifest"),
    )
    .expect("KWS manifest json");
    let kws_inventory = read_json(candidates.join("sherpa-gigaspeech-kws.operator-inventory.json"));
    let encoder_inventory = kws_inventory["models"]
        .as_array()
        .expect("KWS inventory models")
        .iter()
        .find(|model| {
            model["path"]
                .as_str()
                .is_some_and(|path| path.starts_with("encoder-"))
        })
        .expect("KWS encoder inventory");
    assert!(encoder_inventory["metadata"]["ir_version"].is_number());
    assert!(encoder_inventory["metadata"]["opset_imports"]
        .as_array()
        .is_some_and(|imports| !imports.is_empty()));
    let expected_kws_state: BTreeSet<String> = encoder_inventory["operator_inventory"]
        ["top_level_inputs"]
        .as_array()
        .expect("KWS encoder inputs")
        .iter()
        .filter_map(|value| value.as_str())
        .filter(|name| {
            name.starts_with("cached_") || *name == "embed_states" || *name == "processed_lens"
        })
        .chain(
            encoder_inventory["operator_inventory"]["top_level_outputs"]
                .as_array()
                .expect("KWS encoder outputs")
                .iter()
                .filter_map(|value| value.as_str())
                .filter(|name| {
                    name.starts_with("new_cached_")
                        || *name == "new_embed_states"
                        || *name == "new_processed_lens"
                }),
        )
        .map(str::to_owned)
        .collect();
    let kws_encoder = kws
        .files
        .iter()
        .find(|file| file.file_id == "encoder-int8")
        .expect("KWS encoder file");
    assert!(!expected_kws_state.is_empty());
    assert_eq!(
        kws_encoder
            .processing
            .shapes
            .cache_state
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        expected_kws_state,
        "KWS encoder cache_state must match ONNX recurrent inputs and outputs"
    );
    assert!(
        kws.files
            .iter()
            .all(|file| file.file_id != "test-keywords" && !file.asset_id.contains("test_wavs")),
        "KWS selectable manifest must exclude Phase 4 test label assets"
    );

    let kws_tokenizer =
        read_json(candidates.join("sherpa-gigaspeech-kws.tokenizer-inventory.json"));
    let evidence_only = kws_tokenizer["tokenizer_assets"]
        .as_array()
        .expect("KWS tokenizer assets")
        .iter()
        .find(|asset| asset["path"] == "test_wavs/test_keywords.txt")
        .expect("evidence-only KWS label remains documented");
    assert_eq!(evidence_only["excluded_from_selectable_manifest"], true);
    assert!(evidence_only["purpose"]
        .as_str()
        .is_some_and(|purpose| purpose.contains("evidence-only")));

    let moon: ModelPackManifest = serde_json::from_str(
        &std::fs::read_to_string(candidates.join("moonshine-tiny-en-stt.candidate.manifest.json"))
            .expect("read Moonshine manifest"),
    )
    .expect("Moonshine manifest json");
    let moon_inventory = read_json(candidates.join("moonshine-tiny-en.operator-inventory.json"));
    assert_eq!(moon_inventory["parser_version"], "onnxruntime 1.27.0");
    assert_eq!(
        moon_inventory["parser_runtime_revision"],
        "8f0278c77bf44b0cc83c098c6c722b92a36ac4b5"
    );
    let decoder_inventory = moon_inventory["models"]
        .as_array()
        .expect("Moonshine inventory models")
        .iter()
        .find(|model| model["path"] == "decoder_model_merged.ort")
        .expect("Moonshine decoder inventory");
    let expected_moon_state: BTreeSet<String> = decoder_inventory["operator_inventory"]
        ["cache_state_names"]
        .as_array()
        .expect("Moonshine decoder cache state")
        .iter()
        .map(|value| value.as_str().expect("cache state string").to_owned())
        .collect();
    assert!(!expected_moon_state.is_empty());
    let moon_decoder = moon
        .files
        .iter()
        .find(|file| file.file_id == "decoder-merged")
        .expect("Moonshine decoder file");
    assert_eq!(
        moon_decoder
            .processing
            .shapes
            .cache_state
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        expected_moon_state,
        "Moonshine decoder cache_state must match ORT parser state names"
    );
}

#[test]
fn phase6_tts_disposition_is_blocked_and_not_selectable() {
    let disposition = read_json(candidates_dir().join("blocked-tts-disposition.json"));

    assert_eq!(disposition["status"], "blocked");
    assert_eq!(disposition["selectable_model_pack"], false);
    assert!(disposition.get("files").is_none());
    assert!(disposition.get("variants").is_none());
    assert!(disposition.to_string().contains("PocketTTS"));
    assert!(disposition.to_string().contains("Piper/espeak"));
    let supertonic = disposition["dispositions"]
        .as_array()
        .expect("blocked dispositions")
        .iter()
        .find(|entry| entry["id"] == "sherpa-onnx-supertonic-3-tts-int8-2026-05-11")
        .expect("Supertonic 3 TTS block");
    assert_eq!(supertonic["status"], "blocked");
    assert_eq!(
        supertonic["archive_sha256"],
        "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427"
    );
    assert_eq!(
        supertonic["code_license_sha256"],
        "0dfe0d0ba84416fe3879d9a34f4909d8d0137c78d1e95834177b0414ac096fa2"
    );
    assert_eq!(
        supertonic["supported_languages"]
            .as_array()
            .expect("supported language list")
            .iter()
            .map(|value| value.as_str().expect("language string").to_owned())
            .collect::<BTreeSet<_>>(),
        string_set(&["en", "fr", "de", "pt", "it", "es"])
    );
    let rendered = supertonic.to_string();
    assert!(rendered.contains("OpenRAIL-M"));
    assert!(rendered.contains("MIT software"));
    assert!(rendered.contains("legal redistribution"));
    assert!(rendered.contains("maintenance abandonment"));
    assert!(rendered.contains("Do not advertise"));
}
