use std::fmt::Write as _;
use std::path::PathBuf;

use aurora_contracts::{
    envelope_by_topic, event_by_topic, ids, method_by_id, normalize_generated_contract,
    ENVELOPE_DESCRIPTORS, EVENT_DESCRIPTORS, METHOD_DESCRIPTORS, SCHEMA_DESCRIPTORS,
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
    marker_paths: Option<Vec<String>>,
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

fn without_empty_default_fields(value: Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(items) if items.is_empty() => None,
        Value::Array(items) => Some(Value::Array(
            items
                .into_iter()
                .filter_map(without_empty_default_fields)
                .collect(),
        )),
        Value::Object(object) if object.is_empty() => None,
        Value::Object(object) => {
            let filtered = object
                .into_iter()
                .filter_map(|(key, value)| {
                    without_empty_default_fields(value).map(|value| (key, value))
                })
                .collect();
            Some(Value::Object(filtered))
        }
        other => Some(other),
    }
}

fn expected_input_shape(expected: &Value, input: &Value) -> Value {
    match (expected, input) {
        (Value::Object(expected_object), Value::Object(input_object)) => Value::Object(
            input_object
                .keys()
                .filter_map(|key| {
                    expected_object
                        .get(key)
                        .filter(|value| !value.is_null())
                        .map(|value| {
                            let input_value = input_object.get(key).expect("input key exists");
                            (key.clone(), expected_input_shape(value, input_value))
                        })
                })
                .collect(),
        ),
        (Value::Array(expected_items), Value::Array(input_items)) => {
            if input_items.is_empty() {
                Value::Array(Vec::new())
            } else if expected_items.len() == input_items.len() {
                Value::Array(
                    expected_items
                        .iter()
                        .zip(input_items)
                        .map(|(expected_item, input_item)| {
                            expected_input_shape(expected_item, input_item)
                        })
                        .collect(),
                )
            } else {
                expected.clone()
            }
        }
        _ => expected.clone(),
    }
}

fn parsed_input_shape(parsed: &Value, input: &Value) -> Value {
    match (parsed, input) {
        (Value::Object(parsed_object), Value::Object(input_object)) => Value::Object(
            input_object
                .keys()
                .filter_map(|key| {
                    parsed_object.get(key).map(|value| {
                        let input_value = input_object.get(key).expect("input key exists");
                        (key.clone(), parsed_input_shape(value, input_value))
                    })
                })
                .collect(),
        ),
        (Value::Array(parsed_items), Value::Array(input_items)) => {
            if input_items.is_empty() {
                Value::Array(Vec::new())
            } else if parsed_items.len() == input_items.len() {
                Value::Array(
                    parsed_items
                        .iter()
                        .zip(input_items)
                        .map(|(parsed_item, input_item)| {
                            parsed_input_shape(parsed_item, input_item)
                        })
                        .collect(),
                )
            } else {
                parsed.clone()
            }
        }
        _ => parsed.clone(),
    }
}

#[test]
fn descriptors_match_the_backend_inventory() {
    assert_eq!(SCHEMA_DESCRIPTORS.len(), 80);
    assert_eq!(METHOD_DESCRIPTORS.len(), 38);
    assert_eq!(EVENT_DESCRIPTORS.len(), 3);
    assert_eq!(ENVELOPE_DESCRIPTORS.len(), 1);

    let synthesize = method_by_id("TTS.Synthesize").expect("TTS.Synthesize descriptor");
    assert_eq!(synthesize.bus_topic, "TTS.Synthesize");
    assert_eq!(synthesize.route_path, "/api/TTS/Synthesize");
    assert_eq!(synthesize.required_permissions, &["TTS.Synthesize"]);
    assert_eq!(synthesize.callable_feature_ids, &["speech_synthesis"]);

    for method_id in [
        ids::STT_COORDINATOR_CAPTURE_PREPARE,
        ids::STT_COORDINATOR_CAPTURE_RELEASE,
        ids::STT_COORDINATOR_CAPTURE_STATUS,
    ] {
        let capture = method_by_id(method_id).expect("native capture handoff descriptor");
        assert_eq!(capture.required_permissions, &["STTCoordinator.manage"]);
        assert_eq!(capture.callable_feature_ids, &["listening_session_control"]);
    }

    let audio = event_by_topic("TTS.AudioChunk").expect("TTS.AudioChunk descriptor");
    assert!(audio.bounded);
    assert!(audio.authorized);
    assert!(!audio.remote_raw_audio_route);

    let assistant =
        method_by_id(ids::ORCHESTRATOR_EXTERNAL_USER_INPUT).expect("assistant request descriptor");
    assert_eq!(assistant.route_path, "/api/Orchestrator/ExternalUserInput");
    assert_eq!(assistant.required_permissions, &["Orchestrator.use"]);

    let response =
        event_by_topic(ids::ORCHESTRATOR_RESPONSE).expect("assistant stream event descriptor");
    assert_eq!(
        response.schema_id,
        "Orchestrator.Response.event.AssistantStreamEvent"
    );
    assert_eq!(response.required_permissions, &["Orchestrator.use"]);
    assert_eq!(response.ordered_event_group, Some("assistant_stream"));
    assert!(!response.remote_raw_audio_route);

    let envelope = envelope_by_topic(ids::AURORA_EVENT_STREAM).expect("SSE envelope descriptor");
    assert_eq!(envelope.descriptor_kind, "sse_envelope");
    assert_eq!(envelope.route_path, "/api/events/stream");
    assert_eq!(envelope.required_permissions_broad, &["Gateway.manage"]);
    assert_eq!(envelope.required_permissions_scoped, &["Orchestrator.use"]);
    assert_eq!(
        envelope.scoped_topics,
        &["Orchestrator.Response", "TTS.AudioChunk"]
    );
    assert!(envelope.requires_correlation_id);
}

#[test]
fn typed_generated_id_constants_are_available_to_native_callers() {
    assert_eq!(
        ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
        "Orchestrator.ExternalUserInput"
    );
    assert_eq!(ids::ORCHESTRATOR_INTERRUPT, "Orchestrator.Interrupt");
    assert_eq!(ids::ORCHESTRATOR_INTERRUPTED, "Orchestrator.Interrupted");
    assert_eq!(ids::AURORA_EVENT_STREAM, "Aurora.EventStream");
}

#[test]
fn rust_parser_matches_shared_positive_and_negative_vectors() {
    let source = std::fs::read_to_string(fixture_path()).expect("read parser fixture");
    let fixture: ParseFixture = serde_json::from_str(&source).expect("parse parser fixture");
    assert!(!fixture.vectors.is_empty());
    let mut wrongly_accepted = Vec::new();

    for vector in fixture.vectors {
        let input = vector.input;
        let parsed = normalize_generated_contract(&vector.schema_id, input.clone());
        if vector.accepted {
            let parsed = parsed.unwrap_or_else(|error| {
                panic!("{} rejected a positive vector: {error}", vector.schema_id)
            });
            let expected = vector.normalized.expect("positive vector normalization");
            if vector.marker_paths.is_some() {
                assert_eq!(
                    parsed_input_shape(&parsed, &input),
                    without_empty_default_fields(expected_input_shape(&expected, &input))
                        .expect("marker vector expected shape"),
                    "{} normalized payload",
                    vector.schema_id
                );
            }
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
