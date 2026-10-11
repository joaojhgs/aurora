//! Native-only admission and archive writes for Android background transcription.
//!
//! The service receives an opaque capability and ciphertext only. Selected
//! profile identity and recording policy always come from the native coordinator.

use crate::local_data_native::{LocalDataCommandState, NativeTranscriptArchiveWrite};
use crate::native_node_config::NativeNodeConfigRuntime;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const MAX_ACTIVE_TRANSCRIPTIONS: usize = 1;
const MAX_TRANSCRIPT_CHARS: usize = 16_384;

#[derive(Clone)]
struct Authority {
    app: AppHandle,
    runtime: NativeNodeConfigRuntime,
    local_data: LocalDataCommandState,
}

#[derive(Clone)]
struct AdmittedCapture {
    token: String,
    profile_id: String,
    local_node_id: String,
    session_id: String,
    profile_generation: u64,
    next_capture_generation: u64,
    active_capture_generation: Option<u64>,
    capture_mode: String,
    next_sequence: i64,
    previous_end_ms: i64,
}

#[derive(Default)]
struct Registry {
    authority: Option<Authority>,
    captures: HashMap<String, AdmittedCapture>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static NEXT_CAPTURE_GENERATION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn install(
    app: AppHandle,
    runtime: NativeNodeConfigRuntime,
    local_data: LocalDataCommandState,
) {
    if let Ok(mut registry) = REGISTRY
        .get_or_init(|| Mutex::new(Registry::default()))
        .lock()
    {
        registry.authority = Some(Authority {
            app,
            runtime,
            local_data,
        });
    }
}

/// Creates a durable session only after re-reading the current native policy.
/// The mode comes from the notification/manual or automatic service path; a
/// caller cannot provide a selected profile or namespace.
pub(crate) fn admit_capture(mode: &str) -> Result<String, String> {
    if !matches!(mode, "ambient" | "notification") {
        return Err("transcription_unavailable".to_owned());
    }
    let authority = authority()?;
    tauri::async_runtime::block_on(async move {
        let (_profile_guard, generation, policy, profile_document) = authority
            .runtime
            .transcription_admission_snapshot()
            .await
            .map_err(|_| "transcription_unavailable".to_owned())?;
        if !policy.background_transcription.enabled
            || match mode {
                "ambient" => !policy.background_transcription.ambient,
                "notification" => {
                    !policy.background_transcription.notification
                        || policy.background_transcription.ambient
                }
                _ => true,
            }
        {
            return Err("transcription_policy_disabled".to_owned());
        }
        let identity = aurora_voice_native::node_config_profile::resolve_selected_local_mesh_node(
            Some(&profile_document),
        )
        .map_err(|_| "transcription_profile_unavailable".to_owned())?
        .ok_or_else(|| "transcription_profile_unavailable".to_owned())?;
        let stages = &policy.speech.stages.stt;
        let (provider, model_id) = match &stages.routing.prefer {
            aurora_voice_core::node_policy::RoutingPreference::Local
            | aurora_voice_core::node_policy::RoutingPreference::LocalOnly => {
                (Some("local"), nullable_string(&stages.model_id))
            }
            aurora_voice_core::node_policy::RoutingPreference::Network
            | aurora_voice_core::node_policy::RoutingPreference::NetworkOnly => {
                (Some("gateway"), nullable_string(&stages.model_id))
            }
        };
        let now = now_ms();
        let retention = policy.background_transcription.retention_days.min(3650);
        let expires_at_ms = now.saturating_add(
            i64::try_from(retention)
                .unwrap_or(3650)
                .saturating_mul(24 * 60 * 60 * 1000),
        );
        let session_id = random_id()?;
        let token = random_id()?;
        let next_capture_generation = NEXT_CAPTURE_GENERATION.fetch_add(1, Ordering::Relaxed);
        if next_capture_generation == u64::MAX {
            return Err("transcription_unavailable".to_owned());
        }
        let language = nullable_string(&stages.language)
            .or_else(|| nullable_string(&policy.background_transcription.language));
        let mut registry = registry_lock()?;
        if registry.captures.len() >= MAX_ACTIVE_TRANSCRIPTIONS {
            return Err("transcription_capture_busy".to_owned());
        }
        let record = json!({
            "id": session_id,
            "profileId": identity.profile_id,
            "localNodeId": identity.stable_peer_id,
            "captureMode": mode,
            "createdAtMs": now,
            "startedAtMs": now,
            "endedAtMs": null,
            "lifecycle": "active",
            "terminalReason": null,
            "expiresAtMs": expires_at_ms,
            "language": language,
            "modelProvenance": { "provider": null, "modelId": null, "version": null },
            "diarizationState": "not_requested"
        });
        let write = serde_json::from_value::<NativeTranscriptArchiveWrite>(json!({
            "kind": "createSession",
            "record": record
        }))
        .map_err(|_| "transcription_archive_unavailable".to_owned())?;
        authority
            .local_data
            .native_transcript_write(
                &authority.app,
                &identity.profile_id,
                &identity.stable_peer_id,
                write,
            )
            .map_err(|_| "transcription_archive_unavailable".to_owned())?;
        registry.captures.insert(
            token.clone(),
            AdmittedCapture {
                token: token.clone(),
                profile_id: identity.profile_id.clone(),
                local_node_id: identity.stable_peer_id.clone(),
                session_id: session_id.clone(),
                profile_generation: generation,
                next_capture_generation,
                active_capture_generation: None,
                capture_mode: mode.to_owned(),
                next_sequence: 0,
                previous_end_ms: now,
            },
        );
        Ok(json!({
            "token": token,
            "profileId": identity.profile_id,
            "localNodeId": identity.stable_peer_id,
            "sessionId": session_id,
            "profileGeneration": generation,
            "captureMode": mode,
            "language": language,
            "preferredProvider": provider,
            "preferredModelId": model_id,
            "startedAtMs": now,
            "expiresAtMs": expires_at_ms,
            "policyRevision": policy.revision,
            "speechStagesJson": serde_json::to_string(&policy.speech.stages)
                .map_err(|_| "transcription_policy_unavailable".to_owned())?,
            "confirmedProfileDocumentJson": profile_document
        })
        .to_string())
    })
}

pub(crate) fn start_capture(token: &str) -> Result<u64, String> {
    let authority = authority()?;
    let admitted = capture(token)?;
    tauri::async_runtime::block_on(async {
        let (_guard, generation, policy, document) = authority
            .runtime
            .transcription_admission_snapshot()
            .await
            .map_err(|_| "transcription_policy_unavailable".to_owned())?;
        let identity = aurora_voice_native::node_config_profile::resolve_selected_local_mesh_node(
            Some(&document),
        )
        .map_err(|_| "transcription_profile_unavailable".to_owned())?
        .ok_or_else(|| "transcription_profile_unavailable".to_owned())?;
        if generation != admitted.profile_generation
            || identity.profile_id != admitted.profile_id
            || identity.stable_peer_id != admitted.local_node_id
            || !policy.background_transcription.enabled
            || match admitted.capture_mode.as_str() {
                "ambient" => !policy.background_transcription.ambient,
                "notification" => {
                    !policy.background_transcription.notification
                        || policy.background_transcription.ambient
                }
                _ => true,
            }
        {
            return Err("transcription_policy_disabled".to_owned());
        }
        let mut registry = registry_lock()?;
        let capture = registry
            .captures
            .get_mut(token)
            .ok_or_else(|| "transcription_admission_expired".to_owned())?;
        if capture.active_capture_generation.is_some() {
            return Err("transcription_capture_busy".to_owned());
        }
        let generation = capture.next_capture_generation;
        capture.next_capture_generation = NEXT_CAPTURE_GENERATION.fetch_add(1, Ordering::Relaxed);
        capture.active_capture_generation = Some(generation);
        Ok::<u64, String>(generation)
    })
}

pub(crate) fn finish_capture_interval(token: &str, generation: u64) -> Result<(), String> {
    let mut registry = registry_lock()?;
    let capture = registry
        .captures
        .get_mut(token)
        .ok_or_else(|| "transcription_admission_expired".to_owned())?;
    if capture.active_capture_generation != Some(generation) {
        return Err("transcription_capture_stale".to_owned());
    }
    capture.active_capture_generation = None;
    Ok(())
}

/// Appends an encrypted segment under the exact admitted profile and session.
/// No caller-supplied profile/session identity is accepted.
pub(crate) fn append_result(
    token: &str,
    capture_generation: u64,
    segment_id: &str,
    sequence: i64,
    start_ms: i64,
    end_ms: i64,
    envelope_json: &str,
    microphone_permission_granted: bool,
) -> Result<bool, String> {
    if segment_id.is_empty()
        || segment_id.len() > 96
        || !segment_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.'))
        || envelope_json.len() > MAX_TRANSCRIPT_CHARS * 4
        || start_ms < 0
        || end_ms < start_ms
    {
        return Err("transcription_result_invalid".to_owned());
    }
    if !microphone_permission_granted {
        finish_capture_interval(token, capture_generation)?;
        finalize_capture(token, "interrupted", "microphone_permission_revoked")?;
        return Ok(false);
    }
    let authority = authority()?;
    let admitted = capture(token)?;
    tauri::async_runtime::block_on(async move {
        let (_guard, generation, policy, document) = authority
            .runtime
            .transcription_admission_snapshot()
            .await
            .map_err(|_| "transcription_policy_unavailable".to_owned())?;
        if generation != admitted.profile_generation
            || !authority.runtime.profile_generation_is_current(generation)
        {
            return Err("transcription_profile_changed".to_owned());
        }
        if !policy.background_transcription.enabled
            || match admitted.capture_mode.as_str() {
                "ambient" => !policy.background_transcription.ambient,
                "notification" => {
                    !policy.background_transcription.notification
                        || policy.background_transcription.ambient
                }
                _ => true,
            }
        {
            return Err("transcription_policy_disabled".to_owned());
        }
        let identity = aurora_voice_native::node_config_profile::resolve_selected_local_mesh_node(
            Some(&document),
        )
        .map_err(|_| "transcription_profile_unavailable".to_owned())?
        .ok_or_else(|| "transcription_profile_unavailable".to_owned())?;
        if identity.profile_id != admitted.profile_id
            || identity.stable_peer_id != admitted.local_node_id
        {
            return Err("transcription_profile_changed".to_owned());
        }
        let mut registry = registry_lock()?;
        let current = registry
            .captures
            .get_mut(token)
            .ok_or_else(|| "transcription_admission_expired".to_owned())?;
        if current.active_capture_generation != Some(capture_generation)
            || current.next_sequence != sequence
            || start_ms < current.previous_end_ms
        {
            return Err("transcription_sequence_invalid".to_owned());
        }
        let envelope: Value = serde_json::from_str(envelope_json)
            .map_err(|_| "transcription_result_invalid".to_owned())?;
        let write = serde_json::from_value::<NativeTranscriptArchiveWrite>(json!({
            "kind": "appendSegment",
            "record": {
                "id": segment_id,
                "sessionId": current.session_id,
                "sequence": sequence,
                "startAtMs": start_ms,
                "endAtMs": end_ms,
                "textEnvelope": envelope,
                "confidence": null,
                "speakerId": null,
                "speakerLabel": null,
                "createdAtMs": now_ms()
            }
        }))
        .map_err(|_| "transcription_archive_unavailable".to_owned())?;
        authority
            .local_data
            .native_transcript_write(
                &authority.app,
                &admitted.profile_id,
                &admitted.local_node_id,
                write,
            )
            .map_err(|_| "transcription_archive_unavailable".to_owned())?;
        current.next_sequence = current.next_sequence.saturating_add(1);
        current.previous_end_ms = end_ms;
        Ok(true)
    })
}

/// Finalizes only the session owned by this token. It intentionally does not
/// require the old profile or recording policy to remain current.
pub(crate) fn finalize_capture(token: &str, lifecycle: &str, reason: &str) -> Result<(), String> {
    if !matches!(lifecycle, "completed" | "interrupted" | "failed") {
        return Err("transcription_finalize_invalid".to_owned());
    }
    let authority = authority()?;
    let mut registry = registry_lock()?;
    let admitted = registry
        .captures
        .get(token)
        .cloned()
        .ok_or_else(|| "transcription_admission_expired".to_owned())?;
    if admitted.active_capture_generation.is_some() {
        return Err("transcription_capture_active".to_owned());
    }
    let ended_at_ms = now_ms();
    finalize_record(
        &authority,
        &admitted.profile_id,
        &admitted.local_node_id,
        &admitted.session_id,
        lifecycle,
        ended_at_ms,
        reason,
    )?;
    registry.captures.remove(token);
    Ok(())
}

fn finalize_record(
    authority: &Authority,
    profile_id: &str,
    local_node_id: &str,
    session_id: &str,
    lifecycle: &str,
    ended_at_ms: i64,
    reason: &str,
) -> Result<(), String> {
    let write = serde_json::from_value::<NativeTranscriptArchiveWrite>(json!({
        "kind": "finalizeSession",
        "input": {
            "sessionId": session_id,
            "lifecycle": lifecycle,
            "endedAtMs": ended_at_ms,
            "terminalReason": reason
        }
    }))
    .map_err(|_| "transcription_archive_unavailable".to_owned())?;
    authority
        .local_data
        .native_transcript_write(&authority.app, profile_id, local_node_id, write)
        .map(|_| ())
        .map_err(|_| "transcription_archive_unavailable".to_owned())
}

fn authority() -> Result<Authority, String> {
    registry_lock()?
        .authority
        .clone()
        .ok_or_else(|| "transcription_unavailable".to_owned())
}

fn capture(token: &str) -> Result<AdmittedCapture, String> {
    if token.len() != 64 || !token.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("transcription_admission_invalid".to_owned());
    }
    registry_lock()?
        .captures
        .get(token)
        .cloned()
        .ok_or_else(|| "transcription_admission_expired".to_owned())
}

fn registry_lock() -> Result<std::sync::MutexGuard<'static, Registry>, String> {
    REGISTRY
        .get_or_init(|| Mutex::new(Registry::default()))
        .lock()
        .map_err(|_| "transcription_unavailable".to_owned())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "transcription_unavailable".to_owned())?;
    Ok(bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(""))
}

fn nullable_string<T>(value: &aurora_voice_core::node_policy::NullableField<T>) -> Option<T>
where
    T: Clone,
{
    match value {
        aurora_voice_core::node_policy::NullableField::Value(value) => Some(value.clone()),
        aurora_voice_core::node_policy::NullableField::Missing
        | aurora_voice_core::node_policy::NullableField::Null => None,
    }
}
