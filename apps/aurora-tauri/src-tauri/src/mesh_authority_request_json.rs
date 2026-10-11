//! Bounded, shape-preserving decode for the native authorization command.

use aurora_mesh_authority::types::PeerHostAuthorizeRequest;
use serde_json::Value;

const MAX_AUTHORIZATION_REQUEST_BYTES: usize = 65_536;
const INVALID_AUTHORIZATION_REQUEST: &str = "Invalid authorization request";

/// Decode the text-only Tauri authorization argument before acquiring authority state.
pub(super) fn parse_authorize_request_json(
    request_json: &str,
) -> Result<PeerHostAuthorizeRequest, String> {
    if request_json.len() > MAX_AUTHORIZATION_REQUEST_BYTES {
        return Err(INVALID_AUTHORIZATION_REQUEST.to_owned());
    }

    let mut value = aurora_voice_core::json_text::parse_json_value(request_json)
        .map_err(|_| INVALID_AUTHORIZATION_REQUEST.to_owned())?;
    let request = value
        .as_object_mut()
        .ok_or_else(|| INVALID_AUTHORIZATION_REQUEST.to_owned())?;
    let identity = request
        .get_mut("identity")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| INVALID_AUTHORIZATION_REQUEST.to_owned())?;
    let manifest_revision = match identity.remove("manifestRevision") {
        None | Some(Value::Null) => None,
        Some(value @ Value::String(_)) | Some(value @ Value::Number(_)) => Some(value),
        Some(_) => return Err(INVALID_AUTHORIZATION_REQUEST.to_owned()),
    };

    let mut request: PeerHostAuthorizeRequest =
        serde_json::from_value(value).map_err(|_| INVALID_AUTHORIZATION_REQUEST.to_owned())?;
    request.identity.manifest_revision = manifest_revision;
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_authorize_request_json, INVALID_AUTHORIZATION_REQUEST,
        MAX_AUTHORIZATION_REQUEST_BYTES,
    };
    use aurora_mesh_authority::types::PeerHostAuthorizeRequest;

    fn request_wire(manifest_revision: &str) -> String {
        format!(
            r#"{{
                "remotePeerId":"peer-a",
                "methodId":"Tooling.GetTools",
                "requiredPermissions":[],
                "identity":{{"callerPeerId":"peer-a","effectivePermissions":[],"manifestRevision":{manifest_revision}}},
                "authenticatedPeerContext":{{
                    "selector":{{"tokenId":"token-a","claimantPeerId":"peer-a","verifierPeerId":"peer-host","roomName":"lab-room"}},
                    "transport":{{"channelBinding":"{}","claimantSignalingPeerId":"sig-a","verifierSignalingPeerId":"sig-host"}},
                    "credentialRevision":1,
                    "authenticatedAtMs":500
                }},
                "nowMs":2000
            }}"#,
            "b".repeat(64)
        )
    }

    fn invalid(request_json: &str) {
        assert_eq!(
            parse_authorize_request_json(request_json).expect_err("request must be rejected"),
            INVALID_AUTHORIZATION_REQUEST
        );
    }

    #[test]
    fn preserves_typed_request_and_valid_scalar_revision() {
        let request = parse_authorize_request_json(&request_wire(r#""manifest-7""#))
            .expect("valid typed authorization request");
        assert_eq!(request.remote_peer_id, "peer-a");
        assert_eq!(request.method_id, "Tooling.GetTools");
        assert_eq!(request.required_permissions, Vec::<String>::new());
        assert_eq!(request.identity.caller_peer_id, "peer-a");
        assert_eq!(
            request.identity.manifest_revision,
            Some(serde_json::json!("manifest-7"))
        );
        assert_eq!(
            request
                .authenticated_peer_context
                .expect("context is preserved")
                .selector
                .claimant_peer_id,
            "peer-a"
        );
        assert_eq!(request.now_ms, 2_000);

        let numeric = parse_authorize_request_json(&request_wire("7"))
            .expect("numeric revision remains valid");
        assert_eq!(
            numeric.identity.manifest_revision,
            Some(serde_json::json!(7))
        );
    }

    #[test]
    fn absent_null_and_marker_looking_text_revisions_are_valid() {
        let mut absent = request_wire("null");
        absent = absent.replace(r#","manifestRevision":null"#, "");
        assert!(!absent.contains("manifestRevision"));
        let absent: PeerHostAuthorizeRequest =
            parse_authorize_request_json(&absent).expect("absent revision is valid");
        assert_eq!(absent.identity.manifest_revision, None);

        let null =
            parse_authorize_request_json(&request_wire("null")).expect("null revision is valid");
        assert_eq!(null.identity.manifest_revision, None);

        let text = request_wire(r#""$serde_json::private::Number""#);
        let text = parse_authorize_request_json(&text)
            .expect("ordinary marker-looking text is still a string");
        assert_eq!(
            text.identity.manifest_revision,
            Some(serde_json::json!("$serde_json::private::Number"))
        );
    }

    #[test]
    fn rejects_marker_objects_and_non_scalar_revision_shapes() {
        for marker in ["Number", "RawValue"] {
            let literal = format!(r#"{{"$serde_json::private::{marker}":"7"}}"#);
            invalid(&request_wire(&literal));

            let escaped =
                format!(r#"{{"$serde_json\u003a\u003aprivate\u003a\u003a{marker}":"7"}}"#);
            invalid(&request_wire(&escaped));
        }
        for value in ["{}", "[]", "true", "false"] {
            invalid(&request_wire(value));
        }
    }

    #[test]
    fn rejects_malformed_and_typed_invalid_requests_without_echoing_input() {
        for input in ["{", "[]", "null", "{}"] {
            assert_eq!(
                parse_authorize_request_json(input).expect_err("invalid request"),
                INVALID_AUTHORIZATION_REQUEST
            );
        }
        let invalid_typed = request_wire("null").replace("\"nowMs\":2000", "\"nowMs\":\"secret\"");
        assert_eq!(
            parse_authorize_request_json(&invalid_typed)
                .expect_err("typed field mismatch is rejected"),
            INVALID_AUTHORIZATION_REQUEST
        );
    }

    #[test]
    fn enforces_utf8_byte_limit_at_exact_boundary() {
        let base = request_wire("null");
        let exact = format!(
            "{base}{}",
            " ".repeat(MAX_AUTHORIZATION_REQUEST_BYTES - base.len())
        );
        assert_eq!(exact.len(), MAX_AUTHORIZATION_REQUEST_BYTES);
        assert!(parse_authorize_request_json(&exact).is_ok());

        let oversized = format!("{exact} ");
        assert_eq!(
            parse_authorize_request_json(&oversized)
                .expect_err("one byte over the limit is rejected"),
            INVALID_AUTHORIZATION_REQUEST
        );
    }

    #[test]
    fn counts_multibyte_utf8_bytes_for_the_limit() {
        let prefix = request_wire("null");
        let without_method = prefix.replace("Tooling.GetTools", "");
        let remaining_bytes = MAX_AUTHORIZATION_REQUEST_BYTES - without_method.len();
        let method = "é".repeat(remaining_bytes / 2 + 1);
        let wire = prefix.replace("Tooling.GetTools", &method);
        assert_eq!(wire.len(), without_method.len() + method.len());
        assert!(wire.len() > MAX_AUTHORIZATION_REQUEST_BYTES);
        assert_eq!(
            parse_authorize_request_json(&wire)
                .expect_err("UTF-8 bytes, not characters, are bounded"),
            INVALID_AUTHORIZATION_REQUEST
        );
    }
}
