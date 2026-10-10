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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
#[cfg(test)]
use aurora_contracts::ids;
use aurora_mesh_authority::types::{PeerHostAuthorizeRequest, PeerHostErrorBody};
use aurora_mesh_session::{
    classify_background_tooling_result, error_frame, execute_background_tooling_call,
    BackgroundToolingProviderContext, BackgroundToolingResult, CallOutcome, DeviceLinkAction,
    DeviceLinkLedger, InboundDisposition, MeshSessionRegistry, PendingCall, QueuedFrame,
    SurfaceLifecycle,
};
use aurora_voice_native::{NativeMeshAssistantTurnLink, TransportError};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot, Mutex};
use zeroize::{Zeroize, Zeroizing};

use crate::native_event_hub::{
    assistant_observation_event, assistant_terminal_event, clear_global_native_event_peer,
    global_native_event_hub, mesh_peer_state_event, mesh_peer_state_snapshot,
    revoke_global_native_event_peer_publication_leases, NativeEventPeerPublicationLease,
};
#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
use crate::native_event_hub::{
    NativeEventDraft, NativeEventFilter, NativeEventStateSnapshot, NativeEventSubjectSnapshot,
    ASSISTANT_COMPLETED, NATIVE_EVENTS_GAP,
};

/// Event the shell emits when the background dispatcher has something the
/// webview must see once it wakes: drained frames, and the fact of a call
/// having been answered while it slept.
const MESH_SESSION_EVENT: &str = "aurora://mesh-session";
#[cfg(mobile)]
pub(crate) const MESH_SURFACE_RESUMED_EVENT: &str = "aurora://mesh-surface-resumed";

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
const NATIVE_DATA_CHANNEL_CODEC_V1: &str = "aes-256-gcm-nonce-prefix-v1";
const AES_GCM_NONCE_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;
const MAX_DATA_CHANNEL_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const BACKGROUND_CALL_REPLAY_TTL_MS: i64 = 5 * 60 * 1000;
const BACKGROUND_CALL_REPLAY_MAX: usize = 256;
const NATIVE_RTT_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "android")]
const ANDROID_NOTIFICATION_RTT_INITIAL_DELAY: Duration = Duration::from_secs(1);
#[cfg(target_os = "android")]
const ANDROID_NOTIFICATION_RTT_INTERVAL: Duration = Duration::from_secs(15);

/// The registry, plus what the shell needs to route back to a channel.
#[derive(Clone, Default)]
pub struct MeshSessionState {
    inner: Arc<Mutex<MeshSessionInner>>,
}

#[derive(Default)]
struct MeshSessionInner {
    registry: MeshSessionRegistry,
    /// Android/iOS lifecycle owns the lower bound on surface availability.
    ///
    /// A WebView can report `visible` after the Activity has entered
    /// `onPause`. Holding this flag prevents that stale browser observation
    /// from promoting the dispatcher until the native `Resumed` event proves
    /// that the surface is available again.
    native_surface_backgrounded: bool,
    /// Which stable peer id a data channel carries, once TypeScript said so.
    channel_peers: HashMap<u64, String>,
    /// Reverse of `channels`, so an answer can find its way back out.
    peer_channels: HashMap<String, u64>,
    /// Stable peer carried by each native WebRTC connection.
    peer_connection_peers: HashMap<u64, String>,
    /// Per-peer native assistant eligibility supplied by the production bind.
    peer_bindings: HashMap<String, MeshSessionPeerBinding>,
    /// Native-owned outbound calls awaiting a response on an exact peer.
    native_assistant_pending: HashMap<(String, String), NativeAssistantPendingResponse>,
    /// Recently abandoned calls whose late result/error frames must not leak
    /// to the generic WebView path.
    native_assistant_abandoned: HashMap<(String, String), ExpiringMarker>,
    /// Rust-owned application-layer pings awaiting the exact peer's pong.
    native_rtt_pending: HashMap<(String, String), NativeRttPendingResponse>,
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
    /// Per-peer background call ids and their settled answers.
    ///
    /// AES-GCM authenticates bytes but does not make a remote mutation
    /// idempotent. Keeping this bounded cache prevents a retransmitted call id
    /// from executing twice while still returning the original semantic answer.
    background_call_replays: HashMap<(String, String), BackgroundCallReplayEntry>,
    background_call_replay_sequence: u64,
    #[cfg(all(
        target_os = "android",
        debug_assertions,
        feature = "android-voice-live-test"
    ))]
    live_privacy_probes: HashMap<String, MeshSessionLivePrivacyProbeState>,
    /// One Rust-owned RTT loop refreshes Android's peer notification even
    /// while the WebView is suspended.
    #[cfg(target_os = "android")]
    notification_probe_running: bool,
    /// Incremented when profile identity resets so any already-spawned probe
    /// exits without adopting peers from the new profile scope.
    #[cfg(target_os = "android")]
    notification_probe_generation: u64,
}

#[derive(Clone)]
struct MeshSessionPeerBinding {
    native_event_epoch: u64,
    native_event_lease: NativeEventPeerPublicationLease,
    data_channel_id: u64,
    node_name: Option<String>,
    latest_rtt_ms: Option<f64>,
    advertised_method_ids: BTreeSet<String>,
    manifest_methods_ready: bool,
    primary: bool,
    data_channel_codec: Option<Arc<NativeDataChannelCodec>>,
}

#[derive(Clone)]
struct NativeDataChannelCodec {
    key_epoch: u64,
    key: Zeroizing<[u8; 32]>,
}

#[derive(Clone, Debug)]
struct BackgroundCallReplayEntry {
    expires_at_ms: i64,
    sequence: u64,
    state: BackgroundCallReplayState,
}

#[derive(Clone, Debug)]
enum BackgroundCallReplayState {
    Pending,
    Answer {
        frames: Vec<Value>,
        replay_after_resume: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum BackgroundCallReplayDecision {
    Execute,
    Pending,
    Answer(Vec<Value>),
}

#[derive(Debug)]
struct NativeAssistantPendingResponse {
    native_event_epoch: u64,
    native_event_lease: NativeEventPeerPublicationLease,
    data_channel_id: u64,
    stream_events: bool,
    turn: Option<NativeMeshAssistantTurnLink>,
    sender: oneshot::Sender<Result<Value, TransportError>>,
    subscription_ack: Option<oneshot::Sender<Result<Value, TransportError>>>,
    events: Option<mpsc::Sender<Result<Value, TransportError>>>,
}

#[derive(Debug)]
struct NativeRttPendingResponse {
    data_channel_id: u64,
    started_at: Instant,
    sender: oneshot::Sender<f64>,
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
    swallow_all: bool,
}

#[derive(Debug)]
pub struct NativeAssistantPendingCall {
    pub peer_id: String,
    pub native_event_epoch: u64,
    pub native_event_lease: NativeEventPeerPublicationLease,
    pub data_channel_id: u64,
    pub local_peer_id: Option<String>,
    pub stream_events: bool,
    pub turn: Option<NativeMeshAssistantTurnLink>,
    pub response: oneshot::Receiver<Result<Value, TransportError>>,
    pub subscription_ack: Option<oneshot::Receiver<Result<Value, TransportError>>>,
    pub events: Option<mpsc::Receiver<Result<Value, TransportError>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionBindRequest {
    peer_id: String,
    data_channel_id: u64,
    peer_connection_id: u64,
    /// User-facing name learned from authenticated roster/presence state.
    #[serde(default)]
    node_name: Option<String>,
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
    /// Derived payload key only. Room secret, signaling key and root key never
    /// cross this boundary.
    #[serde(default)]
    native_data_channel_codec: Option<NativeDataChannelCodecRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDataChannelCodecRequest {
    version: String,
    key_epoch: u64,
    key_bytes: Vec<u8>,
}

impl NativeDataChannelCodec {
    fn try_from_request(mut request: NativeDataChannelCodecRequest) -> Result<Self, String> {
        let result = if request.version != NATIVE_DATA_CHANNEL_CODEC_V1 {
            Err("unsupported native data-channel codec version".to_owned())
        } else if request.key_bytes.len() != 32 {
            Err("native data-channel codec key must be 32 bytes".to_owned())
        } else {
            let mut key = [0_u8; 32];
            key.copy_from_slice(&request.key_bytes);
            Ok(Self {
                key_epoch: request.key_epoch,
                key: Zeroizing::new(key),
            })
        };
        request.key_bytes.zeroize();
        result
    }

    #[cfg(test)]
    fn new(key_epoch: u64, key_bytes: Vec<u8>) -> Result<Self, String> {
        Self::try_from_request(NativeDataChannelCodecRequest {
            version: NATIVE_DATA_CHANNEL_CODEC_V1.to_owned(),
            key_epoch,
            key_bytes,
        })
    }

    fn open_json(&self, payload: &[u8]) -> Result<Value, String> {
        if payload.len() < AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES
            || payload.len() > MAX_DATA_CHANNEL_PAYLOAD_BYTES
        {
            return Err("encrypted data-channel payload length is invalid".to_owned());
        }
        let (nonce, ciphertext_and_tag) = payload.split_at(AES_GCM_NONCE_BYTES);
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref())
            .map_err(|_| "native data-channel codec key is invalid".to_owned())?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext_and_tag)
            .map_err(|_| "encrypted data-channel payload could not be opened".to_owned())?;
        serde_json::from_slice(&plaintext)
            .map_err(|_| "encrypted data-channel payload is not valid JSON".to_owned())
    }

    fn seal_json(&self, frame: &Value) -> Result<Vec<u8>, String> {
        let mut nonce = [0_u8; AES_GCM_NONCE_BYTES];
        getrandom::getrandom(&mut nonce)
            .map_err(|_| "native data-channel nonce generation failed".to_owned())?;
        self.seal_json_with_nonce(frame, nonce)
    }

    fn seal_json_with_nonce(
        &self,
        frame: &Value,
        nonce: [u8; AES_GCM_NONCE_BYTES],
    ) -> Result<Vec<u8>, String> {
        let plaintext = serde_json::to_vec(frame)
            .map_err(|_| "native data-channel frame is not serializable".to_owned())?;
        if plaintext.len() + AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES
            > MAX_DATA_CHANNEL_PAYLOAD_BYTES
        {
            return Err("native data-channel frame exceeds maximum size".to_owned());
        }
        let cipher = Aes256Gcm::new_from_slice(self.key.as_ref())
            .map_err(|_| "native data-channel codec key is invalid".to_owned())?;
        let ciphertext_and_tag = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| "native data-channel frame could not be sealed".to_owned())?;
        let mut payload = Vec::with_capacity(AES_GCM_NONCE_BYTES + ciphertext_and_tag.len());
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&ciphertext_and_tag);
        Ok(payload)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionPeerRequest {
    peer_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidNotificationPeer {
    peer_id: String,
    display_name: String,
    round_trip_time_ms: Option<f64>,
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
    frames: Vec<MeshSessionDrainFrame>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum MeshSessionDrainFrame {
    Json {
        frame: Value,
    },
    NativeBinary {
        #[serde(rename = "payloadBase64")]
        payload_base64: String,
    },
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
    mut request: MeshSessionBindRequest,
) -> Result<Value, String> {
    let native_event_hub = global_native_event_hub();
    let bind_start_native_event_epoch = native_event_hub.source_epoch();
    let context = match request.authenticated_peer_context {
        Some(value) if !value.is_null() => {
            Some(serde_json::from_value(value).map_err(|error| error.to_string())?)
        }
        _ => None,
    };
    let requested_codec = request
        .native_data_channel_codec
        .take()
        .map(NativeDataChannelCodec::try_from_request)
        .transpose()?
        .map(Arc::new);
    let now_ms = current_time_ms();
    let mut inner = state.inner.lock().await;
    let native_event_epoch = native_event_epoch_for_bind(
        bind_start_native_event_epoch,
        native_event_hub.source_epoch(),
    )?;
    let data_channel_codec = inner.resolve_data_channel_codec(
        &request.peer_id,
        request.data_channel_id,
        requested_codec,
    )?;
    inner
        .registry
        .bind(&request.peer_id, request.peer_connection_id, context)
        .map_err(|error| error.to_string())?;
    let native_event_lease = native_event_hub.issue_peer_publication_lease(request.peer_id.clone());
    inner.bind_channel_to_peer(&request.peer_id, request.data_channel_id, now_ms);
    inner
        .peer_connection_peers
        .insert(request.peer_connection_id, request.peer_id.clone());
    let previous_binding = inner.peer_bindings.get(&request.peer_id).cloned();
    let node_name = notification_peer_name(request.node_name.as_deref()).or_else(|| {
        previous_binding
            .as_ref()
            .and_then(|binding| binding.node_name.clone())
    });
    let latest_rtt_ms = previous_binding.and_then(|binding| binding.latest_rtt_ms);
    inner.peer_bindings.insert(
        request.peer_id.clone(),
        MeshSessionPeerBinding {
            native_event_epoch,
            native_event_lease: native_event_lease.clone(),
            data_channel_id: request.data_channel_id,
            node_name,
            latest_rtt_ms,
            advertised_method_ids: request.advertised_method_ids.into_iter().collect(),
            manifest_methods_ready: request.manifest_methods_ready,
            primary: request.primary,
            data_channel_codec,
        },
    );
    if let Some(local_peer_id) = request.local_peer_id {
        inner.provider_peer_id = Some(local_peer_id);
    }
    if let Some(service_instance_id) = request.provider_service_instance_id {
        inner.provider_service_instance_id = Some(service_instance_id);
    }
    let held = inner.sync_device_link(&app);
    let sessions = inner.registry.len();
    let notification_peers = inner.android_notification_peers();
    let notification_probe_generation = inner.start_notification_probe();
    drop(inner);
    update_android_notification_peers(&app, &notification_peers);
    if let Some(notification_probe_generation) = notification_probe_generation {
        spawn_android_notification_probe(
            app.clone(),
            state.inner().clone(),
            notification_probe_generation,
        );
    }
    publish_mesh_peer_state(
        native_event_epoch,
        &native_event_lease,
        &request.peer_id,
        true,
        sessions,
    );
    Ok(json!({
        "peerId": request.peer_id,
        "sessions": sessions,
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
    let removed_binding = inner.peer_bindings.remove(&request.peer_id);
    inner
        .peer_connection_peers
        .retain(|_, peer_id| peer_id != &request.peer_id);
    inner.cancel_native_rtt_peer(&request.peer_id);
    inner.fail_native_assistant_peer(&request.peer_id, TransportError::RequestFailed);
    let held = inner.sync_device_link(&app);
    let sessions = inner.registry.len();
    let notification_peers = inner.android_notification_peers();
    drop(inner);
    update_android_notification_peers(&app, &notification_peers);
    if let Some(binding) = removed_binding {
        publish_mesh_peer_state(
            binding.native_event_epoch,
            &binding.native_event_lease,
            &request.peer_id,
            false,
            sessions,
        );
        clear_global_native_event_peer(&request.peer_id);
    }
    Ok(json!({
        "peerId": request.peer_id,
        "removed": removed,
        "sessions": sessions,
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
    let drained = inner.set_surface_lifecycle(lifecycle);
    let current = inner.registry.lifecycle();
    Ok(json!({
        "lifecycle": current.as_str(),
        "drained": drained_payload(&inner, drained)?,
        "nativeBackgroundHeld": inner.native_surface_backgrounded,
    }))
}

/// Acknowledge a delivered resume batch and drain anything that arrived during it.
#[tauri::command]
pub async fn aurora_mesh_session_finish_resume(
    state: State<'_, MeshSessionState>,
) -> Result<Value, String> {
    let mut inner = state.inner.lock().await;
    let drained = inner.finish_surface_resume();
    let current = inner.registry.lifecycle();
    Ok(json!({
        "lifecycle": current.as_str(),
        "drained": drained_payload(&inner, drained)?,
        "nativeBackgroundHeld": inner.native_surface_backgrounded,
    }))
}

/// What the dispatcher has seen, for diagnostics and the soak report.
#[tauri::command]
pub async fn aurora_mesh_session_snapshot(
    state: State<'_, MeshSessionState>,
) -> Result<Value, String> {
    let inner = state.inner.lock().await;
    let mut snapshot = inner.registry.snapshot();
    if let Some(object) = snapshot.as_object_mut() {
        object.insert(
            "nativeBackgroundHeld".to_owned(),
            Value::Bool(inner.native_surface_backgrounded),
        );
    }
    Ok(snapshot)
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionLivePrivacyPrepareRequest {
    peer_id: String,
    retained_peer_id: String,
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionLivePrivacyPrepareReport {
    probe_id: String,
    peer_id: String,
    retained_peer_id: String,
    peer_subject: String,
    peer_owned_request_subject: String,
    retained_peer_subject: String,
    peerless_voice_subject: String,
    pending_assistant_before_boundary: usize,
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
#[derive(Clone)]
struct MeshSessionLivePrivacyProbeState {
    peer_id: String,
    retained_peer_id: String,
    peer_epoch: u64,
    retained_peer_epoch: u64,
    peer_lease: NativeEventPeerPublicationLease,
    retained_peer_lease: NativeEventPeerPublicationLease,
    peer_owned_request_subject: String,
    retained_peer_subject: String,
    peerless_voice_subject: String,
    pending_request_id: String,
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionLivePrivacyVerifyRequest {
    probe_id: String,
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionLivePrivacyPeerBoundaryReport {
    probe_id: String,
    peer_id: String,
    retained_peer_id: String,
    old_publication_rejected_after_boundary: bool,
    peer_subject_purged_after_boundary: bool,
    peer_owned_request_purged_after_boundary: bool,
    old_cursor_gap_after_boundary: bool,
    retained_peer_subject_retained_after_boundary: bool,
    retained_peer_old_publication_accepted_after_boundary: bool,
    peerless_voice_retained_after_boundary: bool,
    pending_assistant_cleared_after_boundary: bool,
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionLivePrivacyFreshRebindReport {
    probe_id: String,
    peer_id: String,
    old_publication_attempted_after_fresh_rebind: bool,
    old_publication_rejected_after_fresh_rebind: bool,
    old_peer_owned_request_absent_after_fresh_rebind: bool,
    fresh_binding_present_after_rebind: bool,
    fresh_publication_accepted_after_rebind: bool,
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSessionLivePrivacyProfileResetReport {
    probe_id: String,
    peer_id: String,
    retained_peer_id: String,
    old_publication_attempted_after_profile_reset: bool,
    old_publication_rejected_after_profile_reset: bool,
    old_profile_subjects_cleared: bool,
    replay_cleared: bool,
    pending_assistant_cleared_after_profile_reset: bool,
}

/// Prepare live privacy assertions using currently bound real peers.
///
/// The harness must call production unbind/rebind/profile-reset commands after
/// this command. Follow-up verification commands only inspect the captured old
/// publishers and subjects.
#[tauri::command]
#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
pub async fn aurora_mesh_session_live_privacy_prepare(
    state: State<'_, MeshSessionState>,
    request: MeshSessionLivePrivacyPrepareRequest,
) -> Result<Value, String> {
    if request.peer_id.trim().is_empty() || request.retained_peer_id.trim().is_empty() {
        return Err("peerId and retainedPeerId are required".to_owned());
    }
    if request.peer_id == request.retained_peer_id {
        return Err("peerId and retainedPeerId must be different bound peers".to_owned());
    }

    let hub = global_native_event_hub();
    let tag = format!("{}-{}", current_time_ms(), hub.next_sequence());
    let probe_id = format!("privacy-live-{tag}");
    let peer_owned_request_subject = format!("privacy-live-request-{tag}");
    let retained_peer_subject = format!("privacy-live-retained-{tag}");
    let peerless_voice_subject = format!("voice:privacy-live-local-{tag}");
    let pending_request_id = format!("privacy-live-pending-{tag}");

    let (peer_epoch, peer_lease, retained_peer_epoch, retained_peer_lease, pending_before) = {
        let mut inner = state.inner.lock().await;
        let peer_binding = inner
            .peer_bindings
            .get(&request.peer_id)
            .cloned()
            .ok_or_else(|| "peerId is not bound in the native mesh session".to_owned())?;
        let retained_binding = inner
            .peer_bindings
            .get(&request.retained_peer_id)
            .cloned()
            .ok_or_else(|| "retainedPeerId is not bound in the native mesh session".to_owned())?;
        let before = inner.native_assistant_pending.len();
        let _pending = inner
            .begin_native_assistant_call(
                Some(&request.peer_id),
                "privacy.live.probe",
                &pending_request_id,
                false,
                false,
                None,
            )
            .map_err(|error| format!("unable to create pending native assistant probe: {error}"))?;
        (
            peer_binding.native_event_epoch,
            peer_binding.native_event_lease,
            retained_binding.native_event_epoch,
            retained_binding.native_event_lease,
            inner.native_assistant_pending.len().saturating_sub(before),
        )
    };

    publish_required_peer_observation(
        peer_epoch,
        &peer_lease,
        &request.peer_id,
        &peer_owned_request_subject,
    )?;
    publish_required_peer_observation(
        retained_peer_epoch,
        &retained_peer_lease,
        &request.retained_peer_id,
        &retained_peer_subject,
    )?;
    hub.upsert_subject_snapshot(privacy_probe_subject_snapshot(
        &peerless_voice_subject,
        None,
        "voice.turn.active",
        "active",
        false,
    ));

    let report = MeshSessionLivePrivacyPrepareReport {
        probe_id: probe_id.clone(),
        peer_id: request.peer_id.clone(),
        retained_peer_id: request.retained_peer_id.clone(),
        peer_subject: request.peer_id.clone(),
        peer_owned_request_subject: peer_owned_request_subject.clone(),
        retained_peer_subject: retained_peer_subject.clone(),
        peerless_voice_subject: peerless_voice_subject.clone(),
        pending_assistant_before_boundary: pending_before,
    };

    state.inner.lock().await.live_privacy_probes.insert(
        probe_id,
        MeshSessionLivePrivacyProbeState {
            peer_id: request.peer_id,
            retained_peer_id: request.retained_peer_id,
            peer_epoch,
            retained_peer_epoch,
            peer_lease,
            retained_peer_lease,
            peer_owned_request_subject,
            retained_peer_subject,
            peerless_voice_subject,
            pending_request_id,
        },
    );
    serde_json::to_value(report).map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
pub async fn aurora_mesh_session_live_privacy_verify_peer_boundary(
    state: State<'_, MeshSessionState>,
    request: MeshSessionLivePrivacyVerifyRequest,
) -> Result<Value, String> {
    let probe = live_privacy_probe(&state, &request.probe_id).await?;
    let hub = global_native_event_hub();
    let peer_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.peer_id.clone()],
        after_sequence: Some(0),
        ..NativeEventFilter::default()
    });
    let request_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.peer_owned_request_subject.clone()],
        after_sequence: Some(0),
        ..NativeEventFilter::default()
    });
    let retained_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.retained_peer_subject.clone()],
        ..NativeEventFilter::default()
    });
    let peerless_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.peerless_voice_subject.clone()],
        ..NativeEventFilter::default()
    });
    let pending_cleared = !state
        .inner
        .lock()
        .await
        .native_assistant_pending
        .contains_key(&(probe.peer_id.clone(), probe.pending_request_id.clone()));

    serde_json::to_value(MeshSessionLivePrivacyPeerBoundaryReport {
        probe_id: request.probe_id,
        peer_id: probe.peer_id.clone(),
        retained_peer_id: probe.retained_peer_id.clone(),
        old_publication_rejected_after_boundary: old_peer_publication_rejected(&probe),
        peer_subject_purged_after_boundary: snapshot_is_purged_with_gap(&peer_snapshot),
        peer_owned_request_purged_after_boundary: snapshot_is_purged_with_gap(&request_snapshot),
        old_cursor_gap_after_boundary: snapshot_has_gap(&peer_snapshot)
            && snapshot_has_gap(&request_snapshot),
        retained_peer_subject_retained_after_boundary: snapshot_has_subject(
            &retained_snapshot,
            &probe.retained_peer_subject,
        ),
        retained_peer_old_publication_accepted_after_boundary: retained_peer_publication_accepted(
            &probe,
        ),
        peerless_voice_retained_after_boundary: snapshot_has_subject(
            &peerless_snapshot,
            &probe.peerless_voice_subject,
        ),
        pending_assistant_cleared_after_boundary: pending_cleared,
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
pub async fn aurora_mesh_session_live_privacy_verify_fresh_rebind(
    state: State<'_, MeshSessionState>,
    request: MeshSessionLivePrivacyVerifyRequest,
) -> Result<Value, String> {
    let probe = live_privacy_probe(&state, &request.probe_id).await?;
    let request_snapshot = global_native_event_hub().state_snapshot(NativeEventFilter {
        subjects: vec![probe.peer_owned_request_subject.clone()],
        ..NativeEventFilter::default()
    });
    let fresh_binding = {
        let inner = state.inner.lock().await;
        inner.peer_bindings.get(&probe.peer_id).cloned()
    };
    let fresh_publication_accepted = fresh_binding
        .as_ref()
        .and_then(|binding| {
            global_native_event_hub().publish_observation_with_peer_lease_if_epoch(
                binding.native_event_epoch,
                &binding.native_event_lease,
                mesh_peer_state_event(&probe.peer_id, true, 3),
                Some(mesh_peer_state_snapshot(&probe.peer_id, true, 3)),
            )
        })
        .is_some();

    serde_json::to_value(MeshSessionLivePrivacyFreshRebindReport {
        probe_id: request.probe_id,
        peer_id: probe.peer_id.clone(),
        old_publication_attempted_after_fresh_rebind: true,
        old_publication_rejected_after_fresh_rebind: old_peer_publication_rejected(&probe),
        old_peer_owned_request_absent_after_fresh_rebind: request_snapshot.subjects.is_empty(),
        fresh_binding_present_after_rebind: fresh_binding.is_some(),
        fresh_publication_accepted_after_rebind: fresh_publication_accepted,
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
pub async fn aurora_mesh_session_live_privacy_verify_profile_reset(
    state: State<'_, MeshSessionState>,
    request: MeshSessionLivePrivacyVerifyRequest,
) -> Result<Value, String> {
    let probe = live_privacy_probe(&state, &request.probe_id).await?;
    let hub = global_native_event_hub();
    let peer_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.peer_id.clone()],
        ..NativeEventFilter::default()
    });
    let request_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.peer_owned_request_subject.clone()],
        ..NativeEventFilter::default()
    });
    let retained_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.retained_peer_subject.clone()],
        ..NativeEventFilter::default()
    });
    let peerless_snapshot = hub.state_snapshot(NativeEventFilter {
        subjects: vec![probe.peerless_voice_subject.clone()],
        ..NativeEventFilter::default()
    });
    let pending_cleared = !state
        .inner
        .lock()
        .await
        .native_assistant_pending
        .contains_key(&(probe.peer_id.clone(), probe.pending_request_id.clone()));

    serde_json::to_value(MeshSessionLivePrivacyProfileResetReport {
        probe_id: request.probe_id,
        peer_id: probe.peer_id.clone(),
        retained_peer_id: probe.retained_peer_id.clone(),
        old_publication_attempted_after_profile_reset: true,
        old_publication_rejected_after_profile_reset: old_peer_publication_rejected(&probe),
        old_profile_subjects_cleared: peer_snapshot.subjects.is_empty()
            && request_snapshot.subjects.is_empty()
            && retained_snapshot.subjects.is_empty()
            && peerless_snapshot.subjects.is_empty(),
        replay_cleared: peer_snapshot.events.is_empty()
            && request_snapshot.events.is_empty()
            && retained_snapshot.events.is_empty()
            && peerless_snapshot.events.is_empty(),
        pending_assistant_cleared_after_profile_reset: pending_cleared,
    })
    .map_err(|error| error.to_string())
}

fn drained_payload(
    inner: &MeshSessionInner,
    drained: Vec<(String, Vec<QueuedFrame>)>,
) -> Result<Vec<MeshSessionDrain>, String> {
    drained
        .into_iter()
        .map(|(peer_id, frames)| {
            let codec = inner
                .peer_bindings
                .get(&peer_id)
                .and_then(|binding| binding.data_channel_codec.as_ref());
            let frames = frames
                .into_iter()
                .map(|queued| match codec {
                    Some(codec) => codec.seal_json(&queued.frame).map(|payload| {
                        MeshSessionDrainFrame::NativeBinary {
                            payload_base64: BASE64.encode(payload),
                        }
                    }),
                    None => Ok(MeshSessionDrainFrame::Json {
                        frame: queued.frame,
                    }),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(MeshSessionDrain { peer_id, frames })
        })
        .collect()
}

fn default_manifest_methods_ready() -> bool {
    true
}

impl MeshSessionInner {
    fn resolve_data_channel_codec(
        &self,
        peer_id: &str,
        data_channel_id: u64,
        requested: Option<Arc<NativeDataChannelCodec>>,
    ) -> Result<Option<Arc<NativeDataChannelCodec>>, String> {
        let existing = self.peer_bindings.get(peer_id);
        let Some(requested) = requested else {
            // Manifest hydration may rebind metadata on the same channel. Do
            // not downgrade an already-installed encrypted codec merely because
            // an older composition caller omitted the optional field.
            return Ok(existing
                .filter(|binding| binding.data_channel_id == data_channel_id)
                .and_then(|binding| binding.data_channel_codec.clone()));
        };
        if requested.key_epoch != data_channel_id {
            return Err("native data-channel codec epoch does not match its channel".to_owned());
        }
        if let Some(current) = existing.and_then(|binding| binding.data_channel_codec.as_ref()) {
            if requested.key_epoch < current.key_epoch {
                return Err("native data-channel codec epoch is stale".to_owned());
            }
            if requested.key_epoch == current.key_epoch
                && requested.key.as_ref() != current.key.as_ref()
            {
                return Err("native data-channel codec key changed within one epoch".to_owned());
            }
        }
        Ok(Some(requested))
    }

    fn set_surface_lifecycle(
        &mut self,
        lifecycle: SurfaceLifecycle,
    ) -> Vec<(String, Vec<QueuedFrame>)> {
        if lifecycle == SurfaceLifecycle::Foreground && self.native_surface_backgrounded {
            return Vec::new();
        }
        self.registry.set_lifecycle(lifecycle)
    }

    fn finish_surface_resume(&mut self) -> Vec<(String, Vec<QueuedFrame>)> {
        if self.native_surface_backgrounded {
            return Vec::new();
        }
        self.registry.finish_resume()
    }

    fn surface_is_backgrounded(&self) -> bool {
        self.native_surface_backgrounded || self.registry.lifecycle().is_background()
    }

    fn begin_background_call(
        &mut self,
        peer_id: &str,
        call_id: &str,
        now_ms: i64,
    ) -> BackgroundCallReplayDecision {
        if let Some(decision) = self.background_call_replay(peer_id, call_id, now_ms, true) {
            return decision;
        }
        let key = (peer_id.to_owned(), call_id.to_owned());
        self.background_call_replay_sequence = self.background_call_replay_sequence.wrapping_add(1);
        self.background_call_replays.insert(
            key,
            BackgroundCallReplayEntry {
                expires_at_ms: now_ms.saturating_add(BACKGROUND_CALL_REPLAY_TTL_MS),
                sequence: self.background_call_replay_sequence,
                state: BackgroundCallReplayState::Pending,
            },
        );
        self.prune_background_call_replays(now_ms);
        BackgroundCallReplayDecision::Execute
    }

    fn background_call_replay(
        &mut self,
        peer_id: &str,
        call_id: &str,
        now_ms: i64,
        background: bool,
    ) -> Option<BackgroundCallReplayDecision> {
        self.prune_background_call_replays(now_ms);
        let key = (peer_id.to_owned(), call_id.to_owned());
        let decision =
            self.background_call_replays
                .get(&key)
                .and_then(|entry| match &entry.state {
                    BackgroundCallReplayState::Pending => {
                        Some(BackgroundCallReplayDecision::Pending)
                    }
                    BackgroundCallReplayState::Answer {
                        frames,
                        replay_after_resume,
                    } if background || *replay_after_resume => {
                        Some(BackgroundCallReplayDecision::Answer(frames.clone()))
                    }
                    BackgroundCallReplayState::Answer { .. } => None,
                });
        if decision.is_none()
            && self.background_call_replays.get(&key).is_some_and(|entry| {
                matches!(
                    entry.state,
                    BackgroundCallReplayState::Answer {
                        replay_after_resume: false,
                        ..
                    }
                )
            })
        {
            self.background_call_replays.remove(&key);
        }
        decision
    }

    fn finish_background_call(
        &mut self,
        peer_id: &str,
        call_id: &str,
        frames: Vec<Value>,
        now_ms: i64,
        replay_after_resume: bool,
    ) {
        let key = (peer_id.to_owned(), call_id.to_owned());
        let Some(entry) = self.background_call_replays.get_mut(&key) else {
            return;
        };
        entry.expires_at_ms = now_ms.saturating_add(BACKGROUND_CALL_REPLAY_TTL_MS);
        entry.state = BackgroundCallReplayState::Answer {
            frames,
            replay_after_resume,
        };
    }

    fn abandon_background_call(&mut self, peer_id: &str, call_id: &str) {
        self.background_call_replays
            .remove(&(peer_id.to_owned(), call_id.to_owned()));
    }

    fn prune_background_call_replays(&mut self, now_ms: i64) {
        self.background_call_replays
            .retain(|_, entry| entry.expires_at_ms > now_ms);
        while self.background_call_replays.len() > BACKGROUND_CALL_REPLAY_MAX {
            let Some(oldest) = self
                .background_call_replays
                .iter()
                .min_by_key(|(_, entry)| entry.sequence)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.background_call_replays.remove(&oldest);
        }
    }

    fn reset_for_profile_change(&mut self) {
        let now_ms = current_time_ms();
        let bound_channels = self
            .channel_peers
            .iter()
            .map(|(data_channel_id, peer_id)| (*data_channel_id, peer_id.clone()))
            .collect::<Vec<_>>();
        for (data_channel_id, peer_id) in bound_channels {
            self.retire_channel_for_profile_reset(data_channel_id, &peer_id, now_ms);
        }
        self.prune_expiring_markers(now_ms);
        let peer_ids = self.peer_bindings.keys().cloned().collect::<Vec<_>>();
        for peer_id in peer_ids {
            revoke_global_native_event_peer_publication_leases(&peer_id);
        }
        self.registry = MeshSessionRegistry::default();
        self.channel_peers.clear();
        self.peer_channels.clear();
        self.peer_connection_peers.clear();
        self.peer_bindings.clear();
        self.native_assistant_pending.clear();
        self.native_assistant_abandoned.clear();
        self.native_rtt_pending.clear();
        self.provider_peer_id = None;
        self.provider_service_instance_id = None;
        self.background_call_replays.clear();
        self.background_call_replay_sequence = 0;
        #[cfg(target_os = "android")]
        {
            self.notification_probe_generation = self.notification_probe_generation.wrapping_add(1);
            self.notification_probe_running = false;
        }
    }

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

    fn android_notification_peers(&self) -> Vec<AndroidNotificationPeer> {
        let mut peers = self
            .peer_bindings
            .iter()
            .map(|(peer_id, binding)| {
                (
                    binding.primary,
                    AndroidNotificationPeer {
                        peer_id: peer_id.clone(),
                        display_name: binding
                            .node_name
                            .clone()
                            .unwrap_or_else(|| "Connected device".to_owned()),
                        round_trip_time_ms: binding.latest_rtt_ms,
                    },
                )
            })
            .collect::<Vec<_>>();
        peers.sort_by(|(left_primary, left), (right_primary, right)| {
            right_primary
                .cmp(left_primary)
                .then_with(|| left.display_name.cmp(&right.display_name))
                .then_with(|| left.peer_id.cmp(&right.peer_id))
        });
        peers.into_iter().map(|(_, peer)| peer).collect()
    }

    fn start_notification_probe(&mut self) -> Option<u64> {
        #[cfg(not(target_os = "android"))]
        {
            return None;
        }
        #[cfg(target_os = "android")]
        {
            if self.notification_probe_running || self.peer_connection_peers.is_empty() {
                return None;
            }
            self.notification_probe_running = true;
            Some(self.notification_probe_generation)
        }
    }

    fn record_notification_rtt(
        &mut self,
        peer_id: &str,
        data_channel_id: u64,
        round_trip_time_ms: f64,
    ) {
        let Some(binding) = self.peer_bindings.get_mut(peer_id) else {
            return;
        };
        if binding.data_channel_id != data_channel_id {
            return;
        }
        binding.latest_rtt_ms = Some(round_trip_time_ms);
    }

    fn begin_native_assistant_call(
        &mut self,
        preferred_peer_id: Option<&str>,
        method_id: &str,
        request_id: &str,
        require_advertised_method: bool,
        stream_events: bool,
        turn: Option<NativeMeshAssistantTurnLink>,
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
        let (subscription_ack_sender, subscription_ack) = if stream_events {
            let (sender, receiver) = oneshot::channel();
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        let (event_sender, events) = if stream_events {
            let (sender, receiver) = mpsc::channel(32);
            (Some(sender), Some(receiver))
        } else {
            (None, None)
        };
        self.native_assistant_pending.insert(
            (peer_id.clone(), request_id.to_owned()),
            NativeAssistantPendingResponse {
                native_event_epoch: binding.native_event_epoch,
                native_event_lease: binding.native_event_lease.clone(),
                data_channel_id: binding.data_channel_id,
                stream_events,
                turn: turn.clone(),
                sender,
                subscription_ack: subscription_ack_sender,
                events: event_sender,
            },
        );
        Ok(NativeAssistantPendingCall {
            peer_id,
            native_event_epoch: binding.native_event_epoch,
            native_event_lease: binding.native_event_lease.clone(),
            data_channel_id: binding.data_channel_id,
            local_peer_id: self.provider_peer_id.clone(),
            stream_events,
            turn,
            response,
            subscription_ack,
            events,
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
                .filter(|binding| !binding.native_event_lease.is_revoked())
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
            .filter(|(_, binding)| !binding.native_event_lease.is_revoked())
            .filter(|(_, binding)| {
                required_method_id.map_or(true, |method_id| {
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

    fn native_assistant_route_pending(
        &self,
        preferred_peer_id: Option<&str>,
        required_method_id: Option<&str>,
    ) -> bool {
        if let Some(peer_id) = preferred_peer_id {
            let Some(binding) = self.peer_bindings.get(peer_id) else {
                return true;
            };
            if binding.native_event_lease.is_revoked() {
                return false;
            }
            return required_method_id.is_some_and(|_| !binding.manifest_methods_ready);
        }

        let Some(required_method_id) = required_method_id else {
            return false;
        };

        let has_ready_candidate = self.peer_bindings.values().any(|binding| {
            !binding.native_event_lease.is_revoked()
                && binding.manifest_methods_ready
                && binding.advertised_method_ids.contains(required_method_id)
        });
        !has_ready_candidate
            && self.peer_bindings.values().any(|binding| {
                !binding.native_event_lease.is_revoked() && !binding.manifest_methods_ready
            })
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
                self.cancel_native_rtt_peer(peer_id);
            }
        }
    }

    fn cancel_native_rtt_peer(&mut self, peer_id: &str) {
        let keys = self
            .native_rtt_pending
            .keys()
            .filter(|(pending_peer_id, _)| pending_peer_id == peer_id)
            .cloned()
            .collect::<Vec<_>>();
        for (pending_peer_id, ping_id) in keys {
            self.native_rtt_pending
                .remove(&(pending_peer_id.clone(), ping_id.clone()));
            let _ = self.registry.cancel_native_ping(&pending_peer_id, &ping_id);
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
        let Some(request_id) = native_assistant_frame_request_id(frame) else {
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
        if frame_type != "result" && frame_type != "error" {
            if frame_type == "subscribed" {
                let Some(pending) = self.native_assistant_pending.get_mut(&key) else {
                    return NativeAssistantFrameDisposition::NotAssistant;
                };
                if let Some(subscription_ack) = pending.subscription_ack.take() {
                    let _ = subscription_ack.send(Ok(frame.clone()));
                }
                return NativeAssistantFrameDisposition::Consumed;
            }
            if frame_type == "subscribe_rejected" {
                let Some(mut pending) = self.native_assistant_pending.remove(&key) else {
                    return NativeAssistantFrameDisposition::NotAssistant;
                };
                if let Some(subscription_ack) = pending.subscription_ack.take() {
                    let _ = subscription_ack.send(Err(TransportError::UnknownEvent));
                }
                let _ = pending.sender.send(Err(TransportError::UnknownEvent));
                return NativeAssistantFrameDisposition::Consumed;
            }
            if frame_type != "event" {
                return NativeAssistantFrameDisposition::NotAssistant;
            }
            let native_event_epoch = pending.native_event_epoch;
            let publish_direct = !pending.stream_events;
            let linked_frame =
                native_assistant_linked_frame(frame, request_id, pending.turn.as_ref());
            let event_sender = pending.events.clone();
            if publish_direct {
                if let Some(draft) = assistant_observation_event(peer_id, &linked_frame) {
                    let _ = global_native_event_hub().publish_with_peer_lease_if_epoch(
                        native_event_epoch,
                        &pending.native_event_lease,
                        draft,
                    );
                }
            }
            if let Some(events) = event_sender.as_ref() {
                match events.try_send(Ok(linked_frame)) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) | Err(TrySendError::Closed(_)) => {
                        if let Some(pending) = self.native_assistant_pending.get_mut(&key) {
                            pending.events = None;
                        }
                    }
                }
            }
            return NativeAssistantFrameDisposition::Consumed;
        }
        let Some(pending) = self.native_assistant_pending.remove(&key) else {
            return NativeAssistantFrameDisposition::NotAssistant;
        };
        let linked_frame = native_assistant_linked_frame(frame, request_id, pending.turn.as_ref());
        if !pending.stream_events {
            if let Some(draft) = assistant_terminal_event(peer_id, request_id, &linked_frame) {
                let _ = global_native_event_hub().publish_with_peer_lease_if_epoch(
                    pending.native_event_epoch,
                    &pending.native_event_lease,
                    draft,
                );
            }
        }
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
        self.insert_retired_channel(data_channel_id, peer_id, now_ms, false);
        self.prune_expiring_markers(now_ms);
    }

    fn retire_channel_for_profile_reset(
        &mut self,
        data_channel_id: u64,
        peer_id: &str,
        now_ms: i64,
    ) {
        self.insert_retired_channel(data_channel_id, peer_id, now_ms, true);
    }

    fn insert_retired_channel(
        &mut self,
        data_channel_id: u64,
        peer_id: &str,
        now_ms: i64,
        swallow_all: bool,
    ) {
        let marker = self.new_expiring_marker(now_ms, RETIRED_CHANNEL_TTL_MS);
        self.retired_channel_peers.insert(
            data_channel_id,
            RetiredChannelPeer {
                peer_id: peer_id.to_owned(),
                marker,
                swallow_all,
            },
        );
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

fn native_event_epoch_for_bind(
    bind_start_native_event_epoch: u64,
    current_native_event_epoch: u64,
) -> Result<u64, String> {
    if current_native_event_epoch != bind_start_native_event_epoch {
        return Err("native event profile changed while binding peer".to_owned());
    }
    Ok(current_native_event_epoch)
}

fn publish_mesh_peer_state(
    epoch: u64,
    lease: &NativeEventPeerPublicationLease,
    peer_id: &str,
    connected: bool,
    sessions: usize,
) {
    let hub = global_native_event_hub();
    let _ = hub.publish_observation_with_peer_lease_if_epoch(
        epoch,
        lease,
        mesh_peer_state_event(peer_id, connected, sessions),
        Some(mesh_peer_state_snapshot(peer_id, connected, sessions)),
    );
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
async fn live_privacy_probe(
    state: &State<'_, MeshSessionState>,
    probe_id: &str,
) -> Result<MeshSessionLivePrivacyProbeState, String> {
    state
        .inner
        .lock()
        .await
        .live_privacy_probes
        .get(probe_id)
        .cloned()
        .ok_or_else(|| format!("unknown live privacy probe {probe_id}"))
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
fn publish_required_peer_observation(
    epoch: u64,
    lease: &NativeEventPeerPublicationLease,
    peer_id: &str,
    subject: &str,
) -> Result<(), String> {
    let hub = global_native_event_hub();
    let state_published = hub.publish_observation_with_peer_lease_if_epoch(
        epoch,
        lease,
        mesh_peer_state_event(peer_id, true, 1),
        Some(mesh_peer_state_snapshot(peer_id, true, 1)),
    );
    let request_published = hub.publish_observation_with_peer_lease_if_epoch(
        epoch,
        lease,
        NativeEventDraft::new(
            ASSISTANT_COMPLETED,
            json!({
                "type": "result",
                "id": subject,
                "generation": 1,
                "result": {}
            }),
        )
        .peer_id(peer_id.to_owned())
        .subject(subject.to_owned()),
        Some(privacy_probe_subject_snapshot(
            subject,
            Some(peer_id),
            ASSISTANT_COMPLETED,
            "complete",
            true,
        )),
    );
    if state_published.is_some() && request_published.is_some() {
        Ok(())
    } else {
        Err(format!(
            "active publication lease was rejected for {peer_id}"
        ))
    }
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
fn old_peer_publication_rejected(probe: &MeshSessionLivePrivacyProbeState) -> bool {
    global_native_event_hub()
        .publish_observation_with_peer_lease_if_epoch(
            probe.peer_epoch,
            &probe.peer_lease,
            mesh_peer_state_event(&probe.peer_id, true, 2),
            Some(mesh_peer_state_snapshot(&probe.peer_id, true, 2)),
        )
        .is_none()
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
fn retained_peer_publication_accepted(probe: &MeshSessionLivePrivacyProbeState) -> bool {
    global_native_event_hub()
        .publish_observation_with_peer_lease_if_epoch(
            probe.retained_peer_epoch,
            &probe.retained_peer_lease,
            mesh_peer_state_event(&probe.retained_peer_id, true, 2),
            Some(mesh_peer_state_snapshot(&probe.retained_peer_id, true, 2)),
        )
        .is_some()
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
fn privacy_probe_subject_snapshot(
    subject: &str,
    peer_id: Option<&str>,
    kind: &str,
    status: &str,
    terminal: bool,
) -> NativeEventSubjectSnapshot {
    NativeEventSubjectSnapshot {
        subject: subject.to_owned(),
        peer_id: peer_id.map(str::to_owned),
        kind: kind.to_owned(),
        generation: None,
        session_id: None,
        request_id: Some(subject.to_owned()),
        correlation_id: Some(subject.to_owned()),
        conversation_id: None,
        transcript: None,
        transcript_truncated: false,
        accumulated_text: None,
        text_truncated: false,
        status: status.to_owned(),
        terminal,
        persisted: None,
        persistence_error_code: None,
        updated_at: current_time_ms().to_string(),
    }
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
fn snapshot_has_subject(snapshot: &NativeEventStateSnapshot, subject: &str) -> bool {
    snapshot.subjects.iter().any(|candidate| {
        candidate.subject == subject || candidate.peer_id.as_deref() == Some(subject)
    })
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
fn snapshot_has_gap(snapshot: &NativeEventStateSnapshot) -> bool {
    snapshot.events.iter().any(|event| {
        event.kind == NATIVE_EVENTS_GAP
            && event.payload.get("reason").and_then(Value::as_str) == Some("subject_cleared")
    })
}

#[cfg(all(
    target_os = "android",
    debug_assertions,
    feature = "android-voice-live-test"
))]
fn snapshot_is_purged_with_gap(snapshot: &NativeEventStateSnapshot) -> bool {
    snapshot.subjects.is_empty() && !snapshot.replay_complete && snapshot_has_gap(snapshot)
}

fn stale_channel_should_swallow(retired: &RetiredChannelPeer, frame: &Value) -> bool {
    if retired.swallow_all {
        return true;
    }
    let Some(frame_type) = frame.get("type").and_then(Value::as_str) else {
        return false;
    };
    if !matches!(frame_type, "call" | "cancel" | "result" | "error") {
        return false;
    }
    frame
        .get("peer_id")
        .and_then(Value::as_str)
        .is_none_or(|peer_id| peer_id == retired.peer_id)
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

fn native_assistant_frame_request_id(frame: &Value) -> Option<&str> {
    frame
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| {
            frame
                .get("params")
                .and_then(|params| {
                    params
                        .get("request_id")
                        .or_else(|| params.get("requestId"))
                        .or_else(|| params.get("correlation_id"))
                        .or_else(|| params.get("correlationId"))
                })
                .and_then(Value::as_str)
        })
        .or_else(|| {
            frame
                .get("correlation_id")
                .or_else(|| frame.get("correlationId"))
                .and_then(Value::as_str)
        })
}

fn native_assistant_linked_frame(
    frame: &Value,
    request_id: &str,
    turn: Option<&NativeMeshAssistantTurnLink>,
) -> Value {
    let mut linked = frame.clone();
    let Some(object) = linked.as_object_mut() else {
        return linked;
    };
    object
        .entry("id".to_owned())
        .or_insert_with(|| Value::String(request_id.to_owned()));
    object
        .entry("request_id".to_owned())
        .or_insert_with(|| Value::String(request_id.to_owned()));
    if let Some(turn) = turn {
        insert_link_field(
            object,
            "generation",
            Value::Number(turn.generation().into()),
        );
        insert_link_field(
            object,
            "session_id",
            Value::String(turn.session_id().to_owned()),
        );
        insert_link_field(
            object,
            "sessionId",
            Value::String(turn.session_id().to_owned()),
        );
        insert_link_field(
            object,
            "request_id",
            Value::String(turn.request_id().to_owned()),
        );
        insert_link_field(
            object,
            "requestId",
            Value::String(turn.request_id().to_owned()),
        );
        insert_link_field(
            object,
            "correlation_id",
            Value::String(turn.correlation_id().to_owned()),
        );
        insert_link_field(
            object,
            "correlationId",
            Value::String(turn.correlation_id().to_owned()),
        );
        for nested_key in ["params", "payload", "result"] {
            if let Some(nested) = object.get_mut(nested_key).and_then(Value::as_object_mut) {
                insert_link_field(
                    nested,
                    "generation",
                    Value::Number(turn.generation().into()),
                );
                insert_link_field(
                    nested,
                    "session_id",
                    Value::String(turn.session_id().to_owned()),
                );
                insert_link_field(
                    nested,
                    "sessionId",
                    Value::String(turn.session_id().to_owned()),
                );
                insert_link_field(
                    nested,
                    "request_id",
                    Value::String(turn.request_id().to_owned()),
                );
                insert_link_field(
                    nested,
                    "requestId",
                    Value::String(turn.request_id().to_owned()),
                );
                insert_link_field(
                    nested,
                    "correlation_id",
                    Value::String(turn.correlation_id().to_owned()),
                );
                insert_link_field(
                    nested,
                    "correlationId",
                    Value::String(turn.correlation_id().to_owned()),
                );
            }
        }
    }
    linked
}

fn insert_link_field(object: &mut serde_json::Map<String, Value>, key: &str, value: Value) {
    object.entry(key.to_owned()).or_insert(value);
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
    Answer(Vec<OutboundDataChannelFrame>),
    /// Rust parked it. Nothing goes out and nothing is emitted.
    Parked,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OutboundDataChannelFrame {
    Text(String),
    Binary(Vec<u8>),
}

enum FrameRouting {
    Emit,
    Answer {
        frames: Vec<Value>,
        replay_after_resume: bool,
    },
}

/// Decide what happens to one inbound data-channel payload.
///
/// Called from `native_webrtc`'s `on_message` before anything reaches the
/// webview. A payload that is not a bound peer's JSON frame is passed straight
/// through. Once an encrypted codec is bound, authenticated binary frames are
/// opened here and Rust answers them with encrypted binary frames on the exact
/// same channel; ciphertext is never logged or exposed through snapshots.
pub async fn route_inbound(
    app: &AppHandle,
    state: &MeshSessionState,
    data_channel_id: u64,
    payload: &[u8],
    binary: bool,
    now_ms: i64,
) -> InboundRouting {
    let mut inner = state.inner.lock().await;
    inner.prune_expiring_markers(now_ms);
    let Some(peer_id) = inner.channel_peers.get(&data_channel_id).cloned() else {
        let retired_channel = inner.retired_channel_peers.get(&data_channel_id);
        if binary && retired_channel.is_some() {
            return InboundRouting::Parked;
        }
        let Ok(frame) = serde_json::from_slice::<Value>(payload) else {
            return match retired_channel {
                Some(retired) if retired.swallow_all => InboundRouting::Parked,
                _ => InboundRouting::Emit,
            };
        };
        return match retired_channel {
            Some(retired) if stale_channel_should_swallow(retired, &frame) => {
                InboundRouting::Parked
            }
            _ => InboundRouting::Emit,
        };
    };
    let codec = inner
        .peer_bindings
        .get(&peer_id)
        .filter(|binding| binding.data_channel_id == data_channel_id)
        .and_then(|binding| binding.data_channel_codec.as_ref());
    let frame = if binary {
        let Some(codec) = codec else {
            return InboundRouting::Emit;
        };
        match codec.open_json(payload) {
            Ok(frame) => frame,
            Err(_) => {
                eprintln!(
                    "aurora.mesh inbound_frame_rejected binary=true bytes={} reason=authentication_or_format",
                    payload.len()
                );
                return InboundRouting::Parked;
            }
        }
    } else {
        if codec.is_some() {
            eprintln!(
                "aurora.mesh inbound_frame_rejected binary=false bytes={} reason=codec_mismatch",
                payload.len()
            );
            return InboundRouting::Parked;
        }
        let Ok(frame) = serde_json::from_slice::<Value>(payload) else {
            return InboundRouting::Emit;
        };
        frame
    };
    if inner.settle_native_assistant_response(&peer_id, data_channel_id, &frame, now_ms)
        == NativeAssistantFrameDisposition::Consumed
    {
        return InboundRouting::Parked;
    }
    if let Ok(Some(sample)) = inner.registry.accept_native_pong(&peer_id, &frame, now_ms) {
        if let Some(pending) = inner
            .native_rtt_pending
            .remove(&(peer_id.clone(), sample.ping_id))
        {
            if pending.data_channel_id == data_channel_id {
                let measured_ms = (pending.started_at.elapsed().as_secs_f64() * 1_000.0).max(0.001);
                let _ = pending.sender.send(measured_ms);
            }
        }
        return InboundRouting::Parked;
    }

    let disposition = match inner.registry.accept_inbound(&peer_id, &frame, now_ms) {
        Ok(disposition) => disposition,
        // A frame for a peer the registry does not hold is not ours to swallow.
        Err(_) => return InboundRouting::Emit,
    };

    let routing = match disposition {
        InboundDisposition::Answer(frames) => {
            return finalize_routing_after_unlock(
                inner,
                state,
                data_channel_id,
                binary,
                FrameRouting::Answer {
                    frames,
                    replay_after_resume: true,
                },
            )
            .await;
        }
        InboundDisposition::Dispatch | InboundDisposition::Unknown => {
            return InboundRouting::Emit;
        }
        InboundDisposition::Queued { depth } => {
            let _ = depth;
            return InboundRouting::Parked;
        }
        InboundDisposition::Overflow(answer) => match answer {
            Some(frame) => {
                return finalize_routing_after_unlock(
                    inner,
                    state,
                    data_channel_id,
                    binary,
                    FrameRouting::Answer {
                        frames: vec![frame],
                        replay_after_resume: true,
                    },
                )
                .await;
            }
            None => return InboundRouting::Parked,
        },
        InboundDisposition::Authorize(pending) => {
            let background = inner.surface_is_backgrounded();
            if let Some(replay) =
                inner.background_call_replay(&peer_id, &pending.call_id, now_ms, background)
            {
                match replay {
                    BackgroundCallReplayDecision::Pending => return InboundRouting::Parked,
                    BackgroundCallReplayDecision::Answer(frames) => {
                        drop(inner);
                        return finalize_routing(
                            state,
                            data_channel_id,
                            binary,
                            FrameRouting::Answer {
                                frames,
                                replay_after_resume: true,
                            },
                        )
                        .await;
                    }
                    BackgroundCallReplayDecision::Execute => unreachable!("stored replay"),
                }
            }
            if background {
                debug_assert_eq!(
                    inner.begin_background_call(&peer_id, &pending.call_id, now_ms),
                    BackgroundCallReplayDecision::Execute
                );
            }
            drop(inner);
            let pending = *pending;
            let routing = settle(app, state, pending.clone(), background).await;
            if background {
                let mut inner = state.inner.lock().await;
                match &routing {
                    FrameRouting::Answer {
                        frames,
                        replay_after_resume,
                    } => inner.finish_background_call(
                        &pending.peer_id,
                        &pending.call_id,
                        frames.clone(),
                        now_ms,
                        *replay_after_resume,
                    ),
                    FrameRouting::Emit => {
                        inner.abandon_background_call(&pending.peer_id, &pending.call_id)
                    }
                }
            }
            routing
        }
    };
    finalize_routing(state, data_channel_id, binary, routing).await
}

async fn finalize_routing_after_unlock(
    inner: tokio::sync::MutexGuard<'_, MeshSessionInner>,
    state: &MeshSessionState,
    data_channel_id: u64,
    binary: bool,
    routing: FrameRouting,
) -> InboundRouting {
    // Binary replies need the channel codec from this same state. Release the
    // routing guard before the encoder reacquires it; retaining it here would
    // self-deadlock the data-channel callback and every later native call.
    drop(inner);
    finalize_routing(state, data_channel_id, binary, routing).await
}

async fn finalize_routing(
    state: &MeshSessionState,
    data_channel_id: u64,
    binary: bool,
    routing: FrameRouting,
) -> InboundRouting {
    match routing {
        FrameRouting::Emit => InboundRouting::Emit,
        FrameRouting::Answer { frames, .. } if !binary => InboundRouting::Answer(
            frames
                .into_iter()
                .map(|frame| OutboundDataChannelFrame::Text(frame.to_string()))
                .collect(),
        ),
        FrameRouting::Answer { frames, .. } => {
            let inner = state.inner.lock().await;
            let Some(peer_id) = inner.channel_peers.get(&data_channel_id) else {
                return InboundRouting::Parked;
            };
            let Some(codec) = inner
                .peer_bindings
                .get(peer_id)
                .filter(|binding| binding.data_channel_id == data_channel_id)
                .and_then(|binding| binding.data_channel_codec.as_ref())
            else {
                return InboundRouting::Parked;
            };
            let mut answers = Vec::with_capacity(frames.len());
            for frame in frames {
                let Ok(payload) = codec.seal_json(&frame) else {
                    eprintln!("aurora.mesh outbound_frame_rejected binary=true reason=seal_failed");
                    return InboundRouting::Parked;
                };
                answers.push(OutboundDataChannelFrame::Binary(payload));
            }
            InboundRouting::Answer(answers)
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
    let removed_binding = inner.peer_bindings.remove(&peer_id);
    inner.registry.unbind(&peer_id);
    inner.fail_native_assistant_peer(&peer_id, TransportError::RequestFailed);
    inner.sync_device_link(app);
    let sessions = inner.registry.len();
    let notification_peers = inner.android_notification_peers();
    drop(inner);
    update_android_notification_peers(app, &notification_peers);
    if let Some(binding) = removed_binding {
        publish_mesh_peer_state(
            binding.native_event_epoch,
            &binding.native_event_lease,
            &peer_id,
            false,
            sessions,
        );
        revoke_global_native_event_peer_publication_leases(&peer_id);
    }
}

pub async fn route_native_data_channel_closed(app: &AppHandle, data_channel_id: u64) {
    let Some(state) = app.try_state::<MeshSessionState>() else {
        return;
    };
    native_data_channel_closed(app, &state, data_channel_id).await;
}

impl MeshSessionState {
    /// Conservatively downgrade the native dispatcher when the mobile window
    /// is suspended. The native Tauri window event is emitted by Android's
    /// activity lifecycle even when the WebView is already frozen.
    ///
    /// This intentionally does not promote the dispatcher on resume. The
    /// WebView resume command owns the ordered drain and acknowledgement loop.
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub async fn mark_surface_backgrounded(&self) {
        let mut inner = self.inner.lock().await;
        inner.native_surface_backgrounded = true;
        let _ = inner.registry.set_lifecycle(SurfaceLifecycle::Background);
    }

    /// Release the native background hold after Android/iOS reports a real
    /// resume. The WebView is then prompted through
    /// [`MESH_SURFACE_RESUMED_EVENT`] to perform the existing ordered drain;
    /// native code never discards queued frames by promoting on its own.
    #[cfg_attr(not(mobile), allow(dead_code))]
    pub async fn mark_surface_resumed(&self) {
        self.inner.lock().await.native_surface_backgrounded = false;
    }

    /// Clear profile-scoped native routing without treating a window hide/reopen
    /// as an identity change. The next authorized bind creates fresh publication
    /// leases and peer routing; stale pending work is dropped with the old scope.
    pub async fn reset_for_profile_change(&self, app: &AppHandle) {
        let mut inner = self.inner.lock().await;
        inner.reset_for_profile_change();
        inner.sync_device_link(app);
        let notification_peers = inner.android_notification_peers();
        drop(inner);
        update_android_notification_peers(app, &notification_peers);
    }

    /// Remove a revoked peer from the native session registry and pending assistant calls.
    ///
    /// Authority revocation owns permissions; this only drops Rust session state so
    /// a revoked binding cannot be selected for new native assistant calls before
    /// the peer completes a fresh authorized bind.
    pub async fn revoke_peer_authority(&self, app: &AppHandle, peer_id: &str) {
        let mut inner = self.inner.lock().await;
        if let Some(channel_id) = inner.peer_channels.remove(peer_id) {
            inner.channel_peers.remove(&channel_id);
        }
        let removed_binding = inner.peer_bindings.remove(peer_id);
        inner
            .peer_connection_peers
            .retain(|_, candidate_peer_id| candidate_peer_id != peer_id);
        inner.registry.unbind(peer_id);
        inner.cancel_native_rtt_peer(peer_id);
        inner.fail_native_assistant_peer(peer_id, TransportError::RequestFailed);
        inner.sync_device_link(app);
        let sessions = inner.registry.len();
        let notification_peers = inner.android_notification_peers();
        drop(inner);
        update_android_notification_peers(app, &notification_peers);
        if let Some(binding) = removed_binding {
            publish_mesh_peer_state(
                binding.native_event_epoch,
                &binding.native_event_lease,
                peer_id,
                false,
                sessions,
            );
        }
        clear_global_native_event_peer(peer_id);
    }

    /// Measure the native data channel's application-layer round trip.
    ///
    /// The ping is created, correlated and consumed in Rust. The WebView only
    /// asks for the sample and receives the measured duration, so background
    /// session liveness never depends on JavaScript timers or frame handling.
    pub async fn measure_native_rtt(
        &self,
        app: &AppHandle,
        native_webrtc: &crate::native_webrtc::NativeWebRtcState,
        peer_connection_id: u64,
    ) -> Result<f64, String> {
        self.measure_native_rtt_with_generation(app, native_webrtc, peer_connection_id, None)
            .await
    }

    async fn measure_native_rtt_with_generation(
        &self,
        app: &AppHandle,
        native_webrtc: &crate::native_webrtc::NativeWebRtcState,
        peer_connection_id: u64,
        #[cfg_attr(not(target_os = "android"), allow(unused_variables))]
        expected_notification_probe_generation: Option<u64>,
    ) -> Result<f64, String> {
        let (peer_id, data_channel_id, ping_id, outbound, response) = {
            let mut inner = self.inner.lock().await;
            #[cfg(target_os = "android")]
            if expected_notification_probe_generation
                .is_some_and(|generation| generation != inner.notification_probe_generation)
            {
                return Err("native notification probe was superseded".to_owned());
            }
            let peer_id = inner
                .peer_connection_peers
                .get(&peer_connection_id)
                .cloned()
                .ok_or_else(|| "native mesh session is not bound to this connection".to_owned())?;
            let binding = inner
                .peer_bindings
                .get(&peer_id)
                .cloned()
                .ok_or_else(|| "native mesh data channel is unavailable".to_owned())?;
            let frame = inner
                .registry
                .begin_native_ping(&peer_id, current_time_ms())
                .map_err(|error| error.to_string())?;
            let ping_id = frame
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "native latency ping has no correlation id".to_owned())?
                .to_owned();
            let outbound = match binding.data_channel_codec.as_ref() {
                Some(codec) => codec
                    .seal_json(&frame)
                    .map(OutboundDataChannelFrame::Binary)?,
                None => OutboundDataChannelFrame::Text(
                    serde_json::to_string(&frame).map_err(|error| error.to_string())?,
                ),
            };
            let (sender, response) = oneshot::channel();
            inner.native_rtt_pending.insert(
                (peer_id.clone(), ping_id.clone()),
                NativeRttPendingResponse {
                    data_channel_id: binding.data_channel_id,
                    started_at: Instant::now(),
                    sender,
                },
            );
            (
                peer_id,
                binding.data_channel_id,
                ping_id,
                outbound,
                response,
            )
        };

        let send_result = match outbound {
            OutboundDataChannelFrame::Text(payload) => {
                crate::native_webrtc::send_native_text_data_channel(
                    app.clone(),
                    native_webrtc,
                    data_channel_id,
                    payload,
                )
                .await
            }
            OutboundDataChannelFrame::Binary(payload) => {
                crate::native_webrtc::send_native_binary_data_channel(
                    app.clone(),
                    native_webrtc,
                    data_channel_id,
                    payload,
                )
                .await
            }
        };
        if let Err(error) = send_result {
            self.cancel_native_rtt(&peer_id, &ping_id).await;
            return Err(error.to_string());
        }

        let result = match tokio::time::timeout(NATIVE_RTT_TIMEOUT, response).await {
            Ok(Ok(round_trip_time_ms)) => Ok(round_trip_time_ms),
            Ok(Err(_)) => {
                self.cancel_native_rtt(&peer_id, &ping_id).await;
                Err("native latency measurement was interrupted".to_owned())
            }
            Err(_) => {
                self.cancel_native_rtt(&peer_id, &ping_id).await;
                Err("native latency measurement timed out".to_owned())
            }
        };
        if let Ok(round_trip_time_ms) = result.as_ref() {
            let notification_peers = {
                let mut inner = self.inner.lock().await;
                inner.record_notification_rtt(&peer_id, data_channel_id, *round_trip_time_ms);
                inner.android_notification_peers()
            };
            update_android_notification_peers(app, &notification_peers);
        }
        result
    }

    async fn cancel_native_rtt(&self, peer_id: &str, ping_id: &str) {
        let mut inner = self.inner.lock().await;
        inner
            .native_rtt_pending
            .remove(&(peer_id.to_owned(), ping_id.to_owned()));
        let _ = inner.registry.cancel_native_ping(peer_id, ping_id);
    }

    #[cfg(test)]
    pub async fn begin_native_assistant_call(
        &self,
        preferred_peer_id: Option<&str>,
        method_id: &str,
        request_id: &str,
        require_advertised_method: bool,
        stream_events: bool,
        turn: Option<NativeMeshAssistantTurnLink>,
    ) -> Result<NativeAssistantPendingCall, TransportError> {
        let mut inner = self.inner.lock().await;
        inner.begin_native_assistant_call(
            preferred_peer_id,
            method_id,
            request_id,
            require_advertised_method,
            stream_events,
            turn,
        )
    }

    pub async fn begin_native_assistant_call_or_wait(
        &self,
        preferred_peer_id: Option<&str>,
        method_id: &str,
        request_id: &str,
        require_advertised_method: bool,
        stream_events: bool,
        turn: Option<NativeMeshAssistantTurnLink>,
    ) -> Result<Option<NativeAssistantPendingCall>, TransportError> {
        let mut inner = self.inner.lock().await;
        let request_id_in_use = inner
            .native_assistant_pending
            .keys()
            .any(|(_, pending_request_id)| pending_request_id == request_id);
        let route_pending = !request_id_in_use
            && inner.native_assistant_route_pending(
                preferred_peer_id,
                require_advertised_method.then_some(method_id),
            );
        match inner.begin_native_assistant_call(
            preferred_peer_id,
            method_id,
            request_id,
            require_advertised_method,
            stream_events,
            turn,
        ) {
            Ok(pending) => Ok(Some(pending)),
            Err(error)
                if route_pending
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

    pub async fn encode_native_assistant_frame(
        &self,
        peer_id: &str,
        data_channel_id: u64,
        frame: &Value,
    ) -> Result<OutboundDataChannelFrame, TransportError> {
        let inner = self.inner.lock().await;
        let binding = inner
            .peer_bindings
            .get(peer_id)
            .filter(|binding| binding.data_channel_id == data_channel_id)
            .ok_or(TransportError::RequestFailed)?;
        match binding.data_channel_codec.as_ref() {
            Some(codec) => codec
                .seal_json(frame)
                .map(OutboundDataChannelFrame::Binary)
                .map_err(|_| TransportError::RequestFailed),
            None => serde_json::to_string(frame)
                .map(OutboundDataChannelFrame::Text)
                .map_err(|_| TransportError::InvalidPayload),
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
    pub(crate) async fn test_bind_native_assistant_peer_with_codec(
        &self,
        peer_id: &str,
        data_channel_id: u64,
        advertised_method_ids: &[&str],
        primary: bool,
        local_peer_id: Option<&str>,
        key_bytes: Vec<u8>,
    ) {
        self.test_bind_native_assistant_peer(
            peer_id,
            data_channel_id,
            advertised_method_ids,
            primary,
            local_peer_id,
        )
        .await;
        let codec =
            Arc::new(NativeDataChannelCodec::new(data_channel_id, key_bytes).expect("test codec"));
        self.inner
            .lock()
            .await
            .peer_bindings
            .get_mut(peer_id)
            .expect("test peer binding")
            .data_channel_codec = Some(codec);
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
                native_event_epoch: global_native_event_hub().source_epoch(),
                native_event_lease: global_native_event_hub()
                    .issue_peer_publication_lease(peer_id.to_owned()),
                data_channel_id,
                node_name: None,
                latest_rtt_ms: None,
                advertised_method_ids: advertised_method_ids
                    .iter()
                    .map(|method| (*method).to_owned())
                    .collect(),
                manifest_methods_ready,
                primary,
                data_channel_codec: None,
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
                Some(retired) if stale_channel_should_swallow(retired, frame) => {
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
) -> FrameRouting {
    let decision = authorize(app, &pending.authorize).await;
    let mut inner = state.inner.lock().await;
    let outcome = match inner.registry.settle_call(&pending, &decision) {
        Ok(outcome) => outcome,
        Err(_) => return FrameRouting::Emit,
    };
    match outcome {
        CallOutcome::Denied(frame) => {
            if background {
                log_background_tool_call(&pending, "denied");
            }
            FrameRouting::Answer {
                frames: vec![frame],
                replay_after_resume: true,
            }
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
            FrameRouting::Answer {
                frames: vec![frame],
                replay_after_resume: false,
            }
        }
        CallOutcome::Serve { .. } => {
            let Some(provider_peer_id) = inner.provider_peer_id.clone() else {
                let _ = inner
                    .registry
                    .record_background_tooling_result(&pending, BackgroundToolingResult::Failed);
                log_background_tool_call(&pending, "failed_provider_identity_missing");
                return FrameRouting::Answer {
                    frames: vec![bridge_error_frame(
                        &pending.call_id,
                        503,
                        "provider_identity_missing",
                    )],
                    replay_after_resume: true,
                };
            };
            let Some(provider_service_instance_id) = inner.provider_service_instance_id.clone()
            else {
                let _ = inner
                    .registry
                    .record_background_tooling_result(&pending, BackgroundToolingResult::Failed);
                log_background_tool_call(&pending, "failed_provider_identity_missing");
                return FrameRouting::Answer {
                    frames: vec![bridge_error_frame(
                        &pending.call_id,
                        503,
                        "provider_identity_missing",
                    )],
                    replay_after_resume: true,
                };
            };
            drop(inner);
            let Some(native) = app.try_state::<crate::AuroraMobileNativePlugin<tauri::Wry>>()
            else {
                record_background_result(state, &pending, BackgroundToolingResult::Failed).await;
                log_background_tool_call(&pending, "failed_native_manifest_missing");
                return FrameRouting::Answer {
                    frames: vec![bridge_error_frame(
                        &pending.call_id,
                        503,
                        "native_manifest_unavailable",
                    )],
                    replay_after_resume: true,
                };
            };
            let native_manifest = match crate::native_capability_manifest_value(native).await {
                Ok(value) => value,
                Err(_) => {
                    record_background_result(state, &pending, BackgroundToolingResult::Failed)
                        .await;
                    log_background_tool_call(&pending, "failed_native_manifest_unavailable");
                    return FrameRouting::Answer {
                        frames: vec![bridge_error_frame(
                            &pending.call_id,
                            503,
                            "native_manifest_unavailable",
                        )],
                        replay_after_resume: true,
                    };
                }
            };
            let provider = BackgroundToolingProviderContext {
                provider_peer_id,
                provider_service_instance_id,
                native_manifest,
            };
            let (frame, result) =
                match execute_background_tooling_call(&pending, &decision, &provider) {
                    Ok(frame) => {
                        let result = classify_background_tooling_result(&pending.method_id, &frame);
                        (frame, result)
                    }
                    Err(_) => (
                        bridge_error_frame(
                            &pending.call_id,
                            400,
                            "background_tooling_contract_invalid",
                        ),
                        BackgroundToolingResult::Failed,
                    ),
                };
            record_background_result(state, &pending, result).await;
            log_background_tool_call(&pending, background_result_marker(result));
            FrameRouting::Answer {
                frames: vec![frame],
                replay_after_resume: true,
            }
        }
        CallOutcome::Orchestrate { .. } => FrameRouting::Emit,
    }
}

async fn record_background_result(
    state: &MeshSessionState,
    pending: &PendingCall,
    result: BackgroundToolingResult,
) {
    let mut inner = state.inner.lock().await;
    let _ = inner
        .registry
        .record_background_tooling_result(pending, result);
}

fn background_result_marker(result: BackgroundToolingResult) -> &'static str {
    match result {
        BackgroundToolingResult::Served => "served",
        BackgroundToolingResult::Denied => "denied",
        BackgroundToolingResult::Failed => "failed_execution",
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
/// Every semantic outcome is logged for diagnosis, but the soak qualifies only
/// `served`: denied, deferred, and failed outcomes have distinct markers and
/// counters so they cannot masquerade as successful background execution.
fn log_background_tool_call(pending: &PendingCall, outcome: &str) {
    println!(
        "aurora.mesh {BACKGROUND_TOOL_CALL_MARKER} outcome={outcome} method={}",
        pending.method_id
    );
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
    run_device_link_command(app, "meshDeviceLinkHold", json!({}));
}

#[cfg(target_os = "android")]
fn release_device_link(app: &AppHandle) {
    run_device_link_command(app, "meshDeviceLinkRelease", json!({}));
}

#[cfg(target_os = "android")]
fn update_android_notification_peers(app: &AppHandle, peers: &[AndroidNotificationPeer]) {
    run_device_link_command(app, "meshDeviceLinkUpdate", json!({ "peers": peers }));
}

#[cfg(not(target_os = "android"))]
fn update_android_notification_peers(_app: &AppHandle, _peers: &[AndroidNotificationPeer]) {}

#[cfg(target_os = "android")]
fn run_device_link_command(app: &AppHandle, command: &str, payload: Value) {
    use tauri::Manager;
    let Some(native) = app.try_state::<crate::AuroraMobileNativePlugin<tauri::Wry>>() else {
        return;
    };
    if let Err(error) = crate::run_android_plugin_command(native, command, payload) {
        // A held session is worth more than a notification. Losing the hold
        // means the process may be killed sooner, not that the session is
        // wrong, so this is reported and not propagated.
        eprintln!("aurora.mesh device link {command} failed: {error}");
    }
}

#[cfg(target_os = "android")]
fn spawn_android_notification_probe(
    app: AppHandle,
    state: MeshSessionState,
    notification_probe_generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ANDROID_NOTIFICATION_RTT_INITIAL_DELAY).await;
        loop {
            let peer_connection_ids = {
                let mut inner = state.inner.lock().await;
                if inner.notification_probe_generation != notification_probe_generation {
                    return;
                }
                let ids = inner
                    .peer_connection_peers
                    .keys()
                    .copied()
                    .collect::<Vec<_>>();
                if ids.is_empty() {
                    inner.notification_probe_running = false;
                }
                ids
            };
            if peer_connection_ids.is_empty() {
                return;
            }
            use tauri::Manager;
            let Some(native_webrtc) = app
                .try_state::<crate::native_webrtc::NativeWebRtcState>()
                .map(|native| native.inner().clone())
            else {
                let mut inner = state.inner.lock().await;
                if inner.notification_probe_generation == notification_probe_generation {
                    inner.notification_probe_running = false;
                }
                return;
            };
            for peer_connection_id in peer_connection_ids {
                let _ = state
                    .measure_native_rtt_with_generation(
                        &app,
                        &native_webrtc,
                        peer_connection_id,
                        Some(notification_probe_generation),
                    )
                    .await;
            }
            tokio::time::sleep(ANDROID_NOTIFICATION_RTT_INTERVAL).await;
        }
    });
}

#[cfg(not(target_os = "android"))]
fn spawn_android_notification_probe(
    _app: AppHandle,
    _state: MeshSessionState,
    _notification_probe_generation: u64,
) {
}

fn notification_peer_name(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let normalized = value
        .chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect::<String>();
    (!normalized.is_empty()).then_some(normalized)
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

    fn install_ready_assistant_binding(
        inner: &mut MeshSessionInner,
        peer_id: &str,
        peer_connection_id: u64,
        data_channel_id: u64,
    ) -> NativeEventPeerPublicationLease {
        let lease = global_native_event_hub().issue_peer_publication_lease(peer_id);
        inner
            .registry
            .bind(peer_id, peer_connection_id, None)
            .expect("test registry bind");
        inner.bind_channel_to_peer(peer_id, data_channel_id, 100);
        inner
            .peer_connection_peers
            .insert(peer_connection_id, peer_id.to_owned());
        inner.peer_bindings.insert(
            peer_id.to_owned(),
            MeshSessionPeerBinding {
                native_event_epoch: global_native_event_hub().source_epoch(),
                native_event_lease: lease.clone(),
                data_channel_id,
                node_name: None,
                latest_rtt_ms: None,
                advertised_method_ids: BTreeSet::from([
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT.to_owned()
                ]),
                manifest_methods_ready: true,
                primary: true,
                data_channel_codec: None,
            },
        );
        lease
    }

    #[test]
    fn native_suspend_marks_the_dispatcher_background_without_promoting_it() {
        block_on(async {
            let state = MeshSessionState::default();
            state.mark_surface_backgrounded().await;
            {
                let mut inner = state.inner.lock().await;
                assert!(inner.native_surface_backgrounded);
                assert_eq!(inner.registry.lifecycle(), SurfaceLifecycle::Background);
                assert!(inner
                    .set_surface_lifecycle(SurfaceLifecycle::Foreground)
                    .is_empty());
                assert_eq!(inner.registry.lifecycle(), SurfaceLifecycle::Background);
                assert!(inner.finish_surface_resume().is_empty());
                assert_eq!(inner.registry.lifecycle(), SurfaceLifecycle::Background);
            }
            state.mark_surface_backgrounded().await;
            state.mark_surface_resumed().await;
            let mut inner = state.inner.lock().await;
            assert!(!inner.native_surface_backgrounded);
            assert!(inner
                .set_surface_lifecycle(SurfaceLifecycle::Foreground)
                .is_empty());
            assert_eq!(inner.registry.lifecycle(), SurfaceLifecycle::Resuming);
            assert!(inner.finish_surface_resume().is_empty());
            assert_eq!(inner.registry.lifecycle(), SurfaceLifecycle::Foreground);
        });
    }

    #[test]
    fn surface_lifecycle_does_not_clear_profile_scoped_routes_or_pending_work() {
        let mut inner = MeshSessionInner::default();
        install_ready_assistant_binding(&mut inner, "peer-a", 1, 10);
        inner.provider_peer_id = Some("local-peer".to_owned());
        inner.provider_service_instance_id = Some("provider-service".to_owned());
        let _assistant_call = inner
            .begin_native_assistant_call(
                Some("peer-a"),
                ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                "assistant-request",
                true,
                false,
                None,
            )
            .expect("assistant call starts");
        let (rtt_sender, _rtt_receiver) = oneshot::channel();
        inner.native_rtt_pending.insert(
            ("peer-a".to_owned(), "ping-1".to_owned()),
            NativeRttPendingResponse {
                data_channel_id: 10,
                started_at: Instant::now(),
                sender: rtt_sender,
            },
        );
        assert_eq!(
            inner.begin_background_call("peer-a", "call-1", 100),
            BackgroundCallReplayDecision::Execute
        );

        assert!(inner
            .set_surface_lifecycle(SurfaceLifecycle::Background)
            .is_empty());

        assert!(inner.peer_bindings.contains_key("peer-a"));
        assert!(inner.peer_channels.contains_key("peer-a"));
        assert!(inner
            .native_assistant_pending
            .contains_key(&("peer-a".to_owned(), "assistant-request".to_owned())));
        assert!(inner
            .native_rtt_pending
            .contains_key(&("peer-a".to_owned(), "ping-1".to_owned())));
        assert!(inner
            .background_call_replays
            .contains_key(&("peer-a".to_owned(), "call-1".to_owned())));
        assert_eq!(inner.provider_peer_id.as_deref(), Some("local-peer"));
        assert_eq!(
            inner.provider_service_instance_id.as_deref(),
            Some("provider-service")
        );
    }

    #[test]
    fn profile_reset_clears_bindings_pending_work_and_revokes_old_leases() {
        let mut inner = MeshSessionInner::default();
        let old_lease = install_ready_assistant_binding(&mut inner, "peer-a", 1, 10);
        inner.native_surface_backgrounded = true;
        inner.provider_peer_id = Some("local-peer".to_owned());
        inner.provider_service_instance_id = Some("provider-service".to_owned());
        let _assistant_call = inner
            .begin_native_assistant_call(
                Some("peer-a"),
                ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                "assistant-request",
                true,
                false,
                None,
            )
            .expect("assistant call starts");
        let (rtt_sender, _rtt_receiver) = oneshot::channel();
        inner.native_rtt_pending.insert(
            ("peer-a".to_owned(), "ping-1".to_owned()),
            NativeRttPendingResponse {
                data_channel_id: 10,
                started_at: Instant::now(),
                sender: rtt_sender,
            },
        );
        inner.native_assistant_abandoned.insert(
            ("peer-a".to_owned(), "late-assistant".to_owned()),
            ExpiringMarker {
                expires_at_ms: 10_000,
                sequence: 1,
            },
        );
        assert_eq!(
            inner.begin_background_call("peer-a", "call-1", 100),
            BackgroundCallReplayDecision::Execute
        );

        inner.reset_for_profile_change();

        assert!(old_lease.is_revoked());
        assert!(inner.registry.len() == 0);
        assert!(inner.channel_peers.is_empty());
        assert!(inner.peer_channels.is_empty());
        assert!(inner.peer_connection_peers.is_empty());
        assert!(inner.peer_bindings.is_empty());
        assert!(inner.native_assistant_pending.is_empty());
        assert!(inner.native_assistant_abandoned.is_empty());
        assert!(inner.native_rtt_pending.is_empty());
        let retired = inner
            .retired_channel_peers
            .get(&10)
            .expect("profile reset tombstones the still-open channel");
        assert_eq!(retired.peer_id, "peer-a");
        assert!(retired.swallow_all);
        assert!(stale_channel_should_swallow(
            retired,
            &json!({"type": "unknown", "payload": "late old profile frame"})
        ));
        assert!(inner.background_call_replays.is_empty());
        assert!(inner.provider_peer_id.is_none());
        assert!(inner.provider_service_instance_id.is_none());
        assert!(inner.native_surface_backgrounded);
        assert_eq!(
            inner
                .begin_native_assistant_call(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "assistant-after-reset",
                    true,
                    false,
                    None,
                )
                .expect_err("profile reset requires a fresh authorized bind"),
            TransportError::InvalidConfiguration
        );
    }

    #[test]
    fn profile_reset_bounds_retired_channel_tombstones_without_inbound_activity() {
        let mut inner = MeshSessionInner::default();
        for index in 0..(RETIRED_CHANNEL_MAX + 25) {
            let peer_id = format!("peer-{index}");
            inner.channel_peers.insert(index as u64, peer_id.clone());
            inner.peer_channels.insert(peer_id, index as u64);
        }

        inner.reset_for_profile_change();

        assert_eq!(inner.retired_channel_peers.len(), RETIRED_CHANNEL_MAX);
        assert!(inner
            .retired_channel_peers
            .values()
            .all(|retired| retired.swallow_all));
    }

    #[test]
    fn stale_native_event_epoch_rejects_bind_before_registry_or_lease_install() {
        assert!(native_event_epoch_for_bind(7, 8)
            .expect_err("bind that started before profile reset is rejected")
            .contains("profile changed"));
        assert_eq!(
            native_event_epoch_for_bind(8, 8).expect("same epoch bind continues"),
            8
        );
    }

    #[cfg(target_os = "android")]
    #[test]
    fn profile_reset_invalidates_existing_notification_probe_generation() {
        let mut inner = MeshSessionInner::default();
        install_ready_assistant_binding(&mut inner, "peer-a", 1, 10);

        let old_generation = inner
            .start_notification_probe()
            .expect("first peer starts notification probe");
        assert!(inner.notification_probe_running);

        inner.reset_for_profile_change();
        assert_ne!(inner.notification_probe_generation, old_generation);
        assert!(!inner.notification_probe_running);

        install_ready_assistant_binding(&mut inner, "peer-b", 2, 20);
        let new_generation = inner
            .start_notification_probe()
            .expect("fresh profile bind starts its own probe");
        assert_ne!(new_generation, old_generation);
    }

    #[test]
    fn notification_peers_are_named_primary_first_and_keep_exact_rtt() {
        let mut inner = MeshSessionInner::default();
        inner.peer_bindings.insert(
            "peer-b".to_owned(),
            MeshSessionPeerBinding {
                native_event_epoch: global_native_event_hub().source_epoch(),
                native_event_lease: global_native_event_hub()
                    .issue_peer_publication_lease("peer-b"),
                data_channel_id: 20,
                node_name: notification_peer_name(Some("  Kitchen tablet  ")),
                latest_rtt_ms: None,
                advertised_method_ids: BTreeSet::new(),
                manifest_methods_ready: true,
                primary: false,
                data_channel_codec: None,
            },
        );
        inner.peer_bindings.insert(
            "peer-a".to_owned(),
            MeshSessionPeerBinding {
                native_event_epoch: global_native_event_hub().source_epoch(),
                native_event_lease: global_native_event_hub()
                    .issue_peer_publication_lease("peer-a"),
                data_channel_id: 10,
                node_name: notification_peer_name(Some("Skyron server")),
                latest_rtt_ms: None,
                advertised_method_ids: BTreeSet::new(),
                manifest_methods_ready: true,
                primary: true,
                data_channel_codec: None,
            },
        );
        inner.record_notification_rtt("peer-a", 10, 332.4);
        inner.record_notification_rtt("peer-b", 99, 1.0);

        assert_eq!(
            inner.android_notification_peers(),
            vec![
                AndroidNotificationPeer {
                    peer_id: "peer-a".to_owned(),
                    display_name: "Skyron server".to_owned(),
                    round_trip_time_ms: Some(332.4),
                },
                AndroidNotificationPeer {
                    peer_id: "peer-b".to_owned(),
                    display_name: "Kitchen tablet".to_owned(),
                    round_trip_time_ms: None,
                },
            ],
        );
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
                    false,
                    None,
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
    fn native_assistant_terminal_response_publishes_native_event_without_delaying_response() {
        block_on(async {
            let state = MeshSessionState::default();
            let request_id = "request-native-event-terminal";
            let subscription = global_native_event_hub().subscribe_with_capacity(
                crate::native_event_hub::NativeEventFilter {
                    kinds: vec![crate::native_event_hub::ASSISTANT_COMPLETED.to_owned()],
                    subjects: vec![request_id.to_owned()],
                    after_sequence: Some(
                        global_native_event_hub().next_sequence().saturating_sub(1),
                    ),
                    ..crate::native_event_hub::NativeEventFilter::default()
                },
                4,
            );
            state
                .test_bind_native_assistant_peer(
                    "peer-native-event-terminal",
                    55,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    Some("local-node"),
                )
                .await;
            let pending = state
                .begin_native_assistant_call(
                    None,
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    request_id,
                    true,
                    false,
                    None,
                )
                .await
                .expect("pending call");

            assert!(
                state
                    .test_settle_native_assistant_response(
                        "peer-native-event-terminal",
                        &json!({"type": "result", "id": request_id, "result": {"text": "ready"}}),
                    )
                    .await
            );
            assert_eq!(
                pending.response.await.expect("sender").expect("response"),
                json!({"text": "ready"})
            );
            let event = subscription.recv().await.expect("native event");
            assert_eq!(event.kind, crate::native_event_hub::ASSISTANT_COMPLETED);
            assert_eq!(event.audit.transport.as_deref(), Some("native"));
            assert_eq!(event.audit.correlation_id.as_deref(), Some(request_id));
            assert_eq!(
                event.audit.peer_id.as_deref(),
                Some("peer-native-event-terminal")
            );
        });
    }

    #[test]
    fn native_assistant_delta_event_is_observed_and_pending_call_stays_open() {
        block_on(async {
            let state = MeshSessionState::default();
            let request_id = "request-native-event-delta";
            let subscription = global_native_event_hub().subscribe_with_capacity(
                crate::native_event_hub::NativeEventFilter {
                    kinds: vec![crate::native_event_hub::ASSISTANT_DELTA.to_owned()],
                    subjects: vec![request_id.to_owned()],
                    after_sequence: Some(
                        global_native_event_hub().next_sequence().saturating_sub(1),
                    ),
                    ..crate::native_event_hub::NativeEventFilter::default()
                },
                4,
            );
            state
                .test_bind_native_assistant_peer(
                    "peer-native-event-delta",
                    66,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    Some("local-node"),
                )
                .await;
            let pending = state
                .begin_native_assistant_call(
                    None,
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    request_id,
                    true,
                    false,
                    None,
                )
                .await
                .expect("pending call");

            assert_eq!(
                state
                    .test_route_native_assistant_frame_at(
                        66,
                        &json!({
                            "type": "event",
                            "id": request_id,
                            "kind": "assistant.delta",
                            "delta": "hel"
                        }),
                        0,
                    )
                    .await,
                NativeAssistantFrameDisposition::Consumed
            );
            let event = subscription.recv().await.expect("native delta event");
            assert_eq!(event.kind, crate::native_event_hub::ASSISTANT_DELTA);
            assert_eq!(event.audit.correlation_id.as_deref(), Some(request_id));

            assert!(
                state
                    .test_settle_native_assistant_response(
                        "peer-native-event-delta",
                        &json!({"type": "result", "id": request_id, "result": {"text": "hello"}}),
                    )
                    .await
            );
            assert_eq!(
                pending.response.await.expect("sender").expect("response"),
                json!({"text": "hello"})
            );
        });
    }

    #[test]
    fn native_assistant_stream_events_keep_turn_link_for_transport_observation() {
        block_on(async {
            let state = MeshSessionState::default();
            let request_id = "voice-request-native-77";
            let correlation_id = "voice-correlation-native-77";
            state
                .test_bind_native_assistant_peer(
                    "peer-native-event-linked",
                    77,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    Some("local-node"),
                )
                .await;
            let mut pending = state
                .begin_native_assistant_call(
                    None,
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    request_id,
                    true,
                    true,
                    Some(NativeMeshAssistantTurnLink::new(
                        77,
                        "voice-session-native-77",
                        request_id,
                        correlation_id,
                    )),
                )
                .await
                .expect("pending streaming call");
            let mut stream_events = pending.events.take().expect("stream events");

            assert_eq!(
                state
                    .test_route_native_assistant_frame_at(
                        77,
                        &json!({
                            "type": "event",
                            "topic": ids::ORCHESTRATOR_RESPONSE,
                            "correlation_id": correlation_id,
                            "params": {
                                "kind": "assistant.delta",
                                "sequence": 1,
                                "session_id": "voice-session-native-77",
                                "request_id": request_id,
                                "correlation_id": correlation_id,
                                "delta": "hel"
                            }
                        }),
                        0,
                    )
                    .await,
                NativeAssistantFrameDisposition::Consumed
            );

            let forwarded = stream_events
                .recv()
                .await
                .expect("forwarded stream event")
                .expect("stream event payload");
            assert_eq!(forwarded["generation"], 77);
            assert_eq!(forwarded["session_id"], "voice-session-native-77");
            assert_eq!(forwarded["request_id"], request_id);
            assert_eq!(forwarded["correlation_id"], correlation_id);
            assert_eq!(forwarded["params"]["generation"], 77);
            assert_eq!(forwarded["params"]["session_id"], "voice-session-native-77");

            assert!(
                state
                    .test_settle_native_assistant_response(
                        "peer-native-event-linked",
                        &json!({
                            "type": "result",
                            "id": request_id,
                            "result": {
                                "text": "hello",
                                "session_id": "voice-session-native-77",
                                "request_id": request_id,
                                "correlation_id": correlation_id
                            }
                        }),
                    )
                    .await
            );
            assert_eq!(
                pending.response.await.expect("sender").expect("response"),
                json!({
                    "text": "hello",
                    "session_id": "voice-session-native-77",
                    "request_id": request_id,
                    "correlation_id": correlation_id
                })
            );
        });
    }

    #[test]
    fn native_assistant_stream_event_overflow_closes_observer_without_failing_terminal_call() {
        block_on(async {
            let state = MeshSessionState::default();
            let request_id = "voice-request-overflow";
            let correlation_id = "voice-correlation-overflow";
            state
                .test_bind_native_assistant_peer(
                    "peer-native-event-overflow",
                    88,
                    &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                    true,
                    Some("local-node"),
                )
                .await;
            let mut pending = state
                .begin_native_assistant_call(
                    None,
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    request_id,
                    true,
                    true,
                    Some(NativeMeshAssistantTurnLink::new(
                        88,
                        "voice-session-overflow",
                        request_id,
                        correlation_id,
                    )),
                )
                .await
                .expect("pending streaming call");
            let mut observer = pending.events.take().expect("stream observer");

            for sequence in 1..=33_u64 {
                assert_eq!(
                    state
                        .test_route_native_assistant_frame_at(
                            88,
                            &json!({
                                "type": "event",
                                "topic": ids::ORCHESTRATOR_RESPONSE,
                                "correlation_id": correlation_id,
                                "params": {
                                    "kind": "assistant.delta",
                                    "sequence": sequence,
                                    "session_id": "voice-session-overflow",
                                    "request_id": request_id,
                                    "correlation_id": correlation_id,
                                    "delta": "x"
                                }
                            }),
                            0,
                        )
                        .await,
                    NativeAssistantFrameDisposition::Consumed
                );
            }

            let mut observed = 0;
            while observer.try_recv().is_ok() {
                observed += 1;
            }
            assert_eq!(observed, 32);
            assert_eq!(
                observer.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
            );

            assert!(
                state
                    .test_settle_native_assistant_response(
                        "peer-native-event-overflow",
                        &json!({
                            "type": "result",
                            "id": request_id,
                            "result": {
                                "text": "terminal answer",
                                "session_id": "voice-session-overflow",
                                "request_id": request_id,
                                "correlation_id": correlation_id
                            }
                        }),
                    )
                    .await
            );
            assert_eq!(
                pending.response.await.expect("sender").expect("response"),
                json!({
                    "text": "terminal answer",
                    "session_id": "voice-session-overflow",
                    "request_id": request_id,
                    "correlation_id": correlation_id
                })
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
                        false,
                        None,
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
                        false,
                        None,
                    )
                    .await
                    .expect_err("missing method"),
                TransportError::UnknownMethod
            );
        });
    }

    #[test]
    fn native_assistant_waits_for_preferred_peer_handoff_without_masking_duplicates() {
        block_on(async {
            let state = MeshSessionState::default();
            assert!(state
                .begin_native_assistant_call_or_wait(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-1",
                    true,
                    false,
                    None,
                )
                .await
                .expect("missing preferred peer remains retryable")
                .is_none());

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
                .begin_native_assistant_call_or_wait(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-1",
                    true,
                    false,
                    None,
                )
                .await
                .expect("preferred peer route")
                .expect("preferred peer became ready");
            assert_eq!(pending.peer_id, "peer-a");
            assert_eq!(
                state
                    .begin_native_assistant_call_or_wait(
                        Some("peer-a"),
                        ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        "request-1",
                        true,
                        false,
                        None,
                    )
                    .await
                    .expect_err("duplicate request id must remain invalid"),
                TransportError::InvalidConfiguration
            );
        });
    }

    #[test]
    fn native_assistant_wait_does_not_mask_ambiguous_ready_peers() {
        block_on(async {
            let state = MeshSessionState::default();
            for (peer_id, data_channel_id) in [("peer-a", 10), ("peer-b", 20)] {
                state
                    .test_bind_native_assistant_peer(
                        peer_id,
                        data_channel_id,
                        &[ids::ORCHESTRATOR_EXTERNAL_USER_INPUT],
                        false,
                        None,
                    )
                    .await;
            }
            assert_eq!(
                state
                    .begin_native_assistant_call_or_wait(
                        None,
                        ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                        "ambiguous",
                        true,
                        false,
                        None,
                    )
                    .await
                    .expect_err("ambiguous ready peers must fail closed"),
                TransportError::InvalidConfiguration
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
                    false,
                    None,
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
                    false,
                    None,
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
                        false,
                        None,
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
                    false,
                    None,
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
                    false,
                    None,
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
                    false,
                    None,
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
                    false,
                    None,
                )
                .await
                .expect("interrupt-capable peer selected");
            assert_eq!(pending.peer_id, "peer-interrupt");
            assert_eq!(pending.data_channel_id, 20);
        });
    }

    #[test]
    fn encrypted_answer_releases_routing_lock_before_encoding() {
        block_on(async {
            let state = MeshSessionState::default();
            state
                .test_bind_native_assistant_peer_with_codec(
                    "peer-a",
                    10,
                    &[],
                    true,
                    None,
                    vec![7; 32],
                )
                .await;
            let inner = state.inner.lock().await;
            let routed = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                finalize_routing_after_unlock(
                    inner,
                    &state,
                    10,
                    true,
                    FrameRouting::Answer {
                        frames: vec![json!({"type": "pong", "id": "ping-1"})],
                        replay_after_resume: true,
                    },
                ),
            )
            .await
            .expect("encrypted answer must not deadlock");

            let InboundRouting::Answer(frames) = routed else {
                panic!("encrypted answer must be routed back to the data channel");
            };
            assert_eq!(frames.len(), 1);
            assert!(matches!(frames[0], OutboundDataChannelFrame::Binary(_)));
        });
    }

    #[test]
    fn native_data_channel_codec_opens_sdk_vector_and_seals_decode_compatible_json() {
        let key = std::array::from_fn::<_, 32, _>(|index| index as u8);
        let nonce = std::array::from_fn::<_, 12, _>(|index| (32 + index) as u8);
        let sdk_vector = hex_bytes(
            "202122232425262728292a2ba918d2091cfd3834381f23a2ad3ad8dbb92dcea6a5e3028200db5d3065a8336c01e68a60ac1f178e7b9202fb366e318d9a4f8ffbee59790ea10e5d316ec26bafb94bbe29acecc7e2e4058578d2391b5bf7f35672de98e330bc3ba35e6f6fbcf020355c31bd29fb9dbdef863dd88bb06e1e42b4ad63df34068a77292a40fec674",
        );
        let rust_vector = hex_bytes(
            "202122232425262728292a2ba918cf144ea2386d7b102ee3f03ad8dbbd2c98f4e8e441d44ea2037d25e3306e5bcb9d61ed5041bf409201fe7a253db883588de3e91e171aec030d7a39df6fb3ac55ef31edeac9b4ff05864be4345d43efb55761c192e57be13cb64b6e69edfe7f780c22b134fbd1f3bec766cf9aef6e9b1df1b0bf325d3772938e9c8fc0d761",
        );
        let frame = json!({
            "type": "call",
            "id": "call-1",
            "method": "Tooling.ExecuteTool",
            "params": {"tool_id": "device.status", "arguments": {}}
        });
        let codec = NativeDataChannelCodec::new(7, key.to_vec()).expect("codec");

        assert_eq!(
            codec.open_json(&sdk_vector).expect("open SDK vector"),
            frame
        );
        assert_eq!(
            codec
                .seal_json_with_nonce(&frame, nonce)
                .expect("seal Rust vector"),
            rust_vector
        );
        assert_eq!(
            codec.open_json(&rust_vector).expect("open Rust vector"),
            frame
        );

        let mut tampered = sdk_vector;
        *tampered.last_mut().expect("tag byte") ^= 1;
        assert!(codec.open_json(&tampered).is_err());
        assert!(codec
            .open_json(&vec![0; MAX_DATA_CHANNEL_PAYLOAD_BYTES + 1])
            .is_err());
    }

    #[test]
    fn native_data_channel_codec_rejects_epoch_rollback_and_in_epoch_key_change() {
        let mut inner = MeshSessionInner::default();
        let installed =
            Arc::new(NativeDataChannelCodec::new(10, vec![7; 32]).expect("installed native codec"));
        inner.peer_bindings.insert(
            "peer-a".to_owned(),
            MeshSessionPeerBinding {
                native_event_epoch: global_native_event_hub().source_epoch(),
                native_event_lease: global_native_event_hub()
                    .issue_peer_publication_lease("peer-a"),
                data_channel_id: 10,
                node_name: None,
                latest_rtt_ms: None,
                advertised_method_ids: BTreeSet::new(),
                manifest_methods_ready: true,
                primary: true,
                data_channel_codec: Some(installed.clone()),
            },
        );

        let preserved = inner
            .resolve_data_channel_codec("peer-a", 10, None)
            .expect("metadata refresh preserves codec")
            .expect("preserved codec");
        assert!(Arc::ptr_eq(&installed, &preserved));

        let same_epoch =
            Arc::new(NativeDataChannelCodec::new(10, vec![7; 32]).expect("same-epoch codec"));
        assert!(inner
            .resolve_data_channel_codec("peer-a", 10, Some(same_epoch))
            .is_ok());

        let changed_key =
            Arc::new(NativeDataChannelCodec::new(10, vec![8; 32]).expect("changed-key codec"));
        assert!(inner
            .resolve_data_channel_codec("peer-a", 10, Some(changed_key))
            .is_err());

        let stale = Arc::new(NativeDataChannelCodec::new(9, vec![9; 32]).expect("stale codec"));
        assert!(inner
            .resolve_data_channel_codec("peer-a", 9, Some(stale))
            .is_err());

        let successor =
            Arc::new(NativeDataChannelCodec::new(11, vec![11; 32]).expect("successor codec"));
        assert!(inner
            .resolve_data_channel_codec("peer-a", 11, Some(successor))
            .is_ok());
    }

    #[test]
    fn revoked_native_event_lease_blocks_assistant_selection_until_rebind() {
        let mut inner = MeshSessionInner::default();
        let old_lease = global_native_event_hub().issue_peer_publication_lease("peer-a");
        inner.peer_bindings.insert(
            "peer-a".to_owned(),
            MeshSessionPeerBinding {
                native_event_epoch: global_native_event_hub().source_epoch(),
                native_event_lease: old_lease.clone(),
                data_channel_id: 10,
                node_name: None,
                latest_rtt_ms: None,
                advertised_method_ids: BTreeSet::from([
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT.to_owned()
                ]),
                manifest_methods_ready: true,
                primary: true,
                data_channel_codec: None,
            },
        );
        global_native_event_hub().clear_peer("peer-a");

        assert_eq!(
            inner
                .begin_native_assistant_call(
                    Some("peer-a"),
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    "request-revoked-lease",
                    true,
                    false,
                    None,
                )
                .expect_err("revoked lease cannot be selected"),
            TransportError::InvalidConfiguration
        );
        assert!(inner.native_assistant_pending.is_empty());

        let new_lease = global_native_event_hub().issue_peer_publication_lease("peer-a");
        inner.peer_bindings.insert(
            "peer-a".to_owned(),
            MeshSessionPeerBinding {
                native_event_epoch: global_native_event_hub().source_epoch(),
                native_event_lease: new_lease,
                data_channel_id: 11,
                node_name: None,
                latest_rtt_ms: None,
                advertised_method_ids: BTreeSet::from([
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT.to_owned()
                ]),
                manifest_methods_ready: true,
                primary: true,
                data_channel_codec: None,
            },
        );
        let call = inner
            .begin_native_assistant_call(
                Some("peer-a"),
                ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                "request-rebound-lease",
                true,
                false,
                None,
            )
            .expect("fresh lease can be selected");
        assert_eq!(call.data_channel_id, 11);
        assert!(inner
            .native_assistant_pending
            .contains_key(&("peer-a".to_owned(), "request-rebound-lease".to_owned())));
    }

    #[test]
    fn background_call_replay_cache_is_bounded_and_peer_scoped() {
        let mut inner = MeshSessionInner::default();
        assert_eq!(
            inner.begin_background_call("peer-a", "call-1", 100),
            BackgroundCallReplayDecision::Execute
        );
        assert_eq!(
            inner.begin_background_call("peer-a", "call-1", 101),
            BackgroundCallReplayDecision::Pending
        );
        let answer = vec![json!({"type": "result", "id": "call-1", "result": {"ok": true}})];
        inner.finish_background_call("peer-a", "call-1", answer.clone(), 102, true);
        assert_eq!(
            inner.background_call_replay("peer-a", "call-1", 103, false),
            Some(BackgroundCallReplayDecision::Answer(answer.clone()))
        );
        assert_eq!(
            inner.begin_background_call("peer-a", "call-1", 103),
            BackgroundCallReplayDecision::Answer(answer)
        );
        assert_eq!(
            inner.begin_background_call("peer-b", "call-1", 103),
            BackgroundCallReplayDecision::Execute
        );
        assert_eq!(
            inner.begin_background_call(
                "peer-a",
                "call-1",
                102 + BACKGROUND_CALL_REPLAY_TTL_MS + 1,
            ),
            BackgroundCallReplayDecision::Execute
        );
    }

    #[test]
    fn deferred_background_replay_expires_when_the_surface_resumes() {
        let mut inner = MeshSessionInner::default();
        let answer = vec![json!({
            "type": "error",
            "id": "call-deferred",
            "error": {"reason_code": "orchestration_deferred"}
        })];
        assert_eq!(
            inner.begin_background_call("peer-a", "call-deferred", 100),
            BackgroundCallReplayDecision::Execute
        );
        inner.finish_background_call("peer-a", "call-deferred", answer.clone(), 101, false);
        assert_eq!(
            inner.background_call_replay("peer-a", "call-deferred", 102, true),
            Some(BackgroundCallReplayDecision::Answer(answer))
        );
        assert_eq!(
            inner.background_call_replay("peer-a", "call-deferred", 103, false),
            None
        );
        assert_eq!(
            inner.begin_background_call("peer-a", "call-deferred", 104),
            BackgroundCallReplayDecision::Execute
        );
    }

    fn hex_bytes(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("hex utf8");
                u8::from_str_radix(text, 16).expect("hex byte")
            })
            .collect()
    }
}
