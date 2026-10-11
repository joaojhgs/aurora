//! Bounded resolver for the currently selected local runtime profile.
//!
//! This extracts only the persisted identity needed to choose local policy
//! storage. It is not a complete runtime-profile sanitizer, package-entitlement
//! check, grant evaluator, or speech-admission decision.

use aurora_voice_engine::json_text::parse_json_value;
use serde_json::Value;
use std::collections::BTreeSet;
use thiserror::Error;

const MAX_RUNTIME_PROFILE_DOCUMENT_BYTES: usize = 128 * 1024;
const MAX_RUNTIME_PROFILE_COUNT: usize = 64;
const MAX_PROFILE_ID_BYTES: usize = 96;
const MAX_STABLE_PEER_ID_BYTES: usize = 160;

/// The persisted identities needed to isolate one selected local node's data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedLocalNodeIdentity {
    /// Canonical ID of the selected profile.
    pub profile_id: String,
    /// Stable identity of the local node in that profile.
    pub stable_peer_id: String,
}

/// Fixed, content-free error for profile selection documents.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("runtime profile selection is invalid")]
pub struct RuntimeProfileSelectionError;

/// Resolve the selected local mesh-node identity from complete persisted JSON.
///
/// Missing documents and supported legacy v1 documents do not select a local
/// namespace. A v2 remote-console selection also has no local namespace. This
/// function checks only bounded document structure, profile identity, and the
/// selected local node ID; it does not reproduce the broader UI sanitizer or
/// decide package entitlement, permissions, or runtime readiness.
pub fn resolve_selected_local_mesh_node(
    document_text: Option<&str>,
) -> Result<Option<SelectedLocalNodeIdentity>, RuntimeProfileSelectionError> {
    let Some(document_text) = document_text else {
        return Ok(None);
    };
    if document_text.len() > MAX_RUNTIME_PROFILE_DOCUMENT_BYTES {
        return Err(RuntimeProfileSelectionError);
    }

    let document = parse_json_value(document_text).map_err(|_| RuntimeProfileSelectionError)?;
    let document = document.as_object().ok_or(RuntimeProfileSelectionError)?;
    match document
        .get("version")
        .and_then(Value::as_u64)
        .ok_or(RuntimeProfileSelectionError)?
    {
        // Legacy state is never adopted into the selected-profile namespace.
        1 => return Ok(None),
        2 => {}
        _ => return Err(RuntimeProfileSelectionError),
    }

    let active_profile_id = match document
        .get("activeProfileId")
        .ok_or(RuntimeProfileSelectionError)?
    {
        Value::Null => None,
        Value::String(value) if is_canonical_id(value, MAX_PROFILE_ID_BYTES) => {
            Some(value.as_str())
        }
        _ => return Err(RuntimeProfileSelectionError),
    };

    let profiles = document
        .get("profiles")
        .and_then(Value::as_array)
        .filter(|profiles| profiles.len() <= MAX_RUNTIME_PROFILE_COUNT)
        .ok_or(RuntimeProfileSelectionError)?;
    let mut profile_ids = BTreeSet::new();
    let mut selected_mode = None;

    for profile in profiles {
        let profile = profile.as_object().ok_or(RuntimeProfileSelectionError)?;
        if profile.get("version").and_then(Value::as_u64) != Some(2) {
            return Err(RuntimeProfileSelectionError);
        }

        let profile_id = profile
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| is_canonical_id(value, MAX_PROFILE_ID_BYTES))
            .ok_or(RuntimeProfileSelectionError)?;
        if !profile_ids.insert(profile_id.to_owned()) {
            return Err(RuntimeProfileSelectionError);
        }

        let mode = profile
            .get("nodeMode")
            .and_then(Value::as_str)
            .ok_or(RuntimeProfileSelectionError)?;
        let tier = profile
            .get("runtimeTier")
            .and_then(Value::as_str)
            .ok_or(RuntimeProfileSelectionError)?;
        match (mode, tier) {
            ("remote-console", "none") => {}
            ("mesh-node", "lightweight-ts" | "python-full") => {}
            _ => return Err(RuntimeProfileSelectionError),
        }

        if active_profile_id == Some(profile_id) {
            selected_mode = Some(mode);
        }
    }

    let Some(active_profile_id) = active_profile_id else {
        return Ok(None);
    };
    let selected_mode = selected_mode.ok_or(RuntimeProfileSelectionError)?;
    if selected_mode == "remote-console" {
        return Ok(None);
    }

    let selected_profile = profiles
        .iter()
        .find(|profile| profile.get("id").and_then(Value::as_str) == Some(active_profile_id))
        .and_then(Value::as_object)
        .ok_or(RuntimeProfileSelectionError)?;
    let stable_peer_id = selected_profile
        .get("localNode")
        .and_then(Value::as_object)
        .and_then(|local_node| local_node.get("stablePeerId"))
        .and_then(Value::as_str)
        .filter(|value| is_canonical_id(value, MAX_STABLE_PEER_ID_BYTES))
        .ok_or(RuntimeProfileSelectionError)?;

    Ok(Some(SelectedLocalNodeIdentity {
        profile_id: active_profile_id.to_owned(),
        stable_peer_id: stable_peer_id.to_owned(),
    }))
}

fn is_canonical_id(value: &str, max_bytes: usize) -> bool {
    aurora_contracts::runtime_profile_text::is_canonical_profile_text(value, max_bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_selected_local_mesh_node, RuntimeProfileSelectionError, SelectedLocalNodeIdentity,
    };
    use serde_json::{json, Value};

    fn mesh_profile(id: Value, stable_peer_id: Value) -> Value {
        json!({
            "version": 2,
            "id": id,
            "nodeMode": "mesh-node",
            "runtimeTier": "lightweight-ts",
            "label": "Display name is not identity",
            "localNode": {
                "stablePeerId": stable_peer_id,
                "nodeName": "Renamable label"
            }
        })
    }

    fn remote_profile(id: &str) -> Value {
        json!({
            "version": 2,
            "id": id,
            "nodeMode": "remote-console",
            "runtimeTier": "none"
        })
    }

    fn document(active_profile_id: Value, profiles: Vec<Value>) -> String {
        json!({
            "version": 2,
            "activeProfileId": active_profile_id,
            "profiles": profiles
        })
        .to_string()
    }

    fn selected(profile_id: &str, stable_peer_id: &str) -> SelectedLocalNodeIdentity {
        SelectedLocalNodeIdentity {
            profile_id: profile_id.to_owned(),
            stable_peer_id: stable_peer_id.to_owned(),
        }
    }

    fn selection_error(input: &str) -> RuntimeProfileSelectionError {
        resolve_selected_local_mesh_node(Some(input)).expect_err("invalid profile selection")
    }

    #[test]
    fn non_ecmascript_trim_characters_remain_identity_data() {
        for character in ['\u{0085}', '\u{001c}', '\u{180e}', '\u{200b}'] {
            let id = format!("{character}profile-a{character}");
            let peer = format!("{character}stable-a{character}");
            let input = document(json!(id), vec![mesh_profile(json!(id), json!(peer))]);
            assert_eq!(
                resolve_selected_local_mesh_node(Some(&input)),
                Ok(Some(selected(&id, &peer)))
            );
        }
    }

    #[test]
    fn missing_legacy_null_and_remote_profiles_have_no_local_namespace() {
        assert_eq!(resolve_selected_local_mesh_node(None), Ok(None));
        assert_eq!(
            resolve_selected_local_mesh_node(Some(
                r#"{"version":1,"activeProfileId":"legacy","profiles":[]}"#
            )),
            Ok(None)
        );
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&document(
                Value::Null,
                vec![mesh_profile(json!("node-a"), json!("stable-a"))]
            ))),
            Ok(None)
        );
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&document(
                json!("remote-a"),
                vec![remote_profile("remote-a")]
            ))),
            Ok(None)
        );
    }

    #[test]
    fn active_mesh_node_resolves_only_persisted_profile_and_stable_node_ids() {
        let profile = mesh_profile(json!("profile-a"), json!("stable-a"));
        let input = document(json!("profile-a"), vec![profile]);
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&input)),
            Ok(Some(selected("profile-a", "stable-a")))
        );

        let renamed = json!({
            "version": 2,
            "id": "profile-a",
            "nodeMode": "mesh-node",
            "runtimeTier": "python-full",
            "label": "A different display label",
            "localNode": {"stablePeerId": "stable-a", "nodeName": "A renamed node"}
        });
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&document(json!("profile-a"), vec![renamed]))),
            Ok(Some(selected("profile-a", "stable-a")))
        );
    }

    #[test]
    fn selection_ids_follow_canonical_trimmed_utf8_byte_limits() {
        for (profile_id, stable_peer_id) in [
            ("".to_owned(), "stable-a".to_owned()),
            (" profile-a".to_owned(), "stable-a".to_owned()),
            ("profile-a ".to_owned(), "stable-a".to_owned()),
            ("\u{feff}profile-a".to_owned(), "stable-a".to_owned()),
            ("profile-a\u{feff}".to_owned(), "stable-a".to_owned()),
            ("profile-a".to_owned(), "".to_owned()),
            ("profile-a".to_owned(), " stable-a".to_owned()),
            ("profile-a".to_owned(), "stable-a ".to_owned()),
            ("profile-a".to_owned(), "\u{feff}stable-a".to_owned()),
            ("profile-a".to_owned(), "stable-a\u{feff}".to_owned()),
            ("p".repeat(97), "stable-a".to_owned()),
            ("profile-a".to_owned(), "s".repeat(161)),
            ("é".repeat(49), "stable-a".to_owned()),
            ("profile-a".to_owned(), "é".repeat(81)),
            ("😀".repeat(25), "stable-a".to_owned()),
            ("profile-a".to_owned(), "😀".repeat(41)),
        ] {
            let input = document(
                json!(profile_id),
                vec![mesh_profile(json!(profile_id), json!(stable_peer_id))],
            );
            assert_eq!(selection_error(&input), RuntimeProfileSelectionError);
        }

        let profile_id = "é".repeat(48);
        let stable_peer_id = "é".repeat(80);
        let input = document(
            json!(profile_id),
            vec![mesh_profile(
                json!(profile_id),
                json!(stable_peer_id.clone()),
            )],
        );
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&input)),
            Ok(Some(selected(&profile_id, &stable_peer_id)))
        );

        let profile_id = "profile\u{feff}a";
        let stable_peer_id = "stable\u{feff}a";
        let input = document(
            json!(profile_id),
            vec![mesh_profile(json!(profile_id), json!(stable_peer_id))],
        );
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&input)),
            Ok(Some(selected(profile_id, stable_peer_id)))
        );

        let profile_id = "😀".repeat(24);
        let stable_peer_id = "😀".repeat(40);
        let input = document(
            json!(profile_id),
            vec![mesh_profile(
                json!(profile_id),
                json!(stable_peer_id.clone()),
            )],
        );
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&input)),
            Ok(Some(selected(&profile_id, &stable_peer_id)))
        );
    }

    #[test]
    fn malformed_documents_duplicates_and_missing_active_profiles_fail_closed() {
        assert_eq!(selection_error("{"), RuntimeProfileSelectionError);
        assert_eq!(
            selection_error(&document(
                json!("missing"),
                vec![mesh_profile(json!("profile-a"), json!("stable-a"))]
            )),
            RuntimeProfileSelectionError
        );
        assert_eq!(
            selection_error(&document(
                json!("profile-a"),
                vec![
                    mesh_profile(json!("profile-a"), json!("stable-a")),
                    mesh_profile(json!("profile-a"), json!("stable-b"))
                ]
            )),
            RuntimeProfileSelectionError
        );
        assert_eq!(
            selection_error(
                r#"{"version":2,"profiles":[{"version":2,"id":"profile-a","nodeMode":"mesh-node","runtimeTier":"lightweight-ts","localNode":{"stablePeerId":"stable-a"}}]}"#
            ),
            RuntimeProfileSelectionError
        );
        assert_eq!(
            selection_error(&document(
                json!("profile-a"),
                vec![json!({
                    "version": 2,
                    "id": "profile-a",
                    "nodeMode": "mesh-node",
                    "runtimeTier": "lightweight-ts"
                })]
            )),
            RuntimeProfileSelectionError
        );

        let too_many_profiles = (0..65)
            .map(|index| mesh_profile(json!(format!("profile-{index}")), json!("stable-a")))
            .collect();
        assert_eq!(
            selection_error(&document(json!(null), too_many_profiles)),
            RuntimeProfileSelectionError
        );
        assert_eq!(
            selection_error(&format!("{}{}", " ".repeat(128 * 1024), " ")),
            RuntimeProfileSelectionError
        );
    }

    #[test]
    fn exact_profile_count_and_document_byte_boundaries_are_accepted() {
        let profiles = (0..64)
            .map(|index| mesh_profile(json!(format!("profile-{index}")), json!("stable-a")))
            .collect();
        assert!(
            resolve_selected_local_mesh_node(Some(&document(json!("profile-0"), profiles)))
                .expect("exact profile-count boundary")
                .is_some()
        );

        let mut exact_size = json!({
            "version": 2,
            "activeProfileId": "profile-a",
            "profiles": [mesh_profile(json!("profile-a"), json!("stable-a"))],
            "padding": ""
        });
        let initial = exact_size.to_string();
        let padding_len = 128 * 1024 - initial.len();
        exact_size["padding"] = json!("x".repeat(padding_len));
        let exact_size_text = exact_size.to_string();
        assert_eq!(exact_size_text.len(), 128 * 1024);
        assert_eq!(
            resolve_selected_local_mesh_node(Some(&exact_size_text)),
            Ok(Some(selected("profile-a", "stable-a")))
        );
    }

    #[test]
    fn unsupported_versions_modes_and_tier_contradictions_fail_closed() {
        for input in [
            r#"{"version":3,"activeProfileId":null,"profiles":[]}"#.to_owned(),
            r#"{"version":1.0,"activeProfileId":null,"profiles":[]}"#.to_owned(),
            r#"{"version":2,"activeProfileId":"profile-a","profiles":[{"version":{"$serde_json::private::Number":"2"},"id":"profile-a","nodeMode":"mesh-node","runtimeTier":"lightweight-ts","localNode":{"stablePeerId":"stable-a"}}]}"#.to_owned(),
            document(
                json!("profile-a"),
                vec![json!({
                    "version": 1,
                    "id": "profile-a",
                    "nodeMode": "mesh-node",
                    "runtimeTier": "lightweight-ts",
                    "localNode": {"stablePeerId": "stable-a"}
                })],
            ),
            document(
                json!("profile-a"),
                vec![json!({
                    "version": 2,
                    "id": "profile-a",
                    "nodeMode": "mesh-node",
                    "runtimeTier": "unsupported-tier",
                    "localNode": {"stablePeerId": "stable-a"}
                })],
            ),
            document(
                json!("profile-a"),
                vec![json!({
                    "version": 2,
                    "id": "profile-a",
                    "nodeMode": "unknown-mode",
                    "runtimeTier": "lightweight-ts",
                    "localNode": {"stablePeerId": "stable-a"}
                })],
            ),
            document(
                json!("profile-a"),
                vec![json!({
                    "version": 2,
                    "id": "profile-a",
                    "nodeMode": "mesh-node",
                    "runtimeTier": "none",
                    "localNode": {"stablePeerId": "stable-a"}
                })],
            ),
            document(
                json!("profile-a"),
                vec![json!({
                    "version": 2,
                    "id": "profile-a",
                    "nodeMode": "remote-console",
                    "runtimeTier": "lightweight-ts"
                })],
            ),
        ] {
            assert_eq!(selection_error(&input), RuntimeProfileSelectionError);
        }
    }

    #[test]
    fn serde_private_marker_objects_are_not_selection_scalars() {
        let marker = |name: &str, value: &str| json!({(name): value});
        let cases = [
            json!({"version": marker("$serde_json::private::Number", "2"), "activeProfileId": null, "profiles": []}),
            json!({"version": 2, "activeProfileId": marker("$serde_json::private::RawValue", "\"profile-a\""), "profiles": []}),
            json!({"version": 2, "activeProfileId": "profile-a", "profiles": [mesh_profile(marker("$serde_json::private::Number", "1"), json!("stable-a"))]}),
            json!({"version": 2, "activeProfileId": "profile-a", "profiles": [json!({"version": 2, "id": "profile-a", "nodeMode": marker("$serde_json::private::RawValue", "\"mesh-node\""), "runtimeTier": "lightweight-ts", "localNode": {"stablePeerId": "stable-a"}})]}),
            json!({"version": 2, "activeProfileId": "profile-a", "profiles": [json!({"version": 2, "id": "profile-a", "nodeMode": "mesh-node", "runtimeTier": marker("$serde_json::private::RawValue", "\"lightweight-ts\""), "localNode": {"stablePeerId": "stable-a"}})]}),
            json!({"version": 2, "activeProfileId": "profile-a", "profiles": [json!({"version": 2, "id": "profile-a", "nodeMode": "mesh-node", "runtimeTier": "lightweight-ts", "localNode": {"stablePeerId": marker("$serde_json::private::Number", "1")}})]}),
        ];
        for value in cases {
            let input = serde_json::to_string(&value).expect("marker document JSON");
            assert_eq!(selection_error(&input), RuntimeProfileSelectionError);
        }
    }

    #[test]
    fn selection_errors_are_fixed_and_do_not_include_document_or_identity_text() {
        let secret = "private-profile-id-not-for-errors";
        let input = document(
            json!("missing"),
            vec![mesh_profile(json!(secret), json!("stable-secret"))],
        );
        let error = selection_error(&input).to_string();
        assert_eq!(error, "runtime profile selection is invalid");
        assert!(!error.contains(secret));
        assert!(!error.contains("stable-secret"));
    }
}
