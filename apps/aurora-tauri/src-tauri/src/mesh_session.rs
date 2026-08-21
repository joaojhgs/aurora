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
//! * whether the surface is awake ([`aurora_mesh_session_set_lifecycle`] and
//!   [`aurora_mesh_session_finish_resume`]).
//!
//! Neither widens anything. Every authorization question still goes to the
//! authority on every call, and the answer does not depend on which of the two
//! states we are in.

use std::collections::HashMap;
use std::sync::Arc;

use aurora_mesh_authority::types::{PeerHostAuthorizeRequest, PeerHostErrorBody};
use aurora_mesh_session::{
    error_frame, execute_background_tooling_call, BackgroundToolingProviderContext, CallOutcome,
    DeviceLinkAction, DeviceLinkLedger, InboundDisposition, MeshSessionRegistry, PendingCall,
    QueuedFrame, SurfaceLifecycle,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
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
    /// Stable local provider id used in background Tooling projections.
    provider_peer_id: Option<String>,
    /// Local Tooling service instance id used in background projections.
    provider_service_instance_id: Option<String>,
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
    /// Stable local peer id of this provider, supplied by the production bind.
    #[serde(default)]
    local_peer_id: Option<String>,
    /// Local Tooling service instance id, supplied by the production bind.
    #[serde(default)]
    provider_service_instance_id: Option<String>,
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
    if let Some(local_peer_id) = request.local_peer_id {
        inner.provider_peer_id = Some(local_peer_id);
    }
    if let Some(service_instance_id) = request.provider_service_instance_id {
        inner.provider_service_instance_id = Some(service_instance_id);
    }
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
/// peer, in arrival order, and leaves the registry in `resuming` until the
/// caller acknowledges an empty follow-up drain with
/// [`aurora_mesh_session_finish_resume`].
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
    let current = inner.registry.lifecycle();
    Ok(json!({
        "lifecycle": current.as_str(),
        "drained": drained_payload(drained),
    }))
}

/// Acknowledge a delivered resume batch and drain anything that arrived during it.
#[tauri::command]
pub async fn aurora_mesh_session_finish_resume(
    state: State<'_, MeshSessionState>,
) -> Result<Value, String> {
    let mut inner = state.inner.lock().await;
    let drained = inner.registry.finish_resume();
    let current = inner.registry.lifecycle();
    Ok(json!({
        "lifecycle": current.as_str(),
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
        CallOutcome::Serve { .. } => {
            let Some(provider_peer_id) = inner.provider_peer_id.clone() else {
                log_background_tool_call(&pending, "failed_provider_identity_missing");
                return InboundRouting::Answer(encode(vec![bridge_error_frame(
                    &pending.call_id,
                    503,
                    "provider_identity_missing",
                )]));
            };
            let Some(provider_service_instance_id) = inner.provider_service_instance_id.clone()
            else {
                log_background_tool_call(&pending, "failed_provider_identity_missing");
                return InboundRouting::Answer(encode(vec![bridge_error_frame(
                    &pending.call_id,
                    503,
                    "provider_identity_missing",
                )]));
            };
            drop(inner);
            let Some(native) = app.try_state::<crate::AuroraMobileNativePlugin<tauri::Wry>>()
            else {
                log_background_tool_call(&pending, "failed_native_manifest_missing");
                return InboundRouting::Answer(encode(vec![bridge_error_frame(
                    &pending.call_id,
                    503,
                    "native_manifest_unavailable",
                )]));
            };
            let native_manifest = match crate::native_capability_manifest_value(native).await {
                Ok(value) => value,
                Err(_) => {
                    log_background_tool_call(&pending, "failed_native_manifest_unavailable");
                    return InboundRouting::Answer(encode(vec![bridge_error_frame(
                        &pending.call_id,
                        503,
                        "native_manifest_unavailable",
                    )]));
                }
            };
            let provider = BackgroundToolingProviderContext {
                provider_peer_id,
                provider_service_instance_id,
                native_manifest,
            };
            let frame = match execute_background_tooling_call(&pending, &decision, &provider) {
                Ok(frame) => {
                    log_background_tool_call(&pending, "served");
                    frame
                }
                Err(_) => {
                    log_background_tool_call(&pending, "failed_contract_invalid");
                    bridge_error_frame(&pending.call_id, 400, "background_tooling_contract_invalid")
                }
            };
            InboundRouting::Answer(encode(vec![frame]))
        }
        CallOutcome::Orchestrate { .. } => InboundRouting::Emit,
    }
}

fn bridge_error_frame(call_id: &str, code: u16, reason_code: &str) -> Value {
    error_frame(
        call_id,
        &PeerHostErrorBody {
            code,
            message: "background tooling unavailable".to_owned(),
            reason_code: reason_code.to_owned(),
            retry_when: None,
            error_ref: None,
            schema_id: None,
            boundary: None,
            issues: None,
        },
    )
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
