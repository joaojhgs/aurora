use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{ser::SerializeStruct, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri::{AppHandle, Manager, State};
use thiserror::Error;
use url::Url;

const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:8000";
const NATIVE_MANIFEST_METHOD: &str = "Native.GetCapabilityManifest";
const SIDECAR_HEALTH_PATH: &str = "/api/health";
const SECURE_STORAGE_SERVICE: &str = "dev.aurora.desktop.secure-storage";
const BUNDLED_SIDECAR_NAME: &str = "aurora-sidecar";
const UPDATER_ENDPOINT: &str =
    "https://releases.aurora.local/latest/{{target}}/{{arch}}/{{current_version}}.json";

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarSession {
    token: String,
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

struct AuroraMobileNativePlugin<R: tauri::Runtime> {
    handle: Option<tauri::plugin::PluginHandle<R>>,
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

#[derive(Debug, Serialize)]
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

struct SidecarState {
    child: Option<Child>,
    started_at: Option<Instant>,
    token: String,
    last_error: Option<String>,
    last_health: Option<Value>,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            child: None,
            started_at: None,
            token: generate_sidecar_token(),
            last_error: None,
            last_health: None,
        }
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
    #[error("Aurora mobile native plugin call failed: {0}")]
    AuroraMobileNativePlugin(String),
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
    #[error("Secure storage operation failed: {0}")]
    SecureStorage(String),
}

impl Serialize for AuroraCommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("AuroraCommandError", 3)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.serialize_field(
            "detail",
            &json!({
                "code": self.code(),
                "message": self.to_string(),
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
) -> Result<AuroraEnvelope, AuroraCommandError> {
    aurora_command(request, state).await
}

#[tauri::command]
async fn aurora_command(
    request: AuroraRequest,
    state: State<'_, SharedSidecarState>,
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
    let client = reqwest::Client::new();
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

    let mut builder = client
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
            "HTTP {status}: {data}"
        )))
    }
}

#[tauri::command]
async fn aurora_subscribe(
    request: AuroraSubscribeRequest,
) -> Result<Vec<Value>, AuroraCommandError> {
    let topics = request.topics.join(",");
    let stream = request.stream.unwrap_or_else(|| "event".to_string());
    Err(AuroraCommandError::UnsupportedFeature(
        format!(
            "aurora_subscribe is deferred until BE-003 provides a unified event stream contract; stream={stream}, topics={topics}"
        ),
    ))
}

#[tauri::command]
async fn aurora_sidecar_start(
    state: State<'_, SharedSidecarState>,
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
            let child = spawn_sidecar(&gateway, &sidecar.token)?;
            sidecar.started_at = Some(Instant::now());
            sidecar.child = Some(child);
            sidecar.last_error = None;
        }
    }

    aurora_sidecar_status(state).await
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
    command_token: Option<SidecarCommandToken>,
) -> Result<SidecarStatus, AuroraCommandError> {
    verify_sidecar_command_token(command_token, &state)?;

    {
        let mut sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
        stop_sidecar(&mut sidecar)?;
    }

    aurora_sidecar_status(state).await
}

#[tauri::command]
async fn aurora_sidecar_status(
    state: State<'_, SharedSidecarState>,
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

    let health = check_gateway_health(&gateway).await;
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
        json!("explicit-prebuilt-artifact"),
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
async fn aurora_android_baseline_status() -> Result<AndroidBaselineStatus, AuroraCommandError> {
    let status = android_baseline_status();
    log_android_baseline_status(&status);
    Ok(status)
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

async fn native_capability_manifest_value(
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
        serde_json::to_string(&status).unwrap_or_else(|_| "{\"secretsRedacted\":true}".to_string())
    );
}

fn log_android_native_plugin_payload(payload: &Value) {
    const CHUNK_BYTES: usize = 900;

    let serialized =
        serde_json::to_string(payload).unwrap_or_else(|_| "{\"secretsRedacted\":true}".to_string());
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

fn log_ios_native_plugin_payload(command: &str, payload: &Value) {
    println!(
        "aurora_ios_native_plugin_command command={} payload={}",
        command,
        serde_json::to_string(payload).unwrap_or_else(|_| "{\"secretsRedacted\":true}".to_string())
    );
}

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
    })
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
        Ok(serde_json::to_value(BiometricAdminUnlockRequest {
            started: false,
            request_code: None,
            status,
            reason: "unsupported_platform".to_string(),
            secrets_redacted: true,
        })
        .map_err(|_| AuroraCommandError::InvalidGatewayResponse)?)
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
async fn aurora_shutdown(
    app: AppHandle,
    state: State<'_, SharedSidecarState>,
) -> Result<(), AuroraCommandError> {
    {
        let mut sidecar = state.lock().map_err(|_| AuroraCommandError::SidecarState)?;
        stop_sidecar(&mut sidecar)?;
    }
    app.exit(0);
    Ok(())
}

impl AuroraCommandError {
    fn code(&self) -> &'static str {
        match self {
            Self::InvalidGatewayOrigin(_) => "validation_error",
            Self::Gateway(_) => "transport_loss",
            Self::InvalidGatewayResponse => "validation_error",
            Self::NativePermissionMissing(_) => "native_permission_missing",
            Self::AuroraMobileNativePlugin(_) => "native_plugin_error",
            Self::UnsupportedFeature(_) => "unsupported_feature",
            Self::ThinModeSidecarDisabled => "unsupported_feature",
            Self::SidecarLoopbackRequired(_) => "validation_error",
            Self::SidecarTokenInvalid => "permission",
            Self::SidecarProcess(_) => "unavailable_service",
            Self::SidecarState => "transport_loss",
            Self::SecureStorageKeyInvalid(_) => "validation_error",
            Self::SecureStorage(_) => "secure_storage_error",
        }
    }
}

fn native_permission_missing(permission: &'static str) -> AuroraCommandError {
    AuroraCommandError::NativePermissionMissing(permission.to_string())
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
    permissions.insert("aurora.sidecarSession".to_string(), true);
    permissions.insert("aurora.sidecarStart".to_string(), true);
    permissions.insert("aurora.sidecarStop".to_string(), true);
    permissions.insert("aurora.shutdown".to_string(), true);
    permissions.insert("aurora.logTail".to_string(), true);
    permissions.insert("aurora.updater".to_string(), false);
    permissions.insert("aurora.secureStorage".to_string(), desktop_platform);
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
    permissions.insert("aurora.ios.shareExtension".to_string(), ios_platform);
    permissions.insert("aurora.ios.deepLinks".to_string(), ios_platform);
    permissions.insert("aurora.ios.widgets".to_string(), ios_platform);
    permissions.insert("aurora.ios.fileAssociations".to_string(), ios_platform);
    permissions.insert("aurora.ios.entrypointPayload".to_string(), ios_platform);

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
    capabilities.insert(
        "native.secureCredentialStorage".to_string(),
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
    capabilities.insert("ios.appIntents".to_string(), ios_platform);
    capabilities.insert("ios.shortcuts".to_string(), ios_platform);
    capabilities.insert("ios.shareExtension".to_string(), ios_platform);
    capabilities.insert("ios.deepLinks".to_string(), ios_platform);
    capabilities.insert("ios.widgets".to_string(), ios_platform);
    capabilities.insert("ios.fileAssociations".to_string(), ios_platform);
    capabilities.insert("ios.entrypointPayload".to_string(), ios_platform);
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
    NativeCapabilityManifest {
        platform: native_platform().to_string(),
        permissions,
        capabilities,
        permission_states: ios_state_map("aurora.ios.", ios_platform),
        capability_states: ios_state_map("ios.", ios_platform),
        mobile_integrations: ios_mobile_integrations(ios_platform),
        platform_limitations: ios_platform_limitations(),
        ios_invocation: ios_invocation_status(ios_platform),
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
            support: supported_path.to_string(),
            capability: "ios.shareExtension".to_string(),
            permission: Some("aurora.ios.shareExtension".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-004-native-manifest".to_string(),
            user_copy: "The share extension accepts user-selected text, URLs, and files, then hands redacted metadata to Aurora backend context ingestion.".to_string(),
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
            support: supported_path.to_string(),
            capability: "ios.widgets".to_string(),
            permission: Some("aurora.ios.widgets".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-004-native-manifest".to_string(),
            user_copy: "Widget actions open Aurora through app-owned entrypoints and do not execute assistant work in the extension process.".to_string(),
            verifier: "Xcode widget extension build plus simulator widget tap smoke".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "fileAssociations".to_string(),
            label: "iOS file associations".to_string(),
            support: "supported-path".to_string(),
            capability: "ios.fileAssociations".to_string(),
            permission: Some("aurora.ios.fileAssociations".to_string()),
            privacy_class: "personal".to_string(),
            evidence_source: "IOS-004-tauri-file-associations".to_string(),
            user_copy: "Tauri iOS file associations declare Aurora as a viewer for selected text, markdown, JSON, and Aurora exports.".to_string(),
            verifier: "Tauri mobile file association metadata plus simulator document-open smoke".to_string(),
        },
        NativeMobileIntegration {
            platform: "ios".to_string(),
            id: "siriReplacement".to_string(),
            label: "Siri replacement".to_string(),
            support: "unsupported".to_string(),
            capability: "ios.siriReplacement".to_string(),
            permission: None,
            privacy_class: "public".to_string(),
            evidence_source: "Apple-platform-policy".to_string(),
            user_copy: "iOS does not allow Aurora to replace Siri as the default assistant.".to_string(),
            verifier: "copy and capability review; no executable route should be exposed".to_string(),
        },
    ]
}

fn ios_invocation_status(available: bool) -> IosInvocationStatus {
    IosInvocationStatus {
        platform: "ios".to_string(),
        app_intents_available: available,
        shortcuts_available: available,
        share_extension_available: available,
        deep_links_available: available,
        widgets_available: available,
        file_associations_available: available,
        siri_replacement: false,
        backend_handoff_required: true,
        privacy_labels: vec!["personal".to_string(), "sensitive".to_string()],
        state: if available {
            "available".to_string()
        } else {
            "needs_native_permission".to_string()
        },
        reason: if available {
            "iOS invocation targets are present; backend evidence still decides whether intake was processed.".to_string()
        } else {
            "iOS invocation requires macOS/Xcode-generated targets and simulator/device proof before it can be claimed available.".to_string()
        },
        evidence_source: "IOS-004-native-manifest".to_string(),
        secrets_redacted: true,
    }
}

fn ios_native_entrypoints(available: bool) -> Vec<IosNativeEntrypoint> {
    let state = if available {
        "available".to_string()
    } else {
        "needs_native_permission".to_string()
    };
    vec![
        IosNativeEntrypoint {
            id: "ios_share_extension".to_string(),
            platform: "ios".to_string(),
            label: "iOS share extension".to_string(),
            state: state.clone(),
            available,
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
            reason: "Share extension target must hand redacted payload metadata to backend attachment/context ingestion.".to_string(),
        },
        IosNativeEntrypoint {
            id: "ios_deep_link".to_string(),
            platform: "ios".to_string(),
            label: "iOS deep link".to_string(),
            state: state.clone(),
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
            state: state.clone(),
            available,
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
            reason: "Widgets can open Aurora entrypoints but must not run orchestrator logic in the extension.".to_string(),
        },
        IosNativeEntrypoint {
            id: "ios_file_association".to_string(),
            platform: "ios".to_string(),
            label: "iOS file association".to_string(),
            state,
            available,
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
            reason: "File open events pass file URL metadata to the app; backend ingestion owns storage and redaction decisions.".to_string(),
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
        label: "No Siri replacement".to_string(),
        reason: "Apple permits app-owned App Intents, Shortcuts, widgets, share extensions, and deep links, not replacing Siri as the system assistant.".to_string(),
        user_copy: "Use Siri/Shortcuts/App Intents integration; do not claim Aurora replaces Siri.".to_string(),
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
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(
                    "dev.aurora.tauri.nativeplugin",
                    "AuroraNativePlugin",
                )?;
                app.manage(AuroraMobileNativePlugin::<R> {
                    handle: Some(handle),
                });
            }
            #[cfg(target_os = "ios")]
            {
                let handle = api.register_ios_plugin(init_plugin_aurora_native)?;
                app.manage(AuroraMobileNativePlugin::<R> {
                    handle: Some(handle),
                });
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                app.manage(AuroraMobileNativePlugin::<R> { handle: None });
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn run_android_plugin_command(
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
                "AND-001 proves Android packaging only; RoleManager qualification waits for AND-004 native probe evidence"
                    .to_string()
            } else {
                "Android assistant-role status is unsupported on this platform".to_string()
            },
        },
        fallback_entrypoints,
        evidence_source: "tauri-android-baseline".to_string(),
        secrets_redacted: true,
    }
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
    keyring::Entry::new(SECURE_STORAGE_SERVICE, key)
        .map_err(|error| AuroraCommandError::SecureStorage(error.to_string()))
}

fn validate_secure_storage_key(key: &str) -> Result<(), AuroraCommandError> {
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

fn gateway_url() -> Result<Url, AuroraCommandError> {
    let raw = env::var("AURORA_TAURI_REMOTE_GATEWAY_URL")
        .or_else(|_| env::var("AURORA_GATEWAY_URL"))
        .unwrap_or_else(|_| DEFAULT_GATEWAY_URL.to_string());
    let url =
        Url::parse(&raw).map_err(|_| AuroraCommandError::InvalidGatewayOrigin(raw.clone()))?;
    if is_loopback_http_origin(&url) || remote_gateway_allowed() {
        Ok(url)
    } else {
        Err(AuroraCommandError::InvalidGatewayOrigin(raw))
    }
}

fn remote_gateway_allowed() -> bool {
    env::var("AURORA_TAURI_ALLOW_REMOTE_GATEWAY").as_deref() == Ok("1")
}

fn is_thin_mode() -> bool {
    env::var("AURORA_TAURI_REMOTE_GATEWAY_URL").is_ok()
}

fn gateway_request_url(
    base: &Url,
    path: Option<&str>,
    method: &str,
) -> Result<Url, AuroraCommandError> {
    if let Some(path) = path {
        return base
            .join(path.trim_start_matches('/'))
            .map_err(|error| AuroraCommandError::Gateway(error.to_string()));
    }
    let route = method.replace('.', "/");
    base.join(&format!("api/methods/{route}"))
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))
}

fn filtered_headers(headers: Option<BTreeMap<String, String>>) -> HeaderMap {
    let mut output = HeaderMap::new();
    output.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    if let Ok(token) =
        env::var("AURORA_TAURI_GATEWAY_TOKEN").or_else(|_| env::var("AURORA_GATEWAY_TOKEN"))
    {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
            output.insert(AUTHORIZATION, value);
        }
    }

    for (key, value) in headers.unwrap_or_default() {
        let lower = key.to_ascii_lowercase();
        if !matches!(
            lower.as_str(),
            "x-correlation-id" | "x-request-id" | "content-type"
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

fn spawn_sidecar(gateway: &Url, token: &str) -> Result<Child, AuroraCommandError> {
    let mut command = Command::new(sidecar_program());
    command.args(sidecar_args());
    command.current_dir(sidecar_working_dir());
    command.env("AURORA_ARCHITECTURE_MODE", "threads");
    command.env("AURORA_TAURI_MANAGED_SIDECAR", "1");
    command.env("AURORA_GATEWAY_URL", gateway.to_string());
    command.env("AURORA_TAURI_SIDECAR_TOKEN", token);
    command.env("AURORA_CONFIG_FILE", sidecar_config_file(gateway)?);
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
    command
        .spawn()
        .map_err(|error| AuroraCommandError::SidecarProcess(error.to_string()))
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

async fn check_gateway_health(gateway: &Url) -> Result<Value, AuroraCommandError> {
    let url = gateway
        .join(SIDECAR_HEALTH_PATH.trim_start_matches('/'))
        .map_err(|error| AuroraCommandError::Gateway(error.to_string()))?;
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(2))
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
            "HTTP {status}: {value}"
        )))
    }
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

fn sidecar_config_file(gateway: &Url) -> Result<PathBuf, AuroraCommandError> {
    if let Ok(path) = env::var("AURORA_TAURI_SIDECAR_CONFIG_FILE") {
        return Ok(PathBuf::from(path));
    }

    let defaults_path = sidecar_working_dir()
        .join("app")
        .join("services")
        .join("config")
        .join("config_defaults.json");
    let defaults = fs::read_to_string(&defaults_path).map_err(|error| {
        AuroraCommandError::SidecarProcess(format!(
            "failed to read config defaults at {}: {error}",
            defaults_path.display()
        ))
    })?;
    let mut config: Value = serde_json::from_str(&defaults).map_err(|error| {
        AuroraCommandError::SidecarProcess(format!(
            "failed to parse config defaults at {}: {error}",
            defaults_path.display()
        ))
    })?;

    let gateway_config = config
        .pointer_mut("/services/gateway")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            AuroraCommandError::SidecarProcess(
                "config defaults are missing services.gateway".to_string(),
            )
        })?;
    gateway_config.insert("enabled".to_string(), json!(true));
    let api_config = gateway_config
        .get_mut("api")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            AuroraCommandError::SidecarProcess(
                "config defaults are missing services.gateway.api".to_string(),
            )
        })?;
    api_config.insert(
        "host".to_string(),
        json!(gateway.host_str().unwrap_or("127.0.0.1")),
    );
    if let Some(port) = gateway.port_or_known_default() {
        api_config.insert("port".to_string(), json!(port));
    }

    let path = env::temp_dir().join(format!(
        "aurora-tauri-sidecar-{}-config.json",
        std::process::id()
    ));
    let serialized = serde_json::to_string_pretty(&config).map_err(|error| {
        AuroraCommandError::SidecarProcess(format!("failed to serialize sidecar config: {error}"))
    })?;
    fs::write(&path, serialized).map_err(|error| {
        AuroraCommandError::SidecarProcess(format!(
            "failed to write sidecar config at {}: {error}",
            path.display()
        ))
    })?;
    Ok(path)
}

fn generate_sidecar_token() -> String {
    let mut bytes = [0_u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        let fallback = format!(
            "{}:{}:{:?}",
            std::process::id(),
            env!("CARGO_PKG_VERSION"),
            Instant::now()
        );
        return fallback
            .bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
    }
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn is_loopback_http_origin(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("::1")
        )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar_state: SharedSidecarState = Arc::new(Mutex::new(SidecarState::new()));
    tauri::Builder::default()
        .plugin(aurora_mobile_native_plugin())
        .manage(sidecar_state.clone())
        .setup(|app| {
            #[cfg(desktop)]
            install_tray(app.handle())?;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            aurora_request,
            aurora_command,
            aurora_subscribe,
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
            aurora_dialog_status,
            aurora_audio_bridge_status,
            aurora_android_baseline_status,
            aurora_android_native_plugin_payload,
            aurora_ios_native_plugin_manifest,
            aurora_ios_invocation_status,
            aurora_ios_entrypoint_payload,
            aurora_ios_invoke_action,
            aurora_log_tail,
            aurora_secure_storage_get,
            aurora_secure_storage_set,
            aurora_secure_storage_delete,
            aurora_ios_secure_storage_status,
            aurora_ios_biometric_status,
            aurora_ios_admin_unlock,
            aurora_biometric_admin_unlock_status,
            aurora_biometric_admin_unlock,
            aurora_local_file_read,
            aurora_local_file_write,
            aurora_local_file_pick,
            aurora_secure_file_handle_open,
            aurora_shutdown
        ])
        .on_window_event(move |_window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Ok(mut sidecar) = sidecar_state.lock() {
                    let _ = stop_sidecar(&mut sidecar);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Aurora Tauri shell");
}

#[cfg(desktop)]
fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Aurora", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("aurora-main")
        .tooltip("Aurora")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_manifest_advertises_sidecar_supervision_without_broad_native_access() {
        let manifest = native_capability_manifest();
        assert_eq!(
            manifest.capabilities.get("desktop.localSidecarSupervision"),
            Some(&true)
        );
        assert_eq!(manifest.permissions.get("aurora.sidecarStart"), Some(&true));
        assert_eq!(manifest.permissions.get("aurora.sidecarStop"), Some(&true));
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
                && integration.user_copy.contains("backend context ingestion")
        }));
        assert!(manifest.mobile_integrations.iter().any(|integration| {
            integration.id == "deepLinks" && integration.capability == "ios.deepLinks"
        }));
        assert!(manifest.mobile_integrations.iter().any(|integration| {
            integration.id == "widgets" && integration.capability == "ios.widgets"
        }));
        assert!(manifest.mobile_integrations.iter().any(|integration| {
            integration.id == "fileAssociations"
                && integration.capability == "ios.fileAssociations"
                && integration.support == "supported-path"
        }));
        assert_eq!(
            manifest.capabilities.get("ios.siriReplacement"),
            Some(&false)
        );
        assert_eq!(manifest.ios_invocation.siri_replacement, false);
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
        assert_eq!(status.assistant_role.probe_implemented, false);
        assert_eq!(status.assistant_role.role_available, None);
        assert_eq!(status.assistant_role.package_qualified, None);
        assert_eq!(status.assistant_role.role_held, None);
        assert_eq!(status.assistant_role.requestable, None);
        assert_eq!(status.secrets_redacted, true);
        assert_eq!(
            status.fallback_entrypoints.get("shareIntentPlanned"),
            Some(&false)
        );
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
    fn ios_native_plugin_surface_is_registered_and_permissioned() {
        let ios_capability = include_str!("../capabilities/aurora-ios-baseline.json");
        assert!(ios_capability.contains("\"aurora-ios-native-plugin\""));
        assert!(!ios_capability.contains("\"aurora-android-native-plugin\""));

        let ios_permission = include_str!("../permissions/aurora-ios-native-plugin.toml");
        assert!(ios_permission.contains("aurora_ios_native_plugin_manifest"));
        assert!(ios_permission.contains("aurora_ios_invocation_status"));
        assert!(ios_permission.contains("aurora_ios_entrypoint_payload"));
        assert!(ios_permission.contains("aurora_ios_invoke_action"));
        assert!(ios_permission.contains("aurora_ios_secure_storage_status"));
        assert!(ios_permission.contains("aurora_ios_biometric_status"));
        assert!(ios_permission.contains("aurora_ios_admin_unlock"));

        let swift_plugin = include_str!(
            "../ios/AuroraNativePlugin/Sources/AuroraNativePlugin/AuroraNativePlugin.swift"
        );
        assert!(swift_plugin.contains("@_cdecl(\"init_plugin_aurora_native\")"));
        assert!(swift_plugin.contains("nativeCapabilityManifest"));
        assert!(swift_plugin.contains("invocationStatus"));
        assert!(swift_plugin.contains("iosEntrypointPayload"));
        assert!(swift_plugin.contains("invokeAuroraAction"));
        assert!(swift_plugin.contains("iosSecureStorageStatus"));
        assert!(swift_plugin.contains("iosBiometricStatus"));
        assert!(swift_plugin.contains("iosAdminUnlock"));
        assert!(swift_plugin.contains("\"ios.shareExtension\": true"));
        assert!(swift_plugin.contains("\"ios.fileAssociations\": true"));
        assert!(swift_plugin.contains("\"ios.keychain.secureCredentialStorage\": true"));
        assert!(swift_plugin.contains("\"ios.biometric.adminUnlock\": true"));
        assert!(swift_plugin.contains("\"aurora.iosSiriReplacement\": false"));

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
    fn secure_storage_keys_are_limited_to_credential_namespaces() {
        for key in [
            "aurora.session",
            "aurora.session.gateway",
            "aurora.auth.refresh-token",
            "aurora.mesh.peer_01",
            "aurora.admin.unlock",
        ] {
            assert!(validate_secure_storage_key(key).is_ok(), "{key}");
        }

        for key in [
            "",
            "session",
            "aurora.config.secret",
            "aurora.session/../../token",
            "aurora.session.token value",
        ] {
            assert!(validate_secure_storage_key(key).is_err(), "{key}");
        }
    }

    #[test]
    fn sidecar_token_is_random_hex_and_not_empty() {
        let first = generate_sidecar_token();
        let second = generate_sidecar_token();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn default_sidecar_working_dir_points_to_repo_root() {
        let cwd = sidecar_working_dir();
        assert!(cwd.ends_with("aurora"));
    }

    #[test]
    fn generated_sidecar_config_enables_loopback_gateway() {
        let path = sidecar_config_file(&Url::parse("http://127.0.0.1:8765").unwrap()).unwrap();
        let config = fs::read_to_string(path).unwrap();
        let value: Value = serde_json::from_str(&config).unwrap();
        assert_eq!(
            value.pointer("/services/gateway/enabled"),
            Some(&json!(true))
        );
        assert_eq!(
            value.pointer("/services/gateway/api/host"),
            Some(&json!("127.0.0.1"))
        );
        assert_eq!(
            value.pointer("/services/gateway/api/port"),
            Some(&json!(8765))
        );
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
}
