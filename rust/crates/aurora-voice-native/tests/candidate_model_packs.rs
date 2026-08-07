use std::path::{Path, PathBuf};

use aurora_voice_engine::{
    verify_manifest, ModelPackManifest, PackTask, TrustPolicy, VerificationMode,
};
use aurora_voice_native::Ed25519TrustStore;
use serde_json::Value;

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

#[test]
fn phase6_candidate_manifests_verify_with_candidate_ed25519_trust() {
    let candidates = candidates_dir();
    let trust_json: Value = serde_json::from_str(
        &std::fs::read_to_string(candidates.join("signed-candidate-trust.json"))
            .expect("read candidate trust"),
    )
    .expect("candidate trust json");

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
    }
}

#[test]
fn phase6_tts_disposition_is_blocked_and_not_selectable() {
    let disposition: Value = serde_json::from_str(
        &std::fs::read_to_string(candidates_dir().join("blocked-tts-disposition.json"))
            .expect("read TTS disposition"),
    )
    .expect("TTS disposition json");

    assert_eq!(disposition["status"], "blocked");
    assert_eq!(disposition["selectable_model_pack"], false);
    assert!(disposition.get("files").is_none());
    assert!(disposition.get("variants").is_none());
    assert!(disposition.to_string().contains("PocketTTS"));
    assert!(disposition.to_string().contains("Piper/espeak"));
}
