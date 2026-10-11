use std::collections::BTreeMap;

use aurora_voice_core::json_text::parse_json_value;
use serde::Deserialize;
use serde_json::Value;

/// The fields consumed by the generic Gateway request command.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuroraRequest {
    pub(super) method: String,
    pub(super) path: Option<String>,
    pub(super) http_method: Option<String>,
    pub(super) payload: Option<Value>,
    pub(super) headers: Option<BTreeMap<String, String>>,
}

/// Content-free failure returned for malformed generic request text.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Invalid request")]
pub(super) struct RequestJsonError;

/// Decode the text-only generic request while keeping its opaque payload intact.
pub(super) fn parse_aurora_request(request_json: &str) -> Result<AuroraRequest, RequestJsonError> {
    let mut value = parse_json_value(request_json).map_err(|_| RequestJsonError)?;
    let object = value.as_object_mut().ok_or(RequestJsonError)?;
    let payload = object
        .remove("payload")
        .filter(|payload| !payload.is_null());

    let mut request: AuroraRequest = serde_json::from_value(value).map_err(|_| RequestJsonError)?;
    request.payload = payload;
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::{parse_aurora_request, RequestJsonError};
    use serde_json::json;

    #[test]
    fn keeps_nested_marker_objects_and_escaped_keys_as_ordinary_payload_values() {
        let literal = parse_aurora_request(
            r#"{"method":"Gateway.Call","payload":{"nested":{"number":{"$serde_json::private::Number":"7"},"raw":{"$serde_json::private::RawValue":"not-json"}}}}"#,
        )
        .expect("literal marker payload should decode");
        assert_eq!(
            literal.payload,
            Some(json!({
                "nested": {
                    "number": { "$serde_json::private::Number": "7" },
                    "raw": { "$serde_json::private::RawValue": "not-json" }
                }
            }))
        );

        let escaped = parse_aurora_request(
            r#"{"method":"Gateway.Call","payload":{"nested":{"$serde_json\u003a\u003aprivate\u003a\u003aNumber":"8","raw":{"$serde_json\u003a\u003aprivate\u003a\u003aRawValue":"{bad"}}}}"#,
        )
        .expect("escaped marker keys should decode as ordinary strings");
        assert_eq!(
            escaped.payload,
            Some(json!({
                "nested": {
                    "$serde_json::private::Number": "8",
                    "raw": { "$serde_json::private::RawValue": "{bad" }
                }
            }))
        );
    }

    #[test]
    fn preserves_non_null_scalar_and_array_payloads() {
        let cases = [
            (r#""plain text""#, json!("plain text")),
            ("17", json!(17)),
            ("false", json!(false)),
            ("[null,\"item\",2]", json!([null, "item", 2])),
        ];

        for (payload_text, expected) in cases {
            let request_json = format!(r#"{{"method":"Gateway.Call","payload":{payload_text}}}"#);
            let request = parse_aurora_request(&request_json).expect("valid payload should decode");
            assert_eq!(request.payload, Some(expected));
        }
    }

    #[test]
    fn treats_missing_and_null_payload_as_absent() {
        let missing =
            parse_aurora_request(r#"{"method":"Gateway.Call"}"#).expect("payload may be omitted");
        let null = parse_aurora_request(r#"{"method":"Gateway.Call","payload":null}"#)
            .expect("null payload retains the existing absent behavior");

        assert!(missing.payload.is_none());
        assert!(null.payload.is_none());
    }

    #[test]
    fn parses_existing_typed_fields_and_ignores_additional_fields() {
        let request = parse_aurora_request(
            r#"{"method":"Gateway.Call","path":"/api/call","httpMethod":"PATCH","headers":{"x-client":"webview"},"payload":{"ok":true},"additional":{"ignored":true}}"#,
        )
        .expect("the existing request fields remain accepted");

        assert_eq!(request.method, "Gateway.Call");
        assert_eq!(request.path.as_deref(), Some("/api/call"));
        assert_eq!(request.http_method.as_deref(), Some("PATCH"));
        assert_eq!(
            request
                .headers
                .as_ref()
                .and_then(|headers| headers.get("x-client"))
                .map(String::as_str),
            Some("webview")
        );
        assert_eq!(request.payload, Some(json!({ "ok": true })));
    }

    #[test]
    fn retains_last_key_wins_for_typed_and_opaque_fields() {
        let request = parse_aurora_request(
            r#"{"method":"Gateway.Old","method":"Gateway.New","payload":{"$serde_json::private::RawValue":"first"},"payload":{"winner":true}}"#,
        )
        .expect("duplicate JSON keys keep the decoder's last-key-wins behavior");

        assert_eq!(request.method, "Gateway.New");
        assert_eq!(request.payload, Some(json!({ "winner": true })));
    }

    #[test]
    fn rejects_invalid_json_shapes_and_typed_fields_with_one_fixed_error() {
        let invalid = [
            "not-json",
            "[]",
            "null",
            r#"{"payload":1}"#,
            r#"{"method":3}"#,
            r#"{"method":"Gateway.Call","headers":{"x-test":1}}"#,
        ];

        for input in invalid {
            let error = parse_aurora_request(input).expect_err("invalid request must be rejected");
            assert_eq!(error, RequestJsonError);
            assert_eq!(error.to_string(), "Invalid request");
            assert!(!format!("{error:?}").contains(input));
        }
    }

    #[test]
    fn enforces_the_shared_root_inclusive_depth_limit() {
        let nested = |count: usize| format!("{}null{}", "[".repeat(count), "]".repeat(count));
        let accepted = format!(r#"{{"method":"Gateway.Call","payload":{}}}"#, nested(126));
        let rejected = format!(r#"{{"method":"Gateway.Call","payload":{}}}"#, nested(127));

        assert!(parse_aurora_request(&accepted).is_ok());
        assert!(matches!(
            parse_aurora_request(&rejected),
            Err(RequestJsonError)
        ));
    }

    #[test]
    fn ignores_unknown_fields_without_reinterpreting_marker_shaped_values() {
        let request = parse_aurora_request(
            r#"{"method":"Gateway.Call","unknown":{"$serde_json::private::Number":"1"},"payload":{"ok":true}}"#,
        )
        .expect("unknown fields remain ignored");

        assert_eq!(request.method, "Gateway.Call");
        assert_eq!(request.payload, Some(json!({ "ok": true })));
    }
}
