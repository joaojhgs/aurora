use std::fmt::Write as _;
use std::path::PathBuf;

use aurora_contracts::{
    event_by_topic, method_by_id, normalize_generated_contract, EVENT_DESCRIPTORS,
    METHOD_DESCRIPTORS, SCHEMA_DESCRIPTORS,
};
use serde::Deserialize;
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
struct ParseFixture {
    vectors: Vec<ParseVector>,
}

#[derive(Debug, Deserialize)]
struct ParseVector {
    accepted: bool,
    case_index: Option<usize>,
    input: Value,
    issue_category: Option<String>,
    issue_path: Option<String>,
    normalized: Option<Value>,
    normalized_hash: Option<String>,
    schema_id: String,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../../tests/fixtures/local_speech/runtime/contracts/backend_contract_parse_vectors.json",
    )
}

fn canonical_hash(value: &Value) -> Result<String, serde_json::Error> {
    let canonical = serde_json::to_string(value)?;
    let digest = Sha256::digest(canonical.as_bytes());
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(output)
}

#[test]
fn descriptors_match_the_backend_inventory() {
    assert_eq!(SCHEMA_DESCRIPTORS.len(), 61);
    assert_eq!(METHOD_DESCRIPTORS.len(), 30);
    assert_eq!(EVENT_DESCRIPTORS.len(), 1);

    let synthesize = method_by_id("TTS.Synthesize").expect("TTS.Synthesize descriptor");
    assert_eq!(synthesize.bus_topic, "TTS.Synthesize");
    assert_eq!(synthesize.route_path, "/api/TTS/Synthesize");
    assert_eq!(synthesize.required_permissions, &["TTS.Synthesize"]);
    assert_eq!(synthesize.callable_feature_ids, &["speech_synthesis"]);

    let audio = event_by_topic("TTS.AudioChunk").expect("TTS.AudioChunk descriptor");
    assert!(audio.bounded);
    assert!(audio.authorized);
    assert!(!audio.remote_raw_audio_route);
}

#[test]
fn rust_parser_matches_shared_positive_and_negative_vectors() {
    let source = std::fs::read_to_string(fixture_path()).expect("read parser fixture");
    let fixture: ParseFixture = serde_json::from_str(&source).expect("parse parser fixture");
    assert!(!fixture.vectors.is_empty());
    let mut wrongly_accepted = Vec::new();

    for vector in fixture.vectors {
        let parsed = normalize_generated_contract(&vector.schema_id, vector.input);
        if vector.accepted {
            parsed.unwrap_or_else(|error| {
                panic!("{} rejected a positive vector: {error}", vector.schema_id)
            });
            let expected = vector.normalized.expect("positive vector normalization");
            normalize_generated_contract(&vector.schema_id, expected.clone()).unwrap_or_else(
                |error| {
                    panic!(
                        "{} rejected its normalized vector: {error}",
                        vector.schema_id
                    )
                },
            );
            assert_eq!(
                canonical_hash(&expected).expect("hash normalized JSON"),
                vector.normalized_hash.expect("positive vector hash"),
                "{} normalized hash",
                vector.schema_id
            );
        } else if parsed.is_ok() {
            wrongly_accepted.push(format!(
                "{} case {:?} {:?} {:?}",
                vector.schema_id, vector.case_index, vector.issue_category, vector.issue_path
            ));
        }
    }
    assert!(
        wrongly_accepted.is_empty(),
        "Rust accepted shared negative vectors: {}",
        wrongly_accepted.join("; ")
    );
}

#[test]
fn validation_errors_never_echo_payload_data() {
    let secret = "raw-audio-secret-that-must-not-escape";
    let error = normalize_generated_contract(
        "TTS.AudioChunk.event.TTSAudioChunkEvent",
        json!({
            "audio_data": secret,
            "channels": 1,
            "duration_ms": 1.0,
            "format": "raw",
            "sample_rate": 24000,
            "sequence": -1,
            "stream_id": "stream-1"
        }),
    )
    .expect_err("negative sequence must fail");

    let message = error.to_string();
    assert!(!message.contains(secret));
    assert!(message.contains("TTS.AudioChunk.event.TTSAudioChunkEvent"));
}
