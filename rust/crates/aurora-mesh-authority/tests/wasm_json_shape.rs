#![cfg(target_arch = "wasm32")]

use aurora_mesh_authority::wasm::MeshAuthority;
use serde_json::{json, Value};
use wasm_bindgen::prelude::wasm_bindgen;
use wasm_bindgen::JsValue;
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen(inline_js = r#"
    export function parse_plain_json(source) {
        return JSON.parse(source);
    }
"#)]
extern "C" {
    fn parse_plain_json(source: &str) -> JsValue;
}

fn js_value(value: &Value) -> JsValue {
    let json = serde_json::to_string(value).expect("serialize test fixture JSON");
    parse_plain_json(&json)
}

#[wasm_bindgen_test]
fn public_tts_validator_accepts_normal_chunks_and_final_marker() {
    let mut authority = MeshAuthority::new();
    authority
        .validate_tts_audio_chunk(
            "stream-subscription".to_owned(),
            js_value(&json!({
                "stream_id": "stream-1",
                "sequence": 0,
                "is_final": false,
                "audio_data": "YQ==",
                "duration_ms": 1,
                "source_sequence": 0
            })),
            None,
        )
        .expect("accept normal chunk");
    authority
        .validate_tts_audio_chunk(
            "stream-subscription".to_owned(),
            js_value(&json!({
                "stream_id": "stream-1",
                "sequence": 1,
                "is_final": true,
                "audio_data": "",
                "duration_ms": 0
            })),
            None,
        )
        .expect("accept final marker");
}

#[wasm_bindgen_test]
fn public_tts_validator_rejects_wrapped_sequences_without_echoing_payload() {
    let wrappers = [
        json!({ "$serde_json::private::Number": "0" }),
        json!({ "$serde_json::private::Number": "0", "extra": true }),
        json!({ "$serde_json::private::RawValue": "0" }),
        json!({ "nested": [{ "$serde_json::private::Number": "0" }] }),
    ];

    for (index, sequence) in wrappers.into_iter().enumerate() {
        let mut authority = MeshAuthority::new();
        let event = json!({
            "stream_id": format!("wrapped-{index}"),
            "sequence": sequence,
            "is_final": true,
            "audio_data": "",
            "duration_ms": 0
        });
        let error = authority
            .validate_tts_audio_chunk(
                format!("wrapped-subscription-{index}"),
                js_value(&event),
                None,
            )
            .expect_err("wrapped object is not an integer sequence");
        let message = error.as_string().expect("string error");
        assert!(!message.contains("$serde_json::private"));
        assert!(!message.contains("wrapped-"));
    }
}

#[wasm_bindgen_test(async)]
async fn public_authorization_keeps_dynamic_manifest_objects_and_legacy_decisions() {
    let mut authority = MeshAuthority::new();
    let normal = json!({
        "remotePeerId": "remote-probe",
        "methodId": "TTS.AudioChunk",
        "requiredPermissions": [],
        "identity": { "callerPeerId": "caller-probe", "manifestRevision": "1" },
        "nowMs": 0
    });
    let marker_object = json!({
        "remotePeerId": "remote-probe",
        "methodId": "TTS.AudioChunk",
        "requiredPermissions": [],
        "identity": {
            "callerPeerId": "caller-probe",
            "manifestRevision": {
                "$serde_json::private::Number": "1",
                "extra": true
            }
        },
        "nowMs": 0
    });

    for request in [normal, marker_object] {
        let raw = authority
            .authorize(js_value(&request))
            .await
            .expect("decode and evaluate authorization request");
        let decision: Value = serde_wasm_bindgen::from_value(raw).expect("decode decision");
        assert_eq!(decision["allowed"], false);
        assert_eq!(decision["reasonCode"], "peer_not_authenticated");
    }
}

#[wasm_bindgen_test(async)]
async fn public_authorization_parse_errors_are_fixed_and_payload_free() {
    let mut authority = MeshAuthority::new();
    let request = json!({
        "remotePeerId": "remote-probe",
        "methodId": "TTS.AudioChunk",
        "identity": { "callerPeerId": "caller-probe" },
        "nowMs": "private-invalid-time-$serde_json::private::Number"
    });
    let error = authority
        .authorize(js_value(&request))
        .await
        .expect_err("reject malformed typed timestamp");
    assert_eq!(
        error.as_string().as_deref(),
        Some("invalid authorization request")
    );
}
