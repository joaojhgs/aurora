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
use tauri::{AppHandle, State};
use thiserror::Error;
use url::Url;

const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:8000";
const NATIVE_MANIFEST_METHOD: &str = "Native.GetCapabilityManifest";
const SIDECAR_HEALTH_PATH: &str = "/api/health";

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
struct NativeCapabilityManifest {
    platform: String,
    permissions: BTreeMap<String, bool>,
    capabilities: BTreeMap<String, bool>,
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
    details.insert("healthPath".to_string(), json!(SIDECAR_HEALTH_PATH));
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
async fn aurora_native_capability_manifest() -> Result<NativeCapabilityManifest, AuroraCommandError>
{
    Ok(native_capability_manifest())
}

#[tauri::command]
async fn native_capabilities() -> Result<NativeCapabilityManifest, AuroraCommandError> {
    Ok(native_capability_manifest())
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
async fn aurora_secure_storage_get(key: String) -> Result<Value, AuroraCommandError> {
    let _ = key;
    Err(native_permission_missing("aurora.secureStorage"))
}

#[tauri::command]
async fn aurora_secure_storage_set(
    key: String,
    value: String,
) -> Result<Value, AuroraCommandError> {
    let _ = (key, value);
    Err(native_permission_missing("aurora.secureStorage"))
}

#[tauri::command]
async fn aurora_secure_storage_delete(key: String) -> Result<Value, AuroraCommandError> {
    let _ = key;
    Err(native_permission_missing("aurora.secureStorage"))
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
            Self::UnsupportedFeature(_) => "unsupported_feature",
            Self::ThinModeSidecarDisabled => "unsupported_feature",
            Self::SidecarLoopbackRequired(_) => "validation_error",
            Self::SidecarTokenInvalid => "permission",
            Self::SidecarProcess(_) => "unavailable_service",
            Self::SidecarState => "transport_loss",
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
    permissions.insert("aurora.secureStorage".to_string(), false);
    permissions.insert("aurora.localFileRead".to_string(), false);
    permissions.insert("aurora.localFileWrite".to_string(), false);
    permissions.insert("aurora.secureFileHandle".to_string(), false);
    permissions.insert("aurora.shell".to_string(), false);
    permissions.insert("aurora.processSpawn".to_string(), false);

    let mut capabilities = BTreeMap::new();
    capabilities.insert("desktop.thinGateway".to_string(), true);
    capabilities.insert("desktop.localSidecarHealth".to_string(), true);
    capabilities.insert("desktop.logTail".to_string(), false);
    capabilities.insert("desktop.localSidecarSupervision".to_string(), true);
    capabilities.insert("native.secureCredentialStorage".to_string(), false);
    capabilities.insert("native.secureFileHandles".to_string(), false);
    capabilities.insert("native.filesystem".to_string(), false);
    capabilities.insert("native.audio".to_string(), false);

    NativeCapabilityManifest {
        platform: "tauri-desktop".to_string(),
        permissions,
        capabilities,
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
        .manage(sidecar_state.clone())
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
            aurora_log_tail,
            aurora_secure_storage_get,
            aurora_secure_storage_set,
            aurora_secure_storage_delete,
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
        assert_eq!(manifest.permissions.get("aurora.shell"), Some(&false));
        assert_eq!(
            manifest.permissions.get("aurora.localFileWrite"),
            Some(&false)
        );
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
}
