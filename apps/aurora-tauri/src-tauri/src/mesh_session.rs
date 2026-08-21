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

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
use aurora_contracts::ids;
use aurora_mesh_authority::types::{PeerHostAuthorizeRequest, PeerHostErrorBody};
use aurora_mesh_session::{
    error_frame, execute_background_tooling_call, BackgroundToolingProviderContext, CallOutcome,
    DeviceLinkAction, DeviceLinkLedger, InboundDisposition, MeshSessionRegistry, PendingCall,
    QueuedFrame, SurfaceLifecycle,
};
use aurora_voice_native::TransportError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Mutex};

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
const NATIVE_ASSISTANT_ABANDONED_TTL_MS: i64 = 5 * 60 * 1000;
const NATIVE_ASSISTANT_ABANDONED_MAX: usize = 256;
const RETIRED_CHANNEL_TTL_MS: i64 = 5 * 60 * 1000;
const RETIRED_CHANNEL_MAX: usize = 128;

/// The registry, plus what the shell needs to route back to a channel.
#[derive(Clone, Default)]
pub struct MeshSessionState {
    inner: Arc<Mutex<MeshSessionInner>>,
}

#[derive(Default)]
struct MeshSessionInner {
    registry: MeshSessionRegistry,
    /// Which stable peer id a data channel carries, once TypeScript said so.
    channel_peers: HashMap<u64, String>,
    /// Reverse of `channels`, so an answer can find its way back out.
    peer_channels: HashMap<String, u64>,
    /// Per-peer native assistant eligibility supplied by the production bind.
    peer_bindings: HashMap<String, MeshSessionPeerBinding>,
    /// Native-owned outbound calls awaiting a response on an exact peer.
    native_assistant_pending: HashMap<(String, String), NativeAssistantPendingResponse>,
    /// Recently abandoned calls whose late result/error frames must not leak
    /// to the generic WebView path.
    native_assistant_abandoned: HashMap<(String, String), ExpiringMarker>,
    /// Superseded data channels retained briefly so late frames from them do
    /// not settle current calls or masquerade as generic WebView traffic.
    retired_channel_peers: HashMap<u64, RetiredChannelPeer>,
    expiring_marker_sequence: u64,
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

#[derive(Clone, Debug, Default)]
struct MeshSessionPeerBinding {
    data_channel_id: u64,
    advertised_method_ids: BTreeSet<String>,
    manifest_methods_ready: bool,
    primary: bool,
}

#[derive(Debug)]
struct NativeAssistantPendingResponse {
    data_channel_id: u64,
    sender: oneshot::Sender<Result<Value, TransportError>>,
}

#[derive(Clone, Copy, Debug)]
struct ExpiringMarker {
    expires_at_ms: i64,
    sequence: u64,
}

#[derive(Clone, Debug)]
struct RetiredChannelPeer {
    peer_id: String,
    marker: ExpiringMarker,
}

#[derive(Debug)]
pub struct NativeAssistantPendingCall {
    pub peer_id: String,
    pub data_channel_id: u64,
    pub local_peer_id: Option<String>,
    pub response: oneshot::Receiver<Result<Value, TransportError>>,
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
    /// Methods currently advertised by this exact peer manifest.
    #[serde(default)]
    advertised_method_ids: Vec<String>,
    /// Whether `advertised_method_ids` is authoritative for this binding.
    #[serde(default = "default_manifest_methods_ready")]
    manifest_methods_ready: bool,
    /// Whether this peer is the primary eligible route for this local surface.
    #[serde(default)]
    primary: bool,
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
    let now_ms = current_time_ms();
    let mut inner = state.inner.lock().await;
    inner
        .registry
        .bind(&request.peer_id, request.peer_connection_id, context)
        .map_err(|error| error.to_string())?;
    inner.bind_channel_to_peer(&request.peer_id, request.data_channel_id, now_ms);
    inner.peer_bindings.insert(
        request.peer_id.clone(),
        MeshSessionPeerBinding {
            data_channel_id: request.data_channel_id,
            advertised_method_ids: request.advertised_method_ids.into_iter().collect(),
            manifest_methods_ready: request.manifest_methods_ready,
            primary: request.primary,
        },
    );
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
        inner.channel_peers.remove(&channel_id);
    }
    inner.peer_bindings.remove(&request.peer_id);
    inner.fail_native_assistant_peer(&request.peer_id, TransportError::RequestFailed);
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

fn default_manifest_methods_ready() -> bool {
    true
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

    fn begin_native_assistant_call(
        &mut self,
        preferred_peer_id: Option<&str>,
        method_id: &str,
        request_id: &str,
        require_advertised_method: bool,
    ) -> Result<NativeAssistantPendingCall, TransportError> {
        if self
            .native_assistant_pending
            .keys()
            .any(|(_, id)| id == request_id)
        {
            return Err(TransportError::InvalidConfiguration);
        }
        let required_method_id = require_advertised_method.then_some(method_id);
        let (peer_id, binding) =
            self.select_native_assistant_peer(preferred_peer_id, required_method_id)?;
        let (sender, response) = oneshot::channel();
        self.native_assistant_pending.insert(
            (peer_id.clone(), request_id.to_owned()),
            NativeAssistantPendingResponse {
                data_channel_id: binding.data_channel_id,
                sender,
            },
        );
        Ok(NativeAssistantPendingCall {
            peer_id,
            data_channel_id: binding.data_channel_id,
            local_peer_id: self.provider_peer_id.clone(),
            response,
        })
    }

    fn select_native_assistant_peer(
        &self,
        preferred_peer_id: Option<&str>,
        required_method_id: Option<&str>,
    ) -> Result<(String, MeshSessionPeerBinding), TransportError> {
        if let Some(peer_id) = preferred_peer_id {
            let binding = self
                .peer_bindings
                .get(peer_id)
                .ok_or(TransportError::InvalidConfiguration)?;
            if required_method_id.is_some_and(|method_id| {
                !binding.manifest_methods_ready
                    || !binding.advertised_method_ids.contains(method_id)
            }) {
                return Err(TransportError::UnknownMethod);
            }
            return Ok((peer_id.to_owned(), binding.clone()));
        }

        let mut candidates = self
            .peer_bindings
            .iter()
            .filter(|(_, binding)| {
                required_method_id.is_none_or(|method_id| {
                    binding.manifest_methods_ready
                        && binding.advertised_method_ids.contains(method_id)
                })
            })
            .map(|(peer_id, binding)| (peer_id.clone(), binding.clone()))
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| left.0.cmp(&right.0));
        if candidates.len() == 1 {
            return Ok(candidates.remove(0));
        }
        let mut primary = candidates
            .into_iter()
            .filter(|(_, binding)| binding.primary)
            .collect::<Vec<_>>();
        if primary.len() == 1 {
            return Ok(primary.remove(0));
        }
        Err(TransportError::InvalidConfiguration)
    }

    fn native_assistant_manifest_pending(
        &self,
        preferred_peer_id: Option<&str>,
        required_method_id: Option<&str>,
    ) -> bool {
        let Some(required_method_id) = required_method_id else {
            return false;
        };
        if let Some(peer_id) = preferred_peer_id {
            return self
                .peer_bindings
                .get(peer_id)
                .is_some_and(|binding| !binding.manifest_methods_ready);
        }

        let has_ready_candidate = self.peer_bindings.values().any(|binding| {
            binding.manifest_methods_ready
                && binding.advertised_method_ids.contains(required_method_id)
        });
        !has_ready_candidate
            && self
                .peer_bindings
                .values()
                .any(|binding| !binding.manifest_methods_ready)
    }

    fn bind_channel_to_peer(&mut self, peer_id: &str, data_channel_id: u64, now_ms: i64) {
        self.prune_expiring_markers(now_ms);
        self.channel_peers
            .insert(data_channel_id, peer_id.to_owned());
        if let Some(previous_channel_id) = self
            .peer_channels
            .insert(peer_id.to_owned(), data_channel_id)
        {
            if previous_channel_id != data_channel_id {
                self.channel_peers.remove(&previous_channel_id);
                self.retire_channel(previous_channel_id, peer_id, now_ms);
                self.fail_native_assistant_peer_channel(
                    peer_id,
                    previous_channel_id,
                    TransportError::RequestFailed,
                );
            }
        }
    }

    fn settle_native_assistant_response(
        &mut self,
        peer_id: &str,
        data_channel_id: u64,
        frame: &Value,
        now_ms: i64,
    ) -> NativeAssistantFrameDisposition {
        self.prune_expiring_markers(now_ms);
        let Some(frame_type) = frame.get("type").and_then(Value::as_str) else {
            return NativeAssistantFrameDisposition::NotAssistant;
        };
        if frame_type != "result" && frame_type != "error" {
            return NativeAssistantFrameDisposition::NotAssistant;
        }
        let Some(request_id) = frame.get("id").and_then(Value::as_str) else {
            return NativeAssistantFrameDisposition::NotAssistant;
        };
        let key = (peer_id.to_owned(), request_id.to_owned());
        if self.native_assistant_abandoned.contains_key(&key) {
            return NativeAssistantFrameDisposition::Consumed;
        }
        let Some(pending) = self.native_assistant_pending.get(&key) else {
            return NativeAssistantFrameDisposition::NotAssistant;
        };
        if pending.data_channel_id != data_channel_id {
            return NativeAssistantFrameDisposition::NotAssistant;
        }
        let Some(pending) = self.native_assistant_pending.remove(&key) else {
            return NativeAssistantFrameDisposition::NotAssistant;
        };
        let result = if frame_type == "result" {
            Ok(frame.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(transport_error_from_frame(frame))
        };
        let _ = pending.sender.send(result);
        NativeAssistantFrameDisposition::Consumed
    }

    fn fail_native_assistant_peer(&mut self, peer_id: &str, error: TransportError) {
        let keys = self
            .native_assistant_pending
            .keys()
            .filter(|(pending_peer_id, _)| pending_peer_id == peer_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(pending) = self.native_assistant_pending.remove(&key) {
                let _ = pending.sender.send(Err(error.clone()));
            }
        }
    }

    fn fail_native_assistant_peer_channel(
        &mut self,
        peer_id: &str,
        data_channel_id: u64,
        error: TransportError,
    ) {
        let keys = self
            .native_assistant_pending
            .iter()
            .filter(|((pending_peer_id, _), pending)| {
                pending_peer_id == peer_id && pending.data_channel_id == data_channel_id
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(pending) = self.native_assistant_pending.remove(&key) {
                let _ = pending.sender.send(Err(error.clone()));
            }
        }
    }

    fn remove_native_assistant_call(&mut self, peer_id: &str, request_id: &str) {
        self.native_assistant_pending
            .remove(&(peer_id.to_owned(), request_id.to_owned()));
    }

    fn abandon_native_assistant_call(&mut self, peer_id: &str, request_id: &str, now_ms: i64) {
        self.remove_native_assistant_call(peer_id, request_id);
        let marker = self.new_expiring_marker(now_ms, NATIVE_ASSISTANT_ABANDONED_TTL_MS);
        self.native_assistant_abandoned
            .insert((peer_id.to_owned(), request_id.to_owned()), marker);
        self.prune_expiring_markers(now_ms);
    }

    fn retire_channel(&mut self, data_channel_id: u64, peer_id: &str, now_ms: i64) {
        let marker = self.new_expiring_marker(now_ms, RETIRED_CHANNEL_TTL_MS);
        self.retired_channel_peers.insert(
            data_channel_id,
            RetiredChannelPeer {
                peer_id: peer_id.to_owned(),
                marker,
            },
        );
        self.prune_expiring_markers(now_ms);
    }

    fn new_expiring_marker(&mut self, now_ms: i64, ttl_ms: i64) -> ExpiringMarker {
        self.expiring_marker_sequence = self.expiring_marker_sequence.wrapping_add(1);
        ExpiringMarker {
            expires_at_ms: now_ms.saturating_add(ttl_ms),
            sequence: self.expiring_marker_sequence,
        }
    }

    fn prune_expiring_markers(&mut self, now_ms: i64) {
        self.native_assistant_abandoned
            .retain(|_, marker| marker.expires_at_ms > now_ms);
        self.retired_channel_peers
            .retain(|_, retired| retired.marker.expires_at_ms > now_ms);
        prune_abandoned_marker_map(
            &mut self.native_assistant_abandoned,
            NATIVE_ASSISTANT_ABANDONED_MAX,
        );
        prune_retired_channel_map(&mut self.retired_channel_peers, RETIRED_CHANNEL_MAX);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeAssistantFrameDisposition {
    Consumed,
    NotAssistant,
}

fn stale_channel_should_swallow(expected_peer_id: &str, frame: &Value) -> bool {
    let Some(frame_type) = frame.get("type").and_then(Value::as_str) else {
        return false;
    };
    if !matches!(frame_type, "call" | "cancel" | "result" | "error") {
        return false;
    }
    frame
        .get("peer_id")
        .and_then(Value::as_str)
        .is_none_or(|peer_id| peer_id == expected_peer_id)
}

fn prune_abandoned_marker_map(map: &mut HashMap<(String, String), ExpiringMarker>, max_len: usize) {
    if map.len() <= max_len {
        return;
    }
    let mut by_sequence = map
        .iter()
        .map(|(key, marker)| (key.clone(), marker.sequence))
        .collect::<Vec<_>>();
    by_sequence.sort_by_key(|(_, sequence)| *sequence);
    let remove_count = map.len().saturating_sub(max_len);
    for (key, _) in by_sequence.into_iter().take(remove_count) {
        map.remove(&key);
    }
}

fn prune_retired_channel_map(map: &mut HashMap<u64, RetiredChannelPeer>, max_len: usize) {
    if map.len() <= max_len {
        return;
    }
    let mut by_sequence = map
        .iter()
        .map(|(key, retired)| (*key, retired.marker.sequence))
        .collect::<Vec<_>>();
    by_sequence.sort_by_key(|(_, sequence)| *sequence);
    let remove_count = map.len().saturating_sub(max_len);
    for (key, _) in by_sequence.into_iter().take(remove_count) {
        map.remove(&key);
    }
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn transport_error_from_frame(frame: &Value) -> TransportError {
    match frame
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_u64)
        .and_then(|code| u16::try_from(code).ok())
    {
        Some(408) => TransportError::Timeout,
        Some(status @ 400..=599) => TransportError::HttpStatus { status },
        _ => TransportError::RequestFailed,
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
    inner.prune_expiring_markers(now_ms);
    let Ok(frame) = serde_json::from_str::<Value>(payload) else {
        return InboundRouting::Emit;
    };
    let Some(peer_id) = inner.channel_peers.get(&data_channel_id).cloned() else {
        let retired_peer = inner
            .retired_channel_peers
            .get(&data_channel_id)
            .map(|retired| retired.peer_id.clone());
        return match retired_peer {
            Some(peer_id) if stale_channel_should_swallow(&peer_id, &frame) => {
                InboundRouting::Parked
            }
            _ => InboundRouting::Emit,
        };
    };
    if inner.settle_native_assistant_response(&peer_id, data_channel_id, &frame, now_ms)
        == NativeAssistantFrameDisposition::Consumed
    {
        return InboundRouting::Parked;
    }

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

pub async fn native_data_channel_closed(
    app: &AppHandle,
    state: &MeshSessionState,
    data_channel_id: u64,
) {
    let mut inner = state.inner.lock().await;
    let Some(peer_id) = inner.channel_peers.remove(&data_channel_id) else {
        return;
    };
    if inner.peer_channels.get(&peer_id) != Some(&data_channel_id) {
        return;
    }
    inner.peer_channels.remove(&peer_id);
    inner.peer_bindings.remove(&peer_id);
    inner.registry.unbind(&peer_id);
    inner.fail_native_assistant_peer(&peer_id, TransportError::RequestFailed);
    inner.sync_device_link(app);
}

pub async fn route_native_data_channel_closed(app: &AppHandle, data_channel_id: u64) {
    let Some(state) = app.try_state::<MeshSessionState>() else {
        return;
    };
    native_data_channel_closed(app, &state, data_channel_id).await;
}

impl MeshSessionState {
    pub async fn begin_native_assistant_call(
        &self,
        preferred_peer_id: Option<&str>,
        method_id: &str,
        request_id: &str,
        require_advertised_method: bool,
    ) -> Result<NativeAssistantPendingCall, TransportError> {
        let mut inner = self.inner.lock().await;
        inner.begin_native_assistant_call(
            preferred_peer_id,
            method_id,
            request_id,
            require_advertised_method,
        )
    }

    pub async fn begin_native_assistant_call_or_wait(
        &self,
        preferred_peer_id: Option<&str>,
        method_id: &str,
        request_id: &str,
        require_advertised_method: bool,
    ) -> Result<Option<NativeAssistantPendingCall>, TransportError> {
        let mut inner = self.inner.lock().await;
        let request_id_in_use = inner
            .native_assistant_pending
            .keys()
            .any(|(_, pending_request_id)| pending_request_id == request_id);
        let manifest_pending = !request_id_in_use
            && inner.native_assistant_manifest_pending(
                preferred_peer_id,
                require_advertised_method.then_some(method_id),
            );
        match inner.begin_native_assistant_call(
            preferred_peer_id,
            method_id,
            request_id,
            require_advertised_method,
        ) {
            Ok(pending) => Ok(Some(pending)),
            Err(error)
                if manifest_pending
                    && matches!(
                        error,
                        TransportError::UnknownMethod | TransportError::InvalidConfiguration
                    ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    pub async fn cancel_native_assistant_call(&self, peer_id: &str, request_id: &str) {
        let mut inner = self.inner.lock().await;
        inner.remove_native_assistant_call(peer_id, request_id);
    }

    pub async fn abandon_native_assistant_call(&self, peer_id: &str, request_id: &str) {
        let mut inner = self.inner.lock().await;
        inner.abandon_native_assistant_call(peer_id, request_id, current_time_ms());
    }

    #[cfg(test)]
    pub(crate) async fn test_bind_native_assistant_peer(
        &self,
        peer_id: &str,
        data_channel_id: u64,
        advertised_method_ids: &[&str],
        primary: bool,
        local_peer_id: Option<&str>,
    ) {
        self.test_bind_native_assistant_peer_at(
            peer_id,
            data_channel_id,
            advertised_method_ids,
            primary,
            local_peer_id,
            0,
            true,
        )
        .await;
    }

    #[cfg(test)]
    pub(crate) async fn test_bind_native_assistant_peer_at(
        &self,
        peer_id: &str,
        data_channel_id: u64,
        advertised_method_ids: &[&str],
        primary: bool,
        local_peer_id: Option<&str>,
        now_ms: i64,
        manifest_methods_ready: bool,
    ) {
        let mut inner = self.inner.lock().await;
        inner.bind_channel_to_peer(peer_id, data_channel_id, now_ms);
        inner.peer_bindings.insert(
            peer_id.to_owned(),
            MeshSessionPeerBinding {
                data_channel_id,
                advertised_method_ids: advertised_method_ids
                    .iter()
                    .map(|method| (*method).to_owned())
                    .collect(),
                manifest_methods_ready,
                primary,
            },
        );
        inner.provider_peer_id = local_peer_id.map(str::to_owned);
    }

    #[cfg(test)]
    pub(crate) async fn test_settle_native_assistant_response(
        &self,
        peer_id: &str,
        frame: &Value,
    ) -> bool {
        let mut inner = self.inner.lock().await;
        let Some(data_channel_id) = inner.peer_channels.get(peer_id).copied() else {
            return false;
        };
        inner.settle_native_assistant_response(peer_id, data_channel_id, frame, 0)
            == NativeAssistantFrameDisposition::Consumed
    }

    #[cfg(test)]
    pub(crate) async fn test_abandon_native_assistant_call_at(
        &self,
        peer_id: &str,
        request_id: &str,
        now_ms: i64,
    ) {
        let mut inner = self.inner.lock().await;
        inner.abandon_native_assistant_call(peer_id, request_id, now_ms);
    }

    #[cfg(test)]
    pub(crate) async fn test_route_native_assistant_frame_at(
        &self,
        data_channel_id: u64,
        frame: &Value,
        now_ms: i64,
    ) -> NativeAssistantFrameDisposition {
        let mut inner = self.inner.lock().await;
        inner.prune_expiring_markers(now_ms);
        let Some(peer_id) = inner.channel_peers.get(&data_channel_id).cloned() else {
            return match inner.retired_channel_peers.get(&data_channel_id) {
                Some(retired) if stale_channel_should_swallow(&retired.peer_id, frame) => {
                    NativeAssistantFrameDisposition::Consumed
                }
                _ => NativeAssistantFrameDisposition::NotAssistant,
            };
        };
        inner.settle_native_assistant_response(&peer_id, data_channel_id, frame, now_ms)
    }

    #[cfg(test)]
    pub(crate) async fn test_fail_native_assistant_peer(&self, peer_id: &str) {
        let mut inner = self.inner.lock().await;
        inner.fail_native_assistant_peer(peer_id, TransportError::RequestFailed);
    }

    #[cfg(test)]
    pub(crate) async fn test_close_native_data_channel(&self, data_channel_id: u64) {
        let mut inner = self.inner.lock().await;
        let Some(peer_id) = inner.channel_peers.remove(&data_channel_id) else {
            return;
        };
        if inner.peer_channels.get(&peer_id) != Some(&data_channel_id) {
            return;
        }
        inner.peer_channels.remove(&peer_id);
        inner.peer_bindings.remove(&peer_id);
        inner.registry.unbind(&peer_id);
        inner.fail_native_assistant_peer(&peer_id, TransportError::RequestFailed);
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
        "aurora.mesh {BACKGROUND_TOOL_CALL_MARKER} outcome={outcome} method={}",
        pending.method_id
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

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    #[test]
    fn native_assistant_selects_primary_eligible_peer_and_claims_exact_response() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    10,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    false,
                    Some("local-node"),
                )
                .await;
            state
                .test_bind_native_assistant_peer(
                    "peer-b",
                    20,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    Some("local-node"),
                )
                .await;

            let pending = state
                .begin_native_assistant_call(
                    None,
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-1",
                    true,
                )
                .await
                .expect("pending call");
            assert_eq!(pending.peer_id, "peer-b");
            assert_eq!(pending.data_channel_id, 20);
            assert_eq!(pending.local_peer_id.as_deref(), Some("local-node"));

            assert!(
                !state
                    .test_settle_native_assistant_response(
                        "peer-a",
                        &json!({"type": "result", "id": "request-1", "result": {"text": "wrong"}}),
                    )
                    .await
            );
            assert!(
                state
                    .test_settle_native_assistant_response(
                        "peer-b",
                        &json!({"type": "result", "id": "request-1", "result": {"text": "ok"}}),
                    )
                    .await
            );
            assert_eq!(
                pending.response.await.expect("sender").expect("response"),
                json!({"text": "ok"})
            );
        });
    }

    #[test]
    fn native_assistant_refuses_ambiguous_or_unadvertised_peer() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    10,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    false,
                    None,
                )
                .await;
            state
                .test_bind_native_assistant_peer(
                    "peer-b",
                    20,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    false,
                    None,
                )
                .await;
            assert_eq!(
                state
                    .begin_native_assistant_call(
                        None,
                        ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        "ambiguous",
                        true,
                    )
                    .await
                    .expect_err("ambiguous route"),
                TransportError::InvalidConfiguration
            );
            assert_eq!(
                state
                    .begin_native_assistant_call(
                        Some("peer-a"),
                        ids::ORCHESTRATOR_INTERRUPT,
                        "missing-method",
                        true,
                    )
                    .await
                    .expect_err("missing method"),
                TransportError::UnknownMethod
            );
        });
    }

    #[test]
    fn native_assistant_pending_calls_fail_when_peer_fails() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    10,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            let pending = state
                .begin_native_assistant_call(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-1",
                    true,
                )
                .await
                .expect("pending call");
            state.test_fail_native_assistant_peer("peer-a").await;
            assert_eq!(
                pending
                    .response
                    .await
                    .expect("sender")
                    .expect_err("failed peer"),
                TransportError::RequestFailed
            );
        });
    }

    #[test]
    fn native_assistant_rebind_ignores_stale_channel_close() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    10,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    20,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;

            state.test_close_native_data_channel(10).await;
            let still_bound = state
                .begin_native_assistant_call(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-after-stale-close",
                    true,
                )
                .await
                .expect("new channel remains bound");
            assert_eq!(still_bound.data_channel_id, 20);

            state.test_close_native_data_channel(20).await;
            assert_eq!(
                still_bound
                    .response
                    .await
                    .expect("sender")
                    .expect_err("active channel closed"),
                TransportError::RequestFailed
            );
            assert_eq!(
                state
                    .begin_native_assistant_call(
                        Some("peer-a"),
                        ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        "request-after-active-close",
                        true,
                    )
                    .await
                    .expect_err("active close removed binding"),
                TransportError::InvalidConfiguration
            );
        });
    }

    #[test]
    fn native_assistant_late_abandoned_result_is_consumed_then_expires() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer(
                    "peer-a",
                    10,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            let pending = state
                .begin_native_assistant_call(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-abandoned",
                    true,
                )
                .await
                .expect("pending call");
            state
                .test_abandon_native_assistant_call_at("peer-a", "request-abandoned", 100)
                .await;
            drop(pending);

            let late = json!({
                "type": "result",
                "id": "request-abandoned",
                "result": {"text": "late"}
            });
            assert_eq!(
                state
                    .test_route_native_assistant_frame_at(10, &late, 1_000)
                    .await,
                NativeAssistantFrameDisposition::Consumed
            );
            assert_eq!(
                state
                    .test_route_native_assistant_frame_at(
                        10,
                        &late,
                        100 + NATIVE_ASSISTANT_ABANDONED_TTL_MS + 1,
                    )
                    .await,
                NativeAssistantFrameDisposition::NotAssistant
            );
        });
    }

    #[test]
    fn native_assistant_superseded_channel_frames_do_not_settle_current_call() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer_at(
                    "peer-a",
                    10,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                    100,
                    true,
                )
                .await;
            let old_pending = state
                .begin_native_assistant_call(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-1",
                    true,
                )
                .await
                .expect("old pending");
            state
                .test_bind_native_assistant_peer_at(
                    "peer-a",
                    20,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                    200,
                    true,
                )
                .await;
            assert_eq!(
                old_pending
                    .response
                    .await
                    .expect("sender")
                    .expect_err("old channel failed"),
                TransportError::RequestFailed
            );
            let current_pending = state
                .begin_native_assistant_call(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-1",
                    true,
                )
                .await
                .expect("current pending can reuse abandoned id after failure");

            let stale_result = json!({
                "type": "result",
                "id": "request-1",
                "result": {"text": "stale"}
            });
            assert_eq!(
                state
                    .test_route_native_assistant_frame_at(10, &stale_result, 250)
                    .await,
                NativeAssistantFrameDisposition::Consumed
            );
            assert_eq!(
                state
                    .test_route_native_assistant_frame_at(
                        10,
                        &json!({"type": "call", "id": "stale-call"}),
                        250,
                    )
                    .await,
                NativeAssistantFrameDisposition::Consumed
            );
            assert_eq!(
                state
                    .test_route_native_assistant_frame_at(
                        20,
                        &json!({
                            "type": "result",
                            "id": "request-1",
                            "result": {"text": "current"}
                        }),
                        250,
                    )
                    .await,
                NativeAssistantFrameDisposition::Consumed
            );
            assert_eq!(
                current_pending
                    .response
                    .await
                    .expect("sender")
                    .expect("current result"),
                json!({"text": "current"})
            );
        });
    }

    #[test]
    fn native_assistant_selection_filters_by_requested_method() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer(
                    "peer-primary",
                    10,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    None,
                )
                .await;
            state
                .test_bind_native_assistant_peer(
                    "peer-interrupt",
                    20,
                    &[ids::ORCHESTRATOR_INTERRUPT],
                    false,
                    None,
                )
                .await;

            let pending = state
                .begin_native_assistant_call(
                    None,
                    ids::ORCHESTRATOR_INTERRUPT,
                    "request-interrupt",
                    true,
                )
                .await
                .expect("interrupt-capable peer selected");
            assert_eq!(pending.peer_id, "peer-interrupt");
            assert_eq!(pending.data_channel_id, 20);
        });
    }
}
