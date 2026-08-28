use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
#[cfg(any(target_os = "ios", test))]
use base64::engine::general_purpose::STANDARD;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{ser::SerializeStruct, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewWindow};
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use thiserror::Error;
use tokio::sync::watch;
use url::Url;

#[cfg(any(desktop, target_os = "ios", test))]
use aurora_voice_core::CancellationToken;
#[cfg(any(desktop, target_os = "ios", test))]
use aurora_voice_engine::{SpeechCatalogTask, SpeechModelCatalog, TtsVoiceCatalog};
#[cfg(any(desktop, target_os = "ios", test))]
use aurora_voice_native::{SpeechPackManager, SpeechPackManagerConfig};

#[cfg(target_os = "android")]
mod android_audio;
#[cfg(all(desktop, debug_assertions, feature = "desktop-native-voice-e2e"))]
mod desktop_native_voice_e2e_keyring;
#[cfg(any(target_os = "ios", test))]
mod ios_voice;
#[cfg(target_os = "ios")]
use aurora_voice_ios_bridge::*;
#[cfg(target_os = "ios")]
#[used]
static AURORA_IOS_VOICE_BRIDGE_LINK_ANCHOR:
    extern "C" fn(usize, usize) -> *mut aurora_voice_ios_bridge::AuroraIosAudioState =
    aurora_voice_ios_bridge::aurora_ios_audio_state_new;
#[cfg(target_os = "ios")]
#[used]
static AURORA_IOS_VOICE_SESSION_LINK_ANCHOR:
    unsafe extern "C" fn(
        *const std::os::raw::c_char,
        *const std::os::raw::c_char,
        u32,
    ) -> *mut aurora_voice_native::IosVoiceSession = ios_voice::aurora_ios_voice_session_new;
mod local_data_native;
mod mesh_authority;
mod mesh_session;
mod native_mesh_assistant;
mod native_voice;
mod native_webrtc;
mod generated {
    pub mod local_data_migrations;
}
use local_data_native::{
    aurora_local_data_close, aurora_local_data_export_v1, aurora_local_data_import_v1,
    aurora_local_data_inspect_identity, aurora_local_data_open,
    aurora_local_data_repository_operation, aurora_local_data_status,
    aurora_local_data_transaction_begin, aurora_local_data_transaction_commit,
    aurora_local_data_transaction_rollback, LocalDataCommandState,
};
use native_voice::{
    aurora_native_voice_cancel, aurora_native_voice_finish, aurora_native_voice_start,
    aurora_native_voice_status, aurora_native_voice_tray_toggle_e2e, NativeVoiceState,
};

const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:8000";
const NATIVE_MANIFEST_METHOD: &str = "Native.GetCapabilityManifest";
const SIDECAR_HEALTH_PATH: &str = "/api/health";
const SECURE_STORAGE_SERVICE: &str = "dev.aurora.desktop.secure-storage";
const ASSISTANT_PROVIDER_STORAGE_SERVICE: &str = "dev.aurora.desktop.assistant-provider";
const ASSISTANT_PROVIDER_CONFIG_KEY: &str = "aurora.assistant.provider.openai-compatible.v1";
const ASSISTANT_PROVIDER_KIND: &str = "openai-compatible";
const ASSISTANT_PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const ASSISTANT_PROVIDER_READ_TIMEOUT: Duration = Duration::from_secs(20);
const ASSISTANT_PROVIDER_OVERALL_TIMEOUT: Duration = Duration::from_secs(30);
const ASSISTANT_PROVIDER_RESPONSE_MAX_BYTES: usize = 256 * 1024;
#[cfg(desktop)]
const INBOUND_VERIFIER_STORAGE_SERVICE: &str = "dev.aurora.desktop.inbound-verifier";
const INBOUND_VERIFIER_KEY_PREFIX: &str = "aurora.peer-host.inbound-verifier.v1";
const LOCAL_DATA_ENVELOPE_KEY_SERVICE: &str = "dev.aurora.desktop.local-data-envelope";
const LOCAL_DATA_ENVELOPE_ALGORITHM: &str = "AES-GCM-256";
const LOCAL_DATA_ENVELOPE_KEY_PURPOSE: &str = "local-structured-data";
const LOCAL_DATA_ENVELOPE_CURRENT_VERSION: u32 = 1;
const DESKTOP_THIN_PROFILES_KEY: &str = "aurora.session.desktop-thin-connection-profiles.v1";
const BUNDLED_SIDECAR_NAME: &str = "aurora-sidecar";
#[cfg(test)]
const UPDATER_ENDPOINT: &str =
    "https://releases.aurora.local/latest/{{target}}/{{arch}}/{{current_version}}.json";
const OVERLAY_WINDOW_LABEL: &str = "aurora-overlay";
const DEFAULT_OVERLAY_HOTKEY: &str = "CommandOrControl+K";
const OVERLAY_MARGIN: f64 = 24.0;
const VOICE_OVERLAY_WIDTH: f64 = 220.0;
const VOICE_OVERLAY_HEIGHT: f64 = 230.0;
const TEXT_OVERLAY_WIDTH: f64 = 520.0;
const TEXT_OVERLAY_HEIGHT: f64 = 360.0;
const GATEWAY_EVENT_STREAM_ERROR_BODY_MAX_BYTES: usize = 4096;
const GATEWAY_COMMAND_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const GATEWAY_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const GATEWAY_EVENT_STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const GATEWAY_HEALTH_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const GATEWAY_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuroraRequest {
    method: String,
    path: Option<String>,
    http_method: Option<String>,
    payload: Option<Value>,
    headers: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraEnvelope {
    data: Value,
    audit: AuroraAudit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuroraSubscribeRequest {
    topics: Vec<String>,
    stream: Option<String>,
    kinds: Option<Vec<String>>,
    headers: Option<BTreeMap<String, String>>,
    last_event_id: Option<String>,
    replay_from: Option<String>,
    correlation_id: Option<String>,
    backfill: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuroraUnsubscribeRequest {
    subscription_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuroraActivateSubscriptionRequest {
    subscription_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraSubscribeResponse {
    subscription_id: String,
    event_name: String,
    stream_url: String,
    transport: String,
    mode: String,
    redaction: RedactionMetadata,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraSubscriptionEvent {
    subscription_id: String,
    event: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraSubscriptionClosed {
    subscription_id: String,
    reason: String,
    code: String,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraAudit {
    method: String,
    bus_topic: Option<String>,
    status: String,
    transport: String,
    redaction: RedactionMetadata,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RedactionMetadata {
    secrets_redacted: bool,
    source: String,
    redacted_fields: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarStatus {
    running: bool,
    mode: String,
    pid: Option<u32>,
    gateway_url: Option<String>,
    version: Option<String>,
    last_error: Option<String>,
    details: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogTailRequest {
    lines: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarCommandToken {
    token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogTailResult {
    available: bool,
    source: String,
    lines: Vec<String>,
    truncated: bool,
    reason: Option<String>,
    max_lines: usize,
    secrets_redacted: bool,
    redacted_fields: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarSession {
    token: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidWebviewMicrophonePermissionDecisionRequest {
    origin: String,
    resources: Vec<String>,
    configured_https_origins: Option<Vec<String>>,
    foreground: bool,
    focused: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVoiceForegroundServiceStartRequest {
    remote_audio_consent: bool,
    #[serde(default)]
    background_session: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVoiceForegroundServiceStatusRequest {
    #[serde(default)]
    take_focused_result: bool,
    #[serde(default)]
    take_background_result: bool,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVoiceForegroundServiceStopRequest {
    #[serde(default)]
    background_session: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVoiceLiveTestPcmRequest {
    #[serde(default)]
    pcm_base64: String,
    #[serde(default)]
    arm_ingress: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVoicePackCatalogSetRequest {
    catalog_json: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosVoicePackCatalogSetRequest {
    entries: Vec<Value>,
    replace_existing: bool,
    #[serde(default)]
    trusted_hosts: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeMobileSpeechPackDownloadRequest {
    pack_id: String,
    task: NativeSpeechPackTask,
    #[serde(default)]
    force_download: bool,
    #[serde(default)]
    activate: bool,
    #[serde(flatten)]
    reference: NativeSpeechReferenceProfileRequest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidVoicePackDownloadStatusRequest {
    job_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum NativeSpeechPackTask {
    Stt,
    Vad,
    Kws,
    Tts,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechPackCatalogRequest {
    task: Option<NativeSpeechPackTask>,
    language: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechPackIdRequest {
    pack_id: String,
    task: NativeSpeechPackTask,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechReferenceProfileRequest {
    #[serde(default)]
    reference_id: Option<String>,
    #[serde(default)]
    reference_audio_uri: Option<String>,
    #[serde(default)]
    reference_text: Option<String>,
    #[serde(default)]
    reference_revision: Option<String>,
    #[serde(default)]
    reference_sample_rate_hz: Option<u32>,
    #[serde(default)]
    reference_samples: Option<Vec<f32>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechPackActivateRequest {
    pack_id: String,
    task: NativeSpeechPackTask,
    slot: Option<String>,
    #[serde(flatten)]
    reference: NativeSpeechReferenceProfileRequest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechPackCatalogResponse {
    available: bool,
    languages: Vec<String>,
    packs: Vec<NativeSpeechPackCatalogEntry>,
    count: usize,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechPackCatalogEntry {
    pack_id: String,
    display_name: String,
    task: NativeSpeechPackTask,
    languages: Vec<String>,
    language: Option<String>,
    sha256: String,
    file_size: u64,
    installed: bool,
    active_slot: Option<String>,
    revision: String,
    runtime_revision: String,
    model_family: String,
    requires_reference_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_audio_mode: Option<String>,
    voice_id: Option<String>,
    voice_revision: Option<String>,
    reference_profile_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSpeechPackStatusResponse {
    available: bool,
    active_slots: BTreeMap<String, String>,
    packs: Vec<NativeSpeechPackCatalogEntry>,
    count: usize,
    secrets_redacted: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerCredentialSetRequest {
    peer_id: String,
    token_id: String,
    claimant_peer_id: String,
    verifier_peer_id: String,
    claimant_signaling_peer_id: String,
    verifier_signaling_peer_id: String,
    room_name: String,
    raw_bearer_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerCredentialStatusRequest {
    peer_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerCredentialDeleteRequest {
    peer_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerReconnectProveRequest {
    peer_id: String,
    challenge: MeshReconnectChallengeFrame,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinRoomSecretSetRequest {
    #[serde(rename = "ref")]
    ref_id: String,
    value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinRoomSecretGetRequest {
    #[serde(rename = "ref")]
    ref_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinRoomSecretDeleteRequest {
    #[serde(rename = "ref")]
    ref_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssistantProviderConfigureRequest {
    provider: Option<String>,
    endpoint: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    enabled: Option<bool>,
    clear: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantProviderStoredConfig {
    provider: String,
    endpoint: String,
    model: String,
    api_key: String,
    enabled: bool,
    updated_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantProviderStatus {
    configured: bool,
    enabled: bool,
    provider: String,
    endpoint: Option<String>,
    model: Option<String>,
    backend: String,
    persisted: bool,
    secrets_redacted: bool,
    redacted_fields: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantProviderCompleteRequest {
    messages: Vec<AssistantProviderMessage>,
    tools: Vec<AssistantProviderTool>,
    max_tool_calls: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantProviderMessage {
    role: String,
    content: String,
    tool_call_id: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantProviderTool {
    global_tool_id: String,
    description: String,
    args_schema: Value,
    execution_location: String,
}

#[derive(Clone, Debug)]
struct AssistantToolAlias {
    global_tool_id: String,
    alias: String,
    execution_location: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum AssistantProviderCompleteResponse {
    #[serde(rename = "message")]
    Message { content: String },
    #[serde(rename = "tool_calls")]
    ToolCalls {
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        tool_calls: Vec<AssistantProviderToolCall>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantProviderToolCall {
    id: String,
    tool_name: String,
    provider_tool_name: String,
    arguments: Value,
    route: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboundVerifierSecretGetRequest {
    key: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboundVerifierSecretSetRequest {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboundVerifierSecretDeleteRequest {
    key: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct InboundVerifierSelector {
    token_id: String,
    claimant_peer_id: String,
    verifier_peer_id: String,
    room_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboundVerifierSecretRecord {
    version: u8,
    token_id: String,
    claimant_peer_id: String,
    verifier_peer_id: String,
    room_name: String,
    token_hash_hex: String,
    created_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked_at_ms: Option<u64>,
    credential_revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboundVerifierSecretGetResponse {
    found: bool,
    value: Option<String>,
    backend: String,
    persisted: bool,
    secrets_redacted: bool,
    redacted_fields: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InboundVerifierSecretWriteResponse {
    ok: bool,
    backend: String,
    persisted: bool,
    secrets_redacted: bool,
    redacted_fields: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDataEnvelopeEncryptRequest {
    key_purpose: String,
    profile_id: String,
    local_node_id: String,
    plaintext_b64_url: String,
    aad_b64_url: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDataEnvelopeDecryptRequest {
    profile_id: String,
    local_node_id: String,
    envelope: LocalDataEnvelopeV1,
    aad_b64_url: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDataEnvelopeRotateRequest {
    key_purpose: String,
    profile_id: String,
    local_node_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDataEnvelopeV1 {
    version: u32,
    algorithm: String,
    key_id: String,
    nonce_b64_url: String,
    ciphertext_and_tag_b64_url: String,
    created_at_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerCredentialRecord {
    token_id: String,
    claimant_peer_id: String,
    verifier_peer_id: String,
    claimant_signaling_peer_id: String,
    verifier_signaling_peer_id: String,
    room_name: String,
    raw_bearer_token: String,
    created_at_ms: Option<u64>,
    expires_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct MeshReconnectChallengeFrame {
    r#type: String,
    challenge: String,
    channel_binding: String,
    claimant_peer_id: String,
    verifier_peer_id: String,
    claimant_signaling_peer_id: String,
    verifier_signaling_peer_id: String,
    room_name: String,
}

#[derive(Debug, Serialize)]
struct MeshReconnectProofFrame {
    r#type: String,
    token_id: String,
    challenge: String,
    proof: String,
    channel_binding: String,
    claimant_peer_id: String,
    verifier_peer_id: String,
    claimant_signaling_peer_id: String,
    verifier_signaling_peer_id: String,
    room_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerCredentialMetadata {
    peer_id: String,
    token_id: String,
    claimant_peer_id: String,
    verifier_peer_id: String,
    claimant_signaling_peer_id: String,
    verifier_signaling_peer_id: String,
    room_name: String,
    created_at_ms: Option<u64>,
    expires_at_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerCredentialStatusResponse {
    peer_id: String,
    found: bool,
    has_bearer_token: bool,
    credential: Option<ThinPeerCredentialMetadata>,
    backend: String,
    persisted: bool,
    secrets_redacted: bool,
    redacted_fields: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThinPeerReconnectProofResponse {
    peer_id: String,
    found: bool,
    matched: bool,
    proof: Option<MeshReconnectProofFrame>,
    credential: Option<ThinPeerCredentialMetadata>,
    backend: String,
    secrets_redacted: bool,
    redacted_fields: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteOriginPolicy {
    local_loopback_allowed: bool,
    remote_gateway_allowed: bool,
    remote_gateway_url: Option<String>,
    remote_gateway_origin: Option<String>,
    remote_gateway_origin_allowed: bool,
    allowed_remote_origins: Vec<String>,
    csp_connect_src: Vec<String>,
    requires_https_or_wss: bool,
    wildcard_allowed: bool,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapabilityManifest {
    platform: String,
    permissions: BTreeMap<String, bool>,
    capabilities: BTreeMap<String, bool>,
    permission_states: BTreeMap<String, String>,
    capability_states: BTreeMap<String, String>,
    mobile_integrations: Vec<NativeMobileIntegration>,
    platform_limitations: Vec<NativePlatformLimitation>,
    ios_invocation: IosInvocationStatus,
    local_light_inference: LocalLightInferenceStatus,
    entrypoints: Vec<IosNativeEntrypoint>,
    last_entrypoint_payload: IosEntrypointPayload,
    evidence_source: String,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeMobileIntegration {
    platform: String,
    id: String,
    label: String,
    support: String,
    capability: String,
    permission: Option<String>,
    privacy_class: String,
    evidence_source: String,
    user_copy: String,
    verifier: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePlatformLimitation {
    platform: String,
    id: String,
    label: String,
    reason: String,
    user_copy: String,
    evidence_source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosInvocationStatus {
    platform: String,
    app_intents_available: bool,
    shortcuts_available: bool,
    share_extension_available: bool,
    deep_links_available: bool,
    widgets_available: bool,
    file_associations_available: bool,
    siri_replacement: bool,
    backend_handoff_required: bool,
    privacy_labels: Vec<String>,
    state: String,
    reason: String,
    evidence_source: String,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLightInferenceStatus {
    platform: String,
    provider_id: String,
    available: bool,
    requestable: bool,
    model_runtime_provider: bool,
    backend_model_catalog_required: bool,
    hardware_acceleration: String,
    model_id: Option<String>,
    model_present: bool,
    permission_granted: bool,
    state: String,
    fallback_available: bool,
    fallback_provider_id: Option<String>,
    reason: String,
    evidence_source: String,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosNativeEntrypoint {
    id: String,
    platform: String,
    label: String,
    state: String,
    available: bool,
    capability: String,
    permission: Option<String>,
    intake_type: String,
    url_scheme: Option<String>,
    universal_link_host: Option<String>,
    file_extensions: Vec<String>,
    xcode_target: String,
    backend_required: bool,
    payload_command: String,
    privacy_class: String,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosEntrypointPayload {
    source: String,
    invocation: String,
    url: Option<String>,
    scheme: Option<String>,
    host: Option<String>,
    path: Option<String>,
    file_extension: Option<String>,
    uniform_type_identifier: Option<String>,
    originating_bundle_id: Option<String>,
    shared_item_count: u32,
    privacy_labels: Vec<String>,
    backend_handoff_required: bool,
    correlation_id: Option<String>,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePermissionStatus {
    platform: String,
    permissions: BTreeMap<String, bool>,
    capabilities: BTreeMap<String, bool>,
    denied_by_default: Vec<String>,
    privacy_classes: Vec<String>,
    evidence_source: String,
    secrets_redacted: bool,
}

pub(crate) struct AuroraMobileNativePlugin<R: tauri::Runtime> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    handle: Option<tauri::plugin::PluginHandle<R>>,
    _runtime: std::marker::PhantomData<fn() -> R>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFeatureStatus {
    available: bool,
    permission: String,
    capability: String,
    source: String,
    reason: Option<String>,
    details: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BiometricAdminUnlockRequest {
    started: bool,
    request_code: Option<u32>,
    status: Value,
    reason: String,
    secrets_redacted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidBaselineStatus {
    platform: String,
    state: String,
    feature: String,
    available: bool,
    assistant_role: AndroidAssistantRoleStatus,
    fallback_entrypoints: BTreeMap<String, bool>,
    evidence_source: String,
    secrets_redacted: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidAssistantRoleStatus {
    role_available: Option<bool>,
    package_qualified: Option<bool>,
    role_held: Option<bool>,
    requestable: Option<bool>,
    denied: Option<bool>,
    oem_unavailable: Option<bool>,
    probe_implemented: bool,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeNotificationRequest {
    title: String,
    body: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeShareTextRequest {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOpenDeepLinkRequest {
    url: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeShowNotificationRequest {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosVoiceCredentialSetRequest {
    gateway: String,
    bearer: Option<String>,
    remote_audio_consent: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosAdminUnlockRequest {
    reason: String,
    action: Option<String>,
    correlation_id: Option<String>,
    allow_device_credential: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IosAuroraActionRequest {
    action: String,
    correlation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum OverlayMode {
    Voice,
    Text,
}

impl OverlayMode {
    fn parse(value: Option<String>) -> Result<Self, AuroraCommandError> {
        match value
            .unwrap_or_else(|| "voice".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "voice" => Ok(Self::Voice),
            "text" => Ok(Self::Text),
            other => Err(AuroraCommandError::Gateway(format!(
                "unsupported overlay mode: {other}"
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Voice => "voice",
            Self::Text => "text",
        }
    }
}

#[derive(Clone, Debug)]
struct OverlayState {
    mode: Option<OverlayMode>,
    visible: bool,
    pointer_passthrough: bool,
    hotkey_accelerator: String,
    hotkey_registered: bool,
    last_registration_error: Option<String>,
    voice_position: Option<OverlayPoint>,
    text_position: Option<OverlayPoint>,
}

impl OverlayState {
    fn new() -> Self {
        Self {
            mode: None,
            visible: false,
            pointer_passthrough: true,
            hotkey_accelerator: DEFAULT_OVERLAY_HOTKEY.to_string(),
            hotkey_registered: false,
            last_registration_error: None,
            voice_position: None,
            text_position: None,
        }
    }

    fn saved_position(&self, mode: OverlayMode) -> Option<OverlayPoint> {
        match mode {
            OverlayMode::Voice => self.voice_position,
            OverlayMode::Text => self.text_position,
        }
    }

    fn save_position(&mut self, mode: OverlayMode, position: OverlayPoint) {
        match mode {
            OverlayMode::Voice => self.voice_position = Some(position),
            OverlayMode::Text => self.text_position = Some(position),
        }
    }

    fn status(&self) -> OverlayStatus {
        OverlayStatus {
            available: cfg!(desktop),
            visible: self.visible,
            mode: self.mode.map(OverlayMode::as_str).map(ToString::to_string),
            pointer_passthrough: self.pointer_passthrough,
            hotkey_accelerator: Some(self.hotkey_accelerator.clone()),
            hotkey_registered: self.hotkey_registered,
            last_registration_error: self.last_registration_error.clone(),
            reason: if cfg!(desktop) {
                None
            } else {
                Some(
                    "Aurora overlay windows and global shortcuts require a desktop Tauri target"
                        .to_string(),
                )
            },
            secrets_redacted: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct OverlayPoint {
    x: f64,
    y: f64,
}

impl OverlayPoint {
    fn to_logical_position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }
}

type SharedOverlayState = Arc<Mutex<OverlayState>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayStatus {
    available: bool,
    visible: bool,
    mode: Option<String>,
    pointer_passthrough: bool,
    hotkey_accelerator: Option<String>,
    hotkey_registered: bool,
    last_registration_error: Option<String>,
    reason: Option<String>,
    secrets_redacted: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClosePolicy {
    HideToTray,
    HideOverlay,
    AllowClose,
}

fn close_policy_for_label(label: &str) -> ClosePolicy {
    match label {
        "main" => ClosePolicy::HideToTray,
        OVERLAY_WINDOW_LABEL => ClosePolicy::HideOverlay,
        _ => ClosePolicy::AllowClose,
    }
}

fn should_suppress_overlay_for_main_focus(main_window_focused: bool) -> bool {
    main_window_focused
}

struct SidecarState {
    child: Option<Child>,
    started_at: Option<Instant>,
    token: String,
    last_error: Option<String>,
    last_health: Option<Value>,
}

impl SidecarState {
    fn new() -> Result<Self, AuroraCommandError> {
        Ok(Self {
            child: None,
            started_at: None,
            token: generate_sidecar_token()?,
            last_error: None,
            last_health: None,
        })
    }

    fn is_running(&mut self) -> bool {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.last_error = Some(format!("sidecar exited with status {status}"));
                    self.child = None;
                    self.started_at = None;
                    false
                }
                Ok(None) => true,
                Err(error) => {
                    self.last_error = Some(format!("sidecar status check failed: {error}"));
                    false
                }
            }
        } else {
            false
        }
    }
}

type SharedSidecarState = Arc<Mutex<SidecarState>>;
type SharedSubscriptionState = Arc<Mutex<SubscriptionState>>;
type SharedGatewayClients = Arc<GatewayClients>;

struct GatewayClients {
    command: reqwest::Client,
    event_stream: reqwest::Client,
    health: reqwest::Client,
}

impl GatewayClients {
    fn new() -> Result<Self, AuroraCommandError> {
        Ok(Self {
            command: reqwest::Client::builder()
                .connect_timeout(GATEWAY_COMMAND_CONNECT_TIMEOUT)
                .timeout(GATEWAY_COMMAND_TIMEOUT)
                .build()
                .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?,
            event_stream: reqwest::Client::builder()
                .connect_timeout(GATEWAY_EVENT_STREAM_CONNECT_TIMEOUT)
                .build()
                .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?,
            health: reqwest::Client::builder()
                .connect_timeout(GATEWAY_HEALTH_CONNECT_TIMEOUT)
                .timeout(GATEWAY_HEALTH_TIMEOUT)
                .build()
                .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?,
        })
    }
}

struct SubscriptionState {
    tasks: HashMap<String, SubscriptionTask>,
}

struct SubscriptionTask {
    handle: tauri::async_runtime::JoinHandle<()>,
    ready: watch::Sender<bool>,
    owner_label: String,
}

impl SubscriptionState {
    fn new() -> Self {
        Self {
            tasks: HashMap::new(),
        }
    }

    fn next_subscription_id(&self) -> Result<String, AuroraCommandError> {
        Ok(format!("aurora-sub-{}", random_hex_128()?))
    }

    fn insert(&mut self, id: String, task: SubscriptionTask) {
        if let Some(existing) = self.tasks.insert(id, task) {
            existing.handle.abort();
        }
    }

    fn activate(&self, id: &str, owner_label: &str) -> bool {
        if let Some(task) = self.tasks.get(id) {
            if task.owner_label != owner_label {
                return false;
            }
            task.ready.send_replace(true);
            true
        } else {
            false
        }
    }

    fn remove(&mut self, id: &str, owner_label: &str) {
        let owned = self
            .tasks
            .get(id)
            .map(|task| task.owner_label == owner_label)
            .unwrap_or(false);
        if !owned {
            return;
        }
        if let Some(task) = self.tasks.remove(id) {
            task.handle.abort();
        }
    }

    fn abort_all(&mut self) {
        for (_, task) in self.tasks.drain() {
            task.handle.abort();
        }
    }
}

#[derive(Debug, Error)]
enum AuroraCommandError {
    #[error("Gateway URL is not a valid HTTP loopback origin: {0}")]
    InvalidGatewayOrigin(String),
    #[error("Gateway request failed: {0}")]
    Gateway(String),
    #[error("Gateway response was not JSON")]
    InvalidGatewayResponse,
    #[error("{0} is not available because the required native permission is disabled")]
    NativePermissionMissing(String),
    #[cfg(any(target_os = "android", target_os = "ios"))]
    #[error("Aurora mobile native plugin call failed: {0}")]
    AuroraMobileNativePlugin(String),
    #[error("Selected speech pack cannot be used for that voice feature")]
    NativeSpeechPackSelectionInvalid,
    #[error("{0}")]
    UnsupportedFeature(String),
    #[error("Desktop thin mode is connected to a remote Gateway and cannot start a local sidecar")]
    ThinModeSidecarDisabled,
    #[error("Local sidecar supervision is only allowed for loopback Gateway origins: {0}")]
    SidecarLoopbackRequired(String),
    #[error("Sidecar command token is invalid or missing")]
    SidecarTokenInvalid,
    #[error("Sidecar process failed: {0}")]
    SidecarProcess(String),
    #[error("Sidecar state lock failed")]
    SidecarState,
    #[error("Secure storage key is invalid or outside the Aurora credential namespace: {0}")]
    SecureStorageKeyInvalid(String),
    #[error("Peer reconnect credential is expired")]
    PeerCredentialExpired,
    #[error("Secure storage operation failed: {0}")]
    SecureStorage(String),
    #[error("Local data operation failed: {0}")]
    LocalData(String),
}

impl Serialize for AuroraCommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("AuroraCommandError", 3)?;
        state.serialize_field("code", self.code())?;
        let message = redact_sensitive_text(&self.to_string());
        state.serialize_field("message", &message)?;
        state.serialize_field(
            "detail",
            &json!({
                "code": self.code(),
                "message": message,
                "secrets_redacted": true,
            }),
        )?;
        state.end()
    }
}

#[tauri::command]
async fn aurora_request(
    request: AuroraRequest,
    state: State<'_, SharedSidecarState>,
    gateway_clients: State<'_, SharedGatewayClients>,
) -> Result<AuroraEnvelope, AuroraCommandError> {
    aurora_command(request, state, gateway_clients).await
}

#[tauri::command]
async fn aurora_command(
    request: AuroraRequest,
    state: State<'_, SharedSidecarState>,
    gateway_clients: State<'_, SharedGatewayClients>,
) -> Result<AuroraEnvelope, AuroraCommandError> {
    if !request_has_valid_sidecar_token(&request, &state)? {
        return Err(AuroraCommandError::SidecarTokenInvalid);
    }
    if request.method == NATIVE_MANIFEST_METHOD {
        return Ok(envelope(
            request.method,
            serde_json::to_value(native_capability_manifest()).expect("native manifest serializes"),
        ));
    }

    let gateway_url = gateway_url()?;
    let url = gateway_request_url(&gateway_url, request.path.as_deref(), &request.method)?;
    let method = request
        .http_method
        .as_deref()
        .unwrap_or(if request.payload.is_some() {
            "POST"
        } else {
            "GET"
        })
        .parse()
        .map_err(|error| AuroraCommandError::Gateway(format!("invalid HTTP method: {error}")))?;

    let mut builder = gateway_clients
        .command
        .request(method, url)
        .headers(filtered_headers(request.headers));
    if let Some(payload) = request.payload {
        builder = builder.json(&payload);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?;
    let status = response.status();
    let data = response
        .json::<Value>()
        .await
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;

    if status.is_success() {
        Ok(envelope(request.method, data))
    } else {
        Err(AuroraCommandError::Gateway(format!(
            "HTTP {status}: {}",
            serialize_redacted_value(&data)
        )))
    }
}

#[tauri::command]
async fn aurora_subscribe(
    request: AuroraSubscribeRequest,
    app: AppHandle,
    window: WebviewWindow,
    sidecar_state: State<'_, SharedSidecarState>,
    subscription_state: State<'_, SharedSubscriptionState>,
    gateway_clients: State<'_, SharedGatewayClients>,
) -> Result<AuroraSubscribeResponse, AuroraCommandError> {
    if !subscribe_has_valid_sidecar_token(&request, &sidecar_state)? {
        return Err(AuroraCommandError::SidecarTokenInvalid);
    }

    let gateway = gateway_url()?;
    let url = event_stream_url(&gateway, &request)?;
    let subscription_id = {
        let subscriptions = subscription_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        subscriptions.next_subscription_id()?
    };
    let owner_label = window.label().to_string();
    let event_name = format!("aurora://events/{subscription_id}");
    let closed_event_name = format!("aurora://events/{subscription_id}/closed");
    let client = gateway_clients.event_stream.clone();
    let headers = filtered_headers(request.headers.clone());
    let task_subscription_id = subscription_id.clone();
    let cleanup_subscription_id = subscription_id.clone();
    let task_event_name = event_name.clone();
    let task_closed_event_name = closed_event_name.clone();
    let task_app = app.clone();
    let task_owner_label = owner_label.clone();
    let task_subscriptions = subscription_state.inner().clone();
    let (ready_tx, mut ready_rx) = watch::channel(false);

    let task = tauri::async_runtime::spawn(async move {
        while !*ready_rx.borrow_and_update() {
            if ready_rx.changed().await.is_err() {
                return;
            }
        }
        run_gateway_event_stream(
            task_app,
            task_owner_label,
            client,
            url,
            headers,
            task_subscription_id,
            task_event_name,
            task_closed_event_name,
        )
        .await;
        if let Ok(mut subscriptions) = task_subscriptions.lock() {
            subscriptions.tasks.remove(&cleanup_subscription_id);
        }
    });

    {
        let mut subscriptions = subscription_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        subscriptions.insert(
            subscription_id.clone(),
            SubscriptionTask {
                handle: task,
                ready: ready_tx,
                owner_label,
            },
        );
    }

    Ok(AuroraSubscribeResponse {
        subscription_id,
        event_name,
        stream_url: "/api/events/stream".to_string(),
        transport: "tauri-local".to_string(),
        mode: if is_thin_mode() {
            "desktop-thin-gateway-proxy".to_string()
        } else {
            "desktop-local-sidecar-gateway-proxy".to_string()
        },
        redaction: RedactionMetadata {
            secrets_redacted: true,
            source: "tauri-gateway-sse-proxy".to_string(),
            redacted_fields: vec![
                "authorization".to_string(),
                "token".to_string(),
                "x-aurora-sidecar-token".to_string(),
            ],
            warnings: Vec::new(),
        },
    })
}

#[tauri::command]
async fn aurora_activate_subscription(
    request: AuroraActivateSubscriptionRequest,
    window: WebviewWindow,
    subscription_state: State<'_, SharedSubscriptionState>,
) -> Result<Value, AuroraCommandError> {
    let owner_label = window.label().to_string();
    let subscriptions = subscription_state
        .lock()
        .map_err(|_| AuroraCommandError::SidecarState)?;
    if subscriptions.activate(&request.subscription_id, &owner_label) {
        Ok(json!({
            "subscriptionId": request.subscription_id,
            "activated": true,
            "secretsRedacted": true
        }))
    } else {
        Err(AuroraCommandError::Gateway(
            "subscription is no longer active".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_unsubscribe(
    request: AuroraUnsubscribeRequest,
    window: WebviewWindow,
    subscription_state: State<'_, SharedSubscriptionState>,
) -> Result<Value, AuroraCommandError> {
    let owner_label = window.label().to_string();
    let mut subscriptions = subscription_state
        .lock()
        .map_err(|_| AuroraCommandError::SidecarState)?;
    subscriptions.remove(&request.subscription_id, &owner_label);
    Ok(json!({
        "subscriptionId": request.subscription_id,
        "closed": true,
        "secretsRedacted": true
    }))
}

#[tauri::command]
async fn aurora_sidecar_start(
    app: AppHandle,
    state: State<'_, SharedSidecarState>,
    gateway_clients: State<'_, SharedGatewayClients>,
    command_token: Option<SidecarCommandToken>,
) -> Result<SidecarStatus, AuroraCommandError> {
    let gateway = gateway_url()?;
    if is_thin_mode() {
        return Err(AuroraCommandError::ThinModeSidecarDisabled);
    }
    if !is_loopback_http_origin(&gateway) {
        return Err(AuroraCommandError::SidecarLoopbackRequired(
            gateway.to_string(),
        ));
    }
    verify_sidecar_command_token(command_token, &state)?;

    {
        let mut sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
        if !sidecar.is_running() {
            let child = spawn_sidecar(&app, &gateway, &sidecar.token)?;
            sidecar.started_at = Some(Instant::now());
            sidecar.child = Some(child);
            sidecar.last_error = None;
        }
    }

    aurora_sidecar_status(state, gateway_clients).await
}

#[tauri::command]
async fn aurora_sidecar_session(
    state: State<'_, SharedSidecarState>,
) -> Result<SidecarSession, AuroraCommandError> {
    let sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
    Ok(SidecarSession {
        token: sidecar.token.clone(),
    })
}

#[tauri::command]
async fn aurora_sidecar_stop(
    state: State<'_, SharedSidecarState>,
    gateway_clients: State<'_, SharedGatewayClients>,
    command_token: Option<SidecarCommandToken>,
) -> Result<SidecarStatus, AuroraCommandError> {
    verify_sidecar_command_token(command_token, &state)?;

    {
        let mut sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
        stop_sidecar(&mut sidecar)?;
    }

    aurora_sidecar_status(state, gateway_clients).await
}

#[tauri::command]
async fn aurora_sidecar_status(
    state: State<'_, SharedSidecarState>,
    gateway_clients: State<'_, SharedGatewayClients>,
) -> Result<SidecarStatus, AuroraCommandError> {
    let gateway = gateway_url()?;
    let (running, pid, last_error, started_at_ms, token_issued) = {
        let mut sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
        (
            sidecar.is_running(),
            sidecar.child.as_ref().map(std::process::Child::id),
            sidecar.last_error.clone(),
            sidecar
                .started_at
                .map(|instant| instant.elapsed().as_millis()),
            !sidecar.token.is_empty(),
        )
    };

    let health = check_gateway_health(&gateway_clients.health, &gateway).await;
    let mut details = BTreeMap::new();
    details.insert("supervisionTask".to_string(), json!("TAURI-002"));
    details.insert("shellTask".to_string(), json!("TAURI-001"));
    details.insert(
        "loopbackHardened".to_string(),
        json!(is_loopback_http_origin(&gateway)),
    );
    details.insert(
        "remoteGatewayAllowed".to_string(),
        json!(remote_gateway_allowed()),
    );
    details.insert("commandTokenIssued".to_string(), json!(token_issued));
    details.insert("tokenStoredInWebStorage".to_string(), json!(false));
    details.insert(
        "secureStorageBackend".to_string(),
        json!("platform-keychain"),
    );
    details.insert("healthPath".to_string(), json!(SIDECAR_HEALTH_PATH));
    details.insert(
        "bundledSidecarName".to_string(),
        json!(BUNDLED_SIDECAR_NAME),
    );
    details.insert(
        "bundledSidecarPolicy".to_string(),
        json!("automatic-build-and-bundle-with-env-override"),
    );
    details.insert("updaterArtifactsEnabled".to_string(), json!(true));
    if let Some(ms) = started_at_ms {
        details.insert("uptimeMs".to_string(), json!(ms));
    }
    match health {
        Ok(value) => {
            {
                let mut sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
                sidecar.last_health = Some(value.clone());
            }
            details.insert("gatewayHealth".to_string(), value);
        }
        Err(error) => {
            details.insert("gatewayHealthError".to_string(), json!(error.to_string()));
        }
    }

    Ok(SidecarStatus {
        running,
        mode: if is_thin_mode() {
            "thin".to_string()
        } else if running {
            "sidecar".to_string()
        } else {
            "desktop-local-stopped".to_string()
        },
        pid,
        gateway_url: Some(gateway.to_string()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        last_error,
        details,
    })
}

#[tauri::command]
async fn aurora_native_capability_manifest(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    native_capability_manifest_value(native).await
}

#[tauri::command]
async fn native_capabilities(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    native_capability_manifest_value(native).await
}

#[tauri::command]
async fn aurora_native_permission_status() -> Result<NativePermissionStatus, AuroraCommandError> {
    let manifest = native_capability_manifest();
    let denied_by_default = manifest
        .permissions
        .iter()
        .filter_map(|(permission, allowed)| {
            if *allowed {
                None
            } else {
                Some(permission.clone())
            }
        })
        .collect();
    Ok(NativePermissionStatus {
        platform: manifest.platform,
        permissions: manifest.permissions,
        capabilities: manifest.capabilities,
        denied_by_default,
        privacy_classes: vec![
            "personal".to_string(),
            "credential".to_string(),
            "raw-audio".to_string(),
        ],
        evidence_source: "tauri-capability-manifest".to_string(),
        secrets_redacted: true,
    })
}

#[tauri::command]
async fn aurora_tray_status() -> Result<NativeFeatureStatus, AuroraCommandError> {
    #[cfg(desktop)]
    {
        let mut details = BTreeMap::new();
        details.insert("menuItems".to_string(), json!(["show", "quit"]));
        details.insert("backendTruthRequired".to_string(), json!(false));
        Ok(NativeFeatureStatus {
            available: true,
            permission: "aurora.trayStatus".to_string(),
            capability: "desktop.tray".to_string(),
            source: "tauri-core-tray-icon".to_string(),
            reason: None,
            details,
        })
    }

    #[cfg(not(desktop))]
    {
        denied_native_feature_status(
            "aurora.trayStatus",
            "desktop.tray",
            "desktop tray is unsupported on mobile/native non-desktop targets",
        )
    }
}

#[tauri::command]
async fn aurora_notification_status() -> Result<NativeFeatureStatus, AuroraCommandError> {
    denied_native_feature_status(
        "aurora.notificationsSend",
        "native.notifications",
        "notification delivery is disabled until UI-004 defines the OS permission request and consent UX",
    )
}

#[tauri::command]
async fn aurora_notification_send(
    request: NativeNotificationRequest,
) -> Result<NativeFeatureStatus, AuroraCommandError> {
    let _ = (request.title, request.body);
    Err(native_permission_missing("aurora.notificationsSend"))
}

#[tauri::command]
async fn aurora_native_share_text(
    request: NativeShareTextRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_native_text(&request.text, 8_192, "share text")?;
    if let Some(title) = &request.title {
        validate_native_text(title, 120, "share title")?;
    }
    let payload =
        serde_json::to_value(&request).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "shareText", payload);
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "shareText", payload);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (native, payload);
        Err(AuroraCommandError::UnsupportedFeature(
            "Native text sharing is only available through Android or iOS platform handlers"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_native_open_deep_link(
    request: NativeOpenDeepLinkRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_native_deep_link(&request.url)?;
    let payload =
        serde_json::to_value(&request).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "openDeepLink", payload);
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "openDeepLink", payload);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (native, payload);
        Err(AuroraCommandError::UnsupportedFeature(
            "Native link opening is only available through Android or iOS platform handlers"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_native_show_notification(
    request: NativeShowNotificationRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_native_text(&request.title, 120, "notification title")?;
    if let Some(body) = &request.body {
        validate_native_text(body, 512, "notification body")?;
    }
    let payload =
        serde_json::to_value(&request).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "showNotification", payload);
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "showNotification", payload);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (native, payload);
        Err(AuroraCommandError::UnsupportedFeature(
            "Native notifications are only available through Android or iOS platform handlers"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_dialog_status() -> Result<NativeFeatureStatus, AuroraCommandError> {
    denied_native_feature_status(
        "aurora.dialogOpen",
        "native.dialogs",
        "dialog plugin access is disabled until file/attachment UX defines scoped picker behavior",
    )
}

#[tauri::command]
async fn aurora_audio_bridge_status() -> Result<NativeFeatureStatus, AuroraCommandError> {
    let mut status = denied_native_feature_status(
        "aurora.audioCapture",
        "native.audio",
        "raw-audio capture/playback requires backend audio events, explicit target, visible privacy state, and consent",
    )?;
    status
        .details
        .insert("privacyClass".to_string(), json!("raw-audio"));
    status
        .details
        .insert("backendEvidenceRequired".to_string(), json!(true));
    status
        .details
        .insert("captureEnabled".to_string(), json!(false));
    status
        .details
        .insert("playbackControlEnabled".to_string(), json!(false));
    Ok(status)
}

#[tauri::command]
async fn aurora_ios_voice_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "voiceStatus", json!({}))?;
        log_ios_native_plugin_payload("voiceStatus", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        serde_json::to_value(ios_voice_status()?)
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
}

#[tauri::command]
async fn aurora_ios_voice_foreground_capture_start(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "voiceForegroundCaptureStart", json!({}))?;
        log_ios_native_plugin_payload("voiceForegroundCaptureStart", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS foreground voice capture is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_background_capture_start(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "voiceBackgroundCaptureStart", json!({}))?;
        log_ios_native_plugin_payload("voiceBackgroundCaptureStart", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS background voice capture is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_foreground_capture_stop(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "voiceForegroundCaptureStop", json!({}))?;
        log_ios_native_plugin_payload("voiceForegroundCaptureStop", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS foreground voice capture is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_foreground_capture_finish(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "voiceForegroundCaptureFinish", json!({}))?;
        log_ios_native_plugin_payload("voiceForegroundCaptureFinish", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS foreground voice capture is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_foreground_capture_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "voiceForegroundCaptureStatus", json!({}))?;
        log_ios_native_plugin_payload("voiceForegroundCaptureStatus", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS foreground voice capture is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

fn ios_voice_status() -> Result<NativeFeatureStatus, AuroraCommandError> {
    let mut status = denied_native_feature_status(
        "aurora.iosMicrophoneCapture",
        "ios.voiceForegroundCapture",
        "iOS microphone capture requires AVAudioSession record permission, a selected local speech pack, audio consent, and a visible stop/revoke path.",
    )?;
    status.details.insert("platform".to_string(), json!("ios"));
    status
        .details
        .insert("privacyClass".to_string(), json!("raw-audio"));
    status
        .details
        .insert("foregroundOnly".to_string(), json!(false));
    status
        .details
        .insert("supportsBackgroundListening".to_string(), json!(true));
    status.details.insert(
        "supportsUserStartedBackgroundSession".to_string(),
        json!(true),
    );
    status
        .details
        .insert("alwaysOnWake".to_string(), json!(false));
    status
        .details
        .insert("supportsSiriReplacement".to_string(), json!(false));
    status
        .details
        .insert("consentRequired".to_string(), json!(true));
    status
        .details
        .insert("stopRevokeRequired".to_string(), json!(true));
    Ok(status)
}

#[tauri::command]
async fn aurora_ios_background_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "backgroundStatus", json!({}))?;
        log_ios_native_plugin_payload("backgroundStatus", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        serde_json::to_value(ios_background_status()?)
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
}

fn ios_background_status() -> Result<NativeFeatureStatus, AuroraCommandError> {
    let mut status = denied_native_feature_status(
        "aurora.iosBackgroundAudio",
        "ios.backgroundVoice",
        "iOS background voice requires the iOS app shell, record permission, a selected local speech pack, explicit user start, visible recording state, and an immediate stop path.",
    )?;
    status.details.insert("platform".to_string(), json!("ios"));
    status.details.insert(
        "supportsUserStartedBackgroundSession".to_string(),
        json!(true),
    );
    status
        .details
        .insert("alwaysOnWake".to_string(), json!(false));
    status
        .details
        .insert("supportsSiriReplacement".to_string(), json!(false));
    status.details.insert(
        "allowedFallbackSurfaces".to_string(),
        json!([
            "foreground microphone permission",
            "user notifications",
            "App Intents",
            "Shortcuts",
            "widgets",
            "share sheet",
            "deep links"
        ]),
    );
    Ok(status)
}

#[tauri::command]
async fn aurora_android_baseline_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<AndroidBaselineStatus, AuroraCommandError> {
    #[cfg(target_os = "android")]
    let status =
        android_baseline_status_from_plugin(native).unwrap_or_else(|_| android_baseline_status());

    #[cfg(not(target_os = "android"))]
    let status = {
        let _ = native;
        android_baseline_status()
    };

    log_android_baseline_status(&status);
    Ok(status)
}

#[tauri::command]
async fn aurora_android_lifecycle_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(native, "androidLifecycleStatus", json!({}))
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Android lifecycle status is only available in the Android Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_webview_microphone_permission_decision(
    request: AndroidWebviewMicrophonePermissionDecisionRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "webviewMicrophonePermissionDecision",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android WebView microphone permission mediation is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_foreground_service_status(
    request: Option<AndroidVoiceForegroundServiceStatusRequest>,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "voiceForegroundServiceStatus",
            serde_json::to_value(request.unwrap_or_default())
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice foreground service status is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_foreground_service_start(
    request: AndroidVoiceForegroundServiceStartRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "startVoiceForegroundService",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice foreground service start is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_live_test_inject_pcm(
    request: AndroidVoiceLiveTestPcmRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "injectVoicePcmForLiveTest",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android live voice PCM injection is only available to debuggable Android packages"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_foreground_service_finish(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(native, "finishVoiceForegroundService", json!({}))
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice foreground service finish is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_foreground_service_cancel(
    request: Option<AndroidVoiceForegroundServiceStopRequest>,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "stopVoiceForegroundService",
            serde_json::to_value(request.unwrap_or_default())
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice foreground service cancel is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_pack_catalog_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(native, "voicePackCatalogStatus", json!({}))
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice pack catalog status is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_pack_catalog_set(
    request: AndroidVoicePackCatalogSetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "voicePackCatalog",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice pack catalog update is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_pack_download(
    request: NativeMobileSpeechPackDownloadRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "downloadVoicePack",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice pack download is only available in the Android Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_pack_download_status(
    request: AndroidVoicePackDownloadStatusRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "voicePackDownloadStatus",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice pack download status is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_pack_activate(
    request: NativeSpeechPackActivateRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "setActiveVoicePack",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice pack activation is only available in the Android Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_voice_pack_remove(
    request: NativeSpeechPackIdRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        run_android_plugin_command(
            native,
            "removeVoicePack",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Android voice pack removal is only available in the Android Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_pack_catalog_set(
    request: IosVoicePackCatalogSetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        run_ios_plugin_command(
            native,
            "voicePackCatalogSet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS voice pack catalog update is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_pack_list(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        run_ios_plugin_command(native, "voicePackList", json!({}))
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS voice pack list is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_pack_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        run_ios_plugin_command(native, "voicePackStatus", json!({}))
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS voice pack status is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_pack_download(
    request: NativeMobileSpeechPackDownloadRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        set_ios_tts_reference_if_present(
            &native,
            request.task,
            &request.pack_id,
            &request.reference,
        )?;
        run_ios_plugin_command(
            native,
            "voicePackDownload",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS voice pack download is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_pack_activate(
    request: NativeSpeechPackActivateRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        set_ios_tts_reference_if_present(
            &native,
            request.task,
            &request.pack_id,
            &request.reference,
        )?;
        run_ios_plugin_command(
            native,
            "voicePackActivate",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS voice pack activation is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_pack_remove(
    request: NativeSpeechPackIdRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        run_ios_plugin_command(
            native,
            "voicePackRemove",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        )
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS voice pack removal is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[cfg(any(target_os = "ios", test))]
fn optional_native_tts_reference_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(any(target_os = "ios", test))]
fn ios_tts_reference_set_payload(
    pack_id: &str,
    reference: &NativeSpeechReferenceProfileRequest,
) -> Result<Value, AuroraCommandError> {
    let revision = reference
        .reference_revision
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
    let sample_rate_hz = reference
        .reference_sample_rate_hz
        .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
    let samples = reference
        .reference_samples
        .as_deref()
        .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
    let audio_base64 = native_reference_wav_base64(sample_rate_hz, samples)?;
    Ok(json!({
        "packId": pack_id,
        "audioBase64": audio_base64,
        "referenceText": optional_native_tts_reference_text(reference.reference_text.as_deref()),
        "sampleRateHz": sample_rate_hz,
        "revision": revision,
    }))
}

#[cfg(target_os = "ios")]
fn set_ios_tts_reference_if_present(
    native: &State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
    task: NativeSpeechPackTask,
    pack_id: &str,
    reference: &NativeSpeechReferenceProfileRequest,
) -> Result<(), AuroraCommandError> {
    if task != NativeSpeechPackTask::Tts || !reference.has_any_value() {
        return Ok(());
    }
    let payload = ios_tts_reference_set_payload(pack_id, reference)?;
    let handle = native.handle.as_ref().ok_or_else(|| {
        AuroraCommandError::AuroraMobileNativePlugin(
            "Aurora iOS native plugin handle was not registered".to_string(),
        )
    })?;
    handle
        .run_mobile_plugin::<Value>("voiceTTSReferenceSet", payload)
        .map_err(|error| AuroraCommandError::AuroraMobileNativePlugin(error.to_string()))?;
    Ok(())
}

impl NativeSpeechReferenceProfileRequest {
    fn has_any_value(&self) -> bool {
        self.reference_id.is_some()
            || self.reference_audio_uri.is_some()
            || self.reference_text.is_some()
            || self.reference_revision.is_some()
            || self.reference_sample_rate_hz.is_some()
            || self.reference_samples.is_some()
    }
}

#[cfg(any(target_os = "ios", test))]
fn native_reference_wav_base64(
    sample_rate_hz: u32,
    samples: &[f32],
) -> Result<String, AuroraCommandError> {
    const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
    const MAX_SAMPLE_RATE_HZ: u32 = 48_000;
    const MAX_REFERENCE_SAMPLES: usize = 48_000 * 30;
    if !(MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ).contains(&sample_rate_hz)
        || samples.is_empty()
        || samples.len() > MAX_REFERENCE_SAMPLES
        || samples
            .iter()
            .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
    {
        return Err(AuroraCommandError::NativeSpeechPackSelectionInvalid);
    }
    let data_len = samples
        .len()
        .checked_mul(2)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate_hz.to_le_bytes());
    wav.extend_from_slice(&(sample_rate_hz * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let pcm = if *sample < 0.0 {
            (*sample * 32_768.0).round() as i16
        } else {
            (*sample * 32_767.0).round() as i16
        };
        wav.extend_from_slice(&pcm.to_le_bytes());
    }
    Ok(STANDARD.encode(wav))
}

#[tauri::command]
async fn aurora_native_speech_pack_catalog(
    app: AppHandle,
    request: NativeSpeechPackCatalogRequest,
) -> Result<NativeSpeechPackCatalogResponse, AuroraCommandError> {
    native_speech_pack_catalog(&app, request)
}

#[tauri::command]
async fn aurora_native_speech_pack_status(
    app: AppHandle,
) -> Result<NativeSpeechPackStatusResponse, AuroraCommandError> {
    native_speech_pack_status(&app)
}

#[tauri::command]
async fn aurora_native_speech_pack_install(
    app: AppHandle,
    request: NativeSpeechPackIdRequest,
) -> Result<NativeSpeechPackStatusResponse, AuroraCommandError> {
    #[cfg(any(desktop, target_os = "ios"))]
    {
        let manager = native_speech_pack_manager(&app)?;
        let cancellation = CancellationToken::new();
        match request.task {
            NativeSpeechPackTask::Tts => {
                let _ = manager
                    .install_voice(&request.pack_id, &cancellation, |_| {})
                    .await
                    .map_err(|_| {
                        AuroraCommandError::UnsupportedFeature(
                            "Speech pack is unavailable".to_string(),
                        )
                    })?;
            }
            _ => {
                let _ = manager
                    .install_model(&request.pack_id, &cancellation, |_| {})
                    .await
                    .map_err(|_| {
                        AuroraCommandError::UnsupportedFeature(
                            "Speech pack is unavailable".to_string(),
                        )
                    })?;
            }
        };
        native_speech_pack_status(&app)
    }

    #[cfg(not(any(desktop, target_os = "ios")))]
    {
        let _ = (app, request);
        Err(AuroraCommandError::UnsupportedFeature(
            "Native speech packs are unavailable on this platform".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_native_speech_pack_activate(
    app: AppHandle,
    request: NativeSpeechPackActivateRequest,
) -> Result<NativeSpeechPackStatusResponse, AuroraCommandError> {
    #[cfg(any(desktop, target_os = "ios"))]
    {
        let manager = native_speech_pack_manager(&app)?;
        let installed = match request.task {
            NativeSpeechPackTask::Tts => manager.resolve_voice_bindings(&request.pack_id).is_ok(),
            _ => manager.resolve_model_bindings(&request.pack_id).is_ok(),
        };
        if !installed {
            return Err(AuroraCommandError::UnsupportedFeature(
                "Speech pack is not ready".to_string(),
            ));
        }
        #[cfg(desktop)]
        if request.task == NativeSpeechPackTask::Tts {
            let catalog = TtsVoiceCatalog::runtime().map_err(|_| {
                AuroraCommandError::UnsupportedFeature("Speech catalog is unavailable".to_string())
            })?;
            let voice = catalog
                .voice(&request.pack_id)
                .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
            if voice.requires_reference_profile() {
                let reference_id = request
                    .reference
                    .reference_id
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
                let sample_rate_hz = request
                    .reference
                    .reference_sample_rate_hz
                    .and_then(|value| i32::try_from(value).ok())
                    .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
                let samples = request
                    .reference
                    .reference_samples
                    .clone()
                    .filter(|value| !value.is_empty())
                    .ok_or(AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
                native_voice::store_desktop_tts_reference_profile(
                    &app,
                    reference_id,
                    request.pack_id.clone(),
                    sample_rate_hz,
                    samples,
                    request.reference.reference_text.clone(),
                    request.reference.reference_revision.clone(),
                )
                .map_err(|_| AuroraCommandError::NativeSpeechPackSelectionInvalid)?;
            } else if (voice.model_family == "vits_piper" && request.reference.has_any_value())
                || (voice.model_family != "vits_piper" && voice.model_family != "pockettts")
            {
                return Err(AuroraCommandError::NativeSpeechPackSelectionInvalid);
            }
        }
        let mut active = native_speech_pack_active_slots(&app)?;
        insert_native_speech_pack_active_slot(
            &mut active,
            request.task,
            request.slot.as_deref(),
            request.pack_id,
        )?;
        write_native_speech_pack_active_slots(&app, &active)?;
        native_speech_pack_status(&app)
    }

    #[cfg(not(any(desktop, target_os = "ios")))]
    {
        let _ = (app, request);
        Err(AuroraCommandError::UnsupportedFeature(
            "Native speech packs are unavailable on this platform".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_native_speech_pack_remove(
    app: AppHandle,
    request: NativeSpeechPackIdRequest,
) -> Result<NativeSpeechPackStatusResponse, AuroraCommandError> {
    #[cfg(any(desktop, target_os = "ios"))]
    {
        let manager = native_speech_pack_manager(&app)?;
        match request.task {
            NativeSpeechPackTask::Tts => manager.remove_voice(&request.pack_id).map_err(|_| {
                AuroraCommandError::UnsupportedFeature("Speech pack is unavailable".to_string())
            })?,
            _ => manager.remove_model(&request.pack_id).map_err(|_| {
                AuroraCommandError::UnsupportedFeature("Speech pack is unavailable".to_string())
            })?,
        };
        let mut active = native_speech_pack_active_slots(&app)?;
        active.retain(|_, pack_id| pack_id != &request.pack_id);
        write_native_speech_pack_active_slots(&app, &active)?;
        native_speech_pack_status(&app)
    }

    #[cfg(not(any(desktop, target_os = "ios")))]
    {
        let _ = (app, request);
        Err(AuroraCommandError::UnsupportedFeature(
            "Native speech packs are unavailable on this platform".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_android_native_plugin_payload(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        let handle = native.handle.as_ref().ok_or_else(|| {
            AuroraCommandError::AuroraMobileNativePlugin(
                "Aurora Android native plugin handle was not registered".to_string(),
            )
        })?;
        let payload = handle
            .run_mobile_plugin::<Value>("nativeCapabilityManifest", json!({}))
            .map_err(|error| AuroraCommandError::AuroraMobileNativePlugin(error.to_string()))?;
        log_android_native_plugin_payload(&payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Aurora Android native plugin is only available in the Android Tauri shell".to_string(),
        ))
    }
}

pub(crate) async fn native_capability_manifest_value(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        let handle = native.handle.as_ref().ok_or_else(|| {
            AuroraCommandError::AuroraMobileNativePlugin(
                "Aurora Android native plugin handle was not registered".to_string(),
            )
        })?;
        let payload = handle
            .run_mobile_plugin::<Value>("nativeCapabilityManifest", json!({}))
            .map_err(|error| AuroraCommandError::AuroraMobileNativePlugin(error.to_string()))?;
        log_android_native_plugin_payload(&payload);
        Ok(payload)
    }

    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "nativeCapabilityManifest", json!({}))?;
        log_ios_native_plugin_payload("nativeCapabilityManifest", &payload);
        Ok(payload)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = native;
        serde_json::to_value(native_capability_manifest())
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
}

#[tauri::command]
async fn aurora_ios_native_plugin_manifest(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "nativeCapabilityManifest", json!({}))?;
        log_ios_native_plugin_payload("nativeCapabilityManifest", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Aurora iOS native plugin is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_invocation_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "invocationStatus", json!({}))?;
        log_ios_native_plugin_payload("invocationStatus", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Aurora iOS invocation status is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_local_light_inference_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let voice_pack_status = run_ios_plugin_command(native, "voicePackStatus", json!({})).ok();
        let payload = serde_json::to_value(ios_local_light_inference_status_from_voice_packs(
            true,
            voice_pack_status.as_ref(),
        ))
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
        log_ios_native_plugin_payload("localLightInferenceStatus", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Aurora iOS local-light inference status is only available in the iOS Tauri shell"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_entrypoint_payload(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "iosEntrypointPayload", json!({}))?;
        log_ios_native_plugin_payload("iosEntrypointPayload", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Err(AuroraCommandError::UnsupportedFeature(
            "Aurora iOS entrypoint payload is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_invoke_action(
    request: IosAuroraActionRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = serde_json::to_value(request)
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
        let result = run_ios_plugin_command(native, "invokeAuroraAction", payload)?;
        log_ios_native_plugin_payload("invokeAuroraAction", &result);
        Ok(result)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "Aurora iOS action invocation is only available in the iOS Tauri shell".to_string(),
        ))
    }
}

fn log_android_baseline_status(status: &AndroidBaselineStatus) {
    println!(
        "aurora_android_baseline_status={}",
        serialize_redacted_json(status)
    );
}

#[cfg(target_os = "android")]
fn log_android_native_plugin_payload(payload: &Value) {
    const CHUNK_BYTES: usize = 900;

    let serialized = serialize_redacted_value(payload);
    let chunks = chunk_string_for_logcat(&serialized, CHUNK_BYTES);
    println!(
        "aurora_android_native_plugin_payload_begin chunks={} bytes={}",
        chunks.len(),
        serialized.len()
    );
    for (index, chunk) in chunks.iter().enumerate() {
        println!(
            "aurora_android_native_plugin_payload_chunk index={} total={} data={}",
            index,
            chunks.len(),
            chunk
        );
    }
    println!(
        "aurora_android_native_plugin_payload_end chunks={}",
        chunks.len()
    );
}

#[cfg(target_os = "ios")]
fn log_ios_native_plugin_payload(command: &str, payload: &Value) {
    println!(
        "aurora_ios_native_plugin_command command={} payload={}",
        command,
        serialize_redacted_value(payload)
    );
}

fn serialize_redacted_json<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(value) => serialize_redacted_value(&value),
        Err(_) => "{\"secretsRedacted\":true}".to_string(),
    }
}

fn serialize_redacted_value(value: &Value) -> String {
    serde_json::to_string(&redact_sensitive_value(value))
        .unwrap_or_else(|_| "{\"secretsRedacted\":true}".to_string())
}

fn redact_sensitive_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    let redacted = if is_safe_redaction_metadata(key, value) {
                        value.clone()
                    } else if is_sensitive_log_key(key) {
                        json!("[redacted]")
                    } else {
                        redact_sensitive_value(value)
                    };
                    (key.clone(), redacted)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact_sensitive_value).collect()),
        Value::String(value) => Value::String(redact_sensitive_text(value)),
        _ => value.clone(),
    }
}

fn is_safe_redaction_metadata(key: &str, value: &Value) -> bool {
    match (key, value) {
        ("secretsRedacted", Value::Bool(_)) => true,
        ("android.secureCredentialStorage", Value::Bool(_)) => true,
        ("android.secureCredentialStorage", Value::String(state)) => matches!(
            state.as_str(),
            "available"
                | "degraded"
                | "fallback"
                | "needs_native_permission"
                | "unsupported_platform"
        ),
        _ => false,
    }
}

fn redact_sensitive_text(input: &str) -> String {
    let mut redacted = redact_embedded_json(input);
    for marker in [
        "bearer ",
        "x-aurora-sidecar-token:",
        "x-aurora-sidecar-token=",
        "token:",
        "token=",
        "\"token\":",
        "secret:",
        "secret=",
        "\"secret\":",
        "password:",
        "password=",
        "\"password\":",
        "api_key:",
        "api_key=",
        "\"api_key\":",
        "apikey:",
        "apikey=",
        "\"apikey\":",
        "private_key:",
        "private_key=",
        "\"private_key\":",
        "raw_audio:",
        "raw_audio=",
        "\"raw_audio\":",
        "rawaudio:",
        "rawaudio=",
        "\"rawaudio\":",
        "audio_bytes:",
        "audio_bytes=",
        "\"audio_bytes\":",
        "\"audiobytes\":",
        "audio_data:",
        "audio_data=",
        "\"audio_data\":",
        "\"audiodata\":",
        "pcm16:",
        "pcm16=",
        "\"pcm16\":",
    ] {
        redacted = redact_after_marker(&redacted, marker);
    }
    redacted
}

fn redact_embedded_json(input: &str) -> String {
    let Some(start) = input.find('{') else {
        return input.to_string();
    };
    let Some(end) = input.rfind('}') else {
        return input.to_string();
    };
    if end <= start {
        return input.to_string();
    }

    let candidate = &input[start..=end];
    let Ok(value) = serde_json::from_str::<Value>(candidate) else {
        return input.to_string();
    };
    format!(
        "{}{}{}",
        &input[..start],
        serialize_redacted_value(&value),
        &input[end + 1..]
    )
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find(marker) {
        let start = cursor + relative_start;
        let value_start = start + marker.len();
        output.push_str(&input[cursor..value_start]);
        output.push_str("[redacted]");

        let mut scan_start = value_start;
        for (offset, character) in input[value_start..].char_indices() {
            if !matches!(character, ' ' | '\t' | '"' | '\'') {
                break;
            }
            scan_start = value_start + offset + character.len_utf8();
        }

        let mut value_end = scan_start;
        for (offset, character) in input[scan_start..].char_indices() {
            if matches!(
                character,
                ' ' | '\t' | '\n' | '\r' | ',' | ';' | '&' | '"' | '\'' | '}' | ']'
            ) {
                break;
            }
            value_end = scan_start + offset + character.len_utf8();
        }
        cursor = value_end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn is_sensitive_log_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "authorization",
        "bearer",
        "token",
        "secret",
        "password",
        "apikey",
        "privatekey",
        "signingkey",
        "credential",
        "refresh",
        "rawaudio",
        "audiobytes",
        "audiodata",
        "audiosamples",
        "samplebuffer",
        "pcm16",
        "wavbytes",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn sensitive_log_redacted_fields() -> Vec<String> {
    vec![
        "authorization".to_string(),
        "token".to_string(),
        "secret".to_string(),
        "password".to_string(),
        "api_key".to_string(),
        "private_key".to_string(),
        "raw_audio".to_string(),
        "audio_bytes".to_string(),
        "audio_data".to_string(),
        "pcm16".to_string(),
    ]
}

#[cfg(target_os = "android")]
fn chunk_string_for_logcat(value: &str, max_bytes: usize) -> Vec<&str> {
    if value.is_empty() {
        return vec![""];
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = usize::min(start + max_bytes, value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&value[start..end]);
        start = end;
    }
    chunks
}

#[tauri::command]
async fn aurora_ios_secure_storage_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "iosSecureStorageStatus", json!({}))?;
        log_ios_native_plugin_payload("iosSecureStorageStatus", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Ok(json!({
            "available": false,
            "permission": "aurora.iosKeychain",
            "capability": "ios.keychain.secureCredentialStorage",
            "source": "tauri-ios-native-plugin",
            "reason": "iOS Keychain status requires an iOS target built with Xcode/Tauri mobile.",
            "details": ios_native_details()
        }))
    }
}

#[tauri::command]
async fn aurora_ios_voice_credential_set(
    request: IosVoiceCredentialSetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    let payload =
        serde_json::to_value(&request).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;

    #[cfg(target_os = "ios")]
    {
        // The Swift plugin stores the bearer in the device-only Keychain and
        // returns only redacted status. Never log this request payload.
        return run_ios_plugin_command(native, "voiceCredentialSet", payload);
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (native, payload);
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS voice credentials require the iOS Tauri shell".to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_ios_voice_credential_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "voiceCredentialStatus", json!({}));
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Ok(json!({
            "configured": false,
            "hasBearer": false,
            "remoteAudioConsent": false,
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_ios_voice_credential_delete(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "voiceCredentialDelete", json!({}));
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Ok(json!({
            "configured": false,
            "hasBearer": false,
            "remoteAudioConsent": false,
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_ios_biometric_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = run_ios_plugin_command(native, "iosBiometricStatus", json!({}))?;
        log_ios_native_plugin_payload("iosBiometricStatus", &payload);
        Ok(payload)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = native;
        Ok(json!({
            "available": false,
            "permission": "aurora.iosBiometricUnlock",
            "capability": "ios.biometric.adminUnlock",
            "source": "tauri-ios-native-plugin",
            "reason": "Face ID/Touch ID status requires an iOS target and cannot be proven on this platform.",
            "details": ios_native_details()
        }))
    }
}

#[tauri::command]
async fn aurora_ios_admin_unlock(
    request: IosAdminUnlockRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "ios")]
    {
        let payload = serde_json::to_value(request)
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
        let result = run_ios_plugin_command(native, "iosAdminUnlock", payload)?;
        log_ios_native_plugin_payload("iosAdminUnlock", &result);
        Ok(result)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "iOS admin unlock requires Face ID/Touch ID through the iOS Tauri native plugin and cannot run on this platform"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_thin_peer_credential_set(
    request: ThinPeerCredentialSetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_peer_storage_id(&request.peer_id)?;
    validate_credential_record_fields(
        &request.token_id,
        &request.claimant_peer_id,
        &request.verifier_peer_id,
        &request.claimant_signaling_peer_id,
        &request.verifier_signaling_peer_id,
        &request.room_name,
        &request.raw_bearer_token,
    )?;
    if request
        .expires_at_ms
        .is_some_and(|expires_at_ms| expires_at_ms <= current_unix_ms())
    {
        return Err(AuroraCommandError::PeerCredentialExpired);
    }

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "thinPeerCredentialSet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "thinPeerCredentialSet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let record = ThinPeerCredentialRecord {
            token_id: request.token_id,
            claimant_peer_id: request.claimant_peer_id,
            verifier_peer_id: request.verifier_peer_id,
            claimant_signaling_peer_id: request.claimant_signaling_peer_id,
            verifier_signaling_peer_id: request.verifier_signaling_peer_id,
            room_name: request.room_name,
            raw_bearer_token: request.raw_bearer_token,
            created_at_ms: request.created_at_ms.or_else(|| Some(current_unix_ms())),
            expires_at_ms: request.expires_at_ms,
        };
        let metadata = thin_peer_credential_metadata(&request.peer_id, &record);
        let storage_key = thin_peer_credential_key(&request.peer_id)?;
        let stored = serde_json::to_string(&record)
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
        peer_credential_storage_entry(&storage_key)?
            .set_password(&stored)
            .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?;
        serde_json::to_value(thin_peer_credential_status_response(
            request.peer_id,
            Some(metadata),
            true,
        ))
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }

    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "thin peer credential storage is only available on desktop keychain, Android Keystore, and iOS Keychain targets"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_thin_peer_credential_status(
    request: ThinPeerCredentialStatusRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_peer_storage_id(&request.peer_id)?;
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "thinPeerCredentialStatus",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "thinPeerCredentialStatus",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let record = load_unexpired_thin_peer_credential_record(&request.peer_id)?;
        let metadata = record
            .as_ref()
            .map(|record| thin_peer_credential_metadata(&request.peer_id, record));
        let has_token = record
            .as_ref()
            .is_some_and(|record| !record.raw_bearer_token.is_empty());
        serde_json::to_value(thin_peer_credential_status_response(
            request.peer_id,
            metadata,
            has_token,
        ))
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "thin peer credential storage is only available on desktop keychain, Android Keystore, and iOS Keychain targets"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_thin_peer_credential_delete(
    request: ThinPeerCredentialDeleteRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_peer_storage_id(&request.peer_id)?;
    let storage_key = thin_peer_credential_key(&request.peer_id)?;

    #[cfg(target_os = "android")]
    {
        let _ = storage_key;
        return run_android_plugin_command(
            native,
            "thinPeerCredentialDelete",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }

    #[cfg(target_os = "ios")]
    {
        let _ = storage_key;
        return run_ios_plugin_command(
            native,
            "thinPeerCredentialDelete",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }

    #[cfg(desktop)]
    {
        let _ = native;
        match peer_credential_storage_entry(&storage_key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(AuroraCommandError::SecureStorage(error.to_string())),
        }
        serde_json::to_value(thin_peer_credential_status_response(
            request.peer_id,
            None,
            false,
        ))
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }

    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native, storage_key);
        Err(AuroraCommandError::UnsupportedFeature(
            "thin peer credential storage is only available on desktop keychain, Android Keystore, and iOS Keychain targets"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_thin_peer_reconnect_prove(
    request: ThinPeerReconnectProveRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_peer_storage_id(&request.peer_id)?;
    validate_reconnect_challenge(&request.challenge)?;
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "thinPeerReconnectProve",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "thinPeerReconnectProve",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let Some(record) = load_unexpired_thin_peer_credential_record(&request.peer_id)? else {
            return serde_json::to_value(thin_peer_reconnect_proof_response(
                request.peer_id,
                None,
                false,
                None,
            ))
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse);
        };
        let metadata = thin_peer_credential_metadata(&request.peer_id, &record);
        if !reconnect_challenge_matches(&record, &request.challenge) {
            return serde_json::to_value(thin_peer_reconnect_proof_response(
                request.peer_id,
                Some(metadata),
                false,
                None,
            ))
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse);
        }
        let proof = MeshReconnectProofFrame {
            r#type: "mesh_auth_proof_v1".to_string(),
            token_id: record.token_id.clone(),
            challenge: request.challenge.challenge.clone(),
            proof: compute_reconnect_proof_hex(
                &record.raw_bearer_token,
                &record,
                &request.challenge,
            )?,
            channel_binding: request.challenge.channel_binding.clone(),
            claimant_peer_id: record.claimant_peer_id.clone(),
            verifier_peer_id: record.verifier_peer_id.clone(),
            claimant_signaling_peer_id: request.challenge.claimant_signaling_peer_id.clone(),
            verifier_signaling_peer_id: request.challenge.verifier_signaling_peer_id.clone(),
            room_name: record.room_name.clone(),
        };
        serde_json::to_value(thin_peer_reconnect_proof_response(
            request.peer_id,
            Some(metadata),
            true,
            Some(proof),
        ))
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "thin peer reconnect proof is only available on desktop keychain, Android Keystore, and iOS Keychain targets"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_remote_origin_policy() -> Result<RemoteOriginPolicy, AuroraCommandError> {
    let remote_gateway = env::var("AURORA_TAURI_REMOTE_GATEWAY_URL").ok();
    let remote_gateway_url = remote_gateway
        .as_deref()
        .and_then(|raw| Url::parse(raw).ok());
    let remote_gateway_origin = remote_gateway_url.as_ref().map(origin_for_url);
    let allowed_remote_origins = allowed_remote_origins();
    let remote_gateway_origin_allowed = remote_gateway_origin.as_ref().is_some_and(|origin| {
        allowed_remote_origins
            .iter()
            .any(|allowed| allowed == origin)
    });
    let mut csp_connect_src = vec![
        "'self'".to_string(),
        "http://127.0.0.1:*".to_string(),
        "http://localhost:*".to_string(),
        "ws://127.0.0.1:*".to_string(),
        "ws://localhost:*".to_string(),
    ];
    csp_connect_src.extend(allowed_remote_origins.iter().cloned());

    Ok(RemoteOriginPolicy {
        local_loopback_allowed: true,
        remote_gateway_allowed: remote_gateway_allowed(),
        remote_gateway_url: remote_gateway,
        remote_gateway_origin,
        remote_gateway_origin_allowed,
        allowed_remote_origins,
        csp_connect_src,
        requires_https_or_wss: true,
        wildcard_allowed: false,
        secrets_redacted: true,
    })
}

#[tauri::command]
async fn aurora_log_tail(
    request: Option<LogTailRequest>,
) -> Result<LogTailResult, AuroraCommandError> {
    let max_lines = request
        .and_then(|request| request.lines)
        .unwrap_or(100)
        .clamp(1, 500);
    Ok(LogTailResult {
        available: false,
        source: "aurora-sidecar".to_string(),
        lines: Vec::new(),
        truncated: false,
        reason: Some(
            "TAURI-004 log tailing is deferred; the supervised sidecar does not expose a local log source yet"
                .to_string(),
        ),
        max_lines,
        secrets_redacted: true,
        redacted_fields: sensitive_log_redacted_fields(),
    })
}

#[tauri::command]
async fn aurora_thin_profile_get(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "thinProfileGet", json!({}));
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "thinProfileGet", json!({}));
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = native;
        return Err(AuroraCommandError::UnsupportedFeature(
            "thin profile storage is only available on desktop keychain, Android private storage, and iOS UserDefaults targets"
                .to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let entry = thin_profile_storage_entry()?;
        let value = match entry.get_password() {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(AuroraCommandError::SecureStorage(error.to_string())),
        };
        Ok(json!({
            "key": DESKTOP_THIN_PROFILES_KEY,
            "value": value,
            "backend": "platform-keychain",
            "persisted": true,
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_thin_profile_set(
    value: String,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "thinProfileSet", json!({ "value": value }));
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "thinProfileSet", json!({ "value": value }));
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (value, native);
        return Err(AuroraCommandError::UnsupportedFeature(
            "thin profile storage is only available on desktop keychain, Android private storage, and iOS UserDefaults targets"
                .to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let entry = thin_profile_storage_entry()?;
        entry
            .set_password(&value)
            .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?;
        Ok(json!({
            "key": DESKTOP_THIN_PROFILES_KEY,
            "ok": true,
            "backend": "platform-keychain",
            "persisted": true,
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_thin_room_secret_set(
    request: ThinRoomSecretSetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_room_secret_ref(&request.ref_id)?;
    validate_non_empty_field("roomSecret", &request.value, 8192)?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "thinRoomSecretSet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "thinRoomSecretSet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let storage_key = thin_room_secret_key(&request.ref_id)?;
        peer_credential_storage_entry(&storage_key)?
            .set_password(&request.value)
            .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?;
        Ok(json!({
            "ref": request.ref_id,
            "ok": true,
            "backend": "platform-keychain",
            "persisted": true,
            "privacyClass": "secret",
            "secretsRedacted": true
        }))
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "thin room-secret storage is only available on desktop keychain, Android Keystore, and iOS Keychain targets"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_thin_room_secret_get(
    request: ThinRoomSecretGetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_room_secret_ref(&request.ref_id)?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "thinRoomSecretGet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "thinRoomSecretGet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let storage_key = thin_room_secret_key(&request.ref_id)?;
        let value = match peer_credential_storage_entry(&storage_key)?.get_password() {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(AuroraCommandError::SecureStorage(error.to_string())),
        };
        Ok(json!({
            "ref": request.ref_id,
            "value": value,
            "backend": "platform-keychain",
            "persisted": true,
            "privacyClass": "secret"
        }))
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "thin room-secret storage is only available on desktop keychain, Android Keystore, and iOS Keychain targets"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_thin_room_secret_delete(
    request: ThinRoomSecretDeleteRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_room_secret_ref(&request.ref_id)?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "thinRoomSecretDelete",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "thinRoomSecretDelete",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let storage_key = thin_room_secret_key(&request.ref_id)?;
        match peer_credential_storage_entry(&storage_key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(json!({
                "ref": request.ref_id,
                "ok": true,
                "backend": "platform-keychain",
                "persisted": false,
                "privacyClass": "secret",
                "secretsRedacted": true
            })),
            Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
        }
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(AuroraCommandError::UnsupportedFeature(
            "thin room-secret storage is only available on desktop keychain, Android Keystore, and iOS Keychain targets"
                .to_string(),
        ))
    }
}

#[tauri::command]
async fn aurora_inbound_verifier_get(
    request: InboundVerifierSecretGetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_inbound_verifier_secret_key(&request.key)?;
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "inboundVerifierGet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "inboundVerifierGet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let backend = DesktopInboundVerifierStorageBackend;
        let value = inbound_verifier_storage_get(&backend, &request.key)?;
        serde_json::to_value(inbound_verifier_get_response(value))
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(inbound_verifier_unsupported())
    }
}

#[tauri::command]
async fn aurora_inbound_verifier_set(
    request: InboundVerifierSecretSetRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_inbound_verifier_secret_key(&request.key)?;
    validate_inbound_verifier_secret_value(&request.value)?;
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "inboundVerifierSet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "inboundVerifierSet",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let backend = DesktopInboundVerifierStorageBackend;
        inbound_verifier_storage_set(&backend, &request.key, &request.value)?;
        serde_json::to_value(inbound_verifier_write_response(true))
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(inbound_verifier_unsupported())
    }
}

#[tauri::command]
async fn aurora_inbound_verifier_delete(
    request: InboundVerifierSecretDeleteRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_inbound_verifier_secret_key(&request.key)?;
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(
            native,
            "inboundVerifierDelete",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "inboundVerifierDelete",
            serde_json::to_value(&request)
                .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?,
        );
    }
    #[cfg(desktop)]
    {
        let _ = native;
        let backend = DesktopInboundVerifierStorageBackend;
        inbound_verifier_storage_delete(&backend, &request.key)?;
        serde_json::to_value(inbound_verifier_write_response(true))
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = (request, native);
        Err(inbound_verifier_unsupported())
    }
}

#[tauri::command]
async fn aurora_secure_storage_get(
    key: String,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        validate_secure_storage_key(&key)?;
        return run_android_plugin_command(
            native,
            "secureStorageGet",
            json!({
                "key": key
            }),
        );
    }

    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = (key, native);
        return Err(AuroraCommandError::UnsupportedFeature(
            "secure storage is only available on desktop keychain and Android Keystore targets"
                .to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let entry = secure_storage_entry(&key)?;
        let value = match entry.get_password() {
            Ok(value) => Some(value),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(AuroraCommandError::SecureStorage(error.to_string())),
        };
        Ok(json!({
            "key": key,
            "value": value,
            "backend": "platform-keychain",
            "persisted": true,
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_secure_storage_set(
    key: String,
    value: String,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        validate_secure_storage_key(&key)?;
        return run_android_plugin_command(
            native,
            "secureStorageSet",
            json!({
                "key": key,
                "value": value
            }),
        );
    }

    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = (key, value, native);
        return Err(AuroraCommandError::UnsupportedFeature(
            "secure storage is only available on desktop keychain and Android Keystore targets"
                .to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let entry = secure_storage_entry(&key)?;
        entry
            .set_password(&value)
            .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?;
        Ok(json!({
            "key": key,
            "ok": true,
            "backend": "platform-keychain",
            "persisted": true,
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_secure_storage_delete(
    key: String,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        validate_secure_storage_key(&key)?;
        return run_android_plugin_command(
            native,
            "secureStorageDelete",
            json!({
                "key": key
            }),
        );
    }

    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = (key, native);
        return Err(AuroraCommandError::UnsupportedFeature(
            "secure storage is only available on desktop keychain and Android Keystore targets"
                .to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let entry = secure_storage_entry(&key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(json!({
                "key": key,
                "ok": true,
                "backend": "platform-keychain",
                "persisted": true,
                "secretsRedacted": true
            })),
            Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
        }
    }
}

#[tauri::command]
async fn aurora_assistant_provider_status() -> Result<AssistantProviderStatus, AuroraCommandError> {
    let config = load_assistant_provider_config()?;
    Ok(assistant_provider_status(config.as_ref()))
}

#[tauri::command]
async fn aurora_assistant_provider_configure(
    request: AssistantProviderConfigureRequest,
) -> Result<AssistantProviderStatus, AuroraCommandError> {
    if request.clear.unwrap_or(false) || request.enabled == Some(false) {
        delete_assistant_provider_config()?;
        return Ok(assistant_provider_status(None));
    }
    let config = validate_assistant_provider_config(request)?;
    store_assistant_provider_config(&config)?;
    Ok(assistant_provider_status(Some(&config)))
}

#[tauri::command]
async fn aurora_assistant_provider_complete(
    request: AssistantProviderCompleteRequest,
) -> Result<AssistantProviderCompleteResponse, AuroraCommandError> {
    let config = load_assistant_provider_config()?
        .filter(|config| config.enabled)
        .ok_or_else(|| {
            AuroraCommandError::UnsupportedFeature(
                "assistant provider is not configured".to_string(),
            )
        })?;
    validate_assistant_provider_request(&request)?;
    let aliases = assistant_tool_aliases(&request.tools)?;
    let body = assistant_provider_openai_body(&config, &request, &aliases)?;
    let response = assistant_provider_http_client()?
        .post(&config.endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {}", config.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            AuroraCommandError::Gateway(format!(
                "assistant provider request failed: {}",
                redact_sensitive_text(&error.to_string())
            ))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AuroraCommandError::Gateway(format!(
            "assistant provider returned HTTP {status}"
        )));
    }
    let text = read_assistant_provider_response_bounded(response).await?;
    let raw: Value =
        serde_json::from_str(&text).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
    parse_assistant_provider_response(&raw, &aliases)
}

#[tauri::command]
async fn aurora_local_data_envelope_encrypt(
    request: LocalDataEnvelopeEncryptRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_local_data_key_scope(
        &request.key_purpose,
        &request.profile_id,
        &request.local_node_id,
    )?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "localDataEnvelopeEncrypt", json!(request));
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "localDataEnvelopeEncrypt", json!(request));
    }

    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = native;
        return Err(AuroraCommandError::UnsupportedFeature(
            "local data envelope crypto requires platform secure key handles".to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let plaintext = decode_base64url_bytes(&request.plaintext_b64_url)?;
        let aad = decode_base64url_bytes(&request.aad_b64_url)?;
        let key_version = current_local_data_envelope_key_version(
            &request.profile_id,
            &request.local_node_id,
            &request.key_purpose,
        )?;
        let key_id = local_data_envelope_key_id(
            &request.profile_id,
            &request.local_node_id,
            &request.key_purpose,
            key_version,
        );
        let key = load_or_create_local_data_envelope_key(&key_id)?;
        let envelope = encrypt_local_data_envelope(&key_id, &key, &plaintext, &aad)?;
        serde_json::to_value(envelope)
            .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
    }
}

#[tauri::command]
async fn aurora_local_data_envelope_decrypt(
    request: LocalDataEnvelopeDecryptRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_local_data_decrypt_request(&request)?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "localDataEnvelopeDecrypt", json!(request));
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "localDataEnvelopeDecrypt", json!(request));
    }

    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = native;
        return Err(AuroraCommandError::UnsupportedFeature(
            "local data envelope crypto requires platform secure key handles".to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let aad = decode_base64url_bytes(&request.aad_b64_url)?;
        let key = load_existing_local_data_envelope_key(&request.envelope.key_id)?;
        let plaintext = decrypt_local_data_envelope(&request.envelope, &key, &aad)?;
        Ok(json!({
            "plaintextB64Url": encode_base64url_bytes(&plaintext),
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_local_data_envelope_rotate(
    request: LocalDataEnvelopeRotateRequest,
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    validate_local_data_key_scope(
        &request.key_purpose,
        &request.profile_id,
        &request.local_node_id,
    )?;

    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "localDataEnvelopeRotate", json!(request));
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "localDataEnvelopeRotate", json!(request));
    }

    #[cfg(not(any(desktop, target_os = "android", target_os = "ios")))]
    {
        let _ = native;
        return Err(AuroraCommandError::UnsupportedFeature(
            "local data envelope crypto requires platform secure key handles".to_string(),
        ));
    }

    #[cfg(desktop)]
    {
        let _ = native;
        let previous_version = current_local_data_envelope_key_version(
            &request.profile_id,
            &request.local_node_id,
            &request.key_purpose,
        )?;
        let previous_key_id = local_data_envelope_key_id(
            &request.profile_id,
            &request.local_node_id,
            &request.key_purpose,
            previous_version,
        );
        let new_version = previous_version + 1;
        let new_key_id = local_data_envelope_key_id(
            &request.profile_id,
            &request.local_node_id,
            &request.key_purpose,
            new_version,
        );
        let key = random_key_256()?;
        store_local_data_envelope_key(&new_key_id, &key)?;
        store_local_data_envelope_current_version(
            &request.profile_id,
            &request.local_node_id,
            &request.key_purpose,
            new_version,
        )?;
        Ok(json!({
            "previousKeyId": previous_key_id,
            "newKeyId": new_key_id,
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_biometric_admin_unlock_status(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "biometricAdminUnlockStatus", json!({}));
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(native, "iosBiometricStatus", json!({}));
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = native;
        Ok(json!({
            "platform": native_platform(),
            "available": false,
            "requestable": false,
            "deviceSecure": false,
            "biometricReady": false,
            "lastDenied": false,
            "state": "unsupported_platform",
            "reason": "biometric admin unlock is only available in Android and iOS Tauri mobile shells",
            "privacyClass": "admin-critical",
            "evidenceSource": "tauri-capability-manifest",
            "secretsRedacted": true
        }))
    }
}

#[tauri::command]
async fn aurora_biometric_admin_unlock(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<Value, AuroraCommandError> {
    #[cfg(target_os = "android")]
    {
        return run_android_plugin_command(native, "biometricAdminUnlock", json!({}));
    }

    #[cfg(target_os = "ios")]
    {
        return run_ios_plugin_command(
            native,
            "iosAdminUnlock",
            json!({
                "reason": "Confirm Aurora administrator action",
                "action": "genericAdminUnlock",
                "allowDeviceCredential": false
            }),
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = native;
        let status = json!({
            "platform": native_platform(),
            "available": false,
            "requestable": false,
            "deviceSecure": false,
            "biometricReady": false,
            "lastDenied": false,
            "state": "unsupported_platform",
            "reason": "biometric admin unlock is only available in Android and iOS Tauri mobile shells",
            "privacyClass": "admin-critical",
            "evidenceSource": "tauri-capability-manifest",
            "secretsRedacted": true
        });
        serde_json::to_value(BiometricAdminUnlockRequest {
            started: false,
            request_code: None,
            status,
            reason: "unsupported_platform".to_string(),
            secrets_redacted: true,
        })
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)
    }
}

#[tauri::command]
async fn aurora_local_file_read(
    path: String,
    options: Option<Value>,
) -> Result<Value, AuroraCommandError> {
    let _ = (path, options);
    Err(native_permission_missing("aurora.localFileRead"))
}

#[tauri::command]
async fn aurora_local_file_write(
    path: String,
    data: Value,
    options: Option<Value>,
) -> Result<Value, AuroraCommandError> {
    let _ = (path, data, options);
    Err(native_permission_missing("aurora.localFileWrite"))
}

#[tauri::command]
async fn aurora_local_file_pick(options: Option<Value>) -> Result<Value, AuroraCommandError> {
    let _ = options;
    Err(native_permission_missing("aurora.secureFileHandle"))
}

#[tauri::command]
async fn aurora_secure_file_handle_open(
    options: Option<Value>,
) -> Result<Value, AuroraCommandError> {
    let _ = options;
    Err(native_permission_missing("aurora.secureFileHandle"))
}

#[tauri::command]
async fn aurora_overlay_show(
    app: AppHandle,
    overlay_state: State<'_, SharedOverlayState>,
    mode: Option<String>,
) -> Result<OverlayStatus, AuroraCommandError> {
    let mode = OverlayMode::parse(mode)?;
    #[cfg(desktop)]
    if should_suppress_overlay_for_main_focus(main_window_is_focused(&app)) {
        hide_overlay_window(&app);
        let status = overlay_hidden_status(&overlay_state, Some("main-window-focused"))?;
        let _ = app.emit("aurora://overlay-mode", json!({ "mode": "hidden" }));
        return Ok(status);
    }
    let saved_position = {
        let overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.saved_position(mode)
    };
    #[cfg(desktop)]
    {
        let window = ensure_overlay_window(&app)?;
        configure_overlay_for_mode(&window, mode, saved_position);
        let _ = window.show();
        set_overlay_passthrough_after_show(&window, false);
        if mode == OverlayMode::Text {
            let _ = window.set_focus();
        }
    }
    let status = {
        let mut overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.mode = Some(mode);
        overlay.visible = cfg!(desktop);
        overlay.pointer_passthrough = false;
        overlay.status()
    };
    let _ = app.emit("aurora://overlay-mode", json!({ "mode": mode.as_str() }));
    Ok(status)
}

#[tauri::command]
async fn aurora_overlay_hide(
    app: AppHandle,
    overlay_state: State<'_, SharedOverlayState>,
) -> Result<OverlayStatus, AuroraCommandError> {
    #[cfg(desktop)]
    hide_overlay_window(&app);
    let status = overlay_hidden_status(&overlay_state, None)?;
    let _ = app.emit("aurora://overlay-mode", json!({ "mode": "hidden" }));
    Ok(status)
}

#[tauri::command]
async fn aurora_overlay_status(
    overlay_state: State<'_, SharedOverlayState>,
) -> Result<OverlayStatus, AuroraCommandError> {
    let overlay = overlay_state
        .lock()
        .map_err(|_| AuroraCommandError::SidecarState)?;
    Ok(overlay.status())
}

#[tauri::command]
async fn aurora_overlay_set_passthrough(
    app: AppHandle,
    overlay_state: State<'_, SharedOverlayState>,
    enabled: bool,
) -> Result<OverlayStatus, AuroraCommandError> {
    let allow_native_passthrough = {
        let overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        should_apply_overlay_passthrough_to_native(overlay.visible, overlay.mode, enabled)
    };
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        if allow_native_passthrough && overlay_window_is_visible(&window) {
            set_overlay_passthrough(&window, enabled);
        } else if overlay_window_is_visible(&window) {
            set_overlay_passthrough(&window, false);
        }
    }
    let mut overlay = overlay_state
        .lock()
        .map_err(|_| AuroraCommandError::SidecarState)?;
    overlay.pointer_passthrough = allow_native_passthrough && enabled;
    Ok(overlay.status())
}

#[tauri::command]
async fn aurora_overlay_start_drag(
    app: AppHandle,
    overlay_state: State<'_, SharedOverlayState>,
) -> Result<OverlayStatus, AuroraCommandError> {
    let mode = {
        let overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.mode
    };

    #[cfg(desktop)]
    {
        if should_suppress_overlay_for_main_focus(main_window_is_focused(&app)) {
            hide_overlay_window(&app);
            let status = overlay_hidden_status(&overlay_state, Some("main-window-focused"))?;
            let _ = app.emit("aurora://overlay-mode", json!({ "mode": "hidden" }));
            return Ok(status);
        }

        if mode.is_some() {
            if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
                if overlay_window_is_visible(&window) {
                    set_overlay_passthrough(&window, false);
                    window.start_dragging().map_err(|error| {
                        AuroraCommandError::Gateway(format!(
                            "failed to start overlay native drag: {error}"
                        ))
                    })?;
                    let mut overlay = overlay_state
                        .lock()
                        .map_err(|_| AuroraCommandError::SidecarState)?;
                    overlay.visible = true;
                    overlay.pointer_passthrough = false;
                    return Ok(overlay.status());
                }
            }
        }
    }

    let overlay = overlay_state
        .lock()
        .map_err(|_| AuroraCommandError::SidecarState)?;
    Ok(overlay.status())
}

#[tauri::command]
async fn aurora_overlay_move_by(
    app: AppHandle,
    overlay_state: State<'_, SharedOverlayState>,
    dx: f64,
    dy: f64,
) -> Result<OverlayStatus, AuroraCommandError> {
    let mode = {
        let overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.mode
    };

    #[cfg(desktop)]
    if let (Some(mode), Some(window)) = (mode, app.get_webview_window(OVERLAY_WINDOW_LABEL)) {
        let scale_factor = overlay_scale_factor(&window);
        let current = window.outer_position().map_err(|error| {
            AuroraCommandError::Gateway(format!("failed to read overlay position: {error}"))
        })?;
        let current_logical: LogicalPosition<f64> = current.to_logical(scale_factor);
        let next = OverlayPoint {
            x: current_logical.x + dx,
            y: current_logical.y + dy,
        };
        let _ = window.set_position(next.to_logical_position());
        let mut overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.save_position(mode, next);
        overlay.pointer_passthrough = false;
        return Ok(overlay.status());
    }

    let overlay = overlay_state
        .lock()
        .map_err(|_| AuroraCommandError::SidecarState)?;
    Ok(overlay.status())
}

#[tauri::command]
async fn aurora_overlay_unregister_hotkey(
    app: AppHandle,
    overlay_state: State<'_, SharedOverlayState>,
) -> Result<OverlayStatus, AuroraCommandError> {
    #[cfg(desktop)]
    {
        let (hotkey_accelerator, hotkey_registered) = {
            let overlay = overlay_state
                .lock()
                .map_err(|_| AuroraCommandError::SidecarState)?;
            (
                overlay.hotkey_accelerator.clone(),
                overlay.hotkey_registered,
            )
        };

        if hotkey_registered {
            if let Ok(previous_shortcut) = parse_overlay_shortcut(&hotkey_accelerator) {
                let _ = app.global_shortcut().unregister(previous_shortcut);
            }
        }

        let mut overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.hotkey_registered = false;
        overlay.last_registration_error = None;
        Ok(overlay.status())
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        let mut overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.hotkey_registered = false;
        overlay.last_registration_error = None;
        Ok(overlay.status())
    }
}

#[tauri::command]
async fn aurora_overlay_register_hotkey(
    app: AppHandle,
    overlay_state: State<'_, SharedOverlayState>,
    accelerator: Option<String>,
) -> Result<OverlayStatus, AuroraCommandError> {
    let accelerator = accelerator.unwrap_or_else(|| DEFAULT_OVERLAY_HOTKEY.to_string());
    let parsed = parse_overlay_shortcut(&accelerator);
    if let Err(error) = parsed.as_ref() {
        let mut overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.last_registration_error = Some(error.to_string());
        return Ok(overlay.status());
    }

    #[cfg(desktop)]
    {
        let shortcut = parsed.expect("overlay shortcut was parsed above");
        let previous = {
            let overlay = overlay_state
                .lock()
                .map_err(|_| AuroraCommandError::SidecarState)?;
            (
                overlay.hotkey_accelerator.clone(),
                overlay.hotkey_registered,
            )
        };
        if app
            .try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>()
            .is_none()
        {
            let mut overlay = overlay_state
                .lock()
                .map_err(|_| AuroraCommandError::SidecarState)?;
            overlay.hotkey_registered = false;
            overlay.last_registration_error =
                Some("Aurora overlay hotkey plugin was not installed".to_string());
            return Ok(overlay.status());
        }
        if previous.1 && previous.0 == accelerator {
            let mut overlay = overlay_state
                .lock()
                .map_err(|_| AuroraCommandError::SidecarState)?;
            overlay.last_registration_error = None;
            return Ok(overlay.status());
        }
        if previous.1 {
            if let Ok(previous_shortcut) = parse_overlay_shortcut(&previous.0) {
                let _ = app.global_shortcut().unregister(previous_shortcut);
            }
        }
        let registration_error = register_overlay_shortcut(&app, shortcut).err();
        let mut overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        if let Some(error) = registration_error {
            overlay.hotkey_registered = false;
            overlay.last_registration_error = Some(error.clone());
            if previous.1 {
                if let Ok(previous_shortcut) = parse_overlay_shortcut(&previous.0) {
                    match register_overlay_shortcut(&app, previous_shortcut) {
                        Ok(()) => {
                            overlay.hotkey_accelerator = previous.0;
                            overlay.hotkey_registered = true;
                            overlay.last_registration_error =
                                Some(format!("{error}; restored previous overlay hotkey"));
                        }
                        Err(restore_error) => {
                            overlay.hotkey_accelerator = previous.0;
                            overlay.last_registration_error = Some(format!(
                                "{error}; failed to restore previous overlay hotkey: {restore_error}"
                            ));
                        }
                    }
                }
            }
        } else {
            overlay.hotkey_accelerator = accelerator;
            overlay.hotkey_registered = true;
            overlay.last_registration_error = None;
        }
        Ok(overlay.status())
    }

    #[cfg(not(desktop))]
    {
        let _ = (app, parsed);
        let mut overlay = overlay_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        overlay.hotkey_registered = false;
        overlay.last_registration_error =
            Some("Aurora overlay hotkeys require a desktop Tauri target".to_string());
        Ok(overlay.status())
    }
}

#[tauri::command]
async fn aurora_shutdown(
    app: AppHandle,
    state: State<'_, SharedSidecarState>,
    subscription_state: State<'_, SharedSubscriptionState>,
    native_voice_state: State<'_, NativeVoiceState>,
) -> Result<(), AuroraCommandError> {
    shutdown_aurora(
        &app,
        state.inner(),
        subscription_state.inner(),
        native_voice_state.inner(),
    )
}

impl AuroraCommandError {
    fn code(&self) -> &'static str {
        match self {
            Self::InvalidGatewayOrigin(_) => "validation_error",
            Self::Gateway(_) => "transport_loss",
            Self::InvalidGatewayResponse => "validation_error",
            Self::NativePermissionMissing(_) => "native_permission_missing",
            #[cfg(any(target_os = "android", target_os = "ios"))]
            Self::AuroraMobileNativePlugin(_) => "native_plugin_error",
            Self::NativeSpeechPackSelectionInvalid => "validation_error",
            Self::UnsupportedFeature(_) => "unsupported_feature",
            Self::ThinModeSidecarDisabled => "unsupported_feature",
            Self::SidecarLoopbackRequired(_) => "validation_error",
            Self::SidecarTokenInvalid => "permission",
            Self::SidecarProcess(_) => "unavailable_service",
            Self::SidecarState => "transport_loss",
            Self::SecureStorageKeyInvalid(_) => "validation_error",
            Self::PeerCredentialExpired => "credential_expired",
            Self::SecureStorage(_) => "secure_storage_error",
            Self::LocalData(_) => "local_data_error",
        }
    }
}

fn native_permission_missing(permission: &'static str) -> AuroraCommandError {
    AuroraCommandError::NativePermissionMissing(permission.to_string())
}

fn validate_native_text(
    value: &str,
    max_len: usize,
    label: &str,
) -> Result<(), AuroraCommandError> {
    if value.trim().is_empty() || value.chars().count() > max_len {
        return Err(AuroraCommandError::UnsupportedFeature(format!(
            "{label} must be between 1 and {max_len} characters"
        )));
    }
    Ok(())
}

fn validate_native_deep_link(value: &str) -> Result<(), AuroraCommandError> {
    validate_native_text(value, 2_048, "native deep link")?;
    let url =
        Url::parse(value).map_err(|_| native_permission_missing("aurora.nativeOpenDeepLink"))?;
    match url.scheme() {
        "https" if url.host_str().is_some() && has_explicit_url_authority(value) => Ok(()),
        "mailto" | "tel" if !url.path().is_empty() => Ok(()),
        "aurora" | "aurora-local" => Ok(()),
        _ => Err(native_permission_missing("aurora.nativeOpenDeepLink")),
    }
}

fn has_explicit_url_authority(value: &str) -> bool {
    let Some((_, remainder)) = value.split_once(':') else {
        return false;
    };
    let Some(authority_and_path) = remainder.strip_prefix("//") else {
        return false;
    };
    authority_and_path
        .split(['/', '?', '#'])
        .next()
        .is_some_and(|authority| !authority.is_empty())
}

fn envelope(method: String, data: Value) -> AuroraEnvelope {
    AuroraEnvelope {
        data,
        audit: AuroraAudit {
            method,
            bus_topic: None,
            status: "ok".to_string(),
            transport: "tauri-local".to_string(),
            redaction: RedactionMetadata {
                secrets_redacted: true,
                source: "tauri-shell".to_string(),
                redacted_fields: vec![
                    "authorization".to_string(),
                    "token".to_string(),
                    "x-aurora-sidecar-token".to_string(),
                ],
                warnings: Vec::new(),
            },
        },
    }
}

fn native_capability_manifest() -> NativeCapabilityManifest {
    let desktop_platform = cfg!(desktop);
    let ios_platform = cfg!(target_os = "ios");
    let mut permissions = BTreeMap::new();
    permissions.insert("aurora.command".to_string(), true);
    permissions.insert("aurora.request".to_string(), true);
    permissions.insert("aurora.subscribe".to_string(), true);
    permissions.insert("aurora.nativeCapabilityManifest".to_string(), true);
    permissions.insert("aurora.sidecarStatus".to_string(), true);
    permissions.insert("aurora.sidecarSession".to_string(), desktop_platform);
    permissions.insert("aurora.sidecarStart".to_string(), desktop_platform);
    permissions.insert("aurora.sidecarStop".to_string(), desktop_platform);
    permissions.insert("aurora.shutdown".to_string(), desktop_platform);
    permissions.insert("aurora.overlay".to_string(), desktop_platform);
    permissions.insert("aurora.overlayHotkey".to_string(), desktop_platform);
    permissions.insert("aurora.logTail".to_string(), true);
    permissions.insert("aurora.updater".to_string(), false);
    permissions.insert("aurora.secureStorage".to_string(), desktop_platform);
    permissions.insert(
        "aurora.inboundVerifierStorage".to_string(),
        desktop_platform,
    );
    permissions.insert("aurora.iosKeychain".to_string(), ios_platform);
    permissions.insert("aurora.iosBiometricUnlock".to_string(), ios_platform);
    permissions.insert("aurora.nativePermissionStatus".to_string(), true);
    permissions.insert("aurora.trayStatus".to_string(), desktop_platform);
    permissions.insert("aurora.notificationsStatus".to_string(), true);
    permissions.insert("aurora.notificationsSend".to_string(), false);
    permissions.insert("aurora.dialogStatus".to_string(), true);
    permissions.insert("aurora.dialogOpen".to_string(), false);
    permissions.insert("aurora.localFileRead".to_string(), false);
    permissions.insert("aurora.localFileWrite".to_string(), false);
    permissions.insert("aurora.secureFileHandle".to_string(), false);
    permissions.insert("aurora.audioBridgeStatus".to_string(), true);
    permissions.insert("aurora.audioCapture".to_string(), false);
    permissions.insert("aurora.audioPlayback".to_string(), false);
    permissions.insert("aurora.nativeVoice".to_string(), desktop_platform);
    permissions.insert("aurora.iosVoiceStatus".to_string(), true);
    permissions.insert("aurora.iosBackgroundStatus".to_string(), true);
    permissions.insert("aurora.iosMicrophoneCapture".to_string(), ios_platform);
    permissions.insert("aurora.iosBackgroundAudio".to_string(), ios_platform);
    permissions.insert("aurora.iosAppIntents".to_string(), false);
    permissions.insert("aurora.iosShortcuts".to_string(), false);
    permissions.insert("aurora.iosShareExtension".to_string(), false);
    permissions.insert("aurora.iosWidgets".to_string(), false);
    permissions.insert("aurora.iosDeepLinks".to_string(), false);
    permissions.insert("aurora.iosSiriReplacement".to_string(), false);
    permissions.insert("aurora.shell".to_string(), false);
    permissions.insert("aurora.processSpawn".to_string(), false);
    permissions.insert("aurora.ios.appIntents".to_string(), ios_platform);
    permissions.insert("aurora.ios.shortcuts".to_string(), ios_platform);
    permissions.insert("aurora.ios.shareExtension".to_string(), false);
    permissions.insert("aurora.ios.deepLinks".to_string(), ios_platform);
    permissions.insert("aurora.ios.widgets".to_string(), false);
    permissions.insert("aurora.ios.fileAssociations".to_string(), false);
    permissions.insert("aurora.ios.entrypointPayload".to_string(), ios_platform);
    permissions.insert("aurora.iosLocalLightInference".to_string(), false);

    let mut capabilities = BTreeMap::new();
    capabilities.insert("desktop.thinGateway".to_string(), desktop_platform);
    capabilities.insert("desktop.localSidecarHealth".to_string(), desktop_platform);
    capabilities.insert("desktop.signedUpdater".to_string(), desktop_platform);
    capabilities.insert("desktop.bundledSidecarPolicy".to_string(), desktop_platform);
    capabilities.insert("desktop.logTail".to_string(), false);
    capabilities.insert(
        "desktop.localSidecarSupervision".to_string(),
        desktop_platform,
    );
    capabilities.insert("desktop.tray".to_string(), desktop_platform);
    capabilities.insert("desktop.overlayWindow".to_string(), desktop_platform);
    capabilities.insert("desktop.globalHotkey".to_string(), desktop_platform);
    capabilities.insert(
        "native.secureCredentialStorage".to_string(),
        desktop_platform,
    );
    capabilities.insert(
        "native.inboundVerifierStorage".to_string(),
        desktop_platform,
    );
    capabilities.insert("native.permissionsManifest".to_string(), true);
    capabilities.insert("native.notifications".to_string(), false);
    capabilities.insert("native.dialogs".to_string(), false);
    capabilities.insert("native.secureFileHandles".to_string(), false);
    capabilities.insert("native.filesystem".to_string(), false);
    capabilities.insert("native.audio".to_string(), false);
    capabilities.insert("native.audioCapture".to_string(), false);
    capabilities.insert("native.audioPlayback".to_string(), false);
    capabilities.insert("desktop.nativeVoice".to_string(), desktop_platform);
    capabilities.insert("ios.voiceForegroundCapture".to_string(), ios_platform);
    capabilities.insert("ios.notifications".to_string(), false);
    capabilities.insert("ios.backgroundVoice".to_string(), ios_platform);
    capabilities.insert("ios.appOwnedInvocation".to_string(), ios_platform);
    capabilities.insert("ios.appIntents".to_string(), ios_platform);
    capabilities.insert("ios.shortcuts".to_string(), ios_platform);
    capabilities.insert("ios.shareExtension".to_string(), false);
    capabilities.insert("ios.deepLinks".to_string(), ios_platform);
    capabilities.insert("ios.widgets".to_string(), false);
    capabilities.insert("ios.fileAssociations".to_string(), false);
    capabilities.insert("ios.entrypointPayload".to_string(), ios_platform);
    capabilities.insert("ios.localLightInference.provider".to_string(), ios_platform);
    capabilities.insert("ios.localLightInference.modelRuntime".to_string(), false);
    capabilities.insert("ios.localLightInference.fallback".to_string(), ios_platform);
    capabilities.insert(
        "ios.keychain.secureCredentialStorage".to_string(),
        ios_platform,
    );
    capabilities.insert("ios.biometric.adminUnlock".to_string(), ios_platform);
    capabilities.insert("ios.siriReplacement".to_string(), false);
    capabilities.insert(
        "android.buildBaseline".to_string(),
        cfg!(target_os = "android"),
    );
    capabilities.insert("android.assistantRoleProbe".to_string(), false);
    capabilities.insert(
        "android.fallbackEntrypoints".to_string(),
        cfg!(target_os = "android"),
    );
    let pending_native_target_state = if ios_platform {
        "pending_native_target"
    } else {
        "needs_native_permission"
    };
    let mut permission_states = ios_state_map("aurora.ios.", ios_platform);
    permission_states.insert(
        "aurora.ios.shareExtension".to_string(),
        pending_native_target_state.to_string(),
    );
    permission_states.insert(
        "aurora.ios.widgets".to_string(),
        pending_native_target_state.to_string(),
    );
    permission_states.insert(
        "aurora.ios.fileAssociations".to_string(),
        pending_native_target_state.to_string(),
    );
    permission_states.insert(
        "aurora.iosMicrophoneCapture".to_string(),
        "needs_native_permission".to_string(),
    );
    permission_states.insert(
        "aurora.iosBackgroundAudio".to_string(),
        "needs_native_permission".to_string(),
    );
    permission_states.insert(
        "aurora.iosLocalLightInference".to_string(),
        if ios_platform {
            "degraded"
        } else {
            "needs_native_permission"
        }
        .to_string(),
    );
    let mut capability_states = ios_state_map("ios.", ios_platform);
    capability_states.insert(
        "ios.shareExtension".to_string(),
        pending_native_target_state.to_string(),
    );
    capability_states.insert(
        "ios.widgets".to_string(),
        pending_native_target_state.to_string(),
    );
    capability_states.insert(
        "ios.fileAssociations".to_string(),
        pending_native_target_state.to_string(),
    );
    capability_states.insert(
        "ios.voiceForegroundCapture".to_string(),
        "needs_native_permission".to_string(),
    );
    capability_states.insert(
        "ios.notifications".to_string(),
        "needs_native_permission".to_string(),
    );
    capability_states.insert(
        "ios.backgroundVoice".to_string(),
        "needs_native_permission".to_string(),
    );
    capability_states.insert(
        "ios.appOwnedInvocation".to_string(),
        if ios_platform {
            "available"
        } else {
            "needs_native_permission"
        }
        .to_string(),
    );
    capability_states.insert(
        "ios.localLightInference.provider".to_string(),
        if ios_platform {
            "degraded"
        } else {
            "needs_native_permission"
        }
        .to_string(),
    );
    capability_states.insert(
        "ios.localLightInference.modelRuntime".to_string(),
        "needs_native_permission".to_string(),
    );
    capability_states.insert(
        "ios.localLightInference.fallback".to_string(),
        if ios_platform {
            "fallback"
        } else {
            "needs_native_permission"
        }
        .to_string(),
    );

    NativeCapabilityManifest {
        platform: native_platform().to_string(),
        permissions,
        capabilities,
        permission_states,
        capability_states,
        mobile_integrations: ios_mobile_integrations(ios_platform),
        platform_limitations: ios_platform_limitations(),
        ios_invocation: ios_invocation_status(ios_platform),
        local_light_inference: ios_local_light_inference_status(ios_platform),
        entrypoints: ios_native_entrypoints(ios_platform),
        last_entrypoint_payload: ios_entrypoint_payload(),
        evidence_source: "tauri-ios-native-manifest".to_string(),
        secrets_redacted: true,
    }
}

fn ios_state_map(prefix: &str, available: bool) -> BTreeMap<String, String> {
    let state = if available {
        "available"
    } else {
        "needs_native_permission"
    };
    let mut states = BTreeMap::new();
    for key in [
        "appIntents",
        "shortcuts",
        "shareExtension",
        "deepLinks",
        "widgets",
        "fileAssociations",
        "entrypointPayload",
    ] {
        states.insert(format!("{prefix}{key}"), state.to_string());
    }
    states.insert(
        format!("{prefix}siriReplacement"),
        "unsupported_platform".to_string(),
    );
    states
}

fn ios_mobile_integrations(available: bool) -> Vec<NativeMobileIntegration> {
    let supported_path = if available {
        "supported-path"
    } else {
        "planned"
    };
    let pending_native_target = if available { "pending" } else { "planned" };
    vec![
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "appIntents".to_string(),
            label: "Siri/Shortcuts/App Intents integration".to_string(),
            support: supported_path.to_string(),
            capability: "ios.appIntents".to_string(),
            permission: Some("aurora.ios.appIntents".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-001-baseline".to_string(),
            user_copy: "Scoped App Intents are planned for concrete Aurora actions; this baseline does not ship an executable intent.".to_string(),
            verifier: "tauri ios build plus simulator/device App Intent invocation on macOS/Xcode".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "shortcuts".to_string(),
            label: "Shortcuts invocation path".to_string(),
            support: "supported-path".to_string(),
            capability: "ios.shortcuts".to_string(),
            permission: Some("aurora.ios.shortcuts".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-001-baseline".to_string(),
            user_copy: "Aurora may expose app-owned Shortcuts/App Intents flows after the iOS plugin and Xcode targets exist.".to_string(),
            verifier: "simulator/device shortcut invocation through Xcode-managed iOS target".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "shareExtension".to_string(),
            label: "iOS share extension intake".to_string(),
            support: pending_native_target.to_string(),
            capability: "ios.shareExtension".to_string(),
            permission: Some("aurora.ios.shareExtension".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-004-native-manifest".to_string(),
            user_copy: "Share extension intake will stay unavailable until Aurora verifies the iOS app target.".to_string(),
            verifier: "Xcode share-extension target smoke plus simulator/device share sheet invocation".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "deepLinks".to_string(),
            label: "iOS deep links".to_string(),
            support: supported_path.to_string(),
            capability: "ios.deepLinks".to_string(),
            permission: Some("aurora.ios.deepLinks".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-004-native-manifest".to_string(),
            user_copy: "aurora:// app links launch app-owned Aurora flows; backend state still proves any session or context handoff.".to_string(),
            verifier: "simulator/device aurora:// URL open smoke through the iOS Tauri target".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "widgets".to_string(),
            label: "iOS widgets".to_string(),
            support: pending_native_target.to_string(),
            capability: "ios.widgets".to_string(),
            permission: Some("aurora.ios.widgets".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-004-native-manifest".to_string(),
            user_copy: "Widget actions will stay unavailable until Aurora verifies the iOS widget target.".to_string(),
            verifier: "Xcode widget extension build plus simulator widget tap smoke".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "fileAssociations".to_string(),
            label: "iOS file associations".to_string(),
            support: pending_native_target.to_string(),
            capability: "ios.fileAssociations".to_string(),
            permission: Some("aurora.ios.fileAssociations".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-004-tauri-file-associations".to_string(),
            user_copy: "File-open intake will stay unavailable until Aurora verifies iOS file association handling.".to_string(),
            verifier: "Tauri mobile file association metadata plus simulator document-open smoke".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "iosLocalLightInference".to_string(),
            label: "iOS local-light inference provider".to_string(),
            support: supported_path.to_string(),
            capability: "ios.localLightInference.provider".to_string(),
            permission: Some("aurora.iosLocalLightInference".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "ios-native-local-light-adapter".to_string(),
            user_copy: "Native adapter reports iOS Core ML/MLC/ExecuTorch-style local-light inference as a capability-gated provider; backend model catalog and device/model proof are still required before selection.".to_string(),
            verifier: "tauri ios build plus simulator/device nativeCapabilityManifest payload smoke".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "siriReplacement".to_string(),
            label: "System assistant role".to_string(),
            support: "unsupported".to_string(),
            capability: "ios.siriReplacement".to_string(),
            permission: None,
            privacy_class: "public".to_string(),
            evidence_source: "Apple-platform-policy".to_string(),
            user_copy: "iOS does not allow third-party default assistant ownership.".to_string(),
            verifier: "copy and capability review; no executable route should be exposed".to_string(),
        },
    ]
}

fn ios_local_light_inference_status(available: bool) -> LocalLightInferenceStatus {
    ios_local_light_inference_status_from_voice_packs(available, None)
}

fn ios_local_light_inference_status_from_voice_packs(
    platform_available: bool,
    voice_pack_status: Option<&Value>,
) -> LocalLightInferenceStatus {
    let catalog_visible = voice_pack_status
        .map(ios_voice_pack_catalog_visible)
        .unwrap_or(false);
    let active_model_id = voice_pack_status.and_then(ios_ready_local_voice_model_id);
    let model_present = active_model_id.is_some();
    let provider_available = platform_available && (catalog_visible || model_present);
    let requestable = platform_available && model_present;
    let state = if !platform_available {
        "needs_native_permission"
    } else if requestable {
        "available"
    } else if catalog_visible {
        "needs_model"
    } else {
        "degraded"
    };
    let reason = if !platform_available {
        "ios_native_local_light_adapter_unavailable"
    } else if requestable {
        "ios_voice_packs_installed_and_active"
    } else if catalog_visible {
        "ios_voice_catalog_ready_but_required_packs_missing"
    } else {
        "backend_model_catalog_and_device_model_proof_required"
    };

    LocalLightInferenceStatus {
        platform: "ios".to_string(),
        provider_id: "native:mobile-local-light".to_string(),
        available: provider_available,
        requestable,
        model_runtime_provider: requestable,
        backend_model_catalog_required: true,
        hardware_acceleration: "unknown".to_string(),
        model_id: active_model_id,
        model_present,
        permission_granted: platform_available,
        state: state.to_string(),
        fallback_available: platform_available,
        fallback_provider_id: if platform_available {
            Some("local:Orchestrator:llama-cpp".to_string())
        } else {
            None
        },
        reason: reason.to_string(),
        evidence_source: "ios-native-local-light-adapter".to_string(),
        secrets_redacted: true,
    }
}

fn ios_voice_pack_catalog_visible(status: &Value) -> bool {
    status
        .get("count")
        .and_then(Value::as_u64)
        .is_some_and(|count| count > 0)
        || status
            .get("packs")
            .and_then(Value::as_array)
            .is_some_and(|packs| !packs.is_empty())
}

fn ios_ready_local_voice_model_id(status: &Value) -> Option<String> {
    let active_slots = status.get("activeSlots")?.as_object()?;
    let packs = status.get("packs")?.as_array()?;
    let mut active_model_id = None;

    for required_slot in ["vad", "kws", "stt", "tts"] {
        let pack_id = active_slots
            .get(required_slot)
            .and_then(Value::as_str)
            .filter(|pack_id| !pack_id.trim().is_empty())?;
        let pack = packs.iter().find(|candidate| {
            candidate
                .get("packId")
                .and_then(Value::as_str)
                .is_some_and(|candidate_id| candidate_id == pack_id)
        })?;
        let installed = pack
            .get("installed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let acknowledged = pack
            .get("acknowledged")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !installed || !acknowledged {
            return None;
        }
        if required_slot == "stt" {
            active_model_id = Some(pack_id.to_string());
        }
    }

    active_model_id
}

fn ios_invocation_status(available: bool) -> IosInvocationStatus {
    IosInvocationStatus {
        platform: "ios".to_string(),
        app_intents_available: available,
        shortcuts_available: available,
        share_extension_available: false,
        deep_links_available: available,
        widgets_available: false,
        file_associations_available: false,
        siri_replacement: false,
        backend_handoff_required: true,
        privacy_labels: vec!["personal".to_string(), "sensitive".to_string()],
        state: if available {
            "degraded"
        } else {
            "needs_native_permission"
        }
        .to_string(),
        reason: if available {
            "Deep links can open Aurora now. Share, widget, and file-open options stay unavailable until mobile app setup is complete.".to_string()
        } else {
            "This iOS feature is unavailable until mobile app setup is complete.".to_string()
        },
        evidence_source: "IOS-004-native-manifest".to_string(),
        secrets_redacted: true,
    }
}

fn ios_native_entrypoints(available: bool) -> Vec<IosNativeEntrypoint> {
    let pending_native_target = if available {
        "pending_native_target".to_string()
    } else {
        "needs_native_permission".to_string()
    };
    let deep_link_state = if available {
        "available".to_string()
    } else {
        "needs_native_permission".to_string()
    };
    vec![
        IosNativeEntrypoint {
            id: "ios_share_extension".to_string(),
            platform: "ios".to_string(),
            label: "iOS share extension".to_string(),
            state: pending_native_target.clone(),
            available: false,
            capability: "ios.shareExtension".to_string(),
            permission: Some("aurora.ios.shareExtension".to_string()),
            intake_type: "share_extension".to_string(),
            url_scheme: None,
            universal_link_host: None,
            file_extensions: Vec::new(),
            xcode_target: "AuroraShareExtension".to_string(),
            backend_required: true,
            payload_command: "iosEntrypointPayload".to_string(),
            privacy_class: "personal".to_string(),
            reason: "This iOS feature is unavailable until mobile app setup is complete.".to_string(),
        },
        IosNativeEntrypoint {
            id: "ios_deep_link".to_string(),
            platform: "ios".to_string(),
            label: "iOS deep link".to_string(),
            state: deep_link_state,
            available,
            capability: "ios.deepLinks".to_string(),
            permission: Some("aurora.ios.deepLinks".to_string()),
            intake_type: "deep_link".to_string(),
            url_scheme: Some("aurora".to_string()),
            universal_link_host: Some("link.aurora.local".to_string()),
            file_extensions: Vec::new(),
            xcode_target: "Aurora".to_string(),
            backend_required: true,
            payload_command: "iosEntrypointPayload".to_string(),
            privacy_class: "personal".to_string(),
            reason: "Deep links launch Aurora-owned flows only; backend evidence decides whether content/session intake succeeded.".to_string(),
        },
        IosNativeEntrypoint {
            id: "ios_widget".to_string(),
            platform: "ios".to_string(),
            label: "iOS widget".to_string(),
            state: pending_native_target.clone(),
            available: false,
            capability: "ios.widgets".to_string(),
            permission: Some("aurora.ios.widgets".to_string()),
            intake_type: "widget".to_string(),
            url_scheme: None,
            universal_link_host: None,
            file_extensions: Vec::new(),
            xcode_target: "AuroraWidgetExtension".to_string(),
            backend_required: true,
            payload_command: "iosEntrypointPayload".to_string(),
            privacy_class: "personal".to_string(),
            reason: "This iOS feature is unavailable until mobile app setup is complete.".to_string(),
        },
        IosNativeEntrypoint {
            id: "ios_file_association".to_string(),
            platform: "ios".to_string(),
            label: "iOS file association".to_string(),
            state: pending_native_target,
            available: false,
            capability: "ios.fileAssociations".to_string(),
            permission: Some("aurora.ios.fileAssociations".to_string()),
            intake_type: "file_association".to_string(),
            url_scheme: None,
            universal_link_host: None,
            file_extensions: vec![
                "txt".to_string(),
                "md".to_string(),
                "json".to_string(),
                "aurora".to_string(),
            ],
            xcode_target: "Aurora".to_string(),
            backend_required: true,
            payload_command: "iosEntrypointPayload".to_string(),
            privacy_class: "personal".to_string(),
            reason: "This iOS feature is unavailable until mobile app setup is complete.".to_string(),
        },
    ]
}

fn ios_entrypoint_payload() -> IosEntrypointPayload {
    IosEntrypointPayload {
        source: "none".to_string(),
        invocation: "none".to_string(),
        url: None,
        scheme: None,
        host: None,
        path: None,
        file_extension: None,
        uniform_type_identifier: None,
        originating_bundle_id: None,
        shared_item_count: 0,
        privacy_labels: vec!["personal".to_string()],
        backend_handoff_required: true,
        correlation_id: None,
        secrets_redacted: true,
    }
}

fn ios_platform_limitations() -> Vec<NativePlatformLimitation> {
    vec![NativePlatformLimitation {
        platform: "ios".to_string(),
        id: "noSiriReplacement".to_string(),
        label: "No system assistant role".to_string(),
        reason: "Apple permits app-owned App Intents, Shortcuts, widgets, share extensions, and deep links, not third-party default assistant ownership.".to_string(),
        user_copy: "Use Siri/Shortcuts/App Intents integration; do not claim default iOS assistant ownership.".to_string(),
        evidence_source: "Apple App Intents and SiriKit extension documentation".to_string(),
    }]
}

fn native_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "tauri-desktop"
    }
}

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_aurora_native);

fn aurora_mobile_native_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("aurora-native")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(
                    "dev.aurora.tauri.nativeplugin",
                    "AuroraNativePlugin",
                )?;
                app.manage(AuroraMobileNativePlugin::<R> {
                    handle: Some(handle),
                    _runtime: std::marker::PhantomData,
                });
            }
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_aurora_native)?;
                app.manage(AuroraMobileNativePlugin::<R> {
                    handle: Some(handle),
                    _runtime: std::marker::PhantomData,
                });
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                app.manage(AuroraMobileNativePlugin::<R> {
                    _runtime: std::marker::PhantomData,
                });
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
pub(crate) fn run_android_plugin_command(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
    command: &str,
    payload: Value,
) -> Result<Value, AuroraCommandError> {
    let handle = native.handle.as_ref().ok_or_else(|| {
        AuroraCommandError::AuroraMobileNativePlugin(
            "Aurora Android native plugin handle was not registered".to_string(),
        )
    })?;
    handle
        .run_mobile_plugin::<Value>(command, payload)
        .map_err(|error| AuroraCommandError::AuroraMobileNativePlugin(error.to_string()))
}

#[cfg(target_os = "android")]
fn release_android_focused_voice_on_background(app: &AppHandle) {
    let Some(native) = app.try_state::<AuroraMobileNativePlugin<tauri::Wry>>() else {
        return;
    };
    let Some(handle) = native.handle.as_ref() else {
        return;
    };
    match handle.run_mobile_plugin::<Value>("releaseFocusedVoiceOnBackground", json!({})) {
        Ok(payload) => {
            let released = payload
                .get("released")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            eprintln!("aurora_android_focused_voice_background_release released={released}");
        }
        Err(error) => {
            eprintln!(
                "aurora_android_focused_voice_background_release_failed error={}",
                error
            );
        }
    }
}

#[cfg(target_os = "ios")]
fn run_ios_plugin_command(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
    command: &str,
    payload: Value,
) -> Result<Value, AuroraCommandError> {
    let handle = native.handle.as_ref().ok_or_else(|| {
        AuroraCommandError::AuroraMobileNativePlugin(
            "Aurora iOS native plugin handle was not registered".to_string(),
        )
    })?;
    handle
        .run_mobile_plugin::<Value>(command, payload)
        .map_err(|error| AuroraCommandError::AuroraMobileNativePlugin(error.to_string()))
}

fn android_baseline_status() -> AndroidBaselineStatus {
    let is_android = cfg!(target_os = "android");
    let mut fallback_entrypoints = BTreeMap::new();
    fallback_entrypoints.insert("manualOpen".to_string(), is_android);
    fallback_entrypoints.insert("remoteGateway".to_string(), is_android);
    fallback_entrypoints.insert("shareIntentPlanned".to_string(), false);
    fallback_entrypoints.insert("deepLinkPlanned".to_string(), false);

    AndroidBaselineStatus {
        platform: native_platform().to_string(),
        state: if is_android {
            "degraded".to_string()
        } else {
            "unsupported_platform".to_string()
        },
        feature: "android.buildBaseline".to_string(),
        available: is_android,
        assistant_role: AndroidAssistantRoleStatus {
            role_available: None,
            package_qualified: None,
            role_held: None,
            requestable: None,
            denied: None,
            oem_unavailable: None,
            probe_implemented: false,
            reason: if is_android {
                "Assistant role status is unavailable on this device".to_string()
            } else {
                "Android assistant-role status is unsupported on this platform".to_string()
            },
        },
        fallback_entrypoints,
        evidence_source: "tauri-android-baseline".to_string(),
        secrets_redacted: true,
    }
}

#[cfg(target_os = "android")]
fn android_baseline_status_from_plugin(
    native: State<'_, AuroraMobileNativePlugin<tauri::Wry>>,
) -> Result<AndroidBaselineStatus, AuroraCommandError> {
    let payload = run_android_plugin_command(native, "assistantRoleStatus", json!({}))?;
    let mut assistant_role: AndroidAssistantRoleStatus = serde_json::from_value(payload.clone())
        .map_err(|_| {
            AuroraCommandError::AuroraMobileNativePlugin(
                "Android assistant role status payload was invalid".to_string(),
            )
        })?;
    assistant_role.probe_implemented = true;
    let role_held = assistant_role.role_held.unwrap_or(false);
    let requestable = assistant_role.requestable.unwrap_or(false);
    let role_available = assistant_role.role_available.unwrap_or(false);
    let package_qualified = assistant_role.package_qualified.unwrap_or(false);
    let fallback_available = payload
        .get("fallbackAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut fallback_entrypoints = BTreeMap::new();
    fallback_entrypoints.insert("manualOpen".to_string(), fallback_available);
    fallback_entrypoints.insert("remoteGateway".to_string(), fallback_available);
    fallback_entrypoints.insert("shareIntentPlanned".to_string(), false);
    fallback_entrypoints.insert("deepLinkPlanned".to_string(), false);
    Ok(AndroidBaselineStatus {
        platform: "android".to_string(),
        state: if role_held || requestable {
            "available".to_string()
        } else if role_available && package_qualified {
            "needs_native_permission".to_string()
        } else if fallback_available {
            "fallback".to_string()
        } else {
            "degraded".to_string()
        },
        feature: "android.buildBaseline".to_string(),
        available: true,
        assistant_role,
        fallback_entrypoints,
        evidence_source: "android-native".to_string(),
        secrets_redacted: true,
    })
}

fn native_speech_pack_task_id(task: NativeSpeechPackTask) -> &'static str {
    match task {
        NativeSpeechPackTask::Stt => "stt",
        NativeSpeechPackTask::Vad => "vad",
        NativeSpeechPackTask::Kws => "kws",
        NativeSpeechPackTask::Tts => "tts",
    }
}

fn native_speech_pack_activation_slot(
    task: NativeSpeechPackTask,
    slot: Option<&str>,
) -> Result<String, AuroraCommandError> {
    let canonical = native_speech_pack_task_id(task);
    let Some(slot) = slot.map(str::trim).filter(|slot| !slot.is_empty()) else {
        return Ok(canonical.to_owned());
    };
    if slot == canonical {
        Ok(canonical.to_owned())
    } else {
        Err(AuroraCommandError::NativeSpeechPackSelectionInvalid)
    }
}

fn insert_native_speech_pack_active_slot(
    active: &mut BTreeMap<String, String>,
    task: NativeSpeechPackTask,
    slot: Option<&str>,
    pack_id: String,
) -> Result<(), AuroraCommandError> {
    let slot = native_speech_pack_activation_slot(task, slot)?;
    active.insert(slot, pack_id);
    Ok(())
}

#[cfg(any(desktop, target_os = "ios", test))]
fn native_speech_catalog_task(task: NativeSpeechPackTask) -> Option<SpeechCatalogTask> {
    match task {
        NativeSpeechPackTask::Stt => Some(SpeechCatalogTask::SpeechToText),
        NativeSpeechPackTask::Vad => Some(SpeechCatalogTask::VoiceActivityDetection),
        NativeSpeechPackTask::Kws => Some(SpeechCatalogTask::KeywordSpotting),
        NativeSpeechPackTask::Tts => None,
    }
}

fn native_speech_pack_catalog(
    app: &AppHandle,
    request: NativeSpeechPackCatalogRequest,
) -> Result<NativeSpeechPackCatalogResponse, AuroraCommandError> {
    #[cfg(any(desktop, target_os = "ios"))]
    {
        let active = native_speech_pack_active_slots(app)?;
        let manager = native_speech_pack_manager(app).ok();
        let mut languages = Vec::new();
        let mut packs = Vec::new();
        if request.task.is_none() || request.task == Some(NativeSpeechPackTask::Tts) {
            let catalog = TtsVoiceCatalog::runtime().map_err(|_| {
                AuroraCommandError::UnsupportedFeature("Speech catalog is unavailable".to_string())
            })?;
            languages.extend(catalog.languages.clone());
            for entry in &catalog.entries {
                if request
                    .language
                    .as_ref()
                    .is_some_and(|language| language != &entry.language)
                {
                    continue;
                }
                let installed = manager
                    .as_ref()
                    .is_some_and(|manager| manager.resolve_voice_bindings(&entry.voice_id).is_ok());
                packs.push(NativeSpeechPackCatalogEntry {
                    pack_id: entry.voice_id.clone(),
                    display_name: entry.display_name.clone(),
                    task: NativeSpeechPackTask::Tts,
                    languages: vec![entry.language.clone()],
                    language: Some(entry.language.clone()),
                    sha256: entry.archive.sha256.clone(),
                    file_size: entry.archive.byte_size,
                    installed,
                    active_slot: installed
                        .then(|| {
                            active
                                .iter()
                                .find(|(_, pack_id)| *pack_id == &entry.voice_id)
                                .map(|(slot, _)| slot.clone())
                        })
                        .flatten(),
                    revision: catalog.revision().to_string(),
                    runtime_revision: entry.engine.clone(),
                    model_family: entry.model_family.clone(),
                    requires_reference_audio: entry.requires_reference_profile(),
                    reference_audio_mode: entry
                        .catalog_reference_audio_mode_label()
                        .map(str::to_string),
                    voice_id: Some(entry.voice_id.clone()),
                    voice_revision: Some(catalog.revision().to_string()),
                    reference_profile_id: None,
                });
            }
        }
        let speech_task = request.task.and_then(native_speech_catalog_task);
        if request.task.is_none() || speech_task.is_some() {
            let catalog = SpeechModelCatalog::embedded().map_err(|_| {
                AuroraCommandError::UnsupportedFeature("Speech catalog is unavailable".to_string())
            })?;
            languages.extend(catalog.languages.clone());
            for entry in &catalog.entries {
                if speech_task.is_some_and(|task| task != entry.task) {
                    continue;
                }
                if request.language.as_ref().is_some_and(|language| {
                    !entry
                        .languages
                        .iter()
                        .any(|candidate| candidate == language)
                        && entry.language_scope != "language_independent"
                }) {
                    continue;
                }
                let task = match entry.task {
                    SpeechCatalogTask::SpeechToText => NativeSpeechPackTask::Stt,
                    SpeechCatalogTask::VoiceActivityDetection => NativeSpeechPackTask::Vad,
                    SpeechCatalogTask::KeywordSpotting => NativeSpeechPackTask::Kws,
                };
                let installed = manager
                    .as_ref()
                    .is_some_and(|manager| manager.resolve_model_bindings(&entry.model_id).is_ok());
                packs.push(NativeSpeechPackCatalogEntry {
                    pack_id: entry.model_id.clone(),
                    display_name: entry.display_name.clone(),
                    task,
                    languages: entry.languages.clone(),
                    language: entry.languages.first().cloned(),
                    sha256: entry.archive.sha256.clone(),
                    file_size: entry.archive.byte_size,
                    installed,
                    active_slot: installed
                        .then(|| {
                            active
                                .iter()
                                .find(|(_, pack_id)| *pack_id == &entry.model_id)
                                .map(|(slot, _)| slot.clone())
                        })
                        .flatten(),
                    revision: catalog.revision().to_string(),
                    runtime_revision: entry.engine.clone(),
                    model_family: entry.model_family.clone(),
                    requires_reference_audio: false,
                    reference_audio_mode: None,
                    voice_id: None,
                    voice_revision: None,
                    reference_profile_id: None,
                });
            }
        }
        languages.sort();
        languages.dedup();
        packs.sort_by(|left, right| left.pack_id.cmp(&right.pack_id));
        Ok(NativeSpeechPackCatalogResponse {
            available: true,
            count: packs.len(),
            languages,
            packs,
            secrets_redacted: true,
        })
    }

    #[cfg(not(any(desktop, target_os = "ios")))]
    {
        let _ = (app, request);
        Err(AuroraCommandError::UnsupportedFeature(
            "Native speech packs are unavailable on this platform".to_string(),
        ))
    }
}

fn native_speech_pack_status(
    app: &AppHandle,
) -> Result<NativeSpeechPackStatusResponse, AuroraCommandError> {
    let catalog = native_speech_pack_catalog(
        app,
        NativeSpeechPackCatalogRequest {
            task: None,
            language: None,
        },
    )?;
    Ok(NativeSpeechPackStatusResponse {
        available: catalog.available,
        active_slots: filtered_native_speech_pack_active_slots(
            native_speech_pack_active_slots(app)?,
            &catalog.packs,
        ),
        count: catalog.count,
        packs: catalog.packs,
        secrets_redacted: true,
    })
}

fn filtered_native_speech_pack_active_slots(
    active: BTreeMap<String, String>,
    packs: &[NativeSpeechPackCatalogEntry],
) -> BTreeMap<String, String> {
    active
        .into_iter()
        .filter(|(slot, pack_id)| {
            packs.iter().any(|pack| {
                pack.installed
                    && pack.pack_id == *pack_id
                    && pack.active_slot.as_deref() == Some(slot.as_str())
            })
        })
        .collect()
}

#[cfg(any(desktop, target_os = "ios"))]
fn native_speech_pack_manager(app: &AppHandle) -> Result<SpeechPackManager, AuroraCommandError> {
    let root = native_speech_pack_root(app)?;
    let config = SpeechPackManagerConfig::new(root, None).map_err(|_| {
        AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
    })?;
    SpeechPackManager::open(config).map_err(|_| {
        AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
    })
}

#[cfg(any(desktop, target_os = "ios"))]
fn native_speech_pack_root(app: &AppHandle) -> Result<PathBuf, AuroraCommandError> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("speech-packs"))
        .map_err(|_| {
            AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
        })
}

fn native_speech_pack_active_slots(
    app: &AppHandle,
) -> Result<BTreeMap<String, String>, AuroraCommandError> {
    #[cfg(any(desktop, target_os = "ios"))]
    {
        let path = native_speech_pack_root(app)?.join("active-slots.json");
        if !path.exists() {
            return Ok(BTreeMap::new());
        }
        let mut file = std::fs::File::open(path).map_err(|_| {
            AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
        })?;
        let mut payload = String::new();
        file.read_to_string(&mut payload).map_err(|_| {
            AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
        })?;
        serde_json::from_str(&payload).map_err(|_| {
            AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
        })
    }

    #[cfg(not(any(desktop, target_os = "ios")))]
    {
        let _ = app;
        Ok(BTreeMap::new())
    }
}

#[cfg(any(desktop, target_os = "ios"))]
fn write_native_speech_pack_active_slots(
    app: &AppHandle,
    active: &BTreeMap<String, String>,
) -> Result<(), AuroraCommandError> {
    let root = native_speech_pack_root(app)?;
    std::fs::create_dir_all(&root).map_err(|_| {
        AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
    })?;
    let path = root.join("active-slots.json");
    let temp = root.join("active-slots.json.tmp");
    let payload =
        serde_json::to_vec(active).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
    std::fs::write(&temp, payload).map_err(|_| {
        AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
    })?;
    std::fs::rename(temp, path).map_err(|_| {
        AuroraCommandError::UnsupportedFeature("Speech packs are unavailable".to_string())
    })
}

fn ios_native_details() -> BTreeMap<String, Value> {
    let mut details = BTreeMap::new();
    details.insert("platform".to_string(), json!(native_platform()));
    details.insert("secretsRedacted".to_string(), json!(true));
    details.insert("privacyClass".to_string(), json!("credential"));
    details.insert("appOwnedSurfaceOnly".to_string(), json!(true));
    details.insert(
        "integrationCopy".to_string(),
        json!("Siri/Shortcuts/App Intents integration"),
    );
    details.insert("siriReplacement".to_string(), json!(false));
    details
}

fn denied_native_feature_status(
    permission: &str,
    capability: &str,
    reason: &str,
) -> Result<NativeFeatureStatus, AuroraCommandError> {
    let mut details = BTreeMap::new();
    details.insert("enabledByDefault".to_string(), json!(false));
    details.insert("secretsRedacted".to_string(), json!(true));
    Ok(NativeFeatureStatus {
        available: false,
        permission: permission.to_string(),
        capability: capability.to_string(),
        source: "tauri-capability-manifest".to_string(),
        reason: Some(reason.to_string()),
        details,
    })
}

#[cfg(desktop)]
fn secure_storage_entry(key: &str) -> Result<keyring::Entry, AuroraCommandError> {
    validate_secure_storage_key(key)?;
    raw_secure_storage_entry(key)
}

#[cfg(desktop)]
fn thin_profile_storage_entry() -> Result<keyring::Entry, AuroraCommandError> {
    raw_secure_storage_entry(DESKTOP_THIN_PROFILES_KEY)
}

#[cfg(desktop)]
fn peer_credential_storage_entry(key: &str) -> Result<keyring::Entry, AuroraCommandError> {
    if !is_peer_proof_storage_key(key) && !is_room_secret_storage_key(key) {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(key.to_string()));
    }
    raw_secure_storage_entry(key)
}

#[cfg(any(desktop, test))]
trait InboundVerifierStorageBackend {
    fn get_secret(&self, account: &str) -> Result<Option<String>, AuroraCommandError>;
    fn set_secret(&self, account: &str, value: &str) -> Result<(), AuroraCommandError>;
    fn delete_secret(&self, account: &str) -> Result<(), AuroraCommandError>;
}

#[cfg(desktop)]
struct DesktopInboundVerifierStorageBackend;

#[cfg(desktop)]
impl InboundVerifierStorageBackend for DesktopInboundVerifierStorageBackend {
    fn get_secret(&self, account: &str) -> Result<Option<String>, AuroraCommandError> {
        match inbound_verifier_storage_entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
        }
    }

    fn set_secret(&self, account: &str, value: &str) -> Result<(), AuroraCommandError> {
        inbound_verifier_storage_entry(account)?
            .set_password(value)
            .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
    }

    fn delete_secret(&self, account: &str) -> Result<(), AuroraCommandError> {
        match inbound_verifier_storage_entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
        }
    }
}

#[cfg(desktop)]
fn inbound_verifier_storage_entry(account: &str) -> Result<keyring::Entry, AuroraCommandError> {
    validate_inbound_verifier_storage_account(account)?;
    keyring::Entry::new(INBOUND_VERIFIER_STORAGE_SERVICE, account)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

#[cfg(any(desktop, test))]
fn inbound_verifier_storage_get<B: InboundVerifierStorageBackend>(
    backend: &B,
    key: &str,
) -> Result<Option<String>, AuroraCommandError> {
    validate_inbound_verifier_secret_key(key)?;
    let account = inbound_verifier_storage_account(key)?;
    backend.get_secret(&account)
}

#[cfg(any(desktop, test))]
fn inbound_verifier_storage_set<B: InboundVerifierStorageBackend>(
    backend: &B,
    key: &str,
    value: &str,
) -> Result<(), AuroraCommandError> {
    let selector = parse_inbound_verifier_secret_key(key)?;
    validate_inbound_verifier_secret_value_for_selector(value, &selector)?;
    let account = inbound_verifier_storage_account_from_valid_key(key);
    backend.set_secret(&account, value)
}

#[cfg(any(desktop, test))]
fn inbound_verifier_storage_delete<B: InboundVerifierStorageBackend>(
    backend: &B,
    key: &str,
) -> Result<(), AuroraCommandError> {
    validate_inbound_verifier_secret_key(key)?;
    let account = inbound_verifier_storage_account(key)?;
    backend.delete_secret(&account)
}

#[cfg(desktop)]
fn raw_secure_storage_entry(key: &str) -> Result<keyring::Entry, AuroraCommandError> {
    keyring::Entry::new(SECURE_STORAGE_SERVICE, key)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

#[cfg(desktop)]
fn assistant_provider_storage_entry() -> Result<keyring::Entry, AuroraCommandError> {
    keyring::Entry::new(
        ASSISTANT_PROVIDER_STORAGE_SERVICE,
        ASSISTANT_PROVIDER_CONFIG_KEY,
    )
    .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

fn load_assistant_provider_config(
) -> Result<Option<AssistantProviderStoredConfig>, AuroraCommandError> {
    #[cfg(desktop)]
    {
        let entry = assistant_provider_storage_entry()?;
        let value = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(error) => return Err(AuroraCommandError::SecureStorage(error.to_string())),
        };
        let config: AssistantProviderStoredConfig =
            serde_json::from_str(&value).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
        validate_assistant_provider_stored_config(&config)?;
        Ok(Some(config))
    }
    #[cfg(not(desktop))]
    {
        Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider keychain is only available on trusted desktop Tauri targets"
                .to_string(),
        ))
    }
}

fn store_assistant_provider_config(
    config: &AssistantProviderStoredConfig,
) -> Result<(), AuroraCommandError> {
    #[cfg(desktop)]
    {
        let serialized = serde_json::to_string(config)
            .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
        assistant_provider_storage_entry()?
            .set_password(&serialized)
            .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
    }
    #[cfg(not(desktop))]
    {
        let _ = config;
        Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider keychain is only available on trusted desktop Tauri targets"
                .to_string(),
        ))
    }
}

fn delete_assistant_provider_config() -> Result<(), AuroraCommandError> {
    #[cfg(desktop)]
    {
        match assistant_provider_storage_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
        }
    }
    #[cfg(not(desktop))]
    {
        Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider keychain is only available on trusted desktop Tauri targets"
                .to_string(),
        ))
    }
}

fn assistant_provider_status(
    config: Option<&AssistantProviderStoredConfig>,
) -> AssistantProviderStatus {
    AssistantProviderStatus {
        configured: config.is_some(),
        enabled: config.is_some_and(|item| item.enabled),
        provider: ASSISTANT_PROVIDER_KIND.to_string(),
        endpoint: config
            .and_then(|item| sanitized_assistant_provider_endpoint(&item.endpoint).ok()),
        model: config.map(|item| item.model.clone()),
        backend: "platform-keychain".to_string(),
        persisted: config.is_some(),
        secrets_redacted: true,
        redacted_fields: vec!["apiKey".to_string()],
    }
}

fn validate_assistant_provider_config(
    request: AssistantProviderConfigureRequest,
) -> Result<AssistantProviderStoredConfig, AuroraCommandError> {
    let provider = request
        .provider
        .unwrap_or_else(|| ASSISTANT_PROVIDER_KIND.to_string());
    if provider != ASSISTANT_PROVIDER_KIND {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider supports only openai-compatible endpoints".to_string(),
        ));
    }
    let endpoint = request.endpoint.ok_or_else(|| {
        AuroraCommandError::UnsupportedFeature(
            "assistant provider endpoint is required".to_string(),
        )
    })?;
    validate_assistant_provider_endpoint(&endpoint)?;
    let model = request.model.ok_or_else(|| {
        AuroraCommandError::UnsupportedFeature("assistant provider model is required".to_string())
    })?;
    validate_assistant_provider_token("model", &model, 128)?;
    let api_key = request.api_key.ok_or_else(|| {
        AuroraCommandError::UnsupportedFeature("assistant provider API key is required".to_string())
    })?;
    validate_assistant_provider_secret(&api_key)?;
    let config = AssistantProviderStoredConfig {
        provider,
        endpoint,
        model,
        api_key,
        enabled: request.enabled.unwrap_or(true),
        updated_at_ms: current_unix_ms(),
    };
    validate_assistant_provider_stored_config(&config)?;
    Ok(config)
}

fn validate_assistant_provider_stored_config(
    config: &AssistantProviderStoredConfig,
) -> Result<(), AuroraCommandError> {
    if config.provider != ASSISTANT_PROVIDER_KIND {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider configuration is not supported".to_string(),
        ));
    }
    validate_assistant_provider_endpoint(&config.endpoint)?;
    validate_assistant_provider_token("model", &config.model, 128)?;
    validate_assistant_provider_secret(&config.api_key)
}

fn validate_assistant_provider_endpoint(endpoint: &str) -> Result<(), AuroraCommandError> {
    validate_assistant_provider_text_bound(endpoint, 2_048, "assistant provider endpoint")?;
    let url = Url::parse(endpoint).map_err(|_| {
        AuroraCommandError::UnsupportedFeature("assistant provider endpoint is invalid".to_string())
    })?;
    if url.host_str().is_none() || !has_explicit_url_authority(endpoint) {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider endpoint must include a host".to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider endpoint must not include credentials".to_string(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider endpoint must not include query or fragment components".to_string(),
        ));
    }
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(&url) => Ok(()),
        _ => Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider endpoint must use HTTPS or loopback HTTP".to_string(),
        )),
    }
}

fn sanitized_assistant_provider_endpoint(endpoint: &str) -> Result<String, AuroraCommandError> {
    validate_assistant_provider_endpoint(endpoint)?;
    let mut url = Url::parse(endpoint).map_err(|_| {
        AuroraCommandError::UnsupportedFeature("assistant provider endpoint is invalid".to_string())
    })?;
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn assistant_provider_http_client() -> Result<reqwest::Client, AuroraCommandError> {
    reqwest::Client::builder()
        .connect_timeout(ASSISTANT_PROVIDER_CONNECT_TIMEOUT)
        .read_timeout(ASSISTANT_PROVIDER_READ_TIMEOUT)
        .timeout(ASSISTANT_PROVIDER_OVERALL_TIMEOUT)
        .build()
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))
}

async fn read_assistant_provider_response_bounded(
    mut response: reqwest::Response,
) -> Result<String, AuroraCommandError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?
    {
        append_assistant_provider_response_chunk(
            &mut bytes,
            chunk.as_ref(),
            ASSISTANT_PROVIDER_RESPONSE_MAX_BYTES,
        )?;
    }
    String::from_utf8(bytes).map_err(|_| AuroraCommandError::InvalidGatewayResponse)
}

fn append_assistant_provider_response_chunk(
    bytes: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: usize,
) -> Result<(), AuroraCommandError> {
    let next_len = bytes.len().checked_add(chunk.len()).ok_or_else(|| {
        AuroraCommandError::UnsupportedFeature(
            "assistant provider response is too large".to_string(),
        )
    })?;
    if next_len > max_bytes {
        return Err(AuroraCommandError::UnsupportedFeature(format!(
            "assistant provider response exceeds {max_bytes} bytes"
        )));
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn validate_assistant_provider_secret(secret: &str) -> Result<(), AuroraCommandError> {
    validate_assistant_provider_text_bound(secret, 8_192, "assistant provider API key")?;
    if secret.trim().is_empty() || secret.chars().any(char::is_control) {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider API key is invalid".to_string(),
        ));
    }
    Ok(())
}

fn validate_assistant_provider_token(
    label: &str,
    value: &str,
    max_len: usize,
) -> Result<(), AuroraCommandError> {
    validate_assistant_provider_text_bound(value, max_len, label)?;
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(AuroraCommandError::UnsupportedFeature(format!(
            "{label} is invalid"
        )));
    }
    Ok(())
}

fn validate_assistant_provider_text_bound(
    value: &str,
    max_len: usize,
    label: &str,
) -> Result<(), AuroraCommandError> {
    if value.is_empty() || value.len() > max_len {
        return Err(AuroraCommandError::UnsupportedFeature(format!(
            "{label} must be between 1 and {max_len} bytes"
        )));
    }
    Ok(())
}

fn validate_assistant_provider_request(
    request: &AssistantProviderCompleteRequest,
) -> Result<(), AuroraCommandError> {
    if request.messages.is_empty() || request.messages.len() > 40 {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider message count is outside the allowed range".to_string(),
        ));
    }
    if request.tools.len() > 32 {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider tool count is outside the allowed range".to_string(),
        ));
    }
    for message in &request.messages {
        match message.role.as_str() {
            "system" | "user" | "assistant" | "tool" => {}
            _ => {
                return Err(AuroraCommandError::UnsupportedFeature(
                    "assistant provider message role is unsupported".to_string(),
                ))
            }
        }
        validate_assistant_provider_text_bound(&message.content, 64 * 1024, "assistant message")?;
        if let Some(name) = &message.name {
            validate_assistant_provider_token("assistant message name", name, 128)?;
        }
        if let Some(tool_call_id) = &message.tool_call_id {
            validate_assistant_provider_token("assistant tool call id", tool_call_id, 128)?;
        }
    }
    for tool in &request.tools {
        validate_assistant_provider_token("tool id", &tool.global_tool_id, 512)?;
        validate_assistant_provider_text_bound(&tool.description, 8 * 1024, "tool description")?;
        match tool.execution_location.as_str() {
            "local" | "remote" => {}
            _ => {
                return Err(AuroraCommandError::UnsupportedFeature(
                    "tool execution location is unsupported".to_string(),
                ))
            }
        }
    }
    let serialized =
        serde_json::to_string(request).map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
    validate_assistant_provider_text_bound(&serialized, 128 * 1024, "assistant provider request")
}

fn assistant_provider_openai_body(
    config: &AssistantProviderStoredConfig,
    request: &AssistantProviderCompleteRequest,
    aliases: &HashMap<String, AssistantToolAlias>,
) -> Result<Value, AuroraCommandError> {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|message| {
            let mut object = serde_json::Map::new();
            object.insert("role".to_string(), json!(message.role));
            object.insert("content".to_string(), json!(message.content));
            if let Some(tool_call_id) = &message.tool_call_id {
                object.insert("tool_call_id".to_string(), json!(tool_call_id));
            }
            if let Some(name) = &message.name {
                object.insert("name".to_string(), json!(name));
            }
            Value::Object(object)
        })
        .collect();
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            let alias = aliases
                .get(&tool.global_tool_id)
                .ok_or(AuroraCommandError::InvalidGatewayResponse)?;
            Ok(json!({
                "type": "function",
                "function": {
                    "name": alias.alias,
                    "description": tool.description,
                    "parameters": tool.args_schema
                }
            }))
        })
        .collect::<Result<Vec<_>, AuroraCommandError>>()?;
    Ok(json!({
        "model": config.model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "parallel_tool_calls": false
    }))
}

fn assistant_tool_aliases(
    tools: &[AssistantProviderTool],
) -> Result<HashMap<String, AssistantToolAlias>, AuroraCommandError> {
    let mut by_global = HashMap::new();
    let mut by_alias = HashMap::new();
    for tool in tools {
        let alias = openai_tool_alias(&tool.global_tool_id)?;
        if let Some(existing) = by_alias.get(&alias) {
            if existing != &tool.global_tool_id {
                return Err(AuroraCommandError::UnsupportedFeature(
                    "assistant provider tool alias collision".to_string(),
                ));
            }
        }
        by_alias.insert(alias.clone(), tool.global_tool_id.clone());
        by_global.insert(
            tool.global_tool_id.clone(),
            AssistantToolAlias {
                global_tool_id: tool.global_tool_id.clone(),
                alias,
                execution_location: tool.execution_location.clone(),
            },
        );
    }
    Ok(by_global)
}

fn parse_assistant_provider_response(
    raw: &Value,
    aliases: &HashMap<String, AssistantToolAlias>,
) -> Result<AssistantProviderCompleteResponse, AuroraCommandError> {
    let by_alias: HashMap<String, AssistantToolAlias> = aliases
        .values()
        .map(|alias| (alias.alias.clone(), alias.clone()))
        .collect();
    let message = raw
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .ok_or(AuroraCommandError::InvalidGatewayResponse)?;
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let Some(tool_calls) = message.get("tool_calls") else {
        return Ok(AssistantProviderCompleteResponse::Message { content });
    };
    let tool_calls = tool_calls
        .as_array()
        .ok_or(AuroraCommandError::InvalidGatewayResponse)?
        .iter()
        .map(|tool_call| parse_assistant_tool_call(tool_call, &by_alias))
        .collect::<Result<Vec<_>, AuroraCommandError>>()?;
    Ok(AssistantProviderCompleteResponse::ToolCalls {
        content: Some(content),
        tool_calls,
    })
}

fn parse_assistant_tool_call(
    raw: &Value,
    aliases: &HashMap<String, AssistantToolAlias>,
) -> Result<AssistantProviderToolCall, AuroraCommandError> {
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .ok_or(AuroraCommandError::InvalidGatewayResponse)?
        .to_string();
    let function = raw
        .get("function")
        .and_then(Value::as_object)
        .ok_or(AuroraCommandError::InvalidGatewayResponse)?;
    let provider_tool_name = function
        .get("name")
        .and_then(Value::as_str)
        .ok_or(AuroraCommandError::InvalidGatewayResponse)?
        .to_string();
    let arguments_text = function
        .get("arguments")
        .and_then(Value::as_str)
        .ok_or(AuroraCommandError::InvalidGatewayResponse)?;
    let arguments: Value = serde_json::from_str(arguments_text)
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
    if !arguments.is_object() {
        return Err(AuroraCommandError::InvalidGatewayResponse);
    }
    let alias = aliases.get(&provider_tool_name);
    Ok(AssistantProviderToolCall {
        id,
        tool_name: alias
            .map(|item| item.global_tool_id.clone())
            .unwrap_or_else(|| provider_tool_name.clone()),
        provider_tool_name,
        arguments,
        route: alias
            .map(|item| item.execution_location.clone())
            .unwrap_or_else(|| "remote".to_string()),
    })
}

fn openai_tool_alias(global_tool_id: &str) -> Result<String, AuroraCommandError> {
    let suffix = stable_fnv1a_hash(global_tool_id);
    let mut previous_was_underscore = false;
    let mut base = String::new();
    for ch in global_tool_id.chars() {
        let next = if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            ch
        } else {
            '_'
        };
        if next == '_' {
            if previous_was_underscore {
                continue;
            }
            previous_was_underscore = true;
        } else {
            previous_was_underscore = false;
        }
        base.push(next);
    }
    let base = base.trim_matches('_');
    let base = if base.is_empty() { "tool" } else { base };
    let prefix: String = base.chars().take(55).collect();
    let alias = format!("{prefix}_{suffix}");
    if alias.len() > 64
        || !alias
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(AuroraCommandError::UnsupportedFeature(
            "assistant provider generated an unsafe tool alias".to_string(),
        ));
    }
    Ok(alias)
}

fn stable_fnv1a_hash(value: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for byte in value.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

#[derive(Debug, Eq, PartialEq)]
struct LocalDataEnvelopeKeyBinding {
    profile_hash: String,
    local_node_hash: String,
    purpose: String,
    version: u32,
}

fn validate_local_data_key_scope(
    purpose: &str,
    profile_id: &str,
    local_node_id: &str,
) -> Result<(), AuroraCommandError> {
    if purpose != LOCAL_DATA_ENVELOPE_KEY_PURPOSE {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "local data key purpose is unsupported".to_string(),
        ));
    }
    validate_local_data_id("profileId", profile_id)?;
    validate_local_data_id("localNodeId", local_node_id)?;
    Ok(())
}

fn validate_local_data_id(field: &str, value: &str) -> Result<(), AuroraCommandError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '@' | '/' | '-'))
    {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(format!(
            "{field} is invalid"
        )));
    }
    Ok(())
}

fn validate_local_data_decrypt_request(
    request: &LocalDataEnvelopeDecryptRequest,
) -> Result<(), AuroraCommandError> {
    validate_local_data_id("profileId", &request.profile_id)?;
    validate_local_data_id("localNodeId", &request.local_node_id)?;
    validate_local_data_envelope(&request.envelope)?;
    let bound = parse_local_data_envelope_key_id(&request.envelope.key_id)?;
    if bound.profile_hash != sha256_hex(request.profile_id.as_bytes())
        || bound.local_node_hash != sha256_hex(request.local_node_id.as_bytes())
        || bound.purpose != LOCAL_DATA_ENVELOPE_KEY_PURPOSE
    {
        return Err(AuroraCommandError::SecureStorage(
            "local data envelope key does not match this profile".to_string(),
        ));
    }
    Ok(())
}

fn validate_local_data_envelope(envelope: &LocalDataEnvelopeV1) -> Result<(), AuroraCommandError> {
    if envelope.version != 1 || envelope.algorithm != LOCAL_DATA_ENVELOPE_ALGORITHM {
        return Err(AuroraCommandError::SecureStorage(
            "local data envelope is unsupported".to_string(),
        ));
    }
    if decode_base64url_bytes(&envelope.nonce_b64_url)?.len() != 12 {
        return Err(AuroraCommandError::SecureStorage(
            "local data envelope nonce is invalid".to_string(),
        ));
    }
    if decode_base64url_bytes(&envelope.ciphertext_and_tag_b64_url)?.len() < 16 {
        return Err(AuroraCommandError::SecureStorage(
            "local data envelope ciphertext is invalid".to_string(),
        ));
    }
    Ok(())
}

fn local_data_envelope_key_id(
    profile_id: &str,
    local_node_id: &str,
    purpose: &str,
    version: u32,
) -> String {
    format!(
        "aurora.local-data-envelope.v1.{}.{}.{}.k{}",
        sha256_hex(profile_id.as_bytes()),
        sha256_hex(local_node_id.as_bytes()),
        purpose,
        version
    )
}

fn local_data_envelope_current_version_key(
    profile_id: &str,
    local_node_id: &str,
    purpose: &str,
) -> String {
    format!(
        "aurora.local-data-envelope-current.v1.{}.{}.{}",
        sha256_hex(profile_id.as_bytes()),
        sha256_hex(local_node_id.as_bytes()),
        purpose
    )
}

fn parse_local_data_envelope_key_id(
    key_id: &str,
) -> Result<LocalDataEnvelopeKeyBinding, AuroraCommandError> {
    let Some(rest) = key_id.strip_prefix("aurora.local-data-envelope.v1.") else {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "local data envelope key handle is invalid".to_string(),
        ));
    };
    let parts: Vec<&str> = rest.split('.').collect();
    if parts.len() != 4 || !parts[3].starts_with('k') {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "local data envelope key handle is invalid".to_string(),
        ));
    }
    let version = parts[3][1..].parse::<u32>().map_err(|_| {
        AuroraCommandError::SecureStorageKeyInvalid(
            "local data envelope key handle is invalid".to_string(),
        )
    })?;
    if version == 0 || parts[2] != LOCAL_DATA_ENVELOPE_KEY_PURPOSE {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "local data envelope key handle is invalid".to_string(),
        ));
    }
    Ok(LocalDataEnvelopeKeyBinding {
        profile_hash: parts[0].to_string(),
        local_node_hash: parts[1].to_string(),
        purpose: parts[2].to_string(),
        version,
    })
}

fn decode_base64url_bytes(value: &str) -> Result<Vec<u8>, AuroraCommandError> {
    if value.is_empty()
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(AuroraCommandError::SecureStorage(
            "local data envelope base64url value is invalid".to_string(),
        ));
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| {
        AuroraCommandError::SecureStorage(
            "local data envelope base64url value is invalid".to_string(),
        )
    })?;
    if encode_base64url_bytes(&bytes) != value {
        return Err(AuroraCommandError::SecureStorage(
            "local data envelope base64url value is not canonical".to_string(),
        ));
    }
    Ok(bytes)
}

fn encode_base64url_bytes(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn current_unix_ms_result() -> Result<u64, AuroraCommandError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?
        .as_millis() as u64)
}

fn random_key_256() -> Result<[u8; 32], AuroraCommandError> {
    let mut key = [0_u8; 32];
    getrandom::getrandom(&mut key)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?;
    Ok(key)
}

fn random_nonce_96() -> Result<[u8; 12], AuroraCommandError> {
    let mut nonce = [0_u8; 12];
    getrandom::getrandom(&mut nonce)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?;
    Ok(nonce)
}

fn encrypt_local_data_envelope(
    key_id: &str,
    key: &[u8; 32],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<LocalDataEnvelopeV1, AuroraCommandError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AuroraCommandError::SecureStorage("local data key is invalid".to_string()))?;
    let nonce = random_nonce_96()?;
    let ciphertext_and_tag = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| {
            AuroraCommandError::SecureStorage("local data encryption failed".to_string())
        })?;
    Ok(LocalDataEnvelopeV1 {
        version: 1,
        algorithm: LOCAL_DATA_ENVELOPE_ALGORITHM.to_string(),
        key_id: key_id.to_string(),
        nonce_b64_url: encode_base64url_bytes(&nonce),
        ciphertext_and_tag_b64_url: encode_base64url_bytes(&ciphertext_and_tag),
        created_at_ms: current_unix_ms_result()?,
    })
}

fn decrypt_local_data_envelope(
    envelope: &LocalDataEnvelopeV1,
    key: &[u8; 32],
    aad: &[u8],
) -> Result<Vec<u8>, AuroraCommandError> {
    validate_local_data_envelope(envelope)?;
    let nonce = decode_base64url_bytes(&envelope.nonce_b64_url)?;
    let ciphertext_and_tag = decode_base64url_bytes(&envelope.ciphertext_and_tag_b64_url)?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AuroraCommandError::SecureStorage("local data key is invalid".to_string()))?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext_and_tag,
                aad,
            },
        )
        .map_err(|_| {
            AuroraCommandError::SecureStorage("local data envelope could not be opened".to_string())
        })
}

#[cfg(desktop)]
fn local_data_envelope_entry(key_id: &str) -> Result<keyring::Entry, AuroraCommandError> {
    parse_local_data_envelope_key_id(key_id)?;
    keyring::Entry::new(LOCAL_DATA_ENVELOPE_KEY_SERVICE, key_id)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

#[cfg(desktop)]
fn local_data_envelope_current_version_entry(
    profile_id: &str,
    local_node_id: &str,
    purpose: &str,
) -> Result<keyring::Entry, AuroraCommandError> {
    keyring::Entry::new(
        LOCAL_DATA_ENVELOPE_KEY_SERVICE,
        &local_data_envelope_current_version_key(profile_id, local_node_id, purpose),
    )
    .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

#[cfg(desktop)]
fn load_or_create_local_data_envelope_key(key_id: &str) -> Result<[u8; 32], AuroraCommandError> {
    match load_existing_local_data_envelope_key(key_id) {
        Ok(key) => Ok(key),
        Err(AuroraCommandError::SecureStorage(message)) if message == "local_data_key_missing" => {
            let key = random_key_256()?;
            store_local_data_envelope_key(key_id, &key)?;
            Ok(key)
        }
        Err(error) => Err(error),
    }
}

#[cfg(desktop)]
fn load_existing_local_data_envelope_key(key_id: &str) -> Result<[u8; 32], AuroraCommandError> {
    let entry = local_data_envelope_entry(key_id)?;
    let encoded = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => {
            return Err(AuroraCommandError::SecureStorage(
                "local_data_key_missing".to_string(),
            ))
        }
        Err(error) => return Err(AuroraCommandError::SecureStorage(error.to_string())),
    };
    let bytes = decode_base64url_bytes(&encoded)?;
    bytes
        .try_into()
        .map_err(|_| AuroraCommandError::SecureStorage("local data key is invalid".to_string()))
}

#[cfg(desktop)]
fn store_local_data_envelope_key(key_id: &str, key: &[u8; 32]) -> Result<(), AuroraCommandError> {
    let entry = local_data_envelope_entry(key_id)?;
    entry
        .set_password(&encode_base64url_bytes(key))
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

#[cfg(desktop)]
fn current_local_data_envelope_key_version(
    profile_id: &str,
    local_node_id: &str,
    purpose: &str,
) -> Result<u32, AuroraCommandError> {
    let entry = local_data_envelope_current_version_entry(profile_id, local_node_id, purpose)?;
    match entry.get_password() {
        Ok(value) => value.parse::<u32>().map_err(|_| {
            AuroraCommandError::SecureStorage("local data key version is invalid".to_string())
        }),
        Err(keyring::Error::NoEntry) => Ok(LOCAL_DATA_ENVELOPE_CURRENT_VERSION),
        Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
    }
}

#[cfg(desktop)]
fn store_local_data_envelope_current_version(
    profile_id: &str,
    local_node_id: &str,
    purpose: &str,
    version: u32,
) -> Result<(), AuroraCommandError> {
    let entry = local_data_envelope_current_version_entry(profile_id, local_node_id, purpose)?;
    entry
        .set_password(&version.to_string())
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

fn validate_secure_storage_key(key: &str) -> Result<(), AuroraCommandError> {
    if is_peer_proof_storage_key(key) {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "peer reconnect credential namespace is opaque-only".to_string(),
        ));
    }
    if is_inbound_verifier_storage_key(key) {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier namespace is opaque-only".to_string(),
        ));
    }
    if key.is_empty() || key.len() > 128 {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "key length must be 1..128 bytes".to_string(),
        ));
    }
    if !key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "key may only contain ASCII letters, digits, dot, underscore, or hyphen".to_string(),
        ));
    }
    let allowed = [
        "aurora.session",
        "aurora.auth",
        "aurora.gateway",
        "aurora.mesh",
        "aurora.admin",
        "aurora.voice",
    ];
    if allowed
        .iter()
        .any(|prefix| key == *prefix || key.starts_with(&format!("{prefix}.")))
    {
        Ok(())
    } else {
        Err(AuroraCommandError::SecureStorageKeyInvalid(key.to_string()))
    }
}

fn validate_inbound_verifier_secret_key(key: &str) -> Result<(), AuroraCommandError> {
    parse_inbound_verifier_secret_key(key).map(|_| ())
}

fn parse_inbound_verifier_secret_key(
    key: &str,
) -> Result<InboundVerifierSelector, AuroraCommandError> {
    if key.is_empty() || key.len() > 4096 {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier key length must be 1..4096 bytes".to_string(),
        ));
    }
    let prefix = format!("{INBOUND_VERIFIER_KEY_PREFIX}:");
    let Some(rest) = key.strip_prefix(&prefix) else {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier key must use the SDK peer-host namespace".to_string(),
        ));
    };
    let parts: Vec<&str> = rest.split(':').collect();
    if parts.len() != 4 || parts.iter().any(|part| part.is_empty()) {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier key selector is invalid".to_string(),
        ));
    }
    let verifier_peer_id = decode_sdk_key_part(parts[0], "verifierPeerId")?;
    let claimant_peer_id = decode_sdk_key_part(parts[1], "claimantPeerId")?;
    let room_name = decode_sdk_key_part(parts[2], "roomName")?;
    let token_id = decode_sdk_key_part(parts[3], "tokenId")?;
    if encode_sdk_key_part(&verifier_peer_id) != parts[0]
        || encode_sdk_key_part(&claimant_peer_id) != parts[1]
        || encode_sdk_key_part(&room_name) != parts[2]
        || encode_sdk_key_part(&token_id) != parts[3]
    {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier key must be canonical".to_string(),
        ));
    }
    validate_safe_peer_authority_id("verifierPeerId", &verifier_peer_id, 256)?;
    validate_safe_peer_authority_id("claimantPeerId", &claimant_peer_id, 256)?;
    validate_non_empty_field("roomName", &room_name, 512)?;
    validate_safe_peer_authority_id("tokenId", &token_id, 256)?;
    Ok(InboundVerifierSelector {
        token_id,
        claimant_peer_id,
        verifier_peer_id,
        room_name,
    })
}

fn inbound_verifier_storage_account(key: &str) -> Result<String, AuroraCommandError> {
    validate_inbound_verifier_secret_key(key)?;
    Ok(inbound_verifier_storage_account_from_valid_key(key))
}

fn inbound_verifier_storage_account_from_valid_key(key: &str) -> String {
    format!(
        "aurora.mesh.inbound-verifier.{}",
        sha256_hex(key.as_bytes())
    )
}

fn inbound_verifier_selector_matches_record(
    selector: &InboundVerifierSelector,
    record: &InboundVerifierSecretRecord,
) -> bool {
    selector.token_id == record.token_id
        && selector.claimant_peer_id == record.claimant_peer_id
        && selector.verifier_peer_id == record.verifier_peer_id
        && selector.room_name == record.room_name
}

fn canonical_inbound_verifier_secret_value(
    record: &InboundVerifierSecretRecord,
) -> Result<String, AuroraCommandError> {
    serde_json::to_string(record).map_err(|_| AuroraCommandError::InvalidGatewayResponse)
}

fn validate_inbound_verifier_secret_value_for_selector(
    value: &str,
    selector: &InboundVerifierSelector,
) -> Result<(), AuroraCommandError> {
    let record = parse_inbound_verifier_secret_value(value)?;
    if !inbound_verifier_selector_matches_record(selector, &record) {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier value does not match key selector".to_string(),
        ));
    }
    validate_canonical_inbound_verifier_secret_value(value, &record)
}

fn validate_canonical_inbound_verifier_secret_value(
    value: &str,
    record: &InboundVerifierSecretRecord,
) -> Result<(), AuroraCommandError> {
    let canonical = canonical_inbound_verifier_secret_value(record)?;
    if canonical != value {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier value must be canonical SDK JSON".to_string(),
        ));
    }
    Ok(())
}

fn validate_inbound_verifier_secret_value(value: &str) -> Result<(), AuroraCommandError> {
    let record = parse_inbound_verifier_secret_value(value)?;
    validate_canonical_inbound_verifier_secret_value(value, &record)
}

fn parse_inbound_verifier_secret_value(
    value: &str,
) -> Result<InboundVerifierSecretRecord, AuroraCommandError> {
    if value.is_empty() || value.len() > 8192 {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier value length must be 1..8192 bytes".to_string(),
        ));
    }
    let raw_record: Value = serde_json::from_str(value).map_err(|_| {
        AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier value must be canonical JSON".to_string(),
        )
    })?;
    let Some(object) = raw_record.as_object() else {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier value must be a JSON object".to_string(),
        ));
    };
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "version"
                | "tokenId"
                | "claimantPeerId"
                | "verifierPeerId"
                | "roomName"
                | "tokenHashHex"
                | "createdAtMs"
                | "expiresAtMs"
                | "revokedAtMs"
                | "credentialRevision"
        ) || is_forbidden_inbound_verifier_field(key)
        {
            return Err(AuroraCommandError::SecureStorageKeyInvalid(
                "inbound verifier value contains unsupported secret material".to_string(),
            ));
        }
    }
    let record: InboundVerifierSecretRecord = serde_json::from_value(raw_record).map_err(|_| {
        AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier value has invalid fields".to_string(),
        )
    })?;
    if record.version != 1 {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier version is unsupported".to_string(),
        ));
    }
    validate_safe_peer_authority_id("tokenId", &record.token_id, 256)?;
    validate_safe_peer_authority_id("claimantPeerId", &record.claimant_peer_id, 256)?;
    validate_safe_peer_authority_id("verifierPeerId", &record.verifier_peer_id, 256)?;
    validate_non_empty_field("roomName", &record.room_name, 512)?;
    validate_lower_hex64("tokenHashHex", &record.token_hash_hex)?;
    validate_safe_epoch("createdAtMs", record.created_at_ms)?;
    validate_safe_epoch("credentialRevision", record.credential_revision)?;
    if let Some(expires_at_ms) = record.expires_at_ms {
        validate_safe_epoch("expiresAtMs", expires_at_ms)?;
    }
    if let Some(revoked_at_ms) = record.revoked_at_ms {
        validate_safe_epoch("revokedAtMs", revoked_at_ms)?;
    }
    Ok(record)
}

fn validate_inbound_verifier_storage_account(account: &str) -> Result<(), AuroraCommandError> {
    let Some(suffix) = account.strip_prefix("aurora.mesh.inbound-verifier.") else {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier storage account is invalid".to_string(),
        ));
    };
    if suffix.len() != 64 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "inbound verifier storage account is invalid".to_string(),
        ));
    }
    Ok(())
}

fn is_forbidden_inbound_verifier_field(field: &str) -> bool {
    let normalized = field
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "bearer"
            | "rawbearertoken"
            | "rawtoken"
            | "proof"
            | "proofhex"
            | "verifierkey"
            | "password"
            | "secret"
            | "authorization"
    )
}

fn validate_lower_hex64(field: &str, value: &str) -> Result<(), AuroraCommandError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(format!(
            "{field} must be 64 lowercase hex characters"
        )));
    }
    Ok(())
}

fn validate_safe_epoch(field: &str, value: u64) -> Result<(), AuroraCommandError> {
    if value > 9_007_199_254_740_991 {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(format!(
            "{field} is outside the safe integer range"
        )));
    }
    Ok(())
}

fn validate_safe_peer_authority_id(
    field: &str,
    value: &str,
    max_len: usize,
) -> Result<(), AuroraCommandError> {
    validate_non_empty_field(field, value, max_len)?;
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '@' | '/' | '-'))
    {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(format!(
            "{field} contains unsupported characters"
        )));
    }
    Ok(())
}

fn decode_sdk_key_part(value: &str, field: &str) -> Result<String, AuroraCommandError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err(AuroraCommandError::SecureStorageKeyInvalid(format!(
                        "{field} has invalid percent encoding"
                    )));
                }
                let high = hex_value(bytes[index + 1]).ok_or_else(|| {
                    AuroraCommandError::SecureStorageKeyInvalid(format!(
                        "{field} has invalid percent encoding"
                    ))
                })?;
                let low = hex_value(bytes[index + 2]).ok_or_else(|| {
                    AuroraCommandError::SecureStorageKeyInvalid(format!(
                        "{field} has invalid percent encoding"
                    ))
                })?;
                output.push((high << 4) | low);
                index += 3;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(output).map_err(|_| {
        AuroraCommandError::SecureStorageKeyInvalid(format!("{field} is not valid UTF-8"))
    })
}

fn encode_sdk_key_part(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                *byte,
                b'-' | b'_' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(*byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn inbound_verifier_get_response(value: Option<String>) -> InboundVerifierSecretGetResponse {
    InboundVerifierSecretGetResponse {
        found: value.is_some(),
        value,
        backend: "platform-keychain".to_string(),
        persisted: true,
        secrets_redacted: true,
        redacted_fields: inbound_verifier_redacted_fields(),
    }
}

fn inbound_verifier_write_response(ok: bool) -> InboundVerifierSecretWriteResponse {
    InboundVerifierSecretWriteResponse {
        ok,
        backend: "platform-keychain".to_string(),
        persisted: true,
        secrets_redacted: true,
        redacted_fields: inbound_verifier_redacted_fields(),
    }
}

fn inbound_verifier_redacted_fields() -> Vec<String> {
    vec![
        "tokenHashHex".to_string(),
        "rawBearerToken".to_string(),
        "proof".to_string(),
        "verifierKey".to_string(),
    ]
}

#[cfg(not(desktop))]
fn inbound_verifier_unsupported() -> AuroraCommandError {
    AuroraCommandError::UnsupportedFeature(
        "inbound verifier storage is only available on desktop keychain targets".to_string(),
    )
}

fn validate_peer_storage_id(peer_id: &str) -> Result<(), AuroraCommandError> {
    validate_non_empty_field("peerId", peer_id, 256)
}

fn thin_peer_credential_key(peer_id: &str) -> Result<String, AuroraCommandError> {
    validate_peer_storage_id(peer_id)?;
    Ok(format!(
        "aurora.mesh.peer-proof.{}",
        sha256_hex(peer_id.as_bytes())
    ))
}

fn thin_room_secret_key(ref_id: &str) -> Result<String, AuroraCommandError> {
    validate_room_secret_ref(ref_id)?;
    Ok(format!(
        "aurora.mesh.room-secret.{}",
        sha256_hex(ref_id.as_bytes())
    ))
}

fn is_room_secret_storage_key(key: &str) -> bool {
    key.starts_with("aurora.mesh.room-secret.")
        && key
            .strip_prefix("aurora.mesh.room-secret.")
            .is_some_and(|suffix| {
                suffix.len() == 64 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

fn validate_room_secret_ref(ref_id: &str) -> Result<(), AuroraCommandError> {
    validate_non_empty_field("roomSecretRef", ref_id, 1024)
}

fn validate_credential_record_fields(
    token_id: &str,
    claimant_peer_id: &str,
    verifier_peer_id: &str,
    claimant_signaling_peer_id: &str,
    verifier_signaling_peer_id: &str,
    room_name: &str,
    raw_bearer_token: &str,
) -> Result<(), AuroraCommandError> {
    validate_non_empty_field("tokenId", token_id, 128)?;
    validate_non_empty_field("claimantPeerId", claimant_peer_id, 256)?;
    validate_non_empty_field("verifierPeerId", verifier_peer_id, 256)?;
    validate_non_empty_field("claimantSignalingPeerId", claimant_signaling_peer_id, 256)?;
    validate_non_empty_field("verifierSignalingPeerId", verifier_signaling_peer_id, 256)?;
    validate_non_empty_field("roomName", room_name, 512)?;
    validate_non_empty_field("rawBearerToken", raw_bearer_token, 4096)
}

fn validate_non_empty_field(
    field: &str,
    value: &str,
    max_len: usize,
) -> Result<(), AuroraCommandError> {
    if value.is_empty() || value.len() > max_len {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(format!(
            "{field} length must be 1..{max_len} bytes"
        )));
    }
    Ok(())
}

fn validate_reconnect_challenge(
    challenge: &MeshReconnectChallengeFrame,
) -> Result<(), AuroraCommandError> {
    if challenge.r#type != "mesh_auth_challenge_v1" {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(
            "reconnect challenge type must be mesh_auth_challenge_v1".to_string(),
        ));
    }
    validate_hex64("challenge", &challenge.challenge)?;
    validate_hex64("channelBinding", &challenge.channel_binding)?;
    validate_non_empty_field("claimantPeerId", &challenge.claimant_peer_id, 256)?;
    validate_non_empty_field("verifierPeerId", &challenge.verifier_peer_id, 256)?;
    validate_non_empty_field(
        "claimantSignalingPeerId",
        &challenge.claimant_signaling_peer_id,
        256,
    )?;
    validate_non_empty_field(
        "verifierSignalingPeerId",
        &challenge.verifier_signaling_peer_id,
        256,
    )?;
    validate_non_empty_field("roomName", &challenge.room_name, 512)
}

fn validate_hex64(field: &str, value: &str) -> Result<(), AuroraCommandError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AuroraCommandError::SecureStorageKeyInvalid(format!(
            "{field} must be 64 hex characters"
        )));
    }
    Ok(())
}

#[cfg(desktop)]
fn load_thin_peer_credential_value(peer_id: &str) -> Result<Option<String>, AuroraCommandError> {
    let storage_key = thin_peer_credential_key(peer_id)?;
    match peer_credential_storage_entry(&storage_key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
    }
}

#[cfg(not(desktop))]
fn load_thin_peer_credential_value(_peer_id: &str) -> Result<Option<String>, AuroraCommandError> {
    Err(AuroraCommandError::UnsupportedFeature(
        "desktop-thin peer credential keychain storage is only available on desktop Tauri targets"
            .to_string(),
    ))
}

fn parse_thin_peer_credential_record(
    stored: &str,
) -> Result<ThinPeerCredentialRecord, AuroraCommandError> {
    let record: ThinPeerCredentialRecord = serde_json::from_str(stored).map_err(|_| {
        AuroraCommandError::SecureStorage("stored peer credential is invalid".to_string())
    })?;
    validate_credential_record_fields(
        &record.token_id,
        &record.claimant_peer_id,
        &record.verifier_peer_id,
        &record.claimant_signaling_peer_id,
        &record.verifier_signaling_peer_id,
        &record.room_name,
        &record.raw_bearer_token,
    )
    .map_err(|_| {
        AuroraCommandError::SecureStorage("stored peer credential is invalid".to_string())
    })?;
    Ok(record)
}

fn resolve_unexpired_thin_peer_credential_record(
    peer_id: &str,
    stored: Option<String>,
    mut delete_record: impl FnMut(&str) -> Result<(), AuroraCommandError>,
) -> Result<Option<ThinPeerCredentialRecord>, AuroraCommandError> {
    let Some(stored) = stored else {
        return Ok(None);
    };
    let record = match parse_thin_peer_credential_record(&stored) {
        Ok(record) => record,
        Err(AuroraCommandError::SecureStorage(_)) => {
            delete_record(peer_id)?;
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if record
        .expires_at_ms
        .is_some_and(|expires_at_ms| expires_at_ms <= current_unix_ms())
    {
        delete_record(peer_id)?;
        return Ok(None);
    }
    Ok(Some(record))
}

fn load_unexpired_thin_peer_credential_record(
    peer_id: &str,
) -> Result<Option<ThinPeerCredentialRecord>, AuroraCommandError> {
    resolve_unexpired_thin_peer_credential_record(
        peer_id,
        load_thin_peer_credential_value(peer_id)?,
        delete_thin_peer_credential_record,
    )
}

fn delete_thin_peer_credential_record(peer_id: &str) -> Result<(), AuroraCommandError> {
    let storage_key = thin_peer_credential_key(peer_id)?;
    #[cfg(desktop)]
    match peer_credential_storage_entry(&storage_key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(AuroraCommandError::SecureStorage(error.to_string())),
    }
    #[cfg(not(desktop))]
    {
        let _ = storage_key;
        Err(AuroraCommandError::UnsupportedFeature(
            "desktop-thin peer credential keychain storage is only available on desktop Tauri targets"
                .to_string(),
        ))
    }
}

fn is_peer_proof_storage_key(key: &str) -> bool {
    key.strip_prefix("aurora.mesh.peer-proof.")
        .is_some_and(|suffix| {
            suffix.len() == 64
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn is_inbound_verifier_storage_key(key: &str) -> bool {
    key.starts_with("aurora.mesh.inbound-verifier.")
        || key.starts_with(&format!("{INBOUND_VERIFIER_KEY_PREFIX}:"))
}

fn thin_peer_credential_metadata(
    peer_id: &str,
    record: &ThinPeerCredentialRecord,
) -> ThinPeerCredentialMetadata {
    ThinPeerCredentialMetadata {
        peer_id: peer_id.to_string(),
        token_id: record.token_id.clone(),
        claimant_peer_id: record.claimant_peer_id.clone(),
        verifier_peer_id: record.verifier_peer_id.clone(),
        claimant_signaling_peer_id: record.claimant_signaling_peer_id.clone(),
        verifier_signaling_peer_id: record.verifier_signaling_peer_id.clone(),
        room_name: record.room_name.clone(),
        created_at_ms: record.created_at_ms,
        expires_at_ms: record.expires_at_ms,
    }
}

fn thin_peer_credential_status_response(
    peer_id: String,
    metadata: Option<ThinPeerCredentialMetadata>,
    has_token: bool,
) -> ThinPeerCredentialStatusResponse {
    ThinPeerCredentialStatusResponse {
        peer_id,
        found: metadata.is_some(),
        has_bearer_token: has_token,
        credential: metadata,
        backend: "platform-keychain".to_string(),
        persisted: true,
        secrets_redacted: true,
        redacted_fields: vec!["rawBearerToken".to_string()],
    }
}

fn thin_peer_reconnect_proof_response(
    peer_id: String,
    metadata: Option<ThinPeerCredentialMetadata>,
    matched: bool,
    proof: Option<MeshReconnectProofFrame>,
) -> ThinPeerReconnectProofResponse {
    ThinPeerReconnectProofResponse {
        peer_id,
        found: metadata.is_some(),
        matched,
        proof,
        credential: metadata,
        backend: "platform-keychain".to_string(),
        secrets_redacted: true,
        redacted_fields: vec!["rawBearerToken".to_string()],
    }
}

fn reconnect_challenge_matches(
    record: &ThinPeerCredentialRecord,
    challenge: &MeshReconnectChallengeFrame,
) -> bool {
    challenge.claimant_peer_id == record.claimant_peer_id
        && challenge.verifier_peer_id == record.verifier_peer_id
        && challenge.room_name == record.room_name
}

fn compute_reconnect_proof_hex(
    raw_bearer_token: &str,
    record: &ThinPeerCredentialRecord,
    challenge: &MeshReconnectChallengeFrame,
) -> Result<String, AuroraCommandError> {
    type HmacSha256 = Hmac<Sha256>;
    let key = Sha256::digest(raw_bearer_token.as_bytes());
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&key)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))?;
    mac.update(&build_mesh_reconnect_proof_message(record, challenge)?);
    Ok(hex_encode(&mac.finalize().into_bytes()))
}

fn build_mesh_reconnect_proof_message(
    record: &ThinPeerCredentialRecord,
    challenge: &MeshReconnectChallengeFrame,
) -> Result<Vec<u8>, AuroraCommandError> {
    let transcript = format!(
        concat!(
            "{{",
            "\"challenge\":{},",
            "\"channel_binding\":{},",
            "\"claimant_peer_id\":{},",
            "\"room_name\":{},",
            "\"token_id\":{},",
            "\"verifier_peer_id\":{},",
            "\"version\":1",
            "}}"
        ),
        canonical_json_quote(&challenge.challenge),
        canonical_json_quote(&challenge.channel_binding),
        canonical_json_quote(&challenge.claimant_peer_id),
        canonical_json_quote(&challenge.room_name),
        canonical_json_quote(&record.token_id),
        canonical_json_quote(&challenge.verifier_peer_id),
    );
    let mut message = b"aurora.mesh.reconnect-proof.v1\0".to_vec();
    message.extend_from_slice(transcript.as_bytes());
    Ok(message)
}

fn canonical_json_quote(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{0009}' => output.push_str("\\t"),
            '\u{000a}' => output.push_str("\\n"),
            '\u{000c}' => output.push_str("\\f"),
            '\u{000d}' => output.push_str("\\r"),
            '\u{0000}'..='\u{001f}' | '\u{007f}'.. => {
                let codepoint = character as u32;
                if codepoint <= 0xffff {
                    push_json_utf16_escape(&mut output, codepoint as u16);
                } else {
                    let supplementary = codepoint - 0x1_0000;
                    push_json_utf16_escape(&mut output, 0xd800 + ((supplementary >> 10) as u16));
                    push_json_utf16_escape(&mut output, 0xdc00 + ((supplementary & 0x03ff) as u16));
                }
            }
            _ => output.push(character),
        }
    }
    output.push('"');
    output
}

fn push_json_utf16_escape(output: &mut String, code_unit: u16) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    output.push('\\');
    output.push('u');
    for shift in [12, 8, 4, 0] {
        output.push(HEX[((code_unit >> shift) & 0x0f) as usize] as char);
    }
}

fn sha256_hex(input: &[u8]) -> String {
    hex_encode(&Sha256::digest(input))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn gateway_url() -> Result<Url, AuroraCommandError> {
    let raw = resolved_remote_gateway_from_profile()
        .or_else(dev_remote_gateway_bootstrap_url)
        .or_else(|| env::var("AURORA_GATEWAY_URL").ok())
        .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_string());
    let url =
        Url::parse(&raw).map_err(|_| AuroraCommandError::InvalidGatewayOrigin(raw.clone()))?;
    if is_loopback_http_origin(&url) || remote_gateway_allowed_for(&url) {
        Ok(url)
    } else {
        Err(AuroraCommandError::InvalidGatewayOrigin(raw))
    }
}

fn remote_gateway_allowed() -> bool {
    env::var("AURORA_TAURI_ALLOW_REMOTE_GATEWAY").as_deref() == Ok("1")
}

fn remote_gateway_allowed_for(url: &Url) -> bool {
    if !remote_gateway_allowed() || !is_secure_remote_http_origin(url) {
        return false;
    }
    let origin = origin_for_url(url);
    allowed_remote_origins()
        .iter()
        .any(|allowed| allowed == &origin)
}

fn allowed_remote_origins() -> Vec<String> {
    env::var("AURORA_TAURI_ALLOWED_REMOTE_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|raw| canonical_remote_origin(raw).ok())
        .collect()
}

fn canonical_remote_origin(raw: &str) -> Result<String, AuroraCommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('*') {
        return Err(AuroraCommandError::InvalidGatewayOrigin(
            trimmed.to_string(),
        ));
    }
    let url = Url::parse(trimmed)
        .map_err(|_| AuroraCommandError::InvalidGatewayOrigin(trimmed.to_string()))?;
    if !is_secure_remote_http_or_ws_origin(&url) {
        return Err(AuroraCommandError::InvalidGatewayOrigin(
            trimmed.to_string(),
        ));
    }
    Ok(origin_for_url(&url))
}

fn origin_for_url(url: &Url) -> String {
    match url.port() {
        Some(port) => format!(
            "{}://{}:{}",
            url.scheme(),
            url.host_str().unwrap_or_default(),
            port
        ),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
    }
}

fn is_secure_remote_http_origin(url: &Url) -> bool {
    url.scheme() == "https" && !is_loopback_host(url)
}

fn is_secure_remote_http_or_ws_origin(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "wss") && !is_loopback_host(url)
}

fn is_thin_mode() -> bool {
    resolved_remote_gateway_from_profile().is_some() || dev_remote_gateway_bootstrap_url().is_some()
}

fn dev_remote_gateway_bootstrap_url() -> Option<String> {
    if env::var("AURORA_TAURI_DEV_REMOTE_GATEWAY_BOOTSTRAP").as_deref() != Ok("1") {
        return None;
    }
    env::var("AURORA_TAURI_REMOTE_GATEWAY_URL").ok()
}

fn resolved_remote_gateway_from_profile() -> Option<String> {
    #[cfg(desktop)]
    {
        let entry = thin_profile_storage_entry().ok()?;
        let value = entry.get_password().ok()?;
        return remote_gateway_from_profile_document(&value);
    }
    #[cfg(not(desktop))]
    {
        None
    }
}

fn remote_gateway_from_profile_document(value: &str) -> Option<String> {
    let document = serde_json::from_str::<Value>(value).ok()?;
    let version = document.get("version")?.as_u64()?;
    match version {
        1 => {
            let active_id = document.get("activeProfileId")?.as_str()?;
            document
                .get("profiles")?
                .as_array()?
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(active_id))
                .and_then(|profile| profile.get("gatewayUrl"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }
        2 => {
            let active_id = document.get("activeProfileId")?.as_str()?;
            let profile = document
                .get("profiles")?
                .as_array()?
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(active_id))?;
            let node_mode = profile.get("nodeMode").and_then(Value::as_str)?;
            if node_mode != "remote-console" {
                return None;
            }
            profile
                .get("homeConnection")?
                .get("gatewayUrl")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }
        _ => None,
    }
}

fn gateway_request_url(
    base: &Url,
    path: Option<&str>,
    method: &str,
) -> Result<Url, AuroraCommandError> {
    let relative = if let Some(path) = path {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(AuroraCommandError::Gateway("gateway path is empty".into()));
        }
        if trimmed.contains("://") || trimmed.starts_with("//") {
            return Err(AuroraCommandError::Gateway(
                "gateway path must be relative".into(),
            ));
        }
        trimmed.trim_start_matches('/').to_string()
    } else {
        format!("api/methods/{}", method.replace('.', "/"))
    };
    let joined = base
        .join(&relative)
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?;
    if !same_http_origin(base, &joined) {
        return Err(AuroraCommandError::Gateway(
            "gateway path must stay on the configured origin".into(),
        ));
    }
    Ok(joined)
}

fn same_http_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host() == right.host()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn filtered_headers(headers: Option<BTreeMap<String, String>>) -> HeaderMap {
    let mut output = HeaderMap::new();
    output.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    for (key, value) in headers.unwrap_or_default() {
        let lower = key.to_ascii_lowercase();
        if !matches!(
            lower.as_str(),
            "x-correlation-id"
                | "x-request-id"
                | "content-type"
                | "x-aurora-adminaction-id"
                | "x-aurora-adminaction-token"
                | "x-aurora-adminaction-digest"
        ) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(lower.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            output.insert(name, value);
        }
    }
    output
}

fn request_has_valid_sidecar_token(
    request: &AuroraRequest,
    state: &State<'_, SharedSidecarState>,
) -> Result<bool, AuroraCommandError> {
    if is_thin_mode() || request.method == NATIVE_MANIFEST_METHOD {
        return Ok(true);
    }
    let Some(headers) = &request.headers else {
        return Ok(false);
    };
    let Some(token) = headers
        .get("x-aurora-sidecar-token")
        .or_else(|| headers.get("X-Aurora-Sidecar-Token"))
    else {
        return Ok(false);
    };
    let sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
    Ok(token == &sidecar.token)
}

fn verify_sidecar_command_token(
    command_token: Option<SidecarCommandToken>,
    state: &State<'_, SharedSidecarState>,
) -> Result<(), AuroraCommandError> {
    let Some(command_token) = command_token.and_then(|value| value.token) else {
        return Err(AuroraCommandError::SidecarTokenInvalid);
    };
    let sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
    if command_token == sidecar.token {
        Ok(())
    } else {
        Err(AuroraCommandError::SidecarTokenInvalid)
    }
}

fn spawn_sidecar(app: &AppHandle, gateway: &Url, token: &str) -> Result<Child, AuroraCommandError> {
    let launch = sidecar_launch(app)?;
    let mut command = Command::new(&launch.program);
    command.args(&launch.args);
    if launch.bundled {
        let runtime_dir = app.path().app_data_dir().map_err(|error| {
            AuroraCommandError::SidecarProcess(format!(
                "Could not resolve the Aurora application data directory: {error}"
            ))
        })?;
        let data_dir = runtime_dir.join("data");
        let config_file = env::var_os("AURORA_TAURI_SIDECAR_CONFIG_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| runtime_dir.join("config.json"));
        std::fs::create_dir_all(&data_dir).map_err(|error| {
            AuroraCommandError::SidecarProcess(format!(
                "Could not prepare the Aurora sidecar runtime directory: {error}"
            ))
        })?;
        command.current_dir(&runtime_dir);
        command.env("AURORA_CONFIG_FILE", config_file);
        command.env("AURORA_ENV_FILE", runtime_dir.join(".env"));
        command.env("AURORA_DATA_DIR", data_dir);
    } else {
        command.current_dir(&launch.working_dir);
    }
    command.env("AURORA_ARCHITECTURE_MODE", "threads");
    command.env("AURORA_TAURI_MANAGED_SIDECAR", "1");
    command.env("AURORA_TAURI_DISABLE_GATEWAY_AUTH", "1");
    command.env("AURORA_GATEWAY_URL", gateway.to_string());
    command.env("AURORA_TAURI_SIDECAR_TOKEN", token);
    command.env(
        "AURORA_GATEWAY_HOST",
        gateway.host_str().unwrap_or("127.0.0.1"),
    );
    if let Some(port) = gateway.port_or_known_default() {
        command.env("AURORA_GATEWAY_PORT", port.to_string());
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| AuroraCommandError::SidecarProcess(error.to_string()))?;
    if let Some(stdout) = child.stdout.take() {
        spawn_sidecar_log_forwarder("stdout", stdout, false);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_sidecar_log_forwarder("stderr", stderr, true);
    }
    Ok(child)
}

fn spawn_sidecar_log_forwarder<R>(stream: &'static str, reader: R, stderr: bool)
where
    R: Read + Send + 'static,
{
    let _ = thread::Builder::new()
        .name(format!("aurora-sidecar-{stream}"))
        .spawn(move || {
            let reader = BufReader::new(reader);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        let line = redact_sensitive_text(&line);
                        if stderr {
                            eprintln!("[aurora][{stream}] {line}");
                        } else {
                            println!("[aurora][{stream}] {line}");
                        }
                    }
                    Err(error) => {
                        eprintln!("[aurora][{stream}] log reader failed: {error}");
                        break;
                    }
                }
            }
        });
}

fn stop_sidecar(sidecar: &mut SidecarState) -> Result<(), AuroraCommandError> {
    let Some(mut child) = sidecar.child.take() else {
        sidecar.started_at = None;
        return Ok(());
    };
    if let Ok(Some(status)) = child.try_wait() {
        sidecar.last_error = Some(format!("sidecar exited with status {status}"));
        sidecar.started_at = None;
        return Ok(());
    }
    child
        .kill()
        .map_err(|error| AuroraCommandError::SidecarProcess(error.to_string()))?;
    let _ = child.wait();
    sidecar.started_at = None;
    sidecar.last_error = None;
    Ok(())
}

async fn check_gateway_health(
    client: &reqwest::Client,
    gateway: &Url,
) -> Result<Value, AuroraCommandError> {
    let url = gateway
        .join(SIDECAR_HEALTH_PATH.trim_start_matches('/'))
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?;
    if status.is_success() {
        Ok(value)
    } else {
        Err(AuroraCommandError::Gateway(format!(
            "HTTP {status}: {}",
            serialize_redacted_value(&value)
        )))
    }
}

async fn run_gateway_event_stream(
    app: AppHandle,
    owner_label: String,
    client: reqwest::Client,
    url: Url,
    headers: HeaderMap,
    subscription_id: String,
    event_name: String,
    closed_event_name: String,
) {
    let app = app.clone();
    run_gateway_event_stream_with_emitter(
        client,
        url,
        headers,
        subscription_id,
        event_name,
        closed_event_name,
        move |event_name, payload| {
            let _ = app.emit_to(&owner_label, event_name, payload);
        },
    )
    .await;
}

async fn run_gateway_event_stream_with_emitter<F>(
    client: reqwest::Client,
    url: Url,
    headers: HeaderMap,
    subscription_id: String,
    event_name: String,
    closed_event_name: String,
    mut emit: F,
) where
    F: FnMut(&str, Value),
{
    let result = async {
        let response = client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|error| redacted_gateway_error(&error))?;
        let status = response.status();
        if !status.is_success() {
            let body = read_gateway_error_body(response).await?;
            return Err(redacted_gateway_status_error(status.as_u16(), body));
        }

        let mut buffer = String::new();
        let mut response = response;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    let text = String::from_utf8_lossy(&chunk);
                    buffer.push_str(&text);
                    drain_sse_frames(&event_name, &subscription_id, &mut buffer, &mut emit);
                }
                Ok(None) => return Ok(()),
                Err(error) => return Err(redacted_gateway_error(&error)),
            }
        }
    }
    .await;

    let (code, reason) = match result {
        Ok(()) => (
            "closed".to_string(),
            "gateway event stream closed".to_string(),
        ),
        Err(reason) => ("transport_loss".to_string(), reason),
    };
    emit(
        &closed_event_name,
        serde_json::to_value(AuroraSubscriptionClosed {
            subscription_id,
            reason,
            code,
            secrets_redacted: true,
        })
        .expect("gateway stream closed payload serializes"),
    );
}

fn drain_sse_frames<F>(event_name: &str, subscription_id: &str, buffer: &mut String, emit: &mut F)
where
    F: FnMut(&str, Value),
{
    while let Some(index) = find_sse_frame_boundary(buffer) {
        let frame = buffer[..index].to_string();
        let drain_to = if buffer[index..].starts_with("\r\n\r\n") {
            index + 4
        } else {
            index + 2
        };
        buffer.drain(..drain_to);
        if let Some(event) = parse_sse_frame(&frame) {
            emit(
                event_name,
                serde_json::to_value(AuroraSubscriptionEvent {
                    subscription_id: subscription_id.to_string(),
                    event,
                })
                .expect("gateway stream event payload serializes"),
            );
        }
    }
}

fn find_sse_frame_boundary(buffer: &str) -> Option<usize> {
    match (buffer.find("\r\n\r\n"), buffer.find("\n\n")) {
        (Some(crlf), Some(lf)) => Some(usize::min(crlf, lf)),
        (Some(crlf), None) => Some(crlf),
        (None, Some(lf)) => Some(lf),
        (None, None) => None,
    }
}

fn parse_sse_frame(frame: &str) -> Option<Value> {
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str::<Value>(&data).ok().or_else(|| {
        let payload = redact_sensitive_text(&data);
        Some(json!({
            "kind": "event",
            "payload": payload,
            "redaction": {
                "secretsRedacted": true,
                "source": "tauri-gateway-sse-proxy"
            }
        }))
    })
}

fn event_stream_url(
    base: &Url,
    request: &AuroraSubscribeRequest,
) -> Result<Url, AuroraCommandError> {
    let mut url = base
        .join("api/events/stream")
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?;
    {
        let mut pairs = url.query_pairs_mut();
        if let Some(stream) = request.stream.as_deref() {
            pairs.append_pair("stream", stream);
        }
        for topic in &request.topics {
            pairs.append_pair("topic", topic);
        }
        for kind in request.kinds.as_deref().unwrap_or(&[]) {
            pairs.append_pair("kind", kind);
        }
        if let Some(last_event_id) = request.last_event_id.as_deref() {
            pairs.append_pair("last_event_id", last_event_id);
        }
        if let Some(replay_from) = request.replay_from.as_deref() {
            pairs.append_pair("replay_from", replay_from);
        }
        if let Some(correlation_id) = request.correlation_id.as_deref() {
            pairs.append_pair("correlation_id", correlation_id);
        }
        if let Some(backfill) = request.backfill {
            pairs.append_pair("backfill", if backfill { "true" } else { "false" });
        }
    }
    Ok(url)
}

fn subscribe_has_valid_sidecar_token(
    request: &AuroraSubscribeRequest,
    state: &State<'_, SharedSidecarState>,
) -> Result<bool, AuroraCommandError> {
    if is_thin_mode() {
        return Ok(true);
    }
    let Some(headers) = &request.headers else {
        return Ok(false);
    };
    let Some(token) = headers
        .get("x-aurora-sidecar-token")
        .or_else(|| headers.get("X-Aurora-Sidecar-Token"))
    else {
        return Ok(false);
    };
    let sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
    Ok(token == &sidecar.token)
}

fn redacted_gateway_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "Gateway event stream timed out".to_string()
    } else if error.is_connect() {
        "Gateway event stream connection failed".to_string()
    } else if error.is_decode() {
        "Gateway event stream payload decode failed".to_string()
    } else {
        "Gateway event stream failed".to_string()
    }
}

struct GatewayErrorBody {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_gateway_error_body(
    mut response: reqwest::Response,
) -> Result<GatewayErrorBody, String> {
    let max_read = GATEWAY_EVENT_STREAM_ERROR_BODY_MAX_BYTES.saturating_add(1);
    let mut bytes = Vec::with_capacity(max_read);
    let mut truncated = false;

    while bytes.len() < max_read {
        let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| redacted_gateway_error(&error))?
        else {
            break;
        };
        let remaining = max_read - bytes.len();
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() == max_read {
            truncated = true;
            break;
        }
    }

    if bytes.len() > GATEWAY_EVENT_STREAM_ERROR_BODY_MAX_BYTES {
        bytes.truncate(GATEWAY_EVENT_STREAM_ERROR_BODY_MAX_BYTES);
        truncated = true;
    }

    Ok(GatewayErrorBody { bytes, truncated })
}

fn redacted_gateway_status_error(status: u16, body: GatewayErrorBody) -> String {
    let truncated = body.truncated;
    let body_text = String::from_utf8_lossy(&body.bytes);
    let mut body = redact_sensitive_text(&body_text);
    if truncated {
        body.push_str("... [truncated]");
    }
    if body.trim().is_empty() {
        format!("Gateway event stream returned HTTP {status}")
    } else {
        format!("Gateway event stream returned HTTP {status}: {body}")
    }
}

struct SidecarLaunch {
    program: String,
    args: Vec<String>,
    working_dir: PathBuf,
    bundled: bool,
}

fn sidecar_launch(app: &AppHandle) -> Result<SidecarLaunch, AuroraCommandError> {
    if env::var("AURORA_TAURI_SIDECAR_PROGRAM").is_ok() {
        return Ok(SidecarLaunch {
            program: sidecar_program(),
            args: sidecar_args(),
            working_dir: sidecar_working_dir(),
            bundled: false,
        });
    }

    if let Some(program) = bundled_sidecar_path(app) {
        let working_dir = program
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(sidecar_working_dir);
        return Ok(SidecarLaunch {
            program: program.display().to_string(),
            args: Vec::new(),
            working_dir,
            bundled: true,
        });
    }

    Ok(SidecarLaunch {
        program: "python".to_string(),
        args: vec!["main.py".to_string()],
        working_dir: sidecar_working_dir(),
        bundled: false,
    })
}

fn sidecar_program() -> String {
    env::var("AURORA_TAURI_SIDECAR_PROGRAM").unwrap_or_else(|_| "python".to_string())
}

fn sidecar_args() -> Vec<String> {
    if let Ok(args) = env::var("AURORA_TAURI_SIDECAR_ARGS") {
        return args
            .split_whitespace()
            .filter(|part| !part.is_empty())
            .map(ToString::to_string)
            .collect();
    }
    vec!["main.py".to_string()]
}

fn sidecar_working_dir() -> PathBuf {
    env::var("AURORA_TAURI_SIDECAR_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|path| path.parent())
                .and_then(|path| path.parent())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        })
}

fn bundled_sidecar_path(app: &AppHandle) -> Option<PathBuf> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let filename = format!(
        "{}-{}{}",
        BUNDLED_SIDECAR_NAME,
        env!("TAURI_ENV_TARGET_TRIPLE"),
        extension
    );
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("binaries").join(&filename));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&filename),
    );
    candidates.into_iter().find(|path| path.is_file())
}

fn random_hex_128() -> Result<String, AuroraCommandError> {
    random_hex_from_entropy::<16>(fill_secure_random)
}

fn generate_sidecar_token() -> Result<String, AuroraCommandError> {
    random_hex_from_entropy::<32>(fill_secure_random)
}

fn random_hex_from_entropy<const N: usize>(
    fill_entropy: impl FnOnce(&mut [u8]) -> Result<(), AuroraCommandError>,
) -> Result<String, AuroraCommandError> {
    let mut bytes = [0_u8; N];
    fill_entropy(&mut bytes)?;
    Ok(hex_encode(&bytes))
}

fn fill_secure_random(bytes: &mut [u8]) -> Result<(), AuroraCommandError> {
    getrandom::getrandom(bytes).map_err(|error| {
        AuroraCommandError::SidecarProcess(format!("secure random generator unavailable: {error}"))
    })
}

#[cfg(test)]
fn generate_sidecar_token_from_entropy(
    fill_entropy: impl FnOnce(&mut [u8]) -> Result<(), AuroraCommandError>,
) -> Result<String, AuroraCommandError> {
    random_hex_from_entropy::<32>(fill_entropy)
}

fn is_loopback_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
}

fn is_loopback_http_origin(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("::1")
        )
}

fn shutdown_aurora(
    app: &AppHandle,
    sidecar_state: &SharedSidecarState,
    subscription_state: &SharedSubscriptionState,
    native_voice_state: &NativeVoiceState,
) -> Result<(), AuroraCommandError> {
    native_voice_state.stop();
    {
        let mut subscriptions = subscription_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        subscriptions.abort_all();
    }
    {
        let mut sidecar = sidecar_state
            .lock()
            .map_err(|_| AuroraCommandError::SidecarState)?;
        stop_sidecar(&mut sidecar)?;
    }
    app.exit(0);
    Ok(())
}

fn overlay_hidden_status(
    overlay_state: &SharedOverlayState,
    reason: Option<&str>,
) -> Result<OverlayStatus, AuroraCommandError> {
    let mut overlay = overlay_state
        .lock()
        .map_err(|_| AuroraCommandError::SidecarState)?;
    overlay.visible = false;
    overlay.pointer_passthrough = true;
    let mut status = overlay.status();
    if let Some(reason) = reason {
        status.reason = Some(reason.to_string());
    }
    Ok(status)
}

#[cfg(desktop)]
fn main_window_is_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

#[cfg(desktop)]
fn hide_overlay_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

#[cfg(desktop)]
fn ensure_overlay_window(app: &AppHandle) -> Result<tauri::WebviewWindow, AuroraCommandError> {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        return Ok(window);
    }
    WebviewWindowBuilder::new(
        app,
        OVERLAY_WINDOW_LABEL,
        WebviewUrl::App("index.html?surface=overlay".into()),
    )
    .title("Aurora Overlay")
    .inner_size(VOICE_OVERLAY_WIDTH, VOICE_OVERLAY_HEIGHT)
    .position(32.0, 28.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .resizable(false)
    .visible(false)
    .focused(false)
    .build()
    .map_err(|error| AuroraCommandError::Gateway(format!("failed to create overlay: {error}")))
}

#[cfg(desktop)]
fn configure_overlay_for_mode(
    window: &tauri::WebviewWindow,
    mode: OverlayMode,
    saved_position: Option<OverlayPoint>,
) {
    if let Some((work_origin, work_size)) = overlay_work_area(window) {
        let size = overlay_size_for_mode(mode);
        let position = saved_position
            .map(OverlayPoint::to_logical_position)
            .unwrap_or_else(|| default_overlay_position(mode, work_origin, work_size));
        let _ = window.set_size(size);
        let _ = window.set_position(position);
    } else {
        let _ = window.set_size(overlay_size_for_mode(mode));
    }
    let _ = window.set_focusable(mode == OverlayMode::Text);
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_visible_on_all_workspaces(true);
}

#[cfg(desktop)]
fn overlay_work_area(
    window: &tauri::WebviewWindow,
) -> Option<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let origin: LogicalPosition<f64> = work_area.position.to_logical(scale_factor);
    let size: tauri::LogicalSize<f64> = work_area.size.to_logical(scale_factor);
    Some((origin, size))
}

fn overlay_size_for_mode(mode: OverlayMode) -> LogicalSize<f64> {
    match mode {
        OverlayMode::Voice => LogicalSize::new(VOICE_OVERLAY_WIDTH, VOICE_OVERLAY_HEIGHT),
        OverlayMode::Text => LogicalSize::new(TEXT_OVERLAY_WIDTH, TEXT_OVERLAY_HEIGHT),
    }
}

fn default_overlay_position(
    mode: OverlayMode,
    work_origin: LogicalPosition<f64>,
    work_size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    let overlay_size = overlay_size_for_mode(mode);
    match mode {
        OverlayMode::Voice => LogicalPosition::new(
            work_origin.x + work_size.width - overlay_size.width - OVERLAY_MARGIN,
            work_origin.y + OVERLAY_MARGIN,
        ),
        OverlayMode::Text => LogicalPosition::new(
            work_origin.x + (work_size.width - overlay_size.width) / 2.0,
            work_origin.y + work_size.height - overlay_size.height - OVERLAY_MARGIN,
        ),
    }
}

fn should_apply_overlay_passthrough_to_native(
    window_visible: bool,
    mode: Option<OverlayMode>,
    requested_enabled: bool,
) -> bool {
    requested_enabled && window_visible && mode.is_none()
}

#[cfg(desktop)]
fn overlay_scale_factor(window: &tauri::WebviewWindow) -> f64 {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(|monitor| monitor.scale_factor())
        .unwrap_or_else(|| window.scale_factor().unwrap_or(1.0))
}

#[cfg(desktop)]
fn overlay_window_is_visible(window: &tauri::WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false)
}

#[cfg(desktop)]
fn set_overlay_passthrough_after_show(window: &tauri::WebviewWindow, enabled: bool) {
    if cfg!(target_os = "linux") {
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if overlay_window_is_visible(&window) {
                set_overlay_passthrough(&window, enabled);
            }
        });
    } else if overlay_window_is_visible(window) {
        set_overlay_passthrough(window, enabled);
    }
}

#[cfg(desktop)]
fn set_overlay_passthrough(window: &tauri::WebviewWindow, enabled: bool) {
    let _ = window.set_ignore_cursor_events(enabled);
}

#[cfg(desktop)]
fn parse_overlay_shortcut(accelerator: &str) -> Result<Shortcut, String> {
    let (modifiers, code) = parse_overlay_shortcut_parts(accelerator)?;
    Ok(Shortcut::new(Some(modifiers), code))
}

#[cfg(not(desktop))]
fn parse_overlay_shortcut(accelerator: &str) -> Result<(), String> {
    parse_overlay_shortcut_parts(accelerator).map(|_| ())
}

#[cfg(desktop)]
fn parse_overlay_shortcut_parts(accelerator: &str) -> Result<(Modifiers, Code), String> {
    let mut modifiers = Modifiers::empty();
    let mut key: Option<Code> = None;
    for part in accelerator.split('+') {
        let token = part.trim();
        if token.is_empty() {
            return Err("empty hotkey segment".to_string());
        }
        match token.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "primary" => {
                modifiers |= if cfg!(target_os = "macos") {
                    Modifiers::META
                } else {
                    Modifiers::CONTROL
                };
            }
            "control" | "ctrl" => modifiers |= Modifiers::CONTROL,
            "command" | "cmd" | "meta" | "super" => modifiers |= Modifiers::META,
            "shift" => modifiers |= Modifiers::SHIFT,
            "alt" | "option" => modifiers |= Modifiers::ALT,
            _ => {
                if key.is_some() {
                    return Err("hotkey must contain exactly one key".to_string());
                }
                key = Some(parse_overlay_key(token)?);
            }
        }
    }
    let key = key.ok_or_else(|| "hotkey must contain a key".to_string())?;
    if modifiers.is_empty() {
        return Err("hotkey must include at least one modifier".to_string());
    }
    Ok((modifiers, key))
}

#[cfg(not(desktop))]
fn parse_overlay_shortcut_parts(accelerator: &str) -> Result<(), String> {
    let mut has_modifier = false;
    let mut key_count = 0;
    for part in accelerator.split('+') {
        let token = part.trim();
        if token.is_empty() {
            return Err("empty hotkey segment".to_string());
        }
        match token.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "primary" | "control" | "ctrl" | "command"
            | "cmd" | "meta" | "super" | "shift" | "alt" | "option" => has_modifier = true,
            _ => {
                parse_overlay_key_name(token)?;
                key_count += 1;
            }
        }
    }
    if key_count != 1 {
        return Err("hotkey must contain exactly one key".to_string());
    }
    if !has_modifier {
        return Err("hotkey must include at least one modifier".to_string());
    }
    Ok(())
}

#[cfg(desktop)]
fn parse_overlay_key(token: &str) -> Result<Code, String> {
    match parse_overlay_key_name(token)? {
        OverlayKeyName::Letter(character) => match character {
            'a' => Ok(Code::KeyA),
            'b' => Ok(Code::KeyB),
            'c' => Ok(Code::KeyC),
            'd' => Ok(Code::KeyD),
            'e' => Ok(Code::KeyE),
            'f' => Ok(Code::KeyF),
            'g' => Ok(Code::KeyG),
            'h' => Ok(Code::KeyH),
            'i' => Ok(Code::KeyI),
            'j' => Ok(Code::KeyJ),
            'k' => Ok(Code::KeyK),
            'l' => Ok(Code::KeyL),
            'm' => Ok(Code::KeyM),
            'n' => Ok(Code::KeyN),
            'o' => Ok(Code::KeyO),
            'p' => Ok(Code::KeyP),
            'q' => Ok(Code::KeyQ),
            'r' => Ok(Code::KeyR),
            's' => Ok(Code::KeyS),
            't' => Ok(Code::KeyT),
            'u' => Ok(Code::KeyU),
            'v' => Ok(Code::KeyV),
            'w' => Ok(Code::KeyW),
            'x' => Ok(Code::KeyX),
            'y' => Ok(Code::KeyY),
            'z' => Ok(Code::KeyZ),
            _ => unreachable!(),
        },
        OverlayKeyName::Digit(digit) => match digit {
            '0' => Ok(Code::Digit0),
            '1' => Ok(Code::Digit1),
            '2' => Ok(Code::Digit2),
            '3' => Ok(Code::Digit3),
            '4' => Ok(Code::Digit4),
            '5' => Ok(Code::Digit5),
            '6' => Ok(Code::Digit6),
            '7' => Ok(Code::Digit7),
            '8' => Ok(Code::Digit8),
            '9' => Ok(Code::Digit9),
            _ => unreachable!(),
        },
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OverlayKeyName {
    Letter(char),
    Digit(char),
}

fn parse_overlay_key_name(token: &str) -> Result<OverlayKeyName, String> {
    let mut chars = token.chars();
    let Some(character) = chars.next() else {
        return Err("hotkey key is empty".to_string());
    };
    if chars.next().is_some() || !character.is_ascii_alphanumeric() {
        return Err("hotkey key must be a single ASCII letter or digit".to_string());
    }
    let lower = character.to_ascii_lowercase();
    if lower.is_ascii_alphabetic() {
        Ok(OverlayKeyName::Letter(lower))
    } else {
        Ok(OverlayKeyName::Digit(lower))
    }
}

#[cfg(desktop)]
fn open_text_overlay_from_shortcut(app: &AppHandle) {
    if let Some(overlay_state) = app.try_state::<SharedOverlayState>() {
        let _ = tauri::async_runtime::block_on(aurora_overlay_show(
            app.clone(),
            overlay_state,
            Some("text".to_string()),
        ));
    }
}

#[cfg(desktop)]
fn register_overlay_shortcut(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                open_text_overlay_from_shortcut(app);
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(desktop, debug_assertions, feature = "desktop-native-voice-e2e"))]
    if std::env::var("AURORA_DESKTOP_NATIVE_VOICE_E2E").as_deref() == Ok("1") {
        keyring::set_default_credential_builder(
            desktop_native_voice_e2e_keyring::credential_builder(),
        );
    }
    let sidecar_state = match SidecarState::new() {
        Ok(state) => Arc::new(Mutex::new(state)),
        Err(error) => {
            eprintln!("aurora_tauri_startup_failed={error}");
            std::process::exit(1);
        }
    };
    let gateway_clients = match GatewayClients::new() {
        Ok(clients) => Arc::new(clients),
        Err(error) => {
            eprintln!("aurora_tauri_startup_failed={error}");
            std::process::exit(1);
        }
    };
    let subscription_state: SharedSubscriptionState =
        Arc::new(Mutex::new(SubscriptionState::new()));
    let overlay_state: SharedOverlayState = Arc::new(Mutex::new(OverlayState::new()));
    let builder = tauri::Builder::default();
    // Single-instance must be the first registered plugin so a second launch (e.g. an
    // aurora:// deep link on Windows/Linux) forwards its URL here instead of opening a
    // second window; the deep-link feature re-emits those argv URLs as deep-link events.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    // The embedded WebDriver server is restricted to an explicit debug-only E2E
    // feature. Release builds never register its local automation endpoint.
    #[cfg(all(desktop, debug_assertions, feature = "desktop-live-webdriver"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    // The SQL plugin remains registered for Tauri's managed database preload path.
    // WebView SQL capabilities are not granted; generated schema catalogs may list
    // plugin vocabulary, but src-tauri/capabilities is the permission grant source.
    let builder = builder.plugin(tauri_plugin_sql::Builder::default().build());
    builder
        .plugin(aurora_mobile_native_plugin())
        .manage(sidecar_state.clone())
        .manage(gateway_clients)
        .manage(subscription_state.clone())
        .manage(overlay_state.clone())
        .manage(NativeVoiceState::default())
        .manage(LocalDataCommandState::default())
        .manage(native_webrtc::NativeWebRtcState::default())
        .manage(mesh_authority::MeshAuthorityState::default())
        .manage(mesh_session::MeshSessionState::default())
        .setup(move |app| {
            native_mesh_assistant::install_for_app(app);
            #[cfg(desktop)]
            {
                match app
                    .handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
                {
                    Ok(()) => {}
                    Err(error) => {
                        let message =
                            format!("Aurora overlay hotkey plugin install failed: {error}");
                        eprintln!("{message}");
                        if let Some(overlay_state) = app.try_state::<SharedOverlayState>() {
                            if let Ok(mut overlay) = overlay_state.lock() {
                                overlay.hotkey_registered = false;
                                overlay.last_registration_error = Some(message);
                            }
                        }
                    }
                };
                if let (Some(window), Some(icon)) = (
                    app.handle().get_webview_window("main"),
                    aurora_desktop_icon(app.handle()),
                ) {
                    let _ = window.set_icon(icon);
                }
                install_tray(app.handle())?;
                if let Some(native_voice) = app.try_state::<NativeVoiceState>() {
                    native_voice.initialize(app.handle().clone(), sidecar_state.clone());
                }
                let overlay_window = ensure_overlay_window(app.handle())?;
                configure_overlay_for_mode(&overlay_window, OverlayMode::Voice, None);
                let _ = overlay_window.hide();
            }
            #[cfg(target_os = "android")]
            {
                log_android_baseline_status(&android_baseline_status());
                if let Some(native) = app.try_state::<AuroraMobileNativePlugin<tauri::Wry>>() {
                    if let Some(handle) = native.handle.as_ref() {
                        match handle
                            .run_mobile_plugin::<Value>("nativeCapabilityManifest", json!({}))
                        {
                            Ok(payload) => log_android_native_plugin_payload(&payload),
                            Err(error) => eprintln!("aurora_android_native_plugin_error={error}"),
                        }
                    }
                }
            }
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            // Dev/AppImage builds are not installed through a package manager, so register
            // the aurora:// scheme with the OS at startup where the platform allows it.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("aurora deep-link scheme registration failed: {error}");
                }
            }
            #[cfg(desktop)]
            eprintln!("aurora_tauri_shell_ready platform=desktop");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            aurora_request,
            aurora_command,
            aurora_subscribe,
            aurora_activate_subscription,
            aurora_unsubscribe,
            aurora_sidecar_session,
            aurora_sidecar_start,
            aurora_sidecar_stop,
            aurora_sidecar_status,
            aurora_native_capability_manifest,
            native_capabilities,
            aurora_native_permission_status,
            aurora_tray_status,
            aurora_notification_status,
            aurora_notification_send,
            aurora_native_share_text,
            aurora_native_open_deep_link,
            aurora_native_show_notification,
            aurora_ios_voice_status,
            aurora_ios_voice_foreground_capture_start,
            aurora_ios_voice_background_capture_start,
            aurora_ios_voice_foreground_capture_stop,
            aurora_ios_voice_foreground_capture_finish,
            aurora_ios_voice_foreground_capture_status,
            aurora_ios_background_status,
            aurora_dialog_status,
            aurora_audio_bridge_status,
            aurora_native_voice_status,
            aurora_native_voice_start,
            aurora_native_voice_finish,
            aurora_native_voice_cancel,
            aurora_native_voice_tray_toggle_e2e,
            aurora_android_baseline_status,
            aurora_android_native_plugin_payload,
            aurora_android_lifecycle_status,
            aurora_android_webview_microphone_permission_decision,
            aurora_android_voice_foreground_service_status,
            aurora_android_voice_foreground_service_start,
            aurora_android_voice_live_test_inject_pcm,
            aurora_android_voice_foreground_service_finish,
            aurora_android_voice_foreground_service_cancel,
            aurora_android_voice_pack_catalog_status,
            aurora_android_voice_pack_catalog_set,
            aurora_android_voice_pack_download,
            aurora_android_voice_pack_download_status,
            aurora_android_voice_pack_activate,
            aurora_android_voice_pack_remove,
            aurora_ios_voice_pack_catalog_set,
            aurora_ios_voice_pack_list,
            aurora_ios_voice_pack_status,
            aurora_ios_voice_pack_download,
            aurora_ios_voice_pack_activate,
            aurora_ios_voice_pack_remove,
            aurora_native_speech_pack_catalog,
            aurora_native_speech_pack_status,
            aurora_native_speech_pack_install,
            aurora_native_speech_pack_activate,
            aurora_native_speech_pack_remove,
            aurora_ios_native_plugin_manifest,
            aurora_ios_invocation_status,
            aurora_ios_local_light_inference_status,
            aurora_ios_entrypoint_payload,
            aurora_ios_invoke_action,
            aurora_log_tail,
            aurora_thin_peer_credential_set,
            aurora_thin_peer_credential_status,
            aurora_thin_peer_credential_delete,
            aurora_thin_peer_reconnect_prove,
            aurora_remote_origin_policy,
            aurora_thin_profile_get,
            aurora_thin_profile_set,
            aurora_thin_room_secret_set,
            aurora_thin_room_secret_get,
            aurora_thin_room_secret_delete,
            aurora_inbound_verifier_get,
            aurora_inbound_verifier_set,
            aurora_inbound_verifier_delete,
            aurora_secure_storage_get,
            aurora_secure_storage_set,
            aurora_secure_storage_delete,
            aurora_assistant_provider_status,
            aurora_assistant_provider_configure,
            aurora_assistant_provider_complete,
            mesh_session::aurora_mesh_session_bind,
            mesh_session::aurora_mesh_session_unbind,
            mesh_session::aurora_mesh_session_set_lifecycle,
            mesh_session::aurora_mesh_session_finish_resume,
            mesh_session::aurora_mesh_session_snapshot,
            aurora_local_data_open,
            aurora_local_data_status,
            aurora_local_data_inspect_identity,
            aurora_local_data_close,
            aurora_local_data_transaction_begin,
            aurora_local_data_transaction_commit,
            aurora_local_data_transaction_rollback,
            aurora_local_data_repository_operation,
            aurora_local_data_export_v1,
            aurora_local_data_import_v1,
            aurora_local_data_envelope_encrypt,
            aurora_local_data_envelope_decrypt,
            aurora_local_data_envelope_rotate,
            mesh_authority::aurora_mesh_authority_hydrate,
            mesh_authority::aurora_mesh_authority_authorize,
            mesh_authority::aurora_mesh_authority_snapshot_manifest,
            mesh_authority::aurora_mesh_authority_issue_reconnect_challenge,
            mesh_authority::aurora_mesh_authority_verify_reconnect_proof,
            mesh_authority::aurora_mesh_authority_list_active_grants,
            mesh_authority::aurora_mesh_authority_replace_grant,
            mesh_authority::aurora_mesh_authority_revoke_peer_authority,
            mesh_authority::aurora_mesh_authority_resolve_grant,
            mesh_authority::aurora_mesh_authority_issue_pairing_credential,
            mesh_authority::aurora_mesh_authority_rollback_pairing_credential,
            mesh_authority::aurora_mesh_authority_revoke_sharing,
            mesh_authority::aurora_mesh_authority_drain_audit,
            mesh_authority::aurora_mesh_authority_export_grants,
            aurora_ios_secure_storage_status,
            aurora_ios_voice_credential_set,
            aurora_ios_voice_credential_status,
            aurora_ios_voice_credential_delete,
            aurora_ios_biometric_status,
            aurora_ios_admin_unlock,
            aurora_biometric_admin_unlock_status,
            aurora_biometric_admin_unlock,
            aurora_local_file_read,
            aurora_local_file_write,
            aurora_local_file_pick,
            aurora_secure_file_handle_open,
            aurora_overlay_show,
            aurora_overlay_hide,
            aurora_overlay_status,
            aurora_overlay_set_passthrough,
            aurora_overlay_start_drag,
            aurora_overlay_move_by,
            aurora_overlay_unregister_hotkey,
            aurora_overlay_register_hotkey,
            native_webrtc::aurora_native_webrtc_create,
            native_webrtc::aurora_native_webrtc_create_offer,
            native_webrtc::aurora_native_webrtc_create_answer,
            native_webrtc::aurora_native_webrtc_set_local_description,
            native_webrtc::aurora_native_webrtc_set_remote_description,
            native_webrtc::aurora_native_webrtc_add_ice_candidate,
            native_webrtc::aurora_native_webrtc_create_data_channel,
            native_webrtc::aurora_native_webrtc_data_channel_send,
            native_webrtc::aurora_native_webrtc_data_channel_close,
            native_webrtc::aurora_native_webrtc_set_data_channel_buffered_amount_low_threshold,
            native_webrtc::aurora_native_webrtc_get_stats,
            native_webrtc::aurora_native_webrtc_measure_rtt,
            native_webrtc::aurora_native_webrtc_close,
            aurora_shutdown
        ])
        .on_window_event(move |window, event| {
            #[cfg(mobile)]
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Suspended) {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    #[cfg(target_os = "android")]
                    release_android_focused_voice_on_background(&app);
                    if let Some(state) = app.try_state::<mesh_session::MeshSessionState>() {
                        state.mark_surface_backgrounded().await;
                        eprintln!(
                            "aurora.mesh surface_lifecycle source=native_suspended lifecycle=background"
                        );
                    }
                });
            }
            #[cfg(mobile)]
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resumed) {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app.try_state::<mesh_session::MeshSessionState>() {
                        state.mark_surface_resumed().await;
                        let _ = app.emit_to(
                            "main",
                            mesh_session::MESH_SURFACE_RESUMED_EVENT,
                            (),
                        );
                        eprintln!(
                            "aurora.mesh surface_lifecycle source=native_resumed lifecycle=awaiting_webview_drain"
                        );
                    }
                });
            }
            #[cfg(desktop)]
            {
                if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)) {
                    let app = window.app_handle();
                    if let Some(overlay_state) = app.try_state::<SharedOverlayState>() {
                        let overlay_was_visible = overlay_state
                            .lock()
                            .map(|overlay| overlay.visible)
                            .unwrap_or(false);
                        if overlay_was_visible {
                            hide_overlay_window(app);
                            let _ = overlay_hidden_status(&overlay_state, None);
                            let _ = app.emit("aurora://overlay-mode", json!({ "mode": "hidden" }));
                        }
                    }
                }
            }
            #[cfg(desktop)]
            if window.label() == OVERLAY_WINDOW_LABEL {
                if let tauri::WindowEvent::Moved(position) = event {
                    let app = window.app_handle();
                    if let Some(overlay_state) = app.try_state::<SharedOverlayState>() {
                        if let Ok(mut overlay) = overlay_state.lock() {
                            if let Some(mode) = overlay.mode {
                                let scale_factor = app
                                    .get_webview_window(OVERLAY_WINDOW_LABEL)
                                    .as_ref()
                                    .map(overlay_scale_factor)
                                    .unwrap_or_else(|| window.scale_factor().unwrap_or(1.0));
                                let logical: LogicalPosition<f64> =
                                    position.to_logical(scale_factor);
                                overlay.save_position(
                                    mode,
                                    OverlayPoint {
                                        x: logical.x,
                                        y: logical.y,
                                    },
                                );
                            }
                        }
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match close_policy_for_label(window.label()) {
                    ClosePolicy::HideToTray | ClosePolicy::HideOverlay => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    ClosePolicy::AllowClose => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Aurora Tauri shell");
}

#[cfg(desktop)]
fn aurora_desktop_icon(app: &AppHandle) -> Option<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/aurora-desktop-icon.png"))
        .map(Image::to_owned)
        .ok()
        .or_else(|| {
            app.default_window_icon()
                .map(|icon| icon.clone().to_owned())
        })
}

#[cfg(desktop)]
fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Aurora", true, None::<&str>)?;
    let voice = MenuItem::with_id(app, "voice", "Voice", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &voice, &quit])?;
    let mut builder = TrayIconBuilder::with_id("aurora-main")
        .tooltip("Aurora")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                if let (Some(sidecar), Some(subscriptions), Some(native_voice)) = (
                    app.try_state::<SharedSidecarState>(),
                    app.try_state::<SharedSubscriptionState>(),
                    app.try_state::<NativeVoiceState>(),
                ) {
                    let _ = shutdown_aurora(
                        app,
                        sidecar.inner(),
                        subscriptions.inner(),
                        native_voice.inner(),
                    );
                } else {
                    app.exit(0);
                }
            }
            "voice" => native_voice::tray_toggle(app),
            _ => {}
        });
    if let Some(icon) = aurora_desktop_icon(app) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct LoopbackFixture {
        base_url: Url,
        request_rx: mpsc::Receiver<String>,
        release_tx: Option<mpsc::Sender<()>>,
        handle: thread::JoinHandle<()>,
    }

    impl LoopbackFixture {
        fn join(self) {
            if let Some(release_tx) = self.release_tx {
                let _ = release_tx.send(());
            }
            self.handle.join().expect("loopback fixture joins");
        }
    }

    fn spawn_loopback_fixture(chunks: Vec<Vec<u8>>, hold_open: bool) -> LoopbackFixture {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fixture");
        let address = listener
            .local_addr()
            .expect("read loopback fixture address");
        let (request_tx, request_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept loopback SSE request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let read = stream.read(&mut buffer).expect("read loopback SSE request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            request_tx
                .send(String::from_utf8_lossy(&request).to_string())
                .expect("send captured loopback request");
            for chunk in chunks {
                stream.write_all(&chunk).expect("write loopback SSE chunk");
                stream.flush().expect("flush loopback SSE chunk");
                thread::sleep(Duration::from_millis(10));
            }
            if hold_open {
                let _ = release_rx.recv_timeout(Duration::from_secs(5));
            }
        });

        LoopbackFixture {
            base_url: Url::parse(&format!("http://{address}")).expect("parse loopback fixture URL"),
            request_rx,
            release_tx: hold_open.then_some(release_tx),
            handle,
        }
    }

    fn clear_remote_env() {
        env::remove_var("AURORA_TAURI_ALLOW_REMOTE_GATEWAY");
        env::remove_var("AURORA_TAURI_ALLOWED_REMOTE_ORIGINS");
        env::remove_var("AURORA_TAURI_DEV_REMOTE_GATEWAY_BOOTSTRAP");
        env::remove_var("AURORA_TAURI_REMOTE_GATEWAY_URL");
        env::remove_var("AURORA_GATEWAY_URL");
        env::remove_var("AURORA_TAURI_GATEWAY_TOKEN");
        env::remove_var("AURORA_GATEWAY_TOKEN");
    }

    #[test]
    fn filtered_headers_do_not_inject_gateway_tokens_from_environment() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("AURORA_TAURI_GATEWAY_TOKEN", "tauri-env-token");
        env::set_var("AURORA_GATEWAY_TOKEN", "gateway-env-token");

        let filtered = filtered_headers(None);

        assert!(filtered.get("authorization").is_none());
        clear_remote_env();
    }

    #[test]
    fn filtered_headers_forwards_admin_action_confirmation_headers() {
        let mut headers = BTreeMap::new();
        headers.insert("X-Aurora-AdminAction-Id".to_string(), "aa_1".to_string());
        headers.insert(
            "X-Aurora-AdminAction-Token".to_string(),
            "tok_1".to_string(),
        );
        headers.insert(
            "X-Aurora-AdminAction-Digest".to_string(),
            "dig_1".to_string(),
        );
        headers.insert("X-Some-Unrelated-Header".to_string(), "drop-me".to_string());

        let filtered = filtered_headers(Some(headers));

        assert_eq!(
            filtered
                .get("x-aurora-adminaction-id")
                .map(|v| v.to_str().unwrap()),
            Some("aa_1")
        );
        assert_eq!(
            filtered
                .get("x-aurora-adminaction-token")
                .map(|v| v.to_str().unwrap()),
            Some("tok_1")
        );
        assert_eq!(
            filtered
                .get("x-aurora-adminaction-digest")
                .map(|v| v.to_str().unwrap()),
            Some("dig_1")
        );
        assert!(filtered.get("x-some-unrelated-header").is_none());
    }

    #[test]
    fn sse_parser_returns_json_events_from_fragmented_crlf_and_lf_frames() {
        let chunks = [
            "data: {\"kind\":\"one\"}\r",
            "\n\r\n",
            "data: {\"kind\":\"two\"}\n",
            "\n",
        ];
        let mut buffer = String::new();
        let mut events = Vec::new();

        for chunk in chunks {
            buffer.push_str(chunk);
            while let Some(index) = find_sse_frame_boundary(&buffer) {
                let frame = buffer[..index].to_string();
                let drain_to = if buffer[index..].starts_with("\r\n\r\n") {
                    index + 4
                } else {
                    index + 2
                };
                buffer.drain(..drain_to);
                if let Some(event) = parse_sse_frame(&frame) {
                    events.push(event);
                }
            }
        }

        assert_eq!(events, vec![json!({"kind": "one"}), json!({"kind": "two"})]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn sse_parser_ignores_done_frames() {
        assert_eq!(parse_sse_frame("data: [DONE]"), None);
        assert_eq!(parse_sse_frame("event: close\ndata: [DONE]"), None);
    }

    #[test]
    fn sse_parser_redacts_non_json_event_payloads_before_emit() {
        let event = parse_sse_frame(
            "event: error\ndata: Authorization: Bearer gateway-token token=stream-token",
        )
        .unwrap();

        let serialized = serde_json::to_string(&event).unwrap();
        assert!(!serialized.contains("gateway-token"));
        assert!(!serialized.contains("stream-token"));
        assert_eq!(
            event["payload"],
            json!("Authorization: Bearer [redacted] token=[redacted]")
        );
        assert_eq!(event["redaction"]["secretsRedacted"], json!(true));
    }

    #[test]
    fn event_stream_url_percent_encodes_subscription_query_values() {
        let request = AuroraSubscribeRequest {
            topics: vec!["voice local/partial".to_string()],
            stream: Some("main stream".to_string()),
            kinds: Some(vec![
                "transcript.delta".to_string(),
                "wake word".to_string(),
            ]),
            headers: None,
            last_event_id: Some("evt/42?cursor=1".to_string()),
            replay_from: Some("2026-08-07T00:00:00Z".to_string()),
            correlation_id: Some("corr id+plus".to_string()),
            backfill: Some(true),
        };

        let url =
            event_stream_url(&Url::parse("http://127.0.0.1:8000").unwrap(), &request).unwrap();
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();

        assert_eq!(url.path(), "/api/events/stream");
        assert!(url.as_str().contains("topic=voice+local%2Fpartial"));
        assert!(pairs.contains(&("stream".to_string(), "main stream".to_string())));
        assert!(pairs.contains(&("topic".to_string(), "voice local/partial".to_string())));
        assert!(pairs.contains(&("kind".to_string(), "wake word".to_string())));
        assert!(pairs.contains(&("last_event_id".to_string(), "evt/42?cursor=1".to_string())));
        assert!(pairs.contains(&("correlation_id".to_string(), "corr id+plus".to_string())));
        assert!(pairs.contains(&("backfill".to_string(), "true".to_string())));
    }

    #[test]
    fn live_gateway_event_stream_uses_reqwest_without_webview_and_redacts_headers() {
        let fixture = spawn_loopback_fixture(
            vec![
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n"
                    .to_vec(),
                b"data: {\"kind\":\"first\",\"id\":\"stream-event\"}\r".to_vec(),
                b"\n\r\n".to_vec(),
                b"event: message\ndata: {\"kind\":\"multi\",\n".to_vec(),
                b"data: \"message\":\"hello\"}\n\n".to_vec(),
                b"data: [DONE]\n\n".to_vec(),
            ],
            false,
        );
        let request = AuroraSubscribeRequest {
            topics: vec!["voice local/partial".to_string()],
            stream: Some("main stream".to_string()),
            kinds: Some(vec!["transcript.delta".to_string()]),
            headers: Some(BTreeMap::from([
                (
                    "Authorization".to_string(),
                    "Bearer should-not-forward".to_string(),
                ),
                (
                    "X-Aurora-Sidecar-Token".to_string(),
                    "sidecar-secret".to_string(),
                ),
                (
                    "X-Aurora-AdminAction-Token".to_string(),
                    "admin-confirm-token".to_string(),
                ),
            ])),
            last_event_id: Some("evt/42?cursor=1".to_string()),
            replay_from: None,
            correlation_id: Some("corr id+plus".to_string()),
            backfill: Some(false),
        };
        let url = event_stream_url(&fixture.base_url, &request).unwrap();
        let headers = filtered_headers(request.headers.clone());
        let emitted = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let captured = Arc::clone(&emitted);

        tauri::async_runtime::block_on(run_gateway_event_stream_with_emitter(
            reqwest::Client::new(),
            url,
            headers,
            "aurora-sub-live".to_string(),
            "aurora://events/aurora-sub-live".to_string(),
            "aurora://events/aurora-sub-live/closed".to_string(),
            move |event_name, payload| {
                captured
                    .lock()
                    .unwrap()
                    .push((event_name.to_string(), payload));
            },
        ));

        let request = fixture
            .request_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("fixture captured request");
        fixture.join();
        assert!(request.starts_with("GET /api/events/stream?"));
        assert!(request.contains("stream=main+stream"));
        assert!(request.contains("topic=voice+local%2Fpartial"));
        assert!(request.contains("last_event_id=evt%2F42%3Fcursor%3D1"));
        assert!(request.contains("correlation_id=corr+id%2Bplus"));
        assert!(request.contains("x-aurora-adminaction-token: admin-confirm-token"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(!request.contains("should-not-forward"));
        assert!(!request.contains("sidecar-secret"));

        let emitted = emitted.lock().unwrap();
        assert_eq!(emitted.len(), 3);
        assert_eq!(emitted[0].0, "aurora://events/aurora-sub-live");
        assert_eq!(emitted[0].1["subscriptionId"], json!("aurora-sub-live"));
        assert_eq!(
            emitted[0].1["event"],
            json!({"kind": "first", "id": "stream-event"})
        );
        assert_eq!(
            emitted[1].1["event"],
            json!({"kind": "multi", "message": "hello"})
        );
        assert_eq!(emitted[2].0, "aurora://events/aurora-sub-live/closed");
        assert_eq!(emitted[2].1["code"], json!("closed"));
        assert_eq!(emitted[2].1["secretsRedacted"], json!(true));
        let serialized = serde_json::to_string(&*emitted).unwrap();
        assert!(!serialized.contains("admin-confirm-token"));
        assert!(!serialized.contains("should-not-forward"));
        assert!(!serialized.contains("sidecar-secret"));
    }

    #[test]
    fn live_gateway_event_stream_redacts_error_status_body() {
        let fixture = spawn_loopback_fixture(
            vec![
                b"HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n"
                    .to_vec(),
                b"Authorization: Bearer gateway-token token=body-secret api_key=sk-secret".to_vec(),
            ],
            false,
        );
        let emitted = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let captured = Arc::clone(&emitted);

        tauri::async_runtime::block_on(run_gateway_event_stream_with_emitter(
            reqwest::Client::new(),
            fixture.base_url.join("api/events/stream").unwrap(),
            HeaderMap::new(),
            "aurora-sub-error".to_string(),
            "aurora://events/aurora-sub-error".to_string(),
            "aurora://events/aurora-sub-error/closed".to_string(),
            move |event_name, payload| {
                captured
                    .lock()
                    .unwrap()
                    .push((event_name.to_string(), payload));
            },
        ));

        let _ = fixture
            .request_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("fixture captured request");
        fixture.join();
        let emitted = emitted.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, "aurora://events/aurora-sub-error/closed");
        assert_eq!(emitted[0].1["code"], json!("transport_loss"));
        let reason = emitted[0].1["reason"].as_str().unwrap();
        assert!(reason.contains("HTTP 503"));
        assert!(reason.contains("[redacted]"));
        assert!(!reason.contains("gateway-token"));
        assert!(!reason.contains("body-secret"));
        assert!(!reason.contains("sk-secret"));
        assert_eq!(emitted[0].1["secretsRedacted"], json!(true));
    }

    #[test]
    fn live_gateway_event_stream_caps_oversized_utf8_error_body_before_redaction() {
        let mut body = b"token=early-secret ".to_vec();
        body.resize(GATEWAY_EVENT_STREAM_ERROR_BODY_MAX_BYTES - 1, b'a');
        body.extend_from_slice("🙂".as_bytes());
        body.extend_from_slice(b" token=too-late-secret");
        let fixture = spawn_loopback_fixture(
            vec![
                format!(
                    "HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                )
                .into_bytes(),
                body,
            ],
            false,
        );
        let emitted = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let captured = Arc::clone(&emitted);

        tauri::async_runtime::block_on(run_gateway_event_stream_with_emitter(
            reqwest::Client::new(),
            fixture.base_url.join("api/events/stream").unwrap(),
            HeaderMap::new(),
            "aurora-sub-large-error".to_string(),
            "aurora://events/aurora-sub-large-error".to_string(),
            "aurora://events/aurora-sub-large-error/closed".to_string(),
            move |event_name, payload| {
                captured
                    .lock()
                    .unwrap()
                    .push((event_name.to_string(), payload));
            },
        ));

        let _ = fixture
            .request_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("fixture captured request");
        fixture.join();
        let emitted = emitted.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(
            emitted[0].0,
            "aurora://events/aurora-sub-large-error/closed"
        );
        assert_eq!(emitted[0].1["code"], json!("transport_loss"));
        let reason = emitted[0].1["reason"].as_str().unwrap();
        assert!(reason.contains("HTTP 502"));
        assert!(reason.contains("[redacted]"));
        assert!(reason.contains("[truncated]"));
        assert!(!reason.contains("early-secret"));
        assert!(!reason.contains("too-late-secret"));
        assert_eq!(emitted[0].1["secretsRedacted"], json!(true));
    }

    #[test]
    fn live_gateway_event_stream_abort_stops_stale_delivery() {
        let fixture = spawn_loopback_fixture(
            vec![
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: keep-alive\r\n\r\n"
                    .to_vec(),
                b"data: {\"kind\":\"first\"}\n\n".to_vec(),
            ],
            true,
        );
        let emitted = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let captured = Arc::clone(&emitted);
        let handle = tauri::async_runtime::spawn(run_gateway_event_stream_with_emitter(
            reqwest::Client::new(),
            fixture.base_url.join("api/events/stream").unwrap(),
            HeaderMap::new(),
            "aurora-sub-abort".to_string(),
            "aurora://events/aurora-sub-abort".to_string(),
            "aurora://events/aurora-sub-abort/closed".to_string(),
            move |event_name, payload| {
                captured
                    .lock()
                    .unwrap()
                    .push((event_name.to_string(), payload));
            },
        ));

        let _ = fixture
            .request_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("fixture captured request");
        for _ in 0..100 {
            if emitted.lock().unwrap().len() == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        handle.abort();
        thread::sleep(Duration::from_millis(50));
        fixture.join();

        let emitted = emitted.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, "aurora://events/aurora-sub-abort");
        assert_eq!(emitted[0].1["event"], json!({"kind": "first"}));
    }

    #[test]
    fn subscription_remove_aborts_and_bounds_cancelled_tasks() {
        let mut subscriptions = SubscriptionState::new();
        let handle = tauri::async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });

        subscriptions.insert(
            "aurora-sub-test".to_string(),
            SubscriptionTask {
                handle,
                ready: watch::channel(false).0,
                owner_label: "main".to_string(),
            },
        );
        assert!(!subscriptions.activate("aurora-sub-test", OVERLAY_WINDOW_LABEL));
        assert!(subscriptions.activate("aurora-sub-test", "main"));

        subscriptions.remove("aurora-sub-test", OVERLAY_WINDOW_LABEL);
        assert!(subscriptions.tasks.contains_key("aurora-sub-test"));
        subscriptions.remove("aurora-sub-test", "main");

        assert!(!subscriptions.activate("aurora-sub-test", "main"));
        assert!(subscriptions.tasks.is_empty());
    }

    #[test]
    fn subscription_ids_are_random_nonsequential_tokens() {
        let subscriptions = SubscriptionState::new();
        let first = subscriptions.next_subscription_id().unwrap();
        let second = subscriptions.next_subscription_id().unwrap();
        assert_ne!(first, second);
        for id in [first, second] {
            let token = id
                .strip_prefix("aurora-sub-")
                .expect("subscription id prefix");
            assert_eq!(token.len(), 32);
            assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn local_manifest_advertises_sidecar_supervision_without_broad_native_access() {
        let manifest = native_capability_manifest();
        assert_eq!(
            manifest.capabilities.get("desktop.localSidecarSupervision"),
            Some(&true)
        );
        assert_eq!(
            manifest.permissions.get("aurora.sidecarSession"),
            Some(&cfg!(desktop))
        );
        assert_eq!(
            manifest.permissions.get("aurora.sidecarStart"),
            Some(&cfg!(desktop))
        );
        assert_eq!(
            manifest.permissions.get("aurora.sidecarStop"),
            Some(&cfg!(desktop))
        );
        assert_eq!(
            manifest.permissions.get("aurora.shutdown"),
            Some(&cfg!(desktop))
        );
        assert_eq!(manifest.permissions.get("aurora.updater"), Some(&false));
        assert_eq!(
            manifest.capabilities.get("desktop.signedUpdater"),
            Some(&true)
        );
        assert_eq!(
            manifest.capabilities.get("desktop.bundledSidecarPolicy"),
            Some(&true)
        );
        assert_eq!(manifest.permissions.get("aurora.shell"), Some(&false));
        assert_eq!(
            manifest.permissions.get("aurora.localFileWrite"),
            Some(&false)
        );
        assert_eq!(
            manifest.permissions.get("aurora.secureStorage"),
            Some(&true)
        );
        assert_eq!(
            manifest.capabilities.get("native.secureCredentialStorage"),
            Some(&true)
        );
        assert_eq!(
            manifest.permissions.get("aurora.iosKeychain"),
            Some(&cfg!(target_os = "ios"))
        );
        assert_eq!(
            manifest.permissions.get("aurora.iosBiometricUnlock"),
            Some(&cfg!(target_os = "ios"))
        );
        assert_eq!(
            manifest
                .capabilities
                .get("ios.keychain.secureCredentialStorage"),
            Some(&cfg!(target_os = "ios"))
        );
        assert_eq!(
            manifest.capabilities.get("ios.biometric.adminUnlock"),
            Some(&cfg!(target_os = "ios"))
        );
        assert_eq!(
            manifest.capabilities.get("ios.siriReplacement"),
            Some(&false)
        );
        assert_eq!(
            manifest.capabilities.get("native.secureFileHandles"),
            Some(&false)
        );
        assert_eq!(manifest.capabilities.get("desktop.tray"), Some(&true));
        assert_eq!(manifest.permissions.get("aurora.overlay"), Some(&true));
        assert_eq!(
            manifest.permissions.get("aurora.overlayHotkey"),
            Some(&true)
        );
        assert_eq!(
            manifest.capabilities.get("desktop.overlayWindow"),
            Some(&true)
        );
        assert_eq!(
            manifest.capabilities.get("desktop.globalHotkey"),
            Some(&true)
        );
        assert_eq!(
            manifest.permissions.get("aurora.notificationsSend"),
            Some(&false)
        );
        assert_eq!(manifest.permissions.get("aurora.dialogOpen"), Some(&false));
        assert_eq!(
            manifest.permissions.get("aurora.audioCapture"),
            Some(&false)
        );
        assert_eq!(
            manifest.permissions.get("aurora.iosVoiceStatus"),
            Some(&true)
        );
        assert_eq!(
            manifest.permissions.get("aurora.iosBackgroundStatus"),
            Some(&true)
        );
        assert_eq!(
            manifest.permissions.get("aurora.iosMicrophoneCapture"),
            Some(&false)
        );
        assert_eq!(
            manifest.permissions.get("aurora.iosBackgroundAudio"),
            Some(&false)
        );
        assert_eq!(
            manifest.permissions.get("aurora.iosSiriReplacement"),
            Some(&false)
        );
        assert_eq!(
            manifest.capabilities.get("native.notifications"),
            Some(&false)
        );
        assert_eq!(manifest.capabilities.get("native.dialogs"), Some(&false));
        assert_eq!(manifest.capabilities.get("native.audio"), Some(&false));
        assert_eq!(manifest.capabilities.get("ios.appIntents"), Some(&false));
        assert_eq!(manifest.capabilities.get("ios.shortcuts"), Some(&false));
        assert_eq!(
            manifest.capabilities.get("ios.siriReplacement"),
            Some(&false)
        );
        assert_eq!(
            manifest.capabilities.get("ios.voiceForegroundCapture"),
            Some(&false)
        );
        assert_eq!(manifest.capabilities.get("ios.notifications"), Some(&false));
        assert_eq!(
            manifest.capabilities.get("ios.backgroundVoice"),
            Some(&false)
        );
        assert_eq!(
            manifest.capabilities.get("ios.appOwnedInvocation"),
            Some(&false)
        );
        assert!(manifest
            .mobile_integrations
            .iter()
            .any(|integration| integration.id == "appIntents"
                && integration.support == "planned"
                && integration.label.contains("Siri/Shortcuts/App Intents")));
        assert!(manifest
            .mobile_integrations
            .iter()
            .any(|integration| integration.id == "shortcuts"
                && integration.support == "supported-path"));
        assert!(manifest.mobile_integrations.iter().any(|integration| {
            integration.id == "shareExtension"
                && integration.capability == "ios.shareExtension"
                && integration.support == "planned"
                && integration
                    .user_copy
                    .contains("unavailable until Aurora verifies")
        }));
        assert!(manifest.mobile_integrations.iter().any(|integration| {
            integration.id == "deepLinks" && integration.capability == "ios.deepLinks"
        }));
        assert!(manifest.mobile_integrations.iter().any(|integration| {
            integration.id == "widgets"
                && integration.capability == "ios.widgets"
                && integration.support == "planned"
        }));
        assert!(manifest.mobile_integrations.iter().any(|integration| {
            integration.id == "fileAssociations"
                && integration.capability == "ios.fileAssociations"
                && integration.support == "planned"
        }));
        assert_eq!(
            manifest.capabilities.get("ios.siriReplacement"),
            Some(&false)
        );
        assert!(!manifest.ios_invocation.siri_replacement);
        assert!(manifest.ios_invocation.backend_handoff_required);
        assert!(manifest
            .entrypoints
            .iter()
            .any(|entrypoint| entrypoint.id == "ios_share_extension"
                && entrypoint.backend_required
                && entrypoint.payload_command == "iosEntrypointPayload"));
        assert!(manifest
            .entrypoints
            .iter()
            .any(|entrypoint| entrypoint.id == "ios_file_association"
                && entrypoint.file_extensions.contains(&"aurora".to_string())));
        assert_eq!(manifest.last_entrypoint_payload.invocation, "none");
        assert!(manifest.last_entrypoint_payload.secrets_redacted);
        assert!(manifest
            .mobile_integrations
            .iter()
            .any(|integration| integration.id == "siriReplacement"
                && integration.support == "unsupported"
                && integration.user_copy.contains("does not allow")));
        assert!(manifest
            .platform_limitations
            .iter()
            .any(|limitation| limitation.id == "noSiriReplacement"
                && limitation.user_copy.contains("do not claim")));
        assert_eq!(
            manifest.capabilities.get("android.assistantRoleProbe"),
            Some(&false)
        );
    }

    #[test]
    fn android_baseline_status_never_claims_assistant_role_without_probe() {
        let status = android_baseline_status();
        assert!(!status.assistant_role.probe_implemented);
        assert_eq!(status.assistant_role.role_available, None);
        assert_eq!(status.assistant_role.package_qualified, None);
        assert_eq!(status.assistant_role.role_held, None);
        assert_eq!(status.assistant_role.requestable, None);
        assert!(status.secrets_redacted);
        assert_eq!(
            status.fallback_entrypoints.get("shareIntentPlanned"),
            Some(&false)
        );
    }

    #[test]
    fn ios_statuses_preserve_apple_platform_limits() {
        let voice = ios_voice_status().unwrap();
        assert!(!voice.available);
        assert_eq!(voice.permission, "aurora.iosMicrophoneCapture");
        assert_eq!(voice.capability, "ios.voiceForegroundCapture");
        assert_eq!(voice.details.get("privacyClass"), Some(&json!("raw-audio")));
        assert_eq!(voice.details.get("foregroundOnly"), Some(&json!(false)));
        assert_eq!(
            voice.details.get("supportsBackgroundListening"),
            Some(&json!(true))
        );
        assert_eq!(
            voice.details.get("supportsUserStartedBackgroundSession"),
            Some(&json!(true))
        );
        assert_eq!(voice.details.get("alwaysOnWake"), Some(&json!(false)));
        assert_eq!(
            voice.details.get("supportsSiriReplacement"),
            Some(&json!(false))
        );

        let background = ios_background_status().unwrap();
        assert!(!background.available);
        assert_eq!(background.permission, "aurora.iosBackgroundAudio");
        assert_eq!(background.capability, "ios.backgroundVoice");
        assert_eq!(
            background
                .details
                .get("supportsUserStartedBackgroundSession"),
            Some(&json!(true))
        );
        assert_eq!(background.details.get("alwaysOnWake"), Some(&json!(false)));
        assert_eq!(
            background.details.get("supportsSiriReplacement"),
            Some(&json!(false))
        );
        assert!(background
            .reason
            .as_ref()
            .is_some_and(|reason| reason.contains("requires the iOS app shell")));
    }

    #[test]
    fn native_permission_status_lists_denied_sensitive_surfaces() {
        let manifest = native_capability_manifest();
        let denied: Vec<String> = manifest
            .permissions
            .iter()
            .filter_map(|(key, allowed)| if *allowed { None } else { Some(key.clone()) })
            .collect();
        assert!(denied.contains(&"aurora.notificationsSend".to_string()));
        assert!(denied.contains(&"aurora.dialogOpen".to_string()));
        assert!(denied.contains(&"aurora.audioCapture".to_string()));
        assert!(denied.contains(&"aurora.localFileRead".to_string()));
        if !cfg!(target_os = "ios") {
            assert!(denied.contains(&"aurora.iosKeychain".to_string()));
            assert!(denied.contains(&"aurora.iosBiometricUnlock".to_string()));
        }
        if !cfg!(desktop) {
            assert!(denied.contains(&"aurora.sidecarSession".to_string()));
            assert!(denied.contains(&"aurora.sidecarStart".to_string()));
            assert!(denied.contains(&"aurora.sidecarStop".to_string()));
            assert!(denied.contains(&"aurora.shutdown".to_string()));
        }
    }

    #[test]
    fn ios_native_details_are_redacted_and_do_not_claim_siri_replacement() {
        let details = ios_native_details();
        assert_eq!(details.get("secretsRedacted"), Some(&json!(true)));
        assert_eq!(details.get("privacyClass"), Some(&json!("credential")));
        assert_eq!(details.get("siriReplacement"), Some(&json!(false)));
        assert_eq!(
            details.get("integrationCopy"),
            Some(&json!("Siri/Shortcuts/App Intents integration"))
        );
    }

    #[test]
    fn log_serialization_redacts_tokens_secrets_and_raw_audio_payloads() {
        let payload = json!({
            "authorization": "Bearer auth-secret",
            "nested": {
                "sessionToken": "session-secret",
                "api_key": "api-secret",
                "rawAudio": "base64-audio-samples",
                "audioBytes": [1, 2, 3, 4],
                "privacyClass": "raw-audio"
            },
            "message": "Authorization: Bearer inline-secret token=inline-token raw_audio=pcm-secret"
        });

        let serialized = serialize_redacted_value(&payload);

        for forbidden in [
            "auth-secret",
            "session-secret",
            "api-secret",
            "base64-audio-samples",
            "inline-secret",
            "inline-token",
            "pcm-secret",
        ] {
            assert!(!serialized.contains(forbidden), "{forbidden}");
        }
        assert!(serialized.contains("[redacted]"));
        assert!(serialized.contains("raw-audio"));
    }

    #[test]
    fn log_serialization_preserves_typed_redaction_and_capability_metadata() {
        let payload = json!({
            "secretsRedacted": true,
            "capabilities": {
                "android.secureCredentialStorage": true
            },
            "capabilityStates": {
                "android.secureCredentialStorage": "available"
            },
            "credential": {
                "tokenId": "token-id",
                "rawBearerToken": "gateway-token"
            }
        });

        let redacted = redact_sensitive_value(&payload);

        assert_eq!(redacted["secretsRedacted"], json!(true));
        assert_eq!(
            redacted["capabilities"]["android.secureCredentialStorage"],
            json!(true)
        );
        assert_eq!(
            redacted["capabilityStates"]["android.secureCredentialStorage"],
            json!("available")
        );
        assert_eq!(redacted["credential"], json!("[redacted]"));
        assert!(!redacted.to_string().contains("gateway-token"));
    }

    #[test]
    fn log_serialization_does_not_allow_arbitrary_credential_metadata_values() {
        let payload = json!({
            "android.secureCredentialStorage": "raw-credential",
            "secretsRedacted": "not-a-boolean"
        });

        let redacted = redact_sensitive_value(&payload);

        assert_eq!(
            redacted["android.secureCredentialStorage"],
            json!("[redacted]")
        );
        assert_eq!(redacted["secretsRedacted"], json!("[redacted]"));
    }

    #[test]
    fn freeform_sidecar_log_redaction_removes_secret_like_fields() {
        let line = "started Authorization: Bearer gateway-token token=sidecar-token secret=mesh-secret audio_bytes=pcm-secret ok";
        let redacted = redact_sensitive_text(line);

        for forbidden in [
            "gateway-token",
            "sidecar-token",
            "mesh-secret",
            "pcm-secret",
        ] {
            assert!(!redacted.contains(forbidden), "{forbidden}");
        }
        assert!(redacted.contains("[redacted]"));
        assert!(redacted.ends_with(" ok"));
    }

    #[test]
    fn command_error_serialization_redacts_gateway_payloads() {
        let error = AuroraCommandError::Gateway(
            "HTTP 500: {\"token\":\"gateway-token\",\"rawAudio\":\"pcm-secret\"}".to_string(),
        );
        let serialized = serde_json::to_string(&error).unwrap();

        assert!(!serialized.contains("gateway-token"));
        assert!(!serialized.contains("pcm-secret"));
        assert!(serialized.contains("[redacted]"));
        assert!(serialized.contains("secrets_redacted"));
    }

    #[test]
    fn log_tail_result_reports_redaction_boundary() {
        let result = LogTailResult {
            available: false,
            source: "aurora-sidecar".to_string(),
            lines: Vec::new(),
            truncated: false,
            reason: Some("deferred".to_string()),
            max_lines: 100,
            secrets_redacted: true,
            redacted_fields: sensitive_log_redacted_fields(),
        };

        assert!(result.secrets_redacted);
        assert!(result.redacted_fields.contains(&"token".to_string()));
        assert!(result.redacted_fields.contains(&"raw_audio".to_string()));
    }

    #[test]
    fn ios_native_plugin_surface_is_registered_and_permissioned() {
        let ios_capability = include_str!("../capabilities/aurora-ios-baseline.json");
        assert!(ios_capability.contains("\"aurora-ios-native-plugin\""));
        assert!(!ios_capability.contains("\"aurora-android-native-plugin\""));

        let ios_permission = include_str!("../permissions/aurora-ios-native-plugin.toml");
        assert!(ios_permission.contains("aurora_ios_native_plugin_manifest"));
        assert!(ios_permission.contains("aurora_ios_invocation_status"));
        assert!(ios_permission.contains("aurora_ios_local_light_inference_status"));
        assert!(ios_permission.contains("aurora_ios_entrypoint_payload"));
        assert!(ios_permission.contains("aurora_ios_invoke_action"));
        assert!(ios_permission.contains("aurora_ios_secure_storage_status"));
        assert!(ios_permission.contains("aurora_ios_voice_credential_set"));
        assert!(ios_permission.contains("aurora_ios_voice_credential_status"));
        assert!(ios_permission.contains("aurora_ios_voice_credential_delete"));
        assert!(ios_permission.contains("aurora_ios_biometric_status"));
        assert!(ios_permission.contains("aurora_ios_admin_unlock"));
        let ios_voice_permission = include_str!("../permissions/aurora-ios-voice.toml");
        assert!(ios_capability.contains("\"aurora-ios-voice\""));
        assert!(ios_voice_permission.contains("aurora_ios_voice_status"));
        assert!(ios_voice_permission.contains("aurora_ios_voice_foreground_capture_start"));
        let ios_background_voice_permission =
            include_str!("../permissions/aurora-ios-background-voice.toml");
        assert!(
            ios_background_voice_permission.contains("aurora_ios_voice_background_capture_start")
        );
        assert!(ios_voice_permission.contains("aurora_ios_voice_foreground_capture_stop"));
        assert!(ios_voice_permission.contains("aurora_ios_voice_foreground_capture_finish"));
        assert!(ios_voice_permission.contains("aurora_ios_voice_foreground_capture_status"));
        assert!(ios_voice_permission.contains("aurora_ios_background_status"));

        let swift_plugin = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift"
        );
        assert!(swift_plugin.contains("@_cdecl(\"init_plugin_aurora_native\")"));
        assert!(swift_plugin.contains("nativeCapabilityManifest"));
        assert!(swift_plugin.contains("invocationStatus"));
        assert!(swift_plugin.contains("localLightInferenceStatus"));
        assert!(swift_plugin.contains("voiceStatus"));
        assert!(swift_plugin.contains("voiceForegroundCaptureStart"));
        assert!(swift_plugin.contains("voiceBackgroundCaptureStart"));
        assert!(swift_plugin.contains("voiceForegroundCaptureStop"));
        assert!(swift_plugin.contains("voiceForegroundCaptureFinish"));
        assert!(swift_plugin.contains("voiceForegroundCaptureStatus"));
        assert!(swift_plugin.contains("voiceCredentialSet"));
        assert!(swift_plugin.contains("voiceCredentialStatus"));
        assert!(swift_plugin.contains("voiceCredentialDelete"));
        assert!(swift_plugin
            .contains("let transportReady = AuroraNativePlugin.nativeTurnTransportReady()"));
        assert!(swift_plugin.contains("\"nativeTurnTransportAvailable\": transportReady.available"));
        assert!(swift_plugin.contains("notificationStatus"));
        assert!(swift_plugin.contains("backgroundStatus"));
        assert!(swift_plugin.contains("iosEntrypointPayload"));
        assert!(swift_plugin.contains("invokeAuroraAction"));
        assert!(swift_plugin.contains("iosSecureStorageStatus"));
        assert!(swift_plugin.contains("iosBiometricStatus"));
        assert!(swift_plugin.contains("iosAdminUnlock"));
        assert!(swift_plugin.contains("\"ios.shareExtension\": false"));
        assert!(swift_plugin.contains("\"ios.deepLinks\": true"));
        assert!(swift_plugin.contains("\"ios.widgets\": false"));
        assert!(swift_plugin.contains("\"ios.fileAssociations\": false"));
        assert!(swift_plugin.contains("\"ios.shareExtension\": \"pending_native_target\""));
        assert!(swift_plugin.contains("\"ios.widgets\": \"pending_native_target\""));
        assert!(swift_plugin.contains("\"ios.fileAssociations\": \"pending_native_target\""));
        assert!(swift_plugin.contains("\"ios.localLightInference.provider\": true"));
        assert!(swift_plugin.contains("\"ios.localLightInference.modelRuntime\": false"));
        assert!(swift_plugin.contains("\"ios.keychain.secureCredentialStorage\": true"));
        assert!(swift_plugin.contains("\"ios.biometric.adminUnlock\": true"));
        assert!(swift_plugin.contains("\"ios.voiceForegroundCapture\": true"));
        assert!(swift_plugin.contains("\"ios.backgroundVoice\": true"));
        assert!(!swift_plugin.contains("\"ios.backgroundVoice\": \"unsupported_platform\""));
        assert!(swift_plugin.contains("\"supportsUserStartedBackgroundSession\": true"));
        assert!(swift_plugin.contains("\"requiresExplicitStartInApp\": true"));
        assert!(swift_plugin.contains("\"alwaysOnWake\": false"));
        assert!(swift_plugin.contains("\"wakeAfterForceTermination\": false"));
        assert!(swift_plugin.contains("\"aurora.iosSiriReplacement\": false"));

        let ios_info_plist = include_str!("../Info.ios.plist");
        assert!(ios_info_plist.contains("<key>UIBackgroundModes</key>"));
        assert!(ios_info_plist.contains("<string>audio</string>"));
        assert!(ios_info_plist.contains("start listening in the app"));

        let swift_capture = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraIOSVoiceCapture.swift"
        );
        assert!(swift_capture.contains("AVAudioEngine"));
        assert!(swift_capture.contains("installTap(onBus: 0"));
        assert!(swift_capture.contains("aurora_ios_audio_state_push_pcm_f32"));
        assert!(swift_capture.contains("aurora_ios_audio_state_reset"));
        assert!(swift_capture.contains("setActive(false"));
        let swift_session = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraIOSVoiceSessionHost.swift"
        );
        assert!(swift_session.contains("AuroraIOSVoiceSessionHost"));
        assert!(swift_session.contains("aurora_ios_voice_session_start"));
        assert!(swift_session.contains("aurora_ios_voice_session_cancel"));
        assert!(swift_session.contains("capture = nil"));
        let swift_playback = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraIOSVoicePlayback.swift"
        );
        assert!(swift_playback.contains("aurora_ios_audio_output_drain"));
        assert!(swift_playback.contains("aurora_ios_audio_output_acknowledge"));
        assert!(swift_playback.contains("chunkInFlight"));
        let rust_source = include_str!("lib.rs");
        assert!(rust_source.contains("AURORA_IOS_VOICE_BRIDGE_LINK_ANCHOR"));

        let voice_header = include_str!(
            "../ios/AuroraNativePlugin/Sources/CAuroraIOSVoiceBridge/include/aurora_ios_voice_bridge.h"
        );
        assert!(voice_header.contains("aurora_ios_audio_state_push_pcm_f32"));
        assert!(voice_header.contains("AuroraIosAudioStats"));
        assert!(voice_header.contains("aurora_ios_audio_output_drain"));
        assert!(voice_header.contains("aurora_ios_audio_output_acknowledge"));
        assert!(voice_header.contains("AURORA_IOS_AUDIO_EMPTY"));
        assert!(voice_header.contains("aurora_ios_voice_session_new"));
        assert!(voice_header.contains("aurora_ios_voice_session_start_background"));
        assert!(voice_header.contains("aurora_ios_voice_session_status"));
        assert!(voice_header.contains("AuroraIosVoiceSessionStatus"));
        let ios_voice_source = include_str!("ios_voice.rs");
        assert!(ios_voice_source.contains("aurora_ios_voice_session_new"));
        assert!(ios_voice_source.contains("remote_audio_consent"));
        assert!(ios_voice_source.contains("AURORA_IOS_VOICE_OK"));

        let swift_entrypoints = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraEntrypointPayloads.swift"
        );
        assert!(swift_entrypoints.contains("ios_share_extension"));
        assert!(swift_entrypoints.contains("ios_deep_link"));
        assert!(swift_entrypoints.contains("ios_widget"));
        assert!(swift_entrypoints.contains("ios_file_association"));
        assert!(swift_entrypoints.contains("backendHandoffRequired"));
        assert!(swift_entrypoints.contains("secretsRedacted"));
        assert!(swift_entrypoints.contains("siriReplacement: false"));

        let swift_package = include_str!("../ios/AuroraNativePlugin/Package.swift");
        assert!(swift_package.contains("../../.tauri/tauri-api"));
        assert!(swift_package.contains("type: .static"));

        let build_script = include_str!("../build.rs");
        assert!(build_script.contains("DEP_TAURI_IOS_LIBRARY_PATH"));
        assert!(build_script.contains("Path::new(\".tauri\").join(\"tauri-api\")"));
        assert!(build_script.contains("std::env::remove_var(\"SDKROOT\")"));
        assert!(build_script.contains("SwiftLinker::new"));
        assert!(build_script.contains(".with_package(\"AuroraNativePlugin\""));
        assert!(build_script.contains("emit_ios_swift_package_link_search_hints"));
        assert!(build_script.contains("apple-ios-simulator"));
    }

    #[test]
    fn ios_local_light_status_is_requestable_for_installed_active_voice_packs() {
        let status = json!({
            "available": false,
            "activeSlots": {
                "vad": "ios-vad",
                "kws": "ios-kws",
                "stt": "ios-stt",
                "tts": "ios-tts"
            },
            "count": 4,
            "packs": [
                {"packId": "ios-vad", "task": "vad", "installed": true, "acknowledged": true},
                {"packId": "ios-kws", "task": "kws", "installed": true, "acknowledged": true},
                {"packId": "ios-stt", "task": "stt", "installed": true, "acknowledged": true},
                {"packId": "ios-tts", "task": "tts", "installed": true, "acknowledged": true}
            ],
            "secretsRedacted": true
        });
        let derived = ios_local_light_inference_status_from_voice_packs(true, Some(&status));

        assert!(derived.available);
        assert!(derived.requestable);
        assert!(derived.model_runtime_provider);
        assert!(derived.model_present);
        assert_eq!(derived.model_id.as_deref(), Some("ios-stt"));
        assert_eq!(derived.state, "available");
    }

    #[test]
    fn ios_local_light_status_exposes_catalog_without_claiming_runtime_readiness() {
        let status = json!({
            "available": false,
            "activeSlots": {},
            "count": 558,
            "packs": [
                {"packId": "ios-vad", "task": "vad", "installed": false, "acknowledged": true}
            ],
            "secretsRedacted": true
        });
        let derived = ios_local_light_inference_status_from_voice_packs(true, Some(&status));

        assert!(derived.available);
        assert!(!derived.requestable);
        assert!(!derived.model_runtime_provider);
        assert!(!derived.model_present);
        assert_eq!(derived.model_id, None);
        assert_eq!(derived.state, "needs_model");
    }

    #[test]
    fn assistant_provider_validation_requires_https_or_loopback_and_redacts_status() {
        let config = validate_assistant_provider_config(AssistantProviderConfigureRequest {
            provider: Some(ASSISTANT_PROVIDER_KIND.to_string()),
            endpoint: Some("https://llm.example/v1/chat/completions".to_string()),
            model: Some("model-a".to_string()),
            api_key: Some("sk-secret-value".to_string()),
            enabled: None,
            clear: None,
        })
        .unwrap();
        assert_eq!(config.provider, ASSISTANT_PROVIDER_KIND);

        let status = assistant_provider_status(Some(&config));
        assert!(status.configured);
        assert!(status.enabled);
        assert!(status.secrets_redacted);
        assert_eq!(status.redacted_fields, vec!["apiKey".to_string()]);
        assert_eq!(
            status.endpoint.as_deref(),
            Some("https://llm.example/v1/chat/completions")
        );

        assert!(
            validate_assistant_provider_endpoint("http://127.0.0.1:11434/v1/chat/completions")
                .is_ok()
        );
        assert!(
            validate_assistant_provider_endpoint("http://llm.example/v1/chat/completions").is_err()
        );
        for endpoint in [
            "https://user@llm.example/v1/chat/completions",
            "https://user:password@llm.example/v1/chat/completions",
            "https://llm.example/v1/chat/completions?api_key=secret",
            "https://llm.example/v1/chat/completions#token",
        ] {
            assert!(
                validate_assistant_provider_endpoint(endpoint).is_err(),
                "{endpoint}"
            );
        }
    }

    #[test]
    fn assistant_provider_http_bounds_are_configured_and_chunk_cap_is_incremental() {
        assert!(ASSISTANT_PROVIDER_CONNECT_TIMEOUT < ASSISTANT_PROVIDER_OVERALL_TIMEOUT);
        assert!(ASSISTANT_PROVIDER_READ_TIMEOUT < ASSISTANT_PROVIDER_OVERALL_TIMEOUT);
        assert_eq!(ASSISTANT_PROVIDER_RESPONSE_MAX_BYTES, 256 * 1024);
        assert!(assistant_provider_http_client().is_ok());

        let mut bytes = Vec::new();
        append_assistant_provider_response_chunk(&mut bytes, &[b'a'; 8], 10).unwrap();
        assert_eq!(bytes.len(), 8);
        assert!(append_assistant_provider_response_chunk(&mut bytes, &[b'b'; 3], 10,).is_err());
        assert_eq!(bytes.len(), 8);
    }

    #[test]
    fn assistant_provider_openai_aliases_match_sdk_shape() {
        assert_eq!(
            openai_tool_alias("global:native.get_device_status").unwrap(),
            "global_native_get_device_status_75d27037"
        );
        let tools = vec![AssistantProviderTool {
            global_tool_id: "global:native.get_device_status".to_string(),
            description: "Get status".to_string(),
            args_schema: json!({"type": "object", "additionalProperties": false}),
            execution_location: "local".to_string(),
        }];
        let aliases = assistant_tool_aliases(&tools).unwrap();
        let body = assistant_provider_openai_body(
            &AssistantProviderStoredConfig {
                provider: ASSISTANT_PROVIDER_KIND.to_string(),
                endpoint: "https://llm.example/v1/chat/completions".to_string(),
                model: "model-a".to_string(),
                api_key: "sk-secret".to_string(),
                enabled: true,
                updated_at_ms: 1,
            },
            &AssistantProviderCompleteRequest {
                messages: vec![AssistantProviderMessage {
                    role: "user".to_string(),
                    content: "status".to_string(),
                    tool_call_id: None,
                    name: None,
                }],
                tools,
                max_tool_calls: Some(4),
            },
            &aliases,
        )
        .unwrap();
        assert_eq!(
            body["tools"][0]["function"]["name"],
            json!("global_native_get_device_status_75d27037")
        );
        assert!(!body.to_string().contains("sk-secret"));
    }

    #[test]
    fn assistant_provider_response_normalizes_tool_calls_without_secrets() {
        let tools = vec![AssistantProviderTool {
            global_tool_id: "global:native.get_device_status".to_string(),
            description: "Get status".to_string(),
            args_schema: json!({"type": "object", "additionalProperties": false}),
            execution_location: "local".to_string(),
        }];
        let aliases = assistant_tool_aliases(&tools).unwrap();
        let raw = json!({
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                            "id": "call-1",
                        "function": {
                            "name": "global_native_get_device_status_75d27037",
                            "arguments": "{}"
                        }
                    }]
                }
            }]
        });

        let parsed = parse_assistant_provider_response(&raw, &aliases).unwrap();
        match parsed {
            AssistantProviderCompleteResponse::ToolCalls { tool_calls, .. } => {
                assert_eq!(tool_calls[0].tool_name, "global:native.get_device_status");
                assert_eq!(
                    tool_calls[0].provider_tool_name,
                    "global_native_get_device_status_75d27037"
                );
                assert_eq!(tool_calls[0].route, "local");
            }
            AssistantProviderCompleteResponse::Message { .. } => panic!("expected tool calls"),
        }
    }

    #[test]
    fn thin_peer_credential_keys_are_hashed_under_secure_namespace() {
        let key = thin_peer_credential_key("peer/with:flexible id").unwrap();
        assert!(key.starts_with("aurora.mesh.peer-proof."));
        assert_eq!(key.len(), "aurora.mesh.peer-proof.".len() + 64);
        assert!(is_peer_proof_storage_key(&key));
        assert!(!is_peer_proof_storage_key("aurora.mesh.peer-proof.invalid"));
        assert!(validate_secure_storage_key(&key).is_err());
        #[cfg(desktop)]
        assert!(matches!(
            peer_credential_storage_entry("aurora.mesh.peer-proof.invalid"),
            Err(AuroraCommandError::SecureStorageKeyInvalid(_))
        ));
        assert!(thin_peer_credential_key("").is_err());
    }

    #[derive(Default)]
    struct MemoryInboundVerifierStorageBackend {
        records: Mutex<HashMap<String, String>>,
        fail: Mutex<Option<String>>,
    }

    impl InboundVerifierStorageBackend for MemoryInboundVerifierStorageBackend {
        fn get_secret(&self, account: &str) -> Result<Option<String>, AuroraCommandError> {
            if let Some(message) = self.fail.lock().unwrap().clone() {
                return Err(AuroraCommandError::SecureStorage(message));
            }
            Ok(self.records.lock().unwrap().get(account).cloned())
        }

        fn set_secret(&self, account: &str, value: &str) -> Result<(), AuroraCommandError> {
            if let Some(message) = self.fail.lock().unwrap().clone() {
                return Err(AuroraCommandError::SecureStorage(message));
            }
            self.records
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }

        fn delete_secret(&self, account: &str) -> Result<(), AuroraCommandError> {
            if let Some(message) = self.fail.lock().unwrap().clone() {
                return Err(AuroraCommandError::SecureStorage(message));
            }
            self.records.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn inbound_verifier_key_fixture() -> String {
        "aurora.peer-host.inbound-verifier.v1:desktop-peer:claimant-peer:mesh-room:token-1"
            .to_string()
    }

    fn inbound_verifier_record_fixture() -> InboundVerifierSecretRecord {
        InboundVerifierSecretRecord {
            version: 1,
            token_id: "token-1".to_string(),
            claimant_peer_id: "claimant-peer".to_string(),
            verifier_peer_id: "desktop-peer".to_string(),
            room_name: "mesh-room".to_string(),
            token_hash_hex: "a".repeat(64),
            created_at_ms: 1,
            expires_at_ms: None,
            revoked_at_ms: None,
            credential_revision: 1,
        }
    }

    fn inbound_verifier_value_fixture() -> String {
        canonical_inbound_verifier_secret_value(&inbound_verifier_record_fixture()).unwrap()
    }

    #[test]
    fn inbound_verifier_keys_accept_only_exact_sdk_namespace_and_hash_accounts() {
        let key = inbound_verifier_key_fixture();
        assert!(validate_inbound_verifier_secret_key(&key).is_ok());
        let account = inbound_verifier_storage_account(&key).unwrap();
        assert!(account.starts_with("aurora.mesh.inbound-verifier."));
        assert_eq!(account.len(), "aurora.mesh.inbound-verifier.".len() + 64);
        assert!(!account.contains("desktop-peer"));
        assert!(!account.contains("claimant-peer"));
        assert!(validate_inbound_verifier_storage_account(&account).is_ok());
        assert!(validate_secure_storage_key(&account).is_err());
        assert!(validate_secure_storage_key(&key).is_err());

        let encoded = "aurora.peer-host.inbound-verifier.v1:peer%2Ewith%2Edot:claimant%2Fpeer:room%20one:token%40one";
        assert!(validate_inbound_verifier_secret_key(encoded).is_ok());
        for invalid in [
            "",
            "aurora.mesh.inbound-verifier.v1:desktop-peer:claimant-peer:mesh-room:token-1",
            "aurora.peer-host.inbound-verifier.v1:desktop-peer:claimant-peer:mesh-room",
            "aurora.peer-host.inbound-verifier.v1:desktop.peer:claimant-peer:mesh-room:token-1",
            "aurora.peer-host.inbound-verifier.v1:desktop%2epeer:claimant-peer:mesh-room:token-1",
            "aurora.peer-host.inbound-verifier.v1:desktop%ZZpeer:claimant-peer:mesh-room:token-1",
        ] {
            assert!(
                validate_inbound_verifier_secret_key(invalid).is_err(),
                "{invalid}"
            );
        }
        assert!(validate_inbound_verifier_secret_key(&format!(
            "aurora.peer-host.inbound-verifier.v1:{}:claimant-peer:mesh-room:token-1",
            "a".repeat(257)
        ))
        .is_err());
    }

    #[test]
    fn inbound_verifier_values_reject_oversize_and_raw_credential_shapes() {
        let valid = inbound_verifier_value_fixture();
        assert!(validate_inbound_verifier_secret_value(&valid).is_ok());

        let not_hex = canonical_inbound_verifier_secret_value(&InboundVerifierSecretRecord {
            token_hash_hex: "not-hex".to_string(),
            ..inbound_verifier_record_fixture()
        })
        .unwrap();
        let raw_bearer = json!({
                "version": 1,
                "tokenId": "token-1",
                "claimantPeerId": "claimant-peer",
                "verifierPeerId": "desktop-peer",
                "roomName": "mesh-room",
                "tokenHashHex": "a".repeat(64),
                "createdAtMs": 1,
                "credentialRevision": 1,
                "rawBearerToken": "synthetic-reconnect-token"
        })
        .to_string();
        let proof_hex = json!({
                "version": 1,
                "tokenId": "token-1",
                "claimantPeerId": "claimant-peer",
                "verifierPeerId": "desktop-peer",
                "roomName": "mesh-room",
                "tokenHashHex": "a".repeat(64),
                "createdAtMs": 1,
                "credentialRevision": 1,
                "proofHex": "b".repeat(64)
        })
        .to_string();
        for invalid in [
            "",
            "not-json",
            "{\"version\":2}",
            not_hex.as_str(),
            raw_bearer.as_str(),
            proof_hex.as_str(),
        ] {
            assert!(validate_inbound_verifier_secret_value(invalid).is_err());
        }
        assert!(validate_inbound_verifier_secret_value(&"x".repeat(8193)).is_err());
    }

    #[test]
    fn inbound_verifier_storage_rejects_selector_mismatch_before_write() {
        for (field, record) in [
            (
                "tokenId",
                InboundVerifierSecretRecord {
                    token_id: "token-other".to_string(),
                    ..inbound_verifier_record_fixture()
                },
            ),
            (
                "claimantPeerId",
                InboundVerifierSecretRecord {
                    claimant_peer_id: "claimant-other".to_string(),
                    ..inbound_verifier_record_fixture()
                },
            ),
            (
                "verifierPeerId",
                InboundVerifierSecretRecord {
                    verifier_peer_id: "desktop-other".to_string(),
                    ..inbound_verifier_record_fixture()
                },
            ),
            (
                "roomName",
                InboundVerifierSecretRecord {
                    room_name: "room-other".to_string(),
                    ..inbound_verifier_record_fixture()
                },
            ),
        ] {
            let backend = MemoryInboundVerifierStorageBackend::default();
            let key = inbound_verifier_key_fixture();
            let value = canonical_inbound_verifier_secret_value(&record).unwrap();
            assert!(
                inbound_verifier_storage_set(&backend, &key, &value).is_err(),
                "{field}"
            );
            assert!(backend.records.lock().unwrap().is_empty(), "{field}");
        }
    }

    #[test]
    fn inbound_verifier_values_require_lowercase_token_hash_and_sdk_json_shape() {
        let uppercase_hash =
            canonical_inbound_verifier_secret_value(&InboundVerifierSecretRecord {
                token_hash_hex: "A".repeat(64),
                ..inbound_verifier_record_fixture()
            })
            .unwrap();
        assert!(validate_inbound_verifier_secret_value(&uppercase_hash).is_err());

        let noncanonical = json!({
            "credentialRevision": 1,
            "createdAtMs": 1,
            "tokenHashHex": "a".repeat(64),
            "roomName": "mesh-room",
            "verifierPeerId": "desktop-peer",
            "claimantPeerId": "claimant-peer",
            "tokenId": "token-1",
            "version": 1
        })
        .to_string();
        assert!(validate_inbound_verifier_secret_value(&noncanonical).is_err());
        assert!(inbound_verifier_storage_set(
            &MemoryInboundVerifierStorageBackend::default(),
            &inbound_verifier_key_fixture(),
            &noncanonical
        )
        .is_err());
    }

    #[test]
    fn inbound_verifier_storage_roundtrip_uses_testable_seam_and_idempotent_delete() {
        let backend = MemoryInboundVerifierStorageBackend::default();
        let key = inbound_verifier_key_fixture();
        let value = inbound_verifier_value_fixture();
        let account = inbound_verifier_storage_account(&key).unwrap();

        assert!(inbound_verifier_storage_get(&backend, &key)
            .unwrap()
            .is_none());
        inbound_verifier_storage_set(&backend, &key, &value).unwrap();
        assert_eq!(
            inbound_verifier_storage_get(&backend, &key).unwrap(),
            Some(value.clone())
        );
        assert!(backend.records.lock().unwrap().contains_key(&account));
        inbound_verifier_storage_delete(&backend, &key).unwrap();
        inbound_verifier_storage_delete(&backend, &key).unwrap();
        assert!(inbound_verifier_storage_get(&backend, &key)
            .unwrap()
            .is_none());
    }

    #[test]
    fn inbound_verifier_storage_propagates_backend_failures_without_secret_diagnostics() {
        let backend = MemoryInboundVerifierStorageBackend::default();
        *backend.fail.lock().unwrap() = Some("backend_unavailable".to_string());
        let err = inbound_verifier_storage_set(
            &backend,
            &inbound_verifier_key_fixture(),
            &inbound_verifier_value_fixture(),
        )
        .unwrap_err();
        let serialized = serde_json::to_string(&err).unwrap();
        assert!(serialized.contains("backend_unavailable"));
        assert!(serialized.contains("secrets_redacted"));
        assert!(!serialized.contains("synthetic-reconnect-token"));

        let response = inbound_verifier_write_response(true);
        let response_text = serde_json::to_string(&response).unwrap();
        assert!(response_text.contains("tokenHashHex"));
        assert!(response_text.contains("secretsRedacted"));
        assert!(!response_text.contains(&"a".repeat(64)));
    }

    #[test]
    fn thin_peer_credential_status_response_redacts_raw_bearer_token() {
        let record = ThinPeerCredentialRecord {
            token_id: "token-fixture-001".to_string(),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "lab-room".to_string(),
            raw_bearer_token: "synthetic-reconnect-token".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: Some(2),
        };
        let response = thin_peer_credential_status_response(
            "stable-answer".to_string(),
            Some(thin_peer_credential_metadata("stable-answer", &record)),
            true,
        );
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(!serialized.contains("synthetic-reconnect-token"));
        assert!(serialized.contains("secretsRedacted"));
        assert!(serialized.contains("rawBearerToken"));
    }

    #[test]
    fn reconnect_proof_matches_shared_protocol_fixture_without_revealing_token() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/webrtc_web_thin_protocol_vectors.json"
        ))
        .unwrap();
        let reconnect = &fixture["reconnect"];
        let inputs = &reconnect["inputs"];
        let record = ThinPeerCredentialRecord {
            token_id: inputs["token_id"].as_str().unwrap().to_string(),
            claimant_peer_id: inputs["claimant_peer_id"].as_str().unwrap().to_string(),
            verifier_peer_id: inputs["verifier_peer_id"].as_str().unwrap().to_string(),
            claimant_signaling_peer_id: inputs["claimant_signaling_peer_id"]
                .as_str()
                .unwrap()
                .to_string(),
            verifier_signaling_peer_id: inputs["verifier_signaling_peer_id"]
                .as_str()
                .unwrap()
                .to_string(),
            room_name: inputs["room_name"].as_str().unwrap().to_string(),
            raw_bearer_token: "synthetic-reconnect-token".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: Some(2),
        };
        let challenge = MeshReconnectChallengeFrame {
            r#type: "mesh_auth_challenge_v1".to_string(),
            challenge: inputs["challenge"].as_str().unwrap().to_string(),
            channel_binding: inputs["channel_binding"].as_str().unwrap().to_string(),
            claimant_peer_id: inputs["claimant_peer_id"].as_str().unwrap().to_string(),
            verifier_peer_id: inputs["verifier_peer_id"].as_str().unwrap().to_string(),
            claimant_signaling_peer_id: inputs["claimant_signaling_peer_id"]
                .as_str()
                .unwrap()
                .to_string(),
            verifier_signaling_peer_id: inputs["verifier_signaling_peer_id"]
                .as_str()
                .unwrap()
                .to_string(),
            room_name: inputs["room_name"].as_str().unwrap().to_string(),
        };

        let message = build_mesh_reconnect_proof_message(&record, &challenge).unwrap();
        let message_text = String::from_utf8_lossy(&message);
        assert!(message.starts_with(b"aurora.mesh.reconnect-proof.v1\0"));
        assert!(!message_text.contains("claimant_signaling_peer_id"));
        assert!(!message_text.contains("verifier_signaling_peer_id"));
        assert_eq!(
            hex_encode(&message),
            reconnect["message_hex"].as_str().unwrap()
        );
        let proof =
            compute_reconnect_proof_hex(&record.raw_bearer_token, &record, &challenge).unwrap();
        assert_eq!(proof, reconnect["hmac_sha256_hex"].as_str().unwrap());
        let proof_frame = MeshReconnectProofFrame {
            r#type: "mesh_auth_proof_v1".to_string(),
            token_id: record.token_id.clone(),
            challenge: challenge.challenge.clone(),
            proof,
            channel_binding: challenge.channel_binding.clone(),
            claimant_peer_id: challenge.claimant_peer_id.clone(),
            verifier_peer_id: challenge.verifier_peer_id.clone(),
            claimant_signaling_peer_id: challenge.claimant_signaling_peer_id.clone(),
            verifier_signaling_peer_id: challenge.verifier_signaling_peer_id.clone(),
            room_name: challenge.room_name.clone(),
        };
        let serialized = serde_json::to_value(&proof_frame).unwrap();
        assert_eq!(
            serialized["claimant_signaling_peer_id"],
            reconnect["challenge"]["frame"]["claimant_signaling_peer_id"]
        );
        assert_eq!(
            serialized["verifier_signaling_peer_id"],
            reconnect["challenge"]["frame"]["verifier_signaling_peer_id"]
        );
        assert!(!serde_json::to_string(&proof_frame)
            .unwrap()
            .contains("synthetic-reconnect-token"));
    }

    #[test]
    fn reconnect_proof_canonicalization_matches_python_for_unicode_context() {
        let record = ThinPeerCredentialRecord {
            token_id: "token-é".to_string(),
            claimant_peer_id: "peer-😀".to_string(),
            verifier_peer_id: "peer-β".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "café/</room".to_string(),
            raw_bearer_token: "tökén😀".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: None,
        };
        let challenge = MeshReconnectChallengeFrame {
            r#type: "mesh_auth_challenge_v1".to_string(),
            challenge: "a".repeat(64),
            channel_binding: "b".repeat(64),
            claimant_peer_id: record.claimant_peer_id.clone(),
            verifier_peer_id: record.verifier_peer_id.clone(),
            claimant_signaling_peer_id: "fresh-sig-answer".to_string(),
            verifier_signaling_peer_id: "fresh-sig-offer".to_string(),
            room_name: record.room_name.clone(),
        };

        let message = build_mesh_reconnect_proof_message(&record, &challenge).unwrap();
        assert_eq!(
            String::from_utf8(message).unwrap(),
            concat!(
                "aurora.mesh.reconnect-proof.v1\0",
                "{\"challenge\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",",
                "\"channel_binding\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",",
                "\"claimant_peer_id\":\"peer-\\ud83d\\ude00\",",
                "\"room_name\":\"caf\\u00e9/</room\",",
                "\"token_id\":\"token-\\u00e9\",",
                "\"verifier_peer_id\":\"peer-\\u03b2\",",
                "\"version\":1}"
            )
        );
        assert_eq!(
            compute_reconnect_proof_hex(&record.raw_bearer_token, &record, &challenge).unwrap(),
            "23192dbc7bc20cbecad7683032bc064b9cb6c4bca37a6ef2572a2f737c014f22"
        );
    }

    #[test]
    fn reconnect_proof_allows_rotated_signaling_ids_and_rejects_wrong_stable_context() {
        let record = ThinPeerCredentialRecord {
            token_id: "token-fixture-001".to_string(),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "old-sig-answer".to_string(),
            verifier_signaling_peer_id: "old-sig-offer".to_string(),
            room_name: "lab-room".to_string(),
            raw_bearer_token: "synthetic-reconnect-token".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: None,
        };
        let rotated = MeshReconnectChallengeFrame {
            r#type: "mesh_auth_challenge_v1".to_string(),
            challenge: "a".repeat(64),
            channel_binding: "b".repeat(64),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "new-sig-answer".to_string(),
            verifier_signaling_peer_id: "new-sig-offer".to_string(),
            room_name: "lab-room".to_string(),
        };
        assert!(reconnect_challenge_matches(&record, &rotated));
        let rotated_proof =
            compute_reconnect_proof_hex(&record.raw_bearer_token, &record, &rotated).unwrap();
        let rotated_message = String::from_utf8_lossy(
            &build_mesh_reconnect_proof_message(&record, &rotated).unwrap(),
        )
        .to_string();
        assert!(!rotated_message.contains("new-sig-answer"));
        assert!(!rotated_message.contains("new-sig-offer"));
        assert!(!rotated_message.contains("old-sig-answer"));
        assert!(!rotated_message.contains("old-sig-offer"));

        let proof_frame = MeshReconnectProofFrame {
            r#type: "mesh_auth_proof_v1".to_string(),
            token_id: record.token_id.clone(),
            challenge: rotated.challenge.clone(),
            proof: rotated_proof.clone(),
            channel_binding: rotated.channel_binding.clone(),
            claimant_peer_id: rotated.claimant_peer_id.clone(),
            verifier_peer_id: rotated.verifier_peer_id.clone(),
            claimant_signaling_peer_id: rotated.claimant_signaling_peer_id.clone(),
            verifier_signaling_peer_id: rotated.verifier_signaling_peer_id.clone(),
            room_name: rotated.room_name.clone(),
        };
        let proof_value = serde_json::to_value(&proof_frame).unwrap();
        assert_eq!(proof_value["claimant_signaling_peer_id"], "new-sig-answer");
        assert_eq!(proof_value["verifier_signaling_peer_id"], "new-sig-offer");

        let original_session = MeshReconnectChallengeFrame {
            claimant_signaling_peer_id: "old-sig-answer".to_string(),
            verifier_signaling_peer_id: "old-sig-offer".to_string(),
            ..rotated.clone()
        };
        assert_eq!(
            rotated_proof,
            compute_reconnect_proof_hex(&record.raw_bearer_token, &record, &original_session)
                .unwrap()
        );
        for tampered in [
            MeshReconnectChallengeFrame {
                claimant_peer_id: "wrong-stable-answer".to_string(),
                ..rotated.clone()
            },
            MeshReconnectChallengeFrame {
                verifier_peer_id: "wrong-stable-offer".to_string(),
                ..rotated.clone()
            },
            MeshReconnectChallengeFrame {
                room_name: "wrong-room".to_string(),
                ..rotated.clone()
            },
        ] {
            assert!(!reconnect_challenge_matches(&record, &tampered));
            assert_ne!(
                rotated_proof,
                compute_reconnect_proof_hex(&record.raw_bearer_token, &record, &tampered).unwrap()
            );
        }
        for tampered in [
            MeshReconnectChallengeFrame {
                challenge: "c".repeat(64),
                ..rotated.clone()
            },
            MeshReconnectChallengeFrame {
                channel_binding: "d".repeat(64),
                ..rotated.clone()
            },
        ] {
            assert!(reconnect_challenge_matches(&record, &tampered));
            assert_ne!(
                rotated_proof,
                compute_reconnect_proof_hex(&record.raw_bearer_token, &record, &tampered).unwrap()
            );
        }
        let revoked =
            thin_peer_reconnect_proof_response("stable-answer".to_string(), None, false, None);
        assert!(!revoked.found);
        assert!(!revoked.matched);
        assert!(revoked.proof.is_none());
    }

    #[test]
    fn remote_gateway_requires_explicit_https_origin_allowlist() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_remote_env();
        env::set_var("AURORA_TAURI_ALLOW_REMOTE_GATEWAY", "1");
        env::set_var(
            "AURORA_TAURI_ALLOWED_REMOTE_ORIGINS",
            "https://hosted.example,wss://signal.example",
        );

        assert!(remote_gateway_allowed_for(
            &Url::parse("https://hosted.example/api").unwrap()
        ));
        assert!(!remote_gateway_allowed_for(
            &Url::parse("http://hosted.example/api").unwrap()
        ));
        assert!(!remote_gateway_allowed_for(
            &Url::parse("https://evil.example/api").unwrap()
        ));
        assert_eq!(
            canonical_remote_origin("https://hosted.example/path").unwrap(),
            "https://hosted.example"
        );
        assert!(canonical_remote_origin("https://*.example").is_err());
        clear_remote_env();
    }

    #[test]
    fn remote_gateway_env_is_dev_bootstrap_only() {
        let _guard = ENV_LOCK.lock().unwrap();
        clear_remote_env();
        env::set_var(
            "AURORA_TAURI_REMOTE_GATEWAY_URL",
            "https://hosted.example/api",
        );

        assert!(dev_remote_gateway_bootstrap_url().is_none());

        env::set_var("AURORA_TAURI_DEV_REMOTE_GATEWAY_BOOTSTRAP", "1");
        assert_eq!(
            dev_remote_gateway_bootstrap_url().as_deref(),
            Some("https://hosted.example/api")
        );
        clear_remote_env();
    }

    #[test]
    fn persisted_profile_owns_remote_gateway_selection() {
        let remote_console = json!({
            "version": 2,
            "activeProfileId": "remote",
            "profiles": [{
                "version": 2,
                "id": "remote",
                "label": "Home",
                "nodeMode": "remote-console",
                "runtimeTier": "none",
                "homeConnection": {
                    "mode": "http-only",
                    "gatewayUrl": "https://hosted.example/api",
                    "homePeerId": "peer-home"
                },
                "localNode": { "name": "Desk" }
            }]
        });
        let mesh_node = json!({
            "version": 2,
            "activeProfileId": "local",
            "profiles": [{
                "version": 2,
                "id": "local",
                "label": "This device",
                "nodeMode": "mesh-node",
                "runtimeTier": "python-full",
                "localNode": { "name": "Desk" }
            }]
        });
        let legacy = json!({
            "version": 1,
            "activeProfileId": "legacy",
            "profiles": [{
                "id": "legacy",
                "label": "Legacy",
                "mode": "desktop-thin",
                "gatewayUrl": "https://legacy.example/api",
                "signalingUrl": "wss://legacy.example/signal",
                "nodeName": "Desk",
                "localStablePeerId": "peer-local"
            }]
        });

        assert_eq!(
            remote_gateway_from_profile_document(&remote_console.to_string()).as_deref(),
            Some("https://hosted.example/api")
        );
        assert_eq!(
            remote_gateway_from_profile_document(&legacy.to_string()).as_deref(),
            Some("https://legacy.example/api")
        );
        assert!(remote_gateway_from_profile_document(&mesh_node.to_string()).is_none());
    }

    #[test]
    fn gateway_request_url_rejects_absolute_and_protocol_relative_overrides() {
        let base = Url::parse("http://127.0.0.1:8000/").unwrap();
        assert_eq!(
            gateway_request_url(&base, None, "Gateway.GetRegistry")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8000/api/methods/Gateway/GetRegistry"
        );
        assert_eq!(
            gateway_request_url(&base, Some("/health"), "Gateway.GetRegistry")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8000/health"
        );
        assert!(gateway_request_url(
            &base,
            Some("https://evil.example/steal"),
            "Gateway.GetRegistry"
        )
        .is_err());
        assert!(
            gateway_request_url(&base, Some("//evil.example/steal"), "Gateway.GetRegistry")
                .is_err()
        );
        assert!(gateway_request_url(
            &base,
            Some("http://evil.example/steal"),
            "Gateway.GetRegistry"
        )
        .is_err());
    }

    #[test]
    fn tauri_csp_has_loopback_only_defaults_and_no_remote_wildcards_or_samples() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("connect-src"));
        assert!(csp.contains("http://127.0.0.1:*"));
        assert!(csp.contains("ws://localhost:*"));
        assert!(!csp.contains("https://aurora.local"));
        assert!(!csp.contains("https://*"));
        assert!(!csp.contains("wss://*"));
        assert!(!csp.contains("connect-src *"));
    }

    #[test]
    fn thin_peer_credential_commands_are_permissioned_in_main_capability_and_build_manifest() {
        let capability = include_str!("../capabilities/aurora-main.json");
        let permission = include_str!("../permissions/aurora-thin-peer-credentials.toml");
        let inbound_verifier_permission =
            include_str!("../permissions/aurora-inbound-verifier-storage.toml");
        let build_manifest = include_str!("../build.rs");
        assert!(capability.contains("aurora-thin-peer-credentials"));
        for command in [
            "aurora_thin_peer_credential_set",
            "aurora_thin_peer_credential_status",
            "aurora_thin_peer_credential_delete",
            "aurora_thin_peer_reconnect_prove",
            "aurora_thin_room_secret_set",
            "aurora_thin_room_secret_get",
            "aurora_thin_room_secret_delete",
            "aurora_remote_origin_policy",
        ] {
            assert!(permission.contains(command), "{command}");
            assert!(build_manifest.contains(command), "{command}");
        }
        assert!(!permission.contains("aurora_thin_peer_credential_get"));
        let profile_permission = include_str!("../permissions/aurora-thin-profile.toml");
        for command in ["aurora_thin_profile_get", "aurora_thin_profile_set"] {
            assert!(profile_permission.contains(command), "{command}");
            assert!(build_manifest.contains(command), "{command}");
        }
        assert!(!profile_permission.contains("aurora_secure_storage_get"));
        assert!(!profile_permission.contains("aurora_secure_storage_set"));
        assert!(capability.contains("aurora-inbound-verifier-storage"));
        for command in [
            "aurora_inbound_verifier_get",
            "aurora_inbound_verifier_set",
            "aurora_inbound_verifier_delete",
        ] {
            assert!(inbound_verifier_permission.contains(command), "{command}");
            assert!(build_manifest.contains(command), "{command}");
        }
        assert!(!permission.contains("aurora_inbound_verifier_get"));
    }

    #[test]
    fn secure_storage_keys_are_limited_to_credential_namespaces() {
        for key in [
            "aurora.session",
            "aurora.session.gateway",
            "aurora.auth.refresh-token",
            "aurora.mesh.peer_01",
            "aurora.admin.unlock",
            "aurora.voice.transport",
        ] {
            assert!(validate_secure_storage_key(key).is_ok(), "{key}");
        }

        for key in [
            "",
            "session",
            "aurora.config.secret",
            "aurora.session/../../token",
            "aurora.session.token value",
            "aurora.mesh.peer-proof.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ] {
            assert!(validate_secure_storage_key(key).is_err(), "{key}");
        }
    }

    #[test]
    fn generic_secure_storage_cannot_access_peer_proof_namespace() {
        let key = thin_peer_credential_key("stable-answer").unwrap();
        assert!(is_peer_proof_storage_key(&key));
        assert!(validate_secure_storage_key(&key).is_err());
        let error = serde_json::to_string(&validate_secure_storage_key(&key).unwrap_err()).unwrap();
        assert!(!error.contains("synthetic-reconnect-token"));
        assert!(error.contains("secrets_redacted"));
    }

    #[test]
    fn thin_capability_does_not_grant_generic_secure_storage() {
        let capability = include_str!("../capabilities/aurora-thin.json");
        let android_capability = include_str!("../capabilities/aurora-android-thin.json");
        assert!(capability.contains("aurora-thin-profile"));
        assert!(capability.contains("aurora-thin-peer-credentials"));
        assert!(capability.contains("aurora-inbound-verifier-storage"));
        assert!(!capability.contains("aurora-secure-storage"));
        assert!(!capability.contains("aurora_secure_storage_get"));
        assert!(!capability.contains("aurora_secure_storage_set"));
        assert!(!capability.contains("aurora.auth"));
        assert!(!capability.contains("aurora.admin"));
        assert!(!capability.contains("aurora.gateway"));
        assert!(android_capability.contains("aurora-thin-profile"));
        assert!(android_capability.contains("aurora-thin-peer-credentials"));
        assert!(android_capability.contains("aurora-android-native-plugin"));
        assert!(!android_capability.contains("aurora-inbound-verifier-storage"));
        assert!(!android_capability.contains("aurora-secure-storage"));
        assert!(!android_capability.contains("aurora-sidecar-start"));
        assert!(!android_capability.contains("aurora-audio-bridge"));
        assert!(!android_capability.contains("shell:"));
    }

    #[test]
    fn corrupt_stored_peer_credentials_fail_closed_and_are_deleted() {
        let deleted = Mutex::new(Vec::<String>::new());
        let result = resolve_unexpired_thin_peer_credential_record(
            "stable-answer",
            Some("not-json synthetic-reconnect-token".to_string()),
            |peer_id| {
                deleted.lock().unwrap().push(peer_id.to_string());
                Ok(())
            },
        )
        .unwrap();

        assert!(result.is_none());
        assert_eq!(deleted.lock().unwrap().as_slice(), ["stable-answer"]);
        let err =
            parse_thin_peer_credential_record("not-json synthetic-reconnect-token").unwrap_err();
        let serialized = serde_json::to_string(&err).unwrap();
        assert!(serialized.contains("stored peer credential is invalid"));
        assert!(serialized.contains("secrets_redacted"));
        assert!(!serialized.contains("synthetic-reconnect-token"));
    }

    #[test]
    fn semantically_invalid_stored_peer_credentials_fail_closed_and_are_deleted() {
        let stored = serde_json::to_string(&ThinPeerCredentialRecord {
            token_id: "token-fixture-001".to_string(),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "lab-room".to_string(),
            raw_bearer_token: "".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: None,
        })
        .unwrap();
        let deleted = Mutex::new(Vec::<String>::new());

        let result = resolve_unexpired_thin_peer_credential_record(
            "stable-answer",
            Some(stored.clone()),
            |peer_id| {
                deleted.lock().unwrap().push(peer_id.to_string());
                Ok(())
            },
        )
        .unwrap();

        assert!(result.is_none());
        assert_eq!(deleted.lock().unwrap().as_slice(), ["stable-answer"]);
        let serialized =
            serde_json::to_string(&parse_thin_peer_credential_record(&stored).unwrap_err())
                .unwrap();
        assert!(serialized.contains("stored peer credential is invalid"));
        assert!(serialized.contains("secrets_redacted"));
    }

    #[test]
    fn expired_stored_peer_credentials_fail_closed_and_are_deleted() {
        let stored = serde_json::to_string(&ThinPeerCredentialRecord {
            token_id: "token-fixture-001".to_string(),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "lab-room".to_string(),
            raw_bearer_token: "synthetic-reconnect-token".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: Some(1),
        })
        .unwrap();
        let deleted = Mutex::new(Vec::<String>::new());

        let result = resolve_unexpired_thin_peer_credential_record(
            "stable-answer",
            Some(stored),
            |peer_id| {
                deleted.lock().unwrap().push(peer_id.to_string());
                Ok(())
            },
        )
        .unwrap();

        assert!(result.is_none());
        assert_eq!(deleted.lock().unwrap().as_slice(), ["stable-answer"]);
    }

    #[test]
    fn expired_peer_credentials_fail_closed_and_are_not_used_for_proof() {
        let record = ThinPeerCredentialRecord {
            token_id: "token-fixture-001".to_string(),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "lab-room".to_string(),
            raw_bearer_token: "synthetic-reconnect-token".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: Some(1),
        };
        assert!(record
            .expires_at_ms
            .is_some_and(|expires_at_ms| expires_at_ms <= current_unix_ms()));
        let challenge = MeshReconnectChallengeFrame {
            r#type: "mesh_auth_challenge_v1".to_string(),
            challenge: "a".repeat(64),
            channel_binding: "b".repeat(64),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "lab-room".to_string(),
        };
        assert!(reconnect_challenge_matches(&record, &challenge));
        let response =
            thin_peer_reconnect_proof_response("stable-answer".to_string(), None, false, None);
        assert!(!response.found);
        assert!(!response.matched);
        assert!(response.proof.is_none());
    }

    #[test]
    fn saving_already_expired_peer_credential_is_rejected() {
        let request = ThinPeerCredentialSetRequest {
            peer_id: "stable-answer".to_string(),
            token_id: "token-fixture-001".to_string(),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "lab-room".to_string(),
            raw_bearer_token: "synthetic-reconnect-token".to_string(),
            created_at_ms: Some(1),
            expires_at_ms: Some(1),
        };
        assert!(request
            .expires_at_ms
            .is_some_and(|expires_at_ms| expires_at_ms <= current_unix_ms()));
    }

    #[test]
    fn native_peer_credential_payload_omits_absent_optional_timestamps() {
        let request = ThinPeerCredentialSetRequest {
            peer_id: "stable-answer".to_string(),
            token_id: "token-fixture-001".to_string(),
            claimant_peer_id: "stable-answer".to_string(),
            verifier_peer_id: "stable-offer".to_string(),
            claimant_signaling_peer_id: "sig-answer".to_string(),
            verifier_signaling_peer_id: "sig-offer".to_string(),
            room_name: "lab-room".to_string(),
            raw_bearer_token: "synthetic-reconnect-token".to_string(),
            created_at_ms: None,
            expires_at_ms: None,
        };

        let payload = serde_json::to_value(request).unwrap();

        assert!(!payload.as_object().unwrap().contains_key("createdAtMs"));
        assert!(!payload.as_object().unwrap().contains_key("expiresAtMs"));
    }

    #[test]
    fn native_mobile_speech_pack_requests_preserve_task_and_reference_fields() {
        let reference = NativeSpeechReferenceProfileRequest {
            reference_id: Some("voice-1".to_string()),
            reference_audio_uri: Some("content://aurora/voice-1.wav".to_string()),
            reference_text: Some("Hello Aurora".to_string()),
            reference_revision: Some("sha256-reference".to_string()),
            reference_sample_rate_hz: Some(16_000),
            reference_samples: Some(vec![0.0, 0.25, -0.25]),
        };
        let download = serde_json::to_value(NativeMobileSpeechPackDownloadRequest {
            pack_id: "pockettts.en".to_string(),
            task: NativeSpeechPackTask::Tts,
            force_download: true,
            activate: false,
            reference,
        })
        .unwrap();

        assert_eq!(download["packId"], "pockettts.en");
        assert_eq!(download["task"], "tts");
        assert_eq!(download["forceDownload"], true);
        assert_eq!(download["activate"], false);
        assert_eq!(download["referenceId"], "voice-1");
        assert_eq!(
            download["referenceAudioUri"],
            "content://aurora/voice-1.wav"
        );
        assert_eq!(download["referenceText"], "Hello Aurora");
        assert_eq!(download["referenceRevision"], "sha256-reference");
        assert_eq!(download["referenceSampleRateHz"], 16_000);
        assert_eq!(download["referenceSamples"], json!([0.0, 0.25, -0.25]));

        let activate = serde_json::to_value(NativeSpeechPackActivateRequest {
            pack_id: "pockettts.en".to_string(),
            task: NativeSpeechPackTask::Tts,
            slot: Some("tts".to_string()),
            reference: NativeSpeechReferenceProfileRequest {
                reference_id: Some("voice-1".to_string()),
                reference_audio_uri: None,
                reference_text: Some("Hello Aurora".to_string()),
                reference_revision: Some("sha256-reference".to_string()),
                reference_sample_rate_hz: Some(16_000),
                reference_samples: Some(vec![0.0, 0.25, -0.25]),
            },
        })
        .unwrap();

        assert_eq!(activate["packId"], "pockettts.en");
        assert_eq!(activate["task"], "tts");
        assert_eq!(activate["slot"], "tts");
        assert_eq!(activate["referenceId"], "voice-1");
        assert_eq!(activate["referenceSampleRateHz"], 16_000);
        assert_eq!(activate["referenceSamples"], json!([0.0, 0.25, -0.25]));
    }

    #[test]
    fn native_mobile_speech_pack_requests_allow_audio_only_reference() {
        let download = serde_json::to_value(NativeMobileSpeechPackDownloadRequest {
            pack_id: "pockettts.en".to_string(),
            task: NativeSpeechPackTask::Tts,
            force_download: false,
            activate: true,
            reference: NativeSpeechReferenceProfileRequest {
                reference_id: Some("voice-1".to_string()),
                reference_audio_uri: None,
                reference_text: None,
                reference_revision: Some("sha256-reference".to_string()),
                reference_sample_rate_hz: Some(16_000),
                reference_samples: Some(vec![0.0, 0.25, -0.25]),
            },
        })
        .unwrap();

        assert_eq!(download["referenceId"], "voice-1");
        assert_eq!(download["referenceRevision"], "sha256-reference");
        assert_eq!(download["referenceSampleRateHz"], 16_000);
        assert_eq!(download["referenceSamples"], json!([0.0, 0.25, -0.25]));
        assert!(download["referenceText"].is_null());
        assert_eq!(optional_native_tts_reference_text(None), None);
        assert_eq!(optional_native_tts_reference_text(Some("   ")), None);
        assert_eq!(
            optional_native_tts_reference_text(Some("Hello Aurora")),
            Some("Hello Aurora".to_string())
        );
    }

    #[test]
    fn ios_tts_reference_set_payload_allows_audio_only_and_legacy_text() {
        let audio_only = ios_tts_reference_set_payload(
            "pockettts.en",
            &NativeSpeechReferenceProfileRequest {
                reference_id: Some("voice-1".to_string()),
                reference_audio_uri: None,
                reference_text: None,
                reference_revision: Some("rev-1".to_string()),
                reference_sample_rate_hz: Some(16_000),
                reference_samples: Some(vec![0.0, 0.25, -0.25]),
            },
        )
        .expect("audio-only payload");
        assert_eq!(audio_only["packId"], "pockettts.en");
        assert_eq!(audio_only["referenceText"], json!(null));
        assert_eq!(audio_only["revision"], "rev-1");
        assert_eq!(audio_only["sampleRateHz"], 16_000);
        assert!(audio_only["audioBase64"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));

        let blank_text = ios_tts_reference_set_payload(
            "pockettts.en",
            &NativeSpeechReferenceProfileRequest {
                reference_id: Some("voice-1".to_string()),
                reference_audio_uri: None,
                reference_text: Some("   ".to_string()),
                reference_revision: Some("rev-1".to_string()),
                reference_sample_rate_hz: Some(16_000),
                reference_samples: Some(vec![0.0, 0.25, -0.25]),
            },
        )
        .expect("blank text payload");
        assert_eq!(blank_text["referenceText"], json!(null));

        let legacy = ios_tts_reference_set_payload(
            "pockettts.en",
            &NativeSpeechReferenceProfileRequest {
                reference_id: Some("voice-1".to_string()),
                reference_audio_uri: None,
                reference_text: Some("Hello Aurora".to_string()),
                reference_revision: Some("rev-1".to_string()),
                reference_sample_rate_hz: Some(16_000),
                reference_samples: Some(vec![0.0, 0.25, -0.25]),
            },
        )
        .expect("legacy text payload");
        assert_eq!(legacy["referenceText"], "Hello Aurora");

        assert!(matches!(
            ios_tts_reference_set_payload(
                "pockettts.en",
                &NativeSpeechReferenceProfileRequest {
                    reference_id: Some("voice-1".to_string()),
                    reference_audio_uri: None,
                    reference_text: None,
                    reference_revision: None,
                    reference_sample_rate_hz: Some(16_000),
                    reference_samples: Some(vec![0.0, 0.25, -0.25]),
                },
            ),
            Err(AuroraCommandError::NativeSpeechPackSelectionInvalid)
        ));
        assert!(matches!(
            ios_tts_reference_set_payload(
                "pockettts.en",
                &NativeSpeechReferenceProfileRequest {
                    reference_id: Some("voice-1".to_string()),
                    reference_audio_uri: None,
                    reference_text: Some("Hello Aurora".to_string()),
                    reference_revision: Some("rev-1".to_string()),
                    reference_sample_rate_hz: Some(16_000),
                    reference_samples: None,
                },
            ),
            Err(AuroraCommandError::NativeSpeechPackSelectionInvalid)
        ));
    }

    #[test]
    fn native_reference_wav_is_bounded_mono_pcm16() {
        let encoded = native_reference_wav_base64(16_000, &[0.0, 0.5, -0.5]).unwrap();
        let wav = STANDARD.decode(encoded).unwrap();

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 6);
        assert_eq!(wav.len(), 50);

        assert!(native_reference_wav_base64(7_999, &[0.0]).is_err());
        assert!(native_reference_wav_base64(16_000, &[]).is_err());
        assert!(native_reference_wav_base64(16_000, &[f32::NAN]).is_err());
        assert!(native_reference_wav_base64(16_000, &[1.01]).is_err());
    }

    #[test]
    fn native_speech_pack_active_slots_fail_closed_without_resolved_installs() {
        let active = BTreeMap::from([
            ("vad".to_string(), "vad.missing".to_string()),
            ("kws".to_string(), "kws.corrupt".to_string()),
            ("stt".to_string(), "stt.missing".to_string()),
            ("tts".to_string(), "tts.corrupt".to_string()),
        ]);
        let packs = vec![
            NativeSpeechPackCatalogEntry {
                pack_id: "vad.missing".to_string(),
                display_name: "VAD".to_string(),
                task: NativeSpeechPackTask::Vad,
                languages: vec![],
                language: None,
                sha256: "sha256-vad".to_string(),
                file_size: 1,
                installed: false,
                active_slot: None,
                revision: "catalog-revision".to_string(),
                runtime_revision: "engine-revision".to_string(),
                model_family: "silero_vad".to_string(),
                requires_reference_audio: false,
                reference_audio_mode: None,
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            },
            NativeSpeechPackCatalogEntry {
                pack_id: "kws.corrupt".to_string(),
                display_name: "Wake".to_string(),
                task: NativeSpeechPackTask::Kws,
                languages: vec![],
                language: None,
                sha256: "sha256-kws".to_string(),
                file_size: 1,
                installed: false,
                active_slot: Some("kws".to_string()),
                revision: "catalog-revision".to_string(),
                runtime_revision: "engine-revision".to_string(),
                model_family: "zipformer".to_string(),
                requires_reference_audio: false,
                reference_audio_mode: None,
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            },
            NativeSpeechPackCatalogEntry {
                pack_id: "stt.ready".to_string(),
                display_name: "STT".to_string(),
                task: NativeSpeechPackTask::Stt,
                languages: vec!["en".to_string()],
                language: Some("en".to_string()),
                sha256: "sha256-stt".to_string(),
                file_size: 1,
                installed: true,
                active_slot: Some("stt".to_string()),
                revision: "catalog-revision".to_string(),
                runtime_revision: "engine-revision".to_string(),
                model_family: "whisper".to_string(),
                requires_reference_audio: false,
                reference_audio_mode: None,
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            },
            NativeSpeechPackCatalogEntry {
                pack_id: "tts.ready".to_string(),
                display_name: "TTS".to_string(),
                task: NativeSpeechPackTask::Tts,
                languages: vec!["en".to_string()],
                language: Some("en".to_string()),
                sha256: "sha256-tts".to_string(),
                file_size: 1,
                installed: true,
                active_slot: Some("tts".to_string()),
                revision: "catalog-revision".to_string(),
                runtime_revision: "engine-revision".to_string(),
                model_family: "vits_piper".to_string(),
                requires_reference_audio: false,
                reference_audio_mode: None,
                voice_id: Some("tts.ready".to_string()),
                voice_revision: Some("catalog-revision".to_string()),
                reference_profile_id: None,
            },
        ];

        assert!(filtered_native_speech_pack_active_slots(active, &packs).is_empty());
    }

    #[test]
    fn native_speech_pack_activation_uses_canonical_slot() {
        let mut active = BTreeMap::new();

        insert_native_speech_pack_active_slot(
            &mut active,
            NativeSpeechPackTask::Stt,
            None,
            "stt.ready".to_string(),
        )
        .unwrap();
        insert_native_speech_pack_active_slot(
            &mut active,
            NativeSpeechPackTask::Tts,
            Some(" tts "),
            "tts.ready".to_string(),
        )
        .unwrap();

        assert_eq!(active.get("stt").map(String::as_str), Some("stt.ready"));
        assert_eq!(active.get("tts").map(String::as_str), Some("tts.ready"));
        assert_eq!(active.len(), 2);
    }

    #[test]
    fn native_speech_pack_activation_rejects_task_slot_mismatch_without_polluting_state() {
        let mut active = BTreeMap::from([("tts".to_string(), "tts.ready".to_string())]);
        let before = active.clone();

        let result = insert_native_speech_pack_active_slot(
            &mut active,
            NativeSpeechPackTask::Stt,
            Some("tts"),
            "tts.ready".to_string(),
        );

        assert!(matches!(
            result,
            Err(AuroraCommandError::NativeSpeechPackSelectionInvalid)
        ));
        assert_eq!(active, before);
        assert!(!active.contains_key("stt"));
    }

    #[test]
    fn android_native_plugin_implements_opaque_peer_credentials_profile_mic_and_lifecycle() {
        let plugin = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt"
        );
        let local_data = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativeLocalData.kt"
        );
        for command in [
            "fun thinPeerCredentialSet",
            "fun thinPeerCredentialStatus",
            "fun thinPeerCredentialDelete",
            "fun thinPeerReconnectProve",
            "fun thinProfileGet",
            "fun thinProfileSet",
            "fun webviewMicrophonePermissionDecision",
            "fun androidLifecycleStatus",
            "override fun load(webView: WebView)",
            "class AuroraMicWebChromeClient",
            "override fun onPermissionRequest",
            "request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))",
            "request.deny()",
            "PluginManager.requestPermissions",
            "microphonePermissionRequestInFlight",
            "if (isTauriAppOrigin(origin)) return true",
            "scheme != \"http\" && scheme != \"https\"",
            "uri.host != \"tauri.localhost\"",
            "trigger(\"aurora://android-lifecycle\"",
        ] {
            assert!(plugin.contains(command), "{command}");
        }
        assert!(plugin.contains("PEER_PROOF_PREFIX"));
        assert!(plugin.contains("peer reconnect credential namespace is opaque-only"));
        assert!(plugin.contains("HmacSHA256"));
        assert!(plugin.contains("canonicalJsonQuote"));
        assert!(plugin.contains("character.code.toString(16).padStart(4, '0')"));
        assert!(
            plugin.contains("aurora.mesh.reconnect-proof.v1\\u0000")
                || plugin.contains("aurora.mesh.reconnect-proof.v1\u{0}")
        );
        assert!(plugin.contains("RESOURCE_AUDIO_CAPTURE"));
        assert!(plugin.contains("delegateWebChromeClientCaptured"));
        assert!(plugin.contains("micDenyFailureCount"));
        assert!(plugin.contains("lastMicDenyFailureReason"));
        assert!(plugin.contains("Log.w(LOG_TAG"));
        for callback in [
            "override fun onShowFileChooser",
            "delegate?.onShowFileChooser",
            "override fun onJsAlert",
            "delegate?.onJsAlert",
            "override fun onJsConfirm",
            "delegate?.onJsConfirm",
            "override fun onJsPrompt",
            "delegate?.onJsPrompt",
            "override fun onJsBeforeUnload",
            "delegate?.onJsBeforeUnload",
            "override fun onCreateWindow",
            "delegate?.onCreateWindow",
            "override fun onCloseWindow",
            "delegate.onCloseWindow",
            "override fun onShowCustomView",
            "delegate.onShowCustomView",
            "override fun onHideCustomView",
            "delegate.onHideCustomView",
            "override fun getDefaultVideoPoster",
            "delegate.getDefaultVideoPoster",
            "override fun getVideoLoadingProgressView",
            "delegate.getVideoLoadingProgressView",
            "override fun onGeolocationPermissionsShowPrompt",
            "delegate.onGeolocationPermissionsShowPrompt",
            "override fun onReceivedIcon",
            "delegate.onReceivedIcon",
            "override fun onReceivedTouchIconUrl",
            "delegate.onReceivedTouchIconUrl",
            "override fun onRequestFocus",
            "delegate.onRequestFocus",
        ] {
            assert!(plugin.contains(callback), "{callback}");
        }
        assert!(plugin.contains("delegate?.onConsoleMessage"));
        assert!(plugin.contains("uri.userInfo"));
        assert!(plugin.contains("encodedQuery"));
        assert!(plugin.contains("encodedFragment"));
        assert!(plugin.contains("if (scheme != \"https\") return null"));
        assert!(plugin.contains("origin.contains(\"*\")"));
        assert!(plugin.contains("backgroundWakeword",));
        assert!(plugin.contains("background_voice_unavailable"));
        assert!(!plugin.contains(r#"rawBearerToken", record.getString"#));
        for invariant in [
            "validateId(\"profileId\", profileId)",
            "validateId(\"localNodeId\", localNodeId)",
            "private const val LOCAL_DATA_MAX_ID_BYTES = 256",
            "value.toByteArray(Charsets.UTF_8).size <= LOCAL_DATA_MAX_ID_BYTES",
            "LOCAL_DATA_ID_PATTERN.matches(value)",
        ] {
            assert!(local_data.contains(invariant), "{invariant}");
        }
    }

    #[test]
    fn android_voice_service_owns_audiorecord_and_rust_queue_with_visible_stop() {
        let service = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraRuntimeForegroundService.kt"
        );
        let plugin = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt"
        );
        let speech_packs = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativeSpeechPacks.kt"
        );
        let rust_audio = include_str!("android_audio.rs");
        let shared_audio =
            include_str!("../../../../rust/crates/aurora-voice-native/src/android_capture.rs");
        let interaction_session = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraVoiceInteractionSessionService.kt"
        );
        let assistant_role = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraAssistantRole.kt"
        );
        let rust_source = include_str!("lib.rs");
        for required in [
            "AudioRecord.Builder()",
            "HandlerThread(\"aurora-audio-capture\")",
            "ACTION_STOP",
            "ACTION_FINISH",
            "ACTION_START_BACKGROUND",
            "finishHandler",
            "awaitFinishedSession",
            "builder.addAction(0, \"Stop\", stopPendingIntent)",
            "NotificationCompat.DecoratedCustomViewStyle",
            "setCustomContentView",
            "setCustomBigContentView",
            "System.loadLibrary(\"aurora_tauri_lib\")",
            "nativePushPcm",
            "nativeDrainPcm",
            "nativeStats",
            "AuroraNativeAudioOutputBridge",
            "AuroraAudioPlayback",
            "AuroraNativeVoiceSessionBridge",
            "nativeCreateWithPackSelection",
            "auroraSpeechPackStoreRoot",
            "AuroraVoiceNativeConfigStore",
            "isConfigured",
            "VOICE_GATEWAY_KEY",
            "VOICE_BEARER_KEY",
            "VOICE_GENERIC_GATEWAY_KEY",
            "VOICE_GENERIC_BEARER_KEY",
            "VOICE_REMOTE_AUDIO_CONSENT_KEY",
            "setRemoteAudioConsent",
            "toBooleanStrictOrNull",
            "sessionGeneration",
            "closeBridgeOnClose",
            "nativeStart",
            "nativeStartBackground",
            "nativeFinish",
            "nativeTakeBackgroundResult",
            "nativeCancel",
            "finishNativeSession",
            "AudioTrack.Builder()",
            "audio_record_read_failed",
            "requestAudioFocus",
            "onTaskRemoved",
            "AUDIOFOCUS_LOSS_TRANSIENT",
            "START_STICKY",
            "PowerManager.PARTIAL_WAKE_LOCK",
            "backgroundSessionRequested",
            "stopAfterTerminalFailure",
        ] {
            assert!(
                service.contains(required),
                "missing Android service contract: {required}"
            );
        }
        for required in [
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeInstall",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeResolve",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeRemove",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeCreate",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativePushPcm",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeDrainPcm",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeStats",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeCreate",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeDrainPcm",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeAcknowledgeDrained",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeStats",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeFree",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeCreate",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeCreateWithPackSelection",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeStart",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeStartBackground",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeFinish",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeTakeBackgroundResult",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeCancel",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativePushPcm",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeDrainPcm",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeAcknowledgeDrained",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeStats",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeClose",
            "Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeFree",
            "AUDIO_BACKPRESSURE",
            "capacity_chunks",
        ] {
            assert!(
                rust_audio.contains(required),
                "missing Rust audio contract: {required}"
            );
        }
        for required in [
            "AndroidPcmIngress",
            "MAX_CHUNK_SAMPLES",
            "AndroidPcmPushResult",
            "drain_chunk",
        ] {
            assert!(
                shared_audio.contains(required),
                "missing shared Rust audio contract: {required}"
            );
        }
        assert!(plugin.contains("captureBackend"));
        assert!(plugin.contains("nativeSessionReady"));
        assert!(plugin.contains("notificationReady"));
        assert!(plugin.contains("canPostNotifications()"));
        assert!(plugin.contains("notification_delivery_unavailable"));
        assert!(plugin.contains("native_voice_runtime_missing"));
        for required in [
            "AuroraNativeSpeechPackBridge",
            "nativeInstall",
            "nativeResolve",
            "nativeRemove",
            "inferAuroraSpeechPackTask",
            "AURORA_SPEECH_PACK_STORE_DIR",
        ] {
            assert!(
                speech_packs.contains(required),
                "missing Android speech-pack bridge contract: {required}"
            );
        }
        for command in [
            "startVoiceForegroundService",
            "injectVoicePcmForLiveTest",
            "finishVoiceForegroundService",
            "stopVoiceForegroundService",
        ] {
            assert!(plugin.contains(command), "{command}");
        }
        assert!(plugin.contains("AndroidVoiceForegroundServiceStartArgs"));
        assert!(plugin.contains("AndroidVoiceLiveTestPcmArgs"));
        assert!(plugin.contains("ApplicationInfo.FLAG_DEBUGGABLE"));
        assert!(plugin.contains("backgroundSession"));
        assert!(plugin.contains("ACTION_START_BACKGROUND"));
        assert!(rust_source.contains("AndroidVoiceForegroundServiceStartRequest"));
        assert!(rust_source.contains("AndroidVoiceLiveTestPcmRequest"));
        assert!(rust_source.contains("AndroidVoicePackCatalogSetRequest"));
        assert!(rust_source.contains("NativeMobileSpeechPackDownloadRequest"));
        assert!(rust_source.contains("AndroidVoicePackDownloadStatusRequest"));
        assert!(rust_source.contains("NativeSpeechPackActivateRequest"));
        assert!(rust_source.contains("NativeSpeechPackIdRequest"));
        assert!(rust_source.contains("serde_json::to_value(&request)"));
        for command in [
            "aurora_android_voice_foreground_service_start",
            "aurora_android_voice_live_test_inject_pcm",
            "aurora_android_voice_foreground_service_finish",
            "aurora_android_voice_foreground_service_cancel",
            "aurora_android_voice_pack_catalog_status",
            "aurora_android_voice_pack_catalog_set",
            "aurora_android_voice_pack_download",
            "aurora_android_voice_pack_download_status",
            "aurora_android_voice_pack_activate",
            "aurora_android_voice_pack_remove",
        ] {
            assert!(rust_source.contains(command), "{command}");
        }
        let build_manifest = include_str!("../build.rs");
        assert!(build_manifest.contains("aurora_android_voice_live_test_inject_pcm"));
        assert!(plugin.contains("backendAudioEvidenceRequired"));
        let finish_start = service
            .find("private fun finishNativeSession()")
            .expect("finishNativeSession exists");
        let finish_body = &service[finish_start..];
        let native_finish = finish_body
            .find("nativeSession.finish(generationToFinish)")
            .expect("finish calls native session finish");
        let capture_close = finish_body
            .find("captureToClose?.close()")
            .expect("finish closes Android capture");
        assert!(
            native_finish < capture_close,
            "explicit assistant finish must signal native end-of-input before closing Android capture"
        );
        assert!(service.contains("isActivePackReady(AuroraSpeechPackTask.VAD,"));
        assert!(service.contains("isActivePackReady(AuroraSpeechPackTask.KWS,"));
        assert!(service.contains("background_voice_unavailable"));
        for required in [
            "VoiceInteractionSessionService",
            "AuroraVoiceInteractionSession",
            "onShow(args: Bundle?, showFlags: Int)",
            "RoleManager",
            "isRoleHeld",
            "ROLE_ASSISTANT",
            "ACTION_START_ASSISTANT",
            "startForegroundService(intent)",
            "hide()",
        ] {
            assert!(
                interaction_session.contains(required)
                    || assistant_role.contains(required)
                    || service.contains(required),
                "missing Android assistant-session contract: {required}"
            );
        }
    }

    #[test]
    fn ios_native_plugin_implements_opaque_keychain_peer_credentials_and_profile_storage() {
        let plugin = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift"
        );
        let storage = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraThinPeerStorage.swift"
        );
        for command in [
            "@objc public func thinPeerCredentialSet",
            "@objc public func thinPeerCredentialStatus",
            "@objc public func thinPeerCredentialDelete",
            "@objc public func thinPeerReconnectProve",
            "@objc public func thinProfileGet",
            "@objc public func thinProfileSet",
        ] {
            assert!(plugin.contains(command), "{command}");
        }
        for invariant in [
            "import CryptoKit",
            "kSecClassGenericPassword",
            "kSecAttrAccessibleWhenUnlockedThisDeviceOnly",
            "kSecAttrSynchronizable as String: kCFBooleanFalse",
            "HMAC<SHA256>.authenticationCode",
            "aurora.mesh.reconnect-proof.v1\\u{0}",
            "options: [.sortedKeys, .withoutEscapingSlashes]",
            "Data(ensureAscii(serialized).utf8)",
            "for codeUnit in value.utf16",
            "\"token_id\": record.tokenId",
            "\"channel_binding\": challenge.channelBinding",
            "\"claimant_peer_id\": challenge.claimantPeerId",
            "\"verifier_peer_id\": challenge.verifierPeerId",
            "\"claimant_signaling_peer_id\": challenge.claimantSignalingPeerId",
            "\"verifier_signaling_peer_id\": challenge.verifierSignalingPeerId",
            "\"room_name\": record.roomName",
            "\"rawGetter\": false",
            "\"allowedGenericSecureStorage\": false",
            "\"redactedFields\": [\"rawBearerToken\"]",
            "UserDefaults.standard",
            "value.utf8.count <= 65_536",
            "try validateLocalDataId(profileId)",
            "try validateLocalDataId(localNodeId)",
            "value.utf8.count <= 256",
            "$0 == 95 || $0 == 46 || $0 == 58 || $0 == 64 || $0 == 47 || $0 == 45",
        ] {
            assert!(storage.contains(invariant), "{invariant}");
        }
        assert!(!storage.contains("func thinPeerCredentialGet"));
        assert!(!storage.contains("\"rawBearerToken\": record.rawBearerToken"));
    }

    #[test]
    fn ios_thin_capability_and_overlay_are_python_free_and_least_privilege() {
        let capability = include_str!("../capabilities/aurora-ios-thin.json");
        for required in [
            "aurora-thin-profile",
            "aurora-thin-peer-credentials",
            "aurora-ios-native-plugin",
            "aurora-native-capability-manifest",
            "deep-link:default",
        ] {
            assert!(capability.contains(required), "{required}");
        }
        for forbidden in [
            "aurora-main",
            "aurora-overlay",
            "aurora-secure-storage",
            "aurora-inbound-verifier-storage",
            "aurora_secure_storage_get",
            "aurora-sidecar-start",
            "aurora-sidecar-session",
            "aurora-local-file",
            "aurora-audio-bridge",
            "shell:",
            "process:",
            "aurora_thin_peer_credential_get",
        ] {
            assert!(!capability.contains(forbidden), "{forbidden}");
        }

        let overlay: Value =
            serde_json::from_str(include_str!("../tauri.ios-thin.conf.json")).unwrap();
        assert_eq!(
            overlay["app"]["security"]["capabilities"],
            json!(["aurora-ios-thin", "aurora-mobile-mesh"])
        );
        assert_eq!(overlay["bundle"]["externalBin"], json!([]));
        assert_eq!(overlay["bundle"]["resources"], json!({}));
        let raw = overlay.to_string();
        assert!(!raw.contains("aurora-sidecar"));
        assert!(!raw.contains("config_defaults.json"));
        assert!(!raw.contains("site-packages"));
        let csp = overlay["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("media-src 'self' blob: mediastream:"));
        assert!(!csp.contains("https://*"));
        assert!(!csp.contains("wss://*"));
        assert!(!csp.contains("connect-src *"));
    }

    #[test]
    fn ios_thin_rust_commands_route_to_the_swift_plugin() {
        let source = include_str!("lib.rs");
        for command in [
            "\"thinPeerCredentialSet\"",
            "\"thinPeerCredentialStatus\"",
            "\"thinPeerCredentialDelete\"",
            "\"thinPeerReconnectProve\"",
            "\"thinProfileGet\"",
            "\"thinProfileSet\"",
            "\"thinRoomSecretSet\"",
            "\"thinRoomSecretGet\"",
            "\"thinRoomSecretDelete\"",
        ] {
            let occurrences = source.matches(command).count();
            assert!(
                occurrences >= 2,
                "{command} should exist in both mobile routes and static verification"
            );
        }
        assert!(source.contains("#[cfg(target_os = \"ios\")]"));
        assert!(source.contains("run_ios_plugin_command("));
        assert!(source.contains("desktop keychain, Android Keystore, and iOS Keychain targets"));
    }

    #[test]
    fn ios_voice_pack_bridge_delegates_archives_to_rust_manager() {
        let rust_source = include_str!("lib.rs");
        let ios_voice = include_str!("ios_voice.rs");
        let swift_manager = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraIOSVoicePackManager.swift"
        );
        let swift_plugin = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift"
        );
        let c_header = include_str!(
            "../ios/AuroraNativePlugin/Sources/CAuroraIOSVoiceBridge/include/aurora_ios_voice_bridge.h"
        );
        for required in [
            "aurora_ios_voice_pack_install",
            "aurora_ios_voice_pack_resolve_json",
            "aurora_ios_voice_pack_remove",
            "SpeechPackManager::open",
            "install_voice",
            "install_model",
            "resolve_voice_bindings",
            "resolve_model_bindings",
        ] {
            assert!(ios_voice.contains(required), "{required}");
        }
        for required in [
            "aurora_ios_voice_pack_install",
            "aurora_ios_voice_pack_resolve_json",
            "aurora_ios_voice_pack_remove",
            "aurora_ios_voice_pack_string_free",
        ] {
            assert!(c_header.contains(required), "{required}");
            assert!(swift_manager.contains(required), "{required}");
        }
        assert!(swift_plugin.contains("@objc public func voicePackActivate"));
        assert!(swift_manager.contains("try installWithRust(entry)"));
        assert!(swift_manager.contains("resolveWithRust(entry)"));
        assert!(!swift_manager.contains("downloadAndVerify"));
        assert!(!swift_manager.contains("DownloadCoordinator"));
        for command in [
            "aurora_ios_voice_pack_catalog_set",
            "aurora_ios_voice_pack_list",
            "aurora_ios_voice_pack_status",
            "aurora_ios_voice_pack_download",
            "aurora_ios_voice_pack_activate",
            "aurora_ios_voice_pack_remove",
            "aurora_native_speech_pack_catalog",
            "aurora_native_speech_pack_status",
            "aurora_native_speech_pack_install",
            "aurora_native_speech_pack_activate",
            "aurora_native_speech_pack_remove",
        ] {
            assert!(rust_source.contains(command), "{command}");
        }
    }

    #[test]
    fn android_thin_capability_is_least_privilege_for_native_security_surface() {
        let capability = include_str!("../capabilities/aurora-android-thin.json");
        let mobile_mesh = include_str!("../capabilities/aurora-mobile-mesh.json");
        for required in [
            "aurora-thin-profile",
            "aurora-thin-peer-credentials",
            "aurora-android-native-plugin",
            "aurora-native-capability-manifest",
            "deep-link:default",
        ] {
            assert!(capability.contains(required), "{required}");
        }
        for forbidden in [
            "aurora-main",
            "aurora-overlay",
            "aurora-secure-storage",
            "aurora-inbound-verifier-storage",
            "aurora_secure_storage_get",
            "aurora-sidecar-start",
            "aurora-sidecar-session",
            "aurora-local-file",
            "aurora-audio-bridge",
            "shell:",
            "process:",
            "aurora_thin_peer_credential_get",
        ] {
            assert!(!capability.contains(forbidden), "{forbidden}");
        }
        for required in [
            "deep-link:default",
            "barcode-scanner:allow-scan",
            "barcode-scanner:allow-cancel",
            "barcode-scanner:allow-check-permissions",
            "barcode-scanner:allow-request-permissions",
        ] {
            assert!(mobile_mesh.contains(required), "{required}");
        }
    }
    #[test]
    fn android_thin_overlay_does_not_inherit_desktop_main_capabilities() {
        let base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let overlay = android_thin_overlay_fixture();
        let base_caps = base["app"]["security"]["capabilities"].as_array().unwrap();
        assert!(!base_caps.iter().any(|cap| cap == "aurora-android-thin"));

        let overlay_caps = overlay["app"]["security"]["capabilities"]
            .as_array()
            .unwrap();
        assert_eq!(
            overlay_caps,
            &[json!("aurora-android-thin"), json!("aurora-mobile-mesh")]
        );
        assert!(!overlay_caps.iter().any(|cap| cap == "aurora-main"));
        assert!(!overlay_caps.iter().any(|cap| cap == "aurora-overlay"));

        let csp = overlay["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("connect-src 'self' https://gateway.example wss://signal.example"));
        assert!(!csp.contains("http://127.0.0.1"));
        assert!(!csp.contains("ws://localhost"));
        assert!(!csp.contains("https://*"));
        assert!(!csp.contains("wss://*"));
        assert!(!csp.contains("connect-src *"));

        assert_eq!(overlay["bundle"]["externalBin"], json!([]));
        assert_eq!(overlay["bundle"]["resources"], json!({}));
        let overlay_raw = overlay.to_string();
        assert!(!overlay_raw.contains("aurora-sidecar"));
        assert!(!overlay_raw.contains("config_defaults.json"));
        assert!(!overlay_raw.contains("app/services/config"));
    }

    fn android_thin_overlay_fixture() -> Value {
        json!({
            "build": {
                "beforeBuildCommand": "pnpm build:frontend:android-thin"
            },
            "app": {
                "security": {
                    "capabilities": ["aurora-android-thin", "aurora-mobile-mesh"],
                    "csp": "default-src 'self'; connect-src 'self' https://gateway.example wss://signal.example; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:"
                }
            },
            "bundle": {
                "externalBin": [],
                "resources": {},
                "longDescription": "Aurora Android thin packages the shared WebView HTTP/WebRTC app without Python, sidecar resources, or external binaries. Gateway and signaling endpoints are configured at runtime during onboarding and are not compiled into the artifact."
            }
        })
    }

    #[test]
    fn android_reconnect_adapter_preserves_snake_case_protocol_shape() {
        let fixture = serde_json::from_str::<Value>(include_str!(
            "../../../../tests/fixtures/webrtc_web_thin_protocol_vectors.json"
        ))
        .unwrap();
        let reconnect = &fixture["reconnect"];
        let inputs = &reconnect["inputs"];
        let request = ThinPeerReconnectProveRequest {
            peer_id: inputs["claimant_peer_id"].as_str().unwrap().to_string(),
            challenge: MeshReconnectChallengeFrame {
                r#type: "mesh_auth_challenge_v1".to_string(),
                challenge: inputs["challenge"].as_str().unwrap().to_string(),
                channel_binding: inputs["channel_binding"].as_str().unwrap().to_string(),
                claimant_peer_id: inputs["claimant_peer_id"].as_str().unwrap().to_string(),
                verifier_peer_id: inputs["verifier_peer_id"].as_str().unwrap().to_string(),
                claimant_signaling_peer_id: "sig-answer".to_string(),
                verifier_signaling_peer_id: "sig-offer".to_string(),
                room_name: inputs["room_name"].as_str().unwrap().to_string(),
            },
        };
        let android_payload = serde_json::to_value(&request).unwrap();
        assert!(android_payload["challenge"]
            .get("channel_binding")
            .is_some());
        assert!(android_payload["challenge"]
            .get("claimant_peer_id")
            .is_some());
        assert!(android_payload["challenge"].get("channelBinding").is_none());

        let plugin = include_str!(
            "../android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt"
        );
        for key in [
            "proof.put(\"token_id\"",
            "proof.put(\"channel_binding\"",
            "proof.put(\"claimant_peer_id\"",
            "proof.put(\"claimant_signaling_peer_id\", challenge.claimantSignalingPeerIdValue())",
            "proof.put(\"verifier_signaling_peer_id\", challenge.verifierSignalingPeerIdValue())",
            "proof.put(\"room_name\"",
            "channelBindingValue()",
        ] {
            assert!(plugin.contains(key), "{key}");
        }
        assert!(plugin
            .contains(r#"challenge.claimantPeerIdValue() == record.getString("claimantPeerId")"#));
        assert!(!plugin.contains(r#"challenge.claimantSignalingPeerIdValue() == record.getString("claimantSignalingPeerId")"#));
        assert!(!plugin.contains(r#"challenge.verifierSignalingPeerIdValue() == record.getString("verifierSignalingPeerId")"#));
        assert!(!plugin.contains(r#"\"claimant_signaling_peer_id\":${JSONObject.quote(challenge.claimantSignalingPeerIdValue())}"#));
        assert!(!plugin.contains(r#"\"verifier_signaling_peer_id\":${JSONObject.quote(challenge.verifierSignalingPeerIdValue())}"#));
        let android_proof = compute_reconnect_proof_hex(
            "synthetic-reconnect-token",
            &ThinPeerCredentialRecord {
                token_id: inputs["token_id"].as_str().unwrap().to_string(),
                claimant_peer_id: inputs["claimant_peer_id"].as_str().unwrap().to_string(),
                verifier_peer_id: inputs["verifier_peer_id"].as_str().unwrap().to_string(),
                claimant_signaling_peer_id: "stored-sig-answer".to_string(),
                verifier_signaling_peer_id: "stored-sig-offer".to_string(),
                room_name: inputs["room_name"].as_str().unwrap().to_string(),
                raw_bearer_token: "synthetic-reconnect-token".to_string(),
                created_at_ms: Some(1),
                expires_at_ms: None,
            },
            &request.challenge,
        )
        .unwrap();
        assert_eq!(
            android_proof,
            reconnect["hmac_sha256_hex"].as_str().unwrap()
        );
        assert_eq!(
            hex_encode(
                &build_mesh_reconnect_proof_message(
                    &ThinPeerCredentialRecord {
                        token_id: inputs["token_id"].as_str().unwrap().to_string(),
                        claimant_peer_id: inputs["claimant_peer_id"].as_str().unwrap().to_string(),
                        verifier_peer_id: inputs["verifier_peer_id"].as_str().unwrap().to_string(),
                        claimant_signaling_peer_id: "stored-sig-answer".to_string(),
                        verifier_signaling_peer_id: "stored-sig-offer".to_string(),
                        room_name: inputs["room_name"].as_str().unwrap().to_string(),
                        raw_bearer_token: "synthetic-reconnect-token".to_string(),
                        created_at_ms: Some(1),
                        expires_at_ms: None,
                    },
                    &request.challenge,
                )
                .unwrap()
            ),
            reconnect["message_hex"].as_str().unwrap()
        );
        let rotated_request = ThinPeerReconnectProveRequest {
            peer_id: request.peer_id.clone(),
            challenge: MeshReconnectChallengeFrame {
                claimant_signaling_peer_id: "rotated-claimant-sig".to_string(),
                verifier_signaling_peer_id: "rotated-verifier-sig".to_string(),
                ..request.challenge.clone()
            },
        };
        assert_eq!(
            android_proof,
            compute_reconnect_proof_hex(
                "synthetic-reconnect-token",
                &ThinPeerCredentialRecord {
                    token_id: inputs["token_id"].as_str().unwrap().to_string(),
                    claimant_peer_id: inputs["claimant_peer_id"].as_str().unwrap().to_string(),
                    verifier_peer_id: inputs["verifier_peer_id"].as_str().unwrap().to_string(),
                    claimant_signaling_peer_id: "stored-sig-answer".to_string(),
                    verifier_signaling_peer_id: "stored-sig-offer".to_string(),
                    room_name: inputs["room_name"].as_str().unwrap().to_string(),
                    raw_bearer_token: "synthetic-reconnect-token".to_string(),
                    created_at_ms: Some(1),
                    expires_at_ms: None,
                },
                &rotated_request.challenge,
            )
            .unwrap()
        );
    }

    #[test]
    fn sidecar_token_is_random_hex_and_not_empty() {
        let first = generate_sidecar_token().unwrap();
        let second = generate_sidecar_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn sidecar_token_generation_fails_closed_without_secure_entropy() {
        let error = generate_sidecar_token_from_entropy(|_| {
            Err(AuroraCommandError::SidecarProcess(
                "secure random generator unavailable: test entropy failure".to_string(),
            ))
        })
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("secure random generator unavailable"));
    }

    #[test]
    fn default_sidecar_working_dir_points_to_repo_root() {
        let cwd = sidecar_working_dir();
        assert!(cwd.join("main.py").is_file());
    }

    #[test]
    fn loopback_origin_rejects_non_loopback_hosts() {
        assert!(is_loopback_http_origin(
            &Url::parse("http://127.0.0.1:8000").unwrap()
        ));
        assert!(is_loopback_http_origin(
            &Url::parse("http://localhost:8000").unwrap()
        ));
        assert!(!is_loopback_http_origin(
            &Url::parse("https://aurora.example.test").unwrap()
        ));
    }

    #[test]
    fn release_constants_do_not_embed_secret_signing_material() {
        assert_eq!(BUNDLED_SIDECAR_NAME, "aurora-sidecar");
        assert!(UPDATER_ENDPOINT.starts_with("https://"));
        assert!(UPDATER_ENDPOINT.contains("{{target}}"));
        assert!(UPDATER_ENDPOINT.contains("{{arch}}"));
        assert!(UPDATER_ENDPOINT.contains("{{current_version}}"));
    }

    #[test]
    fn close_policy_hides_main_and_overlay_without_quitting() {
        assert_eq!(close_policy_for_label("main"), ClosePolicy::HideToTray);
        assert_eq!(
            close_policy_for_label(OVERLAY_WINDOW_LABEL),
            ClosePolicy::HideOverlay
        );
        assert_eq!(close_policy_for_label("settings"), ClosePolicy::AllowClose);
    }

    #[test]
    fn overlay_suppresses_when_main_window_is_focused() {
        assert!(should_suppress_overlay_for_main_focus(true));
        assert!(!should_suppress_overlay_for_main_focus(false));
    }

    #[test]
    fn overlay_native_passthrough_only_applies_when_hidden() {
        assert!(should_apply_overlay_passthrough_to_native(true, None, true));
        assert!(!should_apply_overlay_passthrough_to_native(
            false, None, true
        ));
        assert!(!should_apply_overlay_passthrough_to_native(
            true,
            Some(OverlayMode::Voice),
            true
        ));
        assert!(!should_apply_overlay_passthrough_to_native(
            true,
            Some(OverlayMode::Text),
            true
        ));
        assert!(!should_apply_overlay_passthrough_to_native(
            true, None, false
        ));
    }

    #[test]
    fn overlay_dimensions_are_component_sized() {
        assert_eq!(
            overlay_size_for_mode(OverlayMode::Voice),
            LogicalSize::new(220.0, 230.0)
        );
        assert_eq!(
            overlay_size_for_mode(OverlayMode::Text),
            LogicalSize::new(520.0, 360.0)
        );
    }

    #[test]
    fn overlay_default_positions_use_margin_and_work_area() {
        let origin = LogicalPosition::new(10.0, 20.0);
        let size = LogicalSize::new(1440.0, 900.0);
        assert_eq!(
            default_overlay_position(OverlayMode::Voice, origin, size),
            LogicalPosition::new(1206.0, 44.0)
        );
        assert_eq!(
            default_overlay_position(OverlayMode::Text, origin, size),
            LogicalPosition::new(470.0, 536.0)
        );
    }

    #[test]
    fn overlay_state_preserves_per_mode_user_positions() {
        let mut state = OverlayState::new();
        let voice = OverlayPoint { x: 100.0, y: 48.0 };
        let text = OverlayPoint { x: 460.0, y: 520.0 };
        state.save_position(OverlayMode::Voice, voice);
        state.save_position(OverlayMode::Text, text);
        assert_eq!(state.saved_position(OverlayMode::Voice), Some(voice));
        assert_eq!(state.saved_position(OverlayMode::Text), Some(text));
    }

    #[test]
    fn hotkey_parser_accepts_default_and_common_modifiers() {
        assert!(parse_overlay_shortcut_parts("CommandOrControl+K").is_ok());
        assert!(parse_overlay_shortcut_parts("Ctrl+Shift+1").is_ok());
        assert!(parse_overlay_shortcut_parts("Option+9").is_ok());
    }

    #[test]
    fn hotkey_parser_rejects_ambiguous_or_broad_inputs() {
        assert!(parse_overlay_shortcut_parts("K").is_err());
        assert!(parse_overlay_shortcut_parts("Ctrl+F12").is_err());
        assert!(parse_overlay_shortcut_parts("Ctrl+K+P").is_err());
        assert!(parse_overlay_shortcut_parts("Ctrl++K").is_err());
    }

    #[test]
    fn local_data_migrations_include_atomic_ledger_sql() {
        assert_eq!(
            generated::local_data_migrations::LOCAL_DATA_DATABASE_NAME,
            "aurora-lightweight.db"
        );
        assert_eq!(
            generated::local_data_migrations::LOCAL_DATA_LATEST_VERSION,
            3
        );
        for (index, generated) in generated::local_data_migrations::LOCAL_DATA_MIGRATIONS
            .iter()
            .enumerate()
        {
            assert_eq!(generated.version, u32::try_from(index + 1).unwrap());
            assert!(generated.sql.contains("PRAGMA foreign_keys = ON;"));
            assert!(generated.ledger_sql.contains("aurora_schema_migrations"));
            assert!(generated
                .ledger_sql
                .contains(&format!("PRAGMA user_version = {}", generated.version)));
        }
    }

    #[test]
    fn local_data_envelope_roundtrip_uses_nondeterministic_nonce_and_aad() {
        let key = [7_u8; 32];
        let key_id =
            local_data_envelope_key_id("profile-1", "node-1", LOCAL_DATA_ENVELOPE_KEY_PURPOSE, 1);
        let aad = br#"{"field":"payload","profileId":"profile-1"}"#;
        let first = encrypt_local_data_envelope(&key_id, &key, b"secret payload", aad).unwrap();
        let second = encrypt_local_data_envelope(&key_id, &key, b"secret payload", aad).unwrap();

        assert_eq!(first.version, 1);
        assert_eq!(first.algorithm, LOCAL_DATA_ENVELOPE_ALGORITHM);
        assert_eq!(
            decode_base64url_bytes(&first.nonce_b64_url).unwrap().len(),
            12
        );
        assert_ne!(first.nonce_b64_url, second.nonce_b64_url);
        assert_ne!(
            first.ciphertext_and_tag_b64_url,
            second.ciphertext_and_tag_b64_url
        );
        assert_eq!(
            decrypt_local_data_envelope(&first, &key, aad).unwrap(),
            b"secret payload"
        );
        assert!(decrypt_local_data_envelope(&first, &key, b"wrong aad").is_err());
    }

    #[test]
    fn local_data_envelope_rejects_tamper_and_wrong_key_scope() {
        let key = [3_u8; 32];
        let other_key = [4_u8; 32];
        let key_id =
            local_data_envelope_key_id("profile-1", "node-1", LOCAL_DATA_ENVELOPE_KEY_PURPOSE, 1);
        let mut envelope = encrypt_local_data_envelope(&key_id, &key, b"secret payload", b"aad")
            .expect("encrypt envelope");
        assert!(decrypt_local_data_envelope(&envelope, &other_key, b"aad").is_err());

        let mut ciphertext = decode_base64url_bytes(&envelope.ciphertext_and_tag_b64_url).unwrap();
        ciphertext[0] ^= 0x01;
        envelope.ciphertext_and_tag_b64_url = encode_base64url_bytes(&ciphertext);
        assert!(decrypt_local_data_envelope(&envelope, &key, b"aad").is_err());

        let binding = parse_local_data_envelope_key_id(&key_id).unwrap();
        assert_eq!(binding.profile_hash, sha256_hex("profile-1".as_bytes()));
        assert_eq!(binding.local_node_hash, sha256_hex("node-1".as_bytes()));
        assert_eq!(binding.purpose, LOCAL_DATA_ENVELOPE_KEY_PURPOSE);
        assert_eq!(binding.version, 1);
        assert!(parse_local_data_envelope_key_id("aurora.secure-storage.raw").is_err());
    }

    #[test]
    fn local_data_envelope_scope_uses_repository_id_rules_before_key_handles() {
        let oversized = "a".repeat(257);
        for invalid in [
            "",
            "profile with spaces",
            "profile#1",
            "profilé",
            &oversized,
        ] {
            assert!(
                validate_local_data_key_scope(LOCAL_DATA_ENVELOPE_KEY_PURPOSE, invalid, "node-1")
                    .is_err(),
                "profileId {invalid:?}"
            );
            assert!(
                validate_local_data_key_scope(
                    LOCAL_DATA_ENVELOPE_KEY_PURPOSE,
                    "profile-1",
                    invalid
                )
                .is_err(),
                "localNodeId {invalid:?}"
            );
        }

        assert!(validate_local_data_key_scope(
            LOCAL_DATA_ENVELOPE_KEY_PURPOSE,
            "profile_1.:@/-",
            "node_1.:@/-"
        )
        .is_ok());
    }

    #[test]
    fn local_data_envelope_decrypt_rejects_malformed_scope_before_key_lookup() {
        let malformed_profile_id = "profile with spaces";
        let local_node_id = "node-1";
        let key_id = local_data_envelope_key_id(
            malformed_profile_id,
            local_node_id,
            LOCAL_DATA_ENVELOPE_KEY_PURPOSE,
            1,
        );
        let binding = parse_local_data_envelope_key_id(&key_id).unwrap();
        assert_eq!(
            binding.profile_hash,
            sha256_hex(malformed_profile_id.as_bytes())
        );
        assert_eq!(
            binding.local_node_hash,
            sha256_hex(local_node_id.as_bytes())
        );

        let request = LocalDataEnvelopeDecryptRequest {
            profile_id: malformed_profile_id.to_string(),
            local_node_id: local_node_id.to_string(),
            envelope: LocalDataEnvelopeV1 {
                version: 1,
                algorithm: LOCAL_DATA_ENVELOPE_ALGORITHM.to_string(),
                key_id,
                nonce_b64_url: encode_base64url_bytes(&[1_u8; 12]),
                ciphertext_and_tag_b64_url: encode_base64url_bytes(&[2_u8; 16]),
                created_at_ms: 1,
            },
            aad_b64_url: encode_base64url_bytes(b"{}"),
        };

        let err = validate_local_data_decrypt_request(&request).unwrap_err();
        assert!(
            matches!(err, AuroraCommandError::SecureStorageKeyInvalid(message) if message == "profileId is invalid")
        );
    }

    #[test]
    fn bounded_native_action_inputs_reject_empty_and_oversized_values() {
        assert!(validate_native_text("hello", 5, "text").is_ok());
        assert!(validate_native_text("   ", 5, "text").is_err());
        assert!(validate_native_text("sixxxx", 5, "text").is_err());
    }

    #[test]
    fn native_deep_links_accept_only_bounded_platform_routes() {
        for allowed in [
            "https://aurora.example/path",
            "mailto:hello@aurora.example",
            "tel:+15551234567",
            "aurora://device/peer-1",
            "aurora-local://device/peer-1",
        ] {
            assert!(validate_native_deep_link(allowed).is_ok(), "{allowed}");
        }
        for denied in [
            "http://aurora.example",
            "file:///tmp/secret",
            "javascript:alert(1)",
            "https:///missing-host",
            "mailto:",
            "tel:",
        ] {
            assert!(validate_native_deep_link(denied).is_err(), "{denied}");
        }
    }
}
