//! Session liveness and background frame serving, wired into the shell.
//!
//! The native half of R3. `aurora-mesh-session` decides *what happens to a
//! frame*; this module is where that decision meets the real data channel, the
//! real authority and Android's real foreground service.
//!
//! ## Why the interception is here and not behind a command
//!
//! The obvious shape -- the webview receives a frame and calls a command to
//! ask what to do with it -- cannot work, because the whole problem is that the
//! webview is frozen. A frozen webview issues no commands. So the decision
//! happens inside `native_webrtc`'s `on_message` handler, before anything is
//! emitted to the webview at all: Rust answers what it owns, parks what it
//! does not, and emits only what TypeScript is awake to receive.
//!
//! ## What TypeScript still tells us
//!
//! Two things, both from the foreground, and neither of them a decision:
//!
//! * which stable peer id a data channel belongs to, once the session is
//!   authorized ([`aurora_mesh_session_bind`]). Before that binding exists
//!   every frame passes straight through, which is right: first contact and
//!   pairing are foreground work by definition.
//! * whether the surface is awake ([`aurora_mesh_session_set_lifecycle`]).
//!
//! Neither widens anything. Every authorization question still goes to the
//! authority on every call, and the answer does not depend on which of the two
//! states we are in.

use std::collections::HashMap;
use std::sync::Arc;

use aurora_mesh_authority::types::PeerHostAuthorizeRequest;
use aurora_mesh_session::{
    BackgroundExecution, CallOutcome, DeviceLinkAction, DeviceLinkLedger, InboundDisposition,
    MeshSessionRegistry, PendingCall, QueuedFrame, SurfaceLifecycle,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Event the shell emits when the background dispatcher has something the
/// webview must see once it wakes: drained frames, and the fact of a call
/// having been answered while it slept.
const MESH_SESSION_EVENT: &str = "aurora://mesh-session";

/// Marker line the R5 harness counts to measure background tool serving.
///
/// Rust's stdout reaches Android's log under the `RustStdoutStderr` tag, and
/// `apps/aurora-tauri/scripts/android-background-measurement.mjs` counts lines
/// matching `/RustStdoutStderr.*\bbackground[ _-]?tool[ _-]?call\b/i` over the
/// measurement window. The spelling here is what makes that regex match; the
/// two are kept in step by `docs/mesh/BACKGROUND-MEASUREMENT.md`.
const BACKGROUND_TOOL_CALL_MARKER: &str = "background_tool_call";
const BACKGROUND_NATIVE_SERVICE_INSTANCE_ID: &str = "local:local-native:Tooling";
const GET_DEVICE_STATUS_TOOL_ID: &str = "aurora.local.native.get_device_status.v1";
const GET_DEVICE_STATUS_LOCAL_NAME: &str = "native.get_device_status";

/// The registry, plus what the shell needs to route back to a channel.
#[derive(Default)]
pub struct MeshSessionState {
    inner: Arc<Mutex<MeshSessionInner>>,
}

#[derive(Default)]
struct MeshSessionInner {
    registry: MeshSessionRegistry,
    /// Which stable peer id a data channel carries, once TypeScript said so.
    channels: HashMap<u64, String>,
    /// Reverse of `channels`, so an answer can find its way back out.
    peer_channels: HashMap<String, u64>,
    /// Whether this process currently holds the R4 connected-device reason.
    ///
    /// The decision is `aurora-mesh-session`'s and is tested there; this only
    /// carries it out.
    device_link: DeviceLinkLedger,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionBindRequest {
    peer_id: String,
    data_channel_id: u64,
    peer_connection_id: u64,
    /// What a reconnect proof established, when there was one. A reference,
    /// never a grant.
    #[serde(default)]
    authenticated_peer_context: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionPeerRequest {
    peer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionLifecycleRequest {
    /// `foreground` or `background`.
    lifecycle: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionDrain {
    peer_id: String,
    frames: Vec<Value>,
}

/// Bind a data channel to the stable peer id it carries.
///
/// Taking the first binding acquires the one Aurora foreground service's
/// connected-device reason, so the process survives long enough to keep
/// answering. R4 built that ledger; this is its first caller.
#[tauri::command]
pub async fn aurora_mesh_session_bind(
    app: AppHandle,
    state: State<'_, MeshSessionState>,
    request: MeshSessionBindRequest,
) -> Result<Value, String> {
    let context = match request.authenticated_peer_context {
        Some(value) if !value.is_null() => {
            Some(serde_json::from_value(value).map_err(|error| error.to_string())?)
        }
        _ => None,
    };
    let mut inner = state.inner.lock().await;
    inner
        .registry
        .bind(&request.peer_id, request.peer_connection_id, context)
        .map_err(|error| error.to_string())?;
    inner
        .channels
        .insert(request.data_channel_id, request.peer_id.clone());
    inner
        .peer_channels
        .insert(request.peer_id.clone(), request.data_channel_id);
    let held = inner.sync_device_link(&app);
    Ok(json!({
        "peerId": request.peer_id,
        "sessions": inner.registry.len(),
        "deviceLinkHeld": held,
    }))
}

/// Drop a peer's session.
///
/// Releasing the last one releases the connected-device reason, so the
/// notification goes away when nothing is being held open for it. Voice may
/// still be holding the service for its own reason; the ledger is
/// reference-counted precisely so this call cannot end someone else's session.
#[tauri::command]
pub async fn aurora_mesh_session_unbind(
    app: AppHandle,
    state: State<'_, MeshSessionState>,
    request: MeshSessionPeerRequest,
) -> Result<Value, String> {
    let mut inner = state.inner.lock().await;
    let removed = inner.registry.unbind(&request.peer_id);
    if let Some(channel_id) = inner.peer_channels.remove(&request.peer_id) {
        inner.channels.remove(&channel_id);
    }
    let held = inner.sync_device_link(&app);
    Ok(json!({
        "peerId": request.peer_id,
        "removed": removed,
        "sessions": inner.registry.len(),
        "deviceLinkHeld": held,
    }))
}

/// Tell the dispatcher whether the webview is awake.
///
/// Coming back to the foreground returns everything parked while it slept, per
/// peer, in arrival order. The caller gets the backlog in the same breath as
/// the state change, so it cannot dispatch a newly arrived frame ahead of it.
#[tauri::command]
pub async fn aurora_mesh_session_set_lifecycle(
    state: State<'_, MeshSessionState>,
    request: MeshSessionLifecycleRequest,
) -> Result<Value, String> {
    let lifecycle = match request.lifecycle.as_str() {
        "foreground" => SurfaceLifecycle::Foreground,
        "background" => SurfaceLifecycle::Background,
        other => return Err(format!("unknown lifecycle {other}")),
    };
    let mut inner = state.inner.lock().await;
    let drained = inner.registry.set_lifecycle(lifecycle);
    Ok(json!({
        "lifecycle": lifecycle.as_str(),
        "drained": drained_payload(drained),
    }))
}

/// What the dispatcher has seen, for diagnostics and the soak report.
#[tauri::command]
pub async fn aurora_mesh_session_snapshot(
    state: State<'_, MeshSessionState>,
) -> Result<Value, String> {
    let inner = state.inner.lock().await;
    Ok(inner.registry.snapshot())
}

fn drained_payload(drained: Vec<(String, Vec<QueuedFrame>)>) -> Vec<MeshSessionDrain> {
    drained
        .into_iter()
        .map(|(peer_id, frames)| MeshSessionDrain {
            peer_id,
            frames: frames.into_iter().map(|queued| queued.frame).collect(),
        })
        .collect()
}

impl MeshSessionInner {
    /// Match the foreground service's connected-device reason to whether any
    /// session is actually being held, and report whether it is held now.
    ///
    /// Idempotent on purpose: it takes at most one hold and releases at most
    /// one, so a flapping session cannot run the reference count away from the
    /// number of sessions that exist.
    fn sync_device_link(&mut self, app: &AppHandle) -> bool {
        match self.device_link.sync(self.registry.len()) {
            Some(DeviceLinkAction::Hold) => hold_device_link(app),
            Some(DeviceLinkAction::Release) => release_device_link(app),
            None => {}
        }
        self.device_link.is_held()
    }
}

/// What the transport should do with a frame it just received.
pub enum InboundRouting {
    /// Hand it to the webview, as before R3.
    Emit,
    /// Rust answered it. These go back out on the same channel, in order.
    Answer(Vec<String>),
    /// Rust parked it. Nothing goes out and nothing is emitted.
    Parked,
}

/// Decide what happens to one inbound data-channel payload.
///
/// Called from `native_webrtc`'s `on_message` before anything reaches the
/// webview. A payload that is not a bound peer's JSON frame is passed straight
/// through, so binary traffic, unbound channels and anything the section 3
/// table does not name behave exactly as they did before R3.
pub async fn route_inbound(
    app: &AppHandle,
    state: &MeshSessionState,
    data_channel_id: u64,
    payload: &str,
    binary: bool,
    now_ms: i64,
) -> InboundRouting {
    if binary {
        return InboundRouting::Emit;
    }
    let mut inner = state.inner.lock().await;
    let Some(peer_id) = inner.channels.get(&data_channel_id).cloned() else {
        return InboundRouting::Emit;
    };
    let Ok(frame) = serde_json::from_str::<Value>(payload) else {
        return InboundRouting::Emit;
    };

    let disposition = match inner.registry.accept_inbound(&peer_id, &frame, now_ms) {
        Ok(disposition) => disposition,
        // A frame for a peer the registry does not hold is not ours to swallow.
        Err(_) => return InboundRouting::Emit,
    };

    match disposition {
        InboundDisposition::Answer(frames) => InboundRouting::Answer(encode(frames)),
        InboundDisposition::Dispatch | InboundDisposition::Unknown => InboundRouting::Emit,
        InboundDisposition::Queued { depth } => {
            let _ = depth;
            InboundRouting::Parked
        }
        InboundDisposition::Overflow(answer) => match answer {
            Some(frame) => InboundRouting::Answer(encode(vec![frame])),
            None => InboundRouting::Parked,
        },
        InboundDisposition::Authorize(pending) => {
            let background = inner.registry.lifecycle().is_background();
            drop(inner);
            settle(app, state, *pending, background).await
        }
    }
}

/// Ask the authority, then answer, defer, or leave it to the orchestrator.
///
/// The authority hop is the same one the foreground takes -- the same crate,
/// the same store, the same request -- which is what makes "the same
/// authorization decision it would make in foreground" true by construction
/// rather than by coincidence.
async fn settle(
    app: &AppHandle,
    state: &MeshSessionState,
    pending: PendingCall,
    background: bool,
) -> InboundRouting {
    let decision = authorize(app, &pending.authorize).await;
    let mut inner = state.inner.lock().await;
    let outcome = match inner.registry.settle_call(&pending, &decision) {
        Ok(outcome) => outcome,
        Err(_) => return InboundRouting::Emit,
    };
    match outcome {
        CallOutcome::Denied(frame) => {
            if background {
                log_background_tool_call(&pending, "denied");
            }
            InboundRouting::Answer(encode(vec![frame]))
        }
        CallOutcome::Deferred(frame) => {
            if background {
                log_background_tool_call(&pending, "deferred");
                let _ = app.emit_to(
                    "main",
                    MESH_SESSION_EVENT,
                    json!({
                        "kind": "deferredWhileBackgrounded",
                        "peerId": pending.peer_id,
                        "methodId": pending.method_id,
                    }),
                );
            }
            InboundRouting::Answer(encode(vec![frame]))
        }
        CallOutcome::Serve { call_id, execution } => {
            log_background_tool_call(&pending, "served");
            let result = serve_background_tool_call(app, &pending, &decision, execution).await;
            InboundRouting::Answer(encode(vec![json!({
                "type": "result",
                "id": call_id,
                "result": result,
            })]))
        }
        CallOutcome::Orchestrate { .. } => InboundRouting::Emit,
    }
}

async fn serve_background_tool_call(
    app: &AppHandle,
    pending: &PendingCall,
    decision: &aurora_mesh_authority::types::PeerHostAuthorizationDecision,
    execution: BackgroundExecution,
) -> Value {
    let provider_peer_id = background_provider_peer_id(pending);
    match execution {
        BackgroundExecution::GetTools => json!({
            "count": background_tools(decision, provider_peer_id).len(),
            "tools": background_tools(decision, provider_peer_id),
        }),
        BackgroundExecution::GetExportCatalog => {
            background_export_catalog(decision, provider_peer_id)
        }
        BackgroundExecution::PrepareExecution => {
            prepare_background_tool(&pending.params, pending, decision)
        }
        BackgroundExecution::ExecuteTool => {
            execute_background_tool(app, &pending.params, pending, decision).await
        }
    }
}

fn background_tools(
    decision: &aurora_mesh_authority::types::PeerHostAuthorizationDecision,
    provider_peer_id: &str,
) -> Vec<Value> {
    if !decision_grants_tool(decision, GET_DEVICE_STATUS_TOOL_ID) {
        return Vec::new();
    }
    vec![get_device_status_tool_info(provider_peer_id)]
}

fn get_device_status_tool_info(provider_peer_id: &str) -> Value {
    let service_instance_id = background_service_instance_id(provider_peer_id);
    let global_tool_id = get_device_status_global_tool_id(provider_peer_id);
    json!({
        "name": GET_DEVICE_STATUS_LOCAL_NAME,
        "display_name": "Get device status",
        "description": "Return bounded local device availability information.",
        "namespace": "native",
        "local_name": GET_DEVICE_STATUS_LOCAL_NAME,
        "global_tool_id": global_tool_id,
        "legacy_global_tool_ids": [],
        "aliases": [],
        "args_schema": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false,
        },
        "argument_visibility": {},
        "capability_class": "device",
        "confirmation_required": false,
        "data_egress": false,
        "execution_location": "local",
        "exportable": true,
        "external": false,
        "mutating": false,
        "privacy_hints": [],
        "provider_available": true,
        "provider_granted_permissions": ["Native.GetDeviceStatus"],
        "provider_label": "This device",
        "provider_peer_id": provider_peer_id,
        "provider_service_instance_id": service_instance_id,
        "rate_limit_hints": null,
        "admin": false,
        "provenance": {
            "advertised_name": GET_DEVICE_STATUS_LOCAL_NAME,
            "provider_kind": "local",
            "provider_peer_id": provider_peer_id,
            "provider_service_instance_id": service_instance_id,
            "provider_tool_id": GET_DEVICE_STATUS_TOOL_ID,
            "source": "core",
            "source_id": "tauri-native",
        },
    })
}

fn background_export_catalog(
    decision: &aurora_mesh_authority::types::PeerHostAuthorizationDecision,
    provider_peer_id: &str,
) -> Value {
    let tools = background_tools(decision, provider_peer_id);
    let service_instance_id = background_service_instance_id(provider_peer_id);
    let projection_revision = "native-background-v1";
    let digest = sha256_hex(&json!({
        "projection_revision": projection_revision,
        "tools": tools,
    }));
    let mut page = json!({
        "ok": true,
        "provider_peer_id": provider_peer_id,
        "service_instance_id": service_instance_id,
        "selected_protocol_tier": "projection_v1",
        "authority_revision": {
            "auth_grant_revision": 0,
            "catalog_revision": 1,
            "export_policy_revision": 1,
            "manifest_revision": 1,
            "protocol_revision": 1,
            "switch_revision": 1,
        },
        "projection_revision": projection_revision,
        "projection_digest": digest,
        "page_index": 0,
        "page_size": tools.len().max(1),
        "tools": tools,
        "blocked_tools": [],
        "retirements": [],
        "complete": true,
        "next_cursor": null,
        "total_count": tools.len(),
        "final_checksum": digest,
    });
    let page_hash = sha256_hex(&page);
    page["page_hash"] = json!(page_hash);
    page
}

fn prepare_background_tool(
    params: &Value,
    pending: &PendingCall,
    decision: &aurora_mesh_authority::types::PeerHostAuthorizationDecision,
) -> Value {
    let provider_peer_id = background_provider_peer_id(pending);
    let tool_name = request_tool_name(params);
    if !is_get_device_status_name(tool_name.as_deref()) {
        return denied_prepare(tool_name.as_deref(), pending, "tool_not_found");
    }
    if !decision_grants_tool(decision, GET_DEVICE_STATUS_TOOL_ID) {
        return denied_prepare(
            tool_name.as_deref(),
            pending,
            "recipient_missing_tool_permissions",
        );
    }
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let args_hash = sha256_hex(&args);
    let service_instance_id = background_service_instance_id(provider_peer_id);
    let global_tool_id = get_device_status_global_tool_id(provider_peer_id);
    json!({
        "ok": true,
        "policy_decision": {
            "allowed": true,
            "share": true,
            "approval_required": false,
            "approval_mode": "approve_all_local_safe",
            "decision_id": pending.call_id,
            "auto_approved_reason": "local_safe_native_tool",
            "reason": null,
            "token_ttl_seconds": 300,
        },
        "args_hash": args_hash,
        "resource_selector_hash": "0".repeat(64),
        "route_decision_id": pending.call_id,
        "correlation_id": pending.call_id,
        "provider_peer_id": provider_peer_id,
        "provider_service_instance_id": service_instance_id,
        "global_tool_id": global_tool_id,
        "local_tool_name": GET_DEVICE_STATUS_LOCAL_NAME,
        "args_schema_hash": null,
        "display_args_preview": {},
        "argument_visibility": {},
        "capability_class": "device",
        "secrets_redacted": true,
    })
}

async fn execute_background_tool(
    app: &AppHandle,
    params: &Value,
    pending: &PendingCall,
    decision: &aurora_mesh_authority::types::PeerHostAuthorizationDecision,
) -> Value {
    let provider_peer_id = background_provider_peer_id(pending);
    let tool_name = request_tool_name(params);
    if !is_get_device_status_name(tool_name.as_deref()) {
        return denied_execute(tool_name.as_deref(), pending, "not_found", "tool_not_found");
    }
    if !decision_grants_tool(decision, GET_DEVICE_STATUS_TOOL_ID) {
        return denied_execute(
            tool_name.as_deref(),
            pending,
            "denied",
            "recipient_missing_tool_permissions",
        );
    }
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({
        "ok": true,
        "status": "success",
        "data": build_device_status(app).await,
        "error": null,
        "error_code": null,
        "correlation_id": pending.call_id,
        "provider_peer_id": provider_peer_id,
        "global_tool_id": get_device_status_global_tool_id(provider_peer_id),
        "policy_decision_id": pending.call_id,
        "args_hash": sha256_hex(&args),
        "display_args_preview": {},
    })
}

fn denied_prepare(tool_name: Option<&str>, pending: &PendingCall, reason: &str) -> Value {
    let provider_peer_id = background_provider_peer_id(pending);
    let name = tool_name.unwrap_or(GET_DEVICE_STATUS_LOCAL_NAME);
    json!({
        "ok": false,
        "policy_decision": {
            "allowed": false,
            "share": false,
            "approval_required": false,
            "approval_mode": "deny_all",
            "decision_id": pending.call_id,
            "reason": reason,
            "token_ttl_seconds": 0,
        },
        "args_hash": "0".repeat(64),
        "resource_selector_hash": "0".repeat(64),
        "route_decision_id": pending.call_id,
        "correlation_id": pending.call_id,
        "provider_peer_id": provider_peer_id,
        "provider_service_instance_id": background_service_instance_id(provider_peer_id),
        "global_tool_id": name,
        "local_tool_name": name,
        "args_schema_hash": null,
        "display_args_preview": {},
        "argument_visibility": {},
        "secrets_redacted": true,
    })
}

fn denied_execute(
    tool_name: Option<&str>,
    pending: &PendingCall,
    status: &str,
    reason: &str,
) -> Value {
    let provider_peer_id = background_provider_peer_id(pending);
    json!({
        "ok": false,
        "data": null,
        "error": if status == "not_found" { "Tool not found" } else { "Tool execution denied" },
        "status": status,
        "error_code": reason,
        "correlation_id": pending.call_id,
        "provider_peer_id": provider_peer_id,
        "global_tool_id": tool_name.unwrap_or(GET_DEVICE_STATUS_LOCAL_NAME),
        "policy_decision_id": null,
        "display_args_preview": {},
        "args_hash": null,
    })
}

async fn build_device_status(_app: &AppHandle) -> Value {
    let manifest =
        serde_json::to_value(crate::native_capability_manifest()).unwrap_or_else(|_| json!({}));
    let platform = manifest
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .chars()
        .take(64)
        .collect::<String>();
    json!({
        "platform": platform,
        "availableCapabilities": available_background_capabilities(&manifest),
        "online": true,
    })
}

fn available_background_capabilities(manifest: &Value) -> Vec<String> {
    if manifest_bool(manifest, "permissions", "aurora.nativeCapabilityManifest")
        && manifest_bool(manifest, "capabilities", "native.permissionsManifest")
        && manifest_state_available(
            manifest,
            "permissionStates",
            "aurora.nativeCapabilityManifest",
        )
        && manifest_state_available(manifest, "capabilityStates", "native.permissionsManifest")
    {
        return vec![GET_DEVICE_STATUS_TOOL_ID.to_owned()];
    }
    Vec::new()
}

fn manifest_bool(manifest: &Value, group: &str, key: &str) -> bool {
    manifest
        .get(group)
        .and_then(|values| values.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn manifest_state_available(manifest: &Value, group: &str, key: &str) -> bool {
    manifest
        .get(group)
        .and_then(|values| values.get(key))
        .and_then(Value::as_str)
        .map(|state| state == "available")
        .unwrap_or(true)
}

fn request_tool_name(params: &Value) -> Option<String> {
    params
        .get("tool_name")
        .or_else(|| params.get("toolName"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn is_get_device_status_name(tool_name: Option<&str>) -> bool {
    let Some(tool_name) = tool_name else {
        return false;
    };
    tool_name == GET_DEVICE_STATUS_TOOL_ID
        || tool_name == GET_DEVICE_STATUS_LOCAL_NAME
        || tool_name.starts_with("aurora-tool:v1:")
            && tool_name.ends_with(&format!(":Tooling:{GET_DEVICE_STATUS_TOOL_ID}"))
}

fn decision_grants_tool(
    decision: &aurora_mesh_authority::types::PeerHostAuthorizationDecision,
    tool_id: &str,
) -> bool {
    decision
        .granted_tool_contract_ids
        .as_ref()
        .map(|ids| ids.iter().any(|id| id == tool_id))
        .unwrap_or(false)
}

fn sha256_hex(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn background_provider_peer_id(pending: &PendingCall) -> &str {
    pending
        .authorize
        .authenticated_peer_context
        .as_ref()
        .map(|context| context.selector.verifier_peer_id.as_str())
        .filter(|peer_id| !peer_id.is_empty())
        .unwrap_or("local-native")
}

fn background_service_instance_id(provider_peer_id: &str) -> String {
    if provider_peer_id == "local-native" {
        return BACKGROUND_NATIVE_SERVICE_INSTANCE_ID.to_owned();
    }
    format!("local:{provider_peer_id}:Tooling")
}

fn get_device_status_global_tool_id(provider_peer_id: &str) -> String {
    format!("aurora-tool:v1:{provider_peer_id}:Tooling:{GET_DEVICE_STATUS_TOOL_ID}")
}

/// One line per inbound call answered without the webview.
///
/// Deliberately counts denials and deferrals as well as served calls: all three
/// are the device answering a remote tool call while backgrounded, which is
/// what the soak is measuring. A denial that never reached the wire would look
/// identical to a dead session from the other end.
fn log_background_tool_call(pending: &PendingCall, outcome: &str) {
    println!(
        "aurora.mesh {BACKGROUND_TOOL_CALL_MARKER} outcome={outcome} method={} peer={}",
        pending.method_id, pending.peer_id
    );
}

fn encode(frames: Vec<Value>) -> Vec<String> {
    frames.iter().map(Value::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_mesh_authority::authority::{
        AuthenticatedPeerContext, PeerRelationshipSelector, ReconnectTransportAttestation,
    };
    use aurora_mesh_authority::types::PeerHostAuthorizationDecision;
    use aurora_mesh_authority::types::{PeerHostAuthorizeRequest, PeerHostIdentity};

    fn decision_with_tools(tool_ids: &[&str]) -> PeerHostAuthorizationDecision {
        PeerHostAuthorizationDecision {
            allowed: true,
            granted_tool_contract_ids: Some(tool_ids.iter().map(|id| (*id).to_owned()).collect()),
            ..PeerHostAuthorizationDecision::default()
        }
    }

    fn pending_with_provider(params: Value, verifier_peer_id: Option<&str>) -> PendingCall {
        PendingCall {
            peer_id: "peer-a".to_owned(),
            call_id: "call-1".to_owned(),
            method_id: "Tooling.PrepareExecution".to_owned(),
            params,
            authorize: PeerHostAuthorizeRequest {
                remote_peer_id: "peer-a".to_owned(),
                method_id: "Tooling.PrepareExecution".to_owned(),
                required_permissions: Vec::new(),
                identity: PeerHostIdentity {
                    caller_peer_id: "peer-a".to_owned(),
                    principal_id: None,
                    effective_permissions: Vec::new(),
                    auth_grant_revision: None,
                    manifest_revision: None,
                },
                authenticated_peer_context: verifier_peer_id.map(authenticated_context),
                now_ms: 1_000,
            },
        }
    }

    fn authenticated_context(verifier_peer_id: &str) -> AuthenticatedPeerContext {
        AuthenticatedPeerContext {
            selector: PeerRelationshipSelector {
                token_id: "token-1".to_owned(),
                claimant_peer_id: "peer-a".to_owned(),
                verifier_peer_id: verifier_peer_id.to_owned(),
                room_name: "room-a".to_owned(),
            },
            transport: ReconnectTransportAttestation {
                channel_binding: "binding-1".to_owned(),
                claimant_signaling_peer_id: "sig-peer-a".to_owned(),
                verifier_signaling_peer_id: "sig-local".to_owned(),
            },
            connection_epoch: Some("epoch-1".to_owned()),
            credential_revision: 7,
            authenticated_at_ms: 900,
        }
    }

    #[test]
    fn background_catalog_filters_by_granted_tool_contracts() {
        let denied = PeerHostAuthorizationDecision {
            allowed: true,
            granted_tool_contract_ids: Some(Vec::new()),
            ..PeerHostAuthorizationDecision::default()
        };
        assert!(background_tools(&denied, "local-peer").is_empty());

        let granted = decision_with_tools(&[GET_DEVICE_STATUS_TOOL_ID]);
        let tools = background_tools(&granted, "local-peer");
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0]["global_tool_id"],
            json!(get_device_status_global_tool_id("local-peer"))
        );
        assert_eq!(tools[0]["provider_peer_id"], json!("local-peer"));
        assert_eq!(tools[0]["confirmation_required"], json!(false));
        assert_eq!(tools[0]["mutating"], json!(false));
    }

    #[test]
    fn background_export_catalog_is_complete_and_hashes_the_page() {
        let page = background_export_catalog(
            &decision_with_tools(&[GET_DEVICE_STATUS_TOOL_ID]),
            "local-peer",
        );
        assert_eq!(page["ok"], json!(true));
        assert_eq!(page["complete"], json!(true));
        assert_eq!(page["total_count"], json!(1));
        assert_eq!(page["provider_peer_id"], json!("local-peer"));
        assert_eq!(
            page["service_instance_id"],
            json!("local:local-peer:Tooling")
        );
        assert_eq!(
            page["tools"][0]["global_tool_id"],
            json!(get_device_status_global_tool_id("local-peer"))
        );
        assert_eq!(page["page_hash"].as_str().map(str::len), Some(64));
        assert_eq!(page["projection_digest"].as_str().map(str::len), Some(64));
    }

    #[test]
    fn prepare_background_tool_auto_approves_only_the_safe_native_tool() {
        let request = pending_with_provider(
            json!({
                "tool_name": GET_DEVICE_STATUS_TOOL_ID,
                "arguments": {},
            }),
            Some("local-peer"),
        );
        let denied = prepare_background_tool(
            &request.params,
            &request,
            &PeerHostAuthorizationDecision {
                allowed: true,
                granted_tool_contract_ids: Some(Vec::new()),
                ..PeerHostAuthorizationDecision::default()
            },
        );
        assert_eq!(denied["ok"], json!(false));
        assert_eq!(
            denied["policy_decision"]["reason"],
            json!("recipient_missing_tool_permissions")
        );

        let granted = prepare_background_tool(
            &request.params,
            &request,
            &decision_with_tools(&[GET_DEVICE_STATUS_TOOL_ID]),
        );
        assert_eq!(granted["ok"], json!(true));
        assert_eq!(granted["provider_peer_id"], json!("local-peer"));
        assert_eq!(
            granted["provider_service_instance_id"],
            json!("local:local-peer:Tooling")
        );
        assert_eq!(
            granted["global_tool_id"],
            json!(get_device_status_global_tool_id("local-peer"))
        );
        assert_eq!(
            granted["policy_decision"]["approval_required"],
            json!(false)
        );
        assert_eq!(
            granted["policy_decision"]["approval_mode"],
            json!("approve_all_local_safe")
        );
    }
}

/// Put the authorization question to the one authority.
async fn authorize(
    app: &AppHandle,
    request: &PeerHostAuthorizeRequest,
) -> aurora_mesh_authority::types::PeerHostAuthorizationDecision {
    use aurora_mesh_authority::types::{PeerHostAuthorizationDecision, PeerHostAuthorizationStore};
    use tauri::Manager;

    let Some(state) = app.try_state::<crate::mesh_authority::MeshAuthorityState>() else {
        // No authority means no grant can be proven, and an unprovable grant is
        // a denial. Failing open here would make a frozen webview the most
        // permissive state the device has.
        return PeerHostAuthorizationDecision::denied("authority_unavailable");
    };
    let mut authority = state.lock().await;
    authority
        .authorize(request)
        .await
        .unwrap_or_else(|_| PeerHostAuthorizationDecision::denied("authority_unavailable"))
}

#[cfg(target_os = "android")]
fn hold_device_link(app: &AppHandle) {
    run_device_link_command(app, "meshDeviceLinkHold");
}

#[cfg(target_os = "android")]
fn release_device_link(app: &AppHandle) {
    run_device_link_command(app, "meshDeviceLinkRelease");
}

#[cfg(target_os = "android")]
fn run_device_link_command(app: &AppHandle, command: &str) {
    use tauri::Manager;
    let Some(native) = app.try_state::<crate::AuroraMobileNativePlugin<tauri::Wry>>() else {
        return;
    };
    if let Err(error) = crate::run_android_plugin_command(native, command, json!({})) {
        // A held session is worth more than a notification. Losing the hold
        // means the process may be killed sooner, not that the session is
        // wrong, so this is reported and not propagated.
        eprintln!("aurora.mesh device link {command} failed: {error}");
    }
}

/// Every other platform keeps its process alive on its own terms.
#[cfg(not(target_os = "android"))]
fn hold_device_link(_app: &AppHandle) {}

#[cfg(not(target_os = "android"))]
fn release_device_link(_app: &AppHandle) {}
