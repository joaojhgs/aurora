use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use tauri::{AppHandle, Manager};
use thiserror::Error;
use url::Url;

const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:8000";
const NATIVE_MANIFEST_METHOD: &str = "Native.GetCapabilityManifest";

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

#[derive(Debug, Serialize)]
struct NativeCapabilityManifest {
    platform: String,
    permissions: BTreeMap<String, bool>,
    capabilities: BTreeMap<String, bool>,
}

#[derive(Debug, Error)]
enum AuroraCommandError {
    #[error("Gateway URL is not a valid HTTP loopback origin: {0}")]
    InvalidGatewayOrigin(String),
    #[error("Gateway request failed: {0}")]
    Gateway(String),
    #[error("Gateway response was not JSON")]
    InvalidGatewayResponse,
}

impl Serialize for AuroraCommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[tauri::command]
async fn aurora_request(request: AuroraRequest) -> Result<AuroraEnvelope, AuroraCommandError> {
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
async fn aurora_sidecar_status() -> Result<SidecarStatus, AuroraCommandError> {
    let gateway = gateway_url()?;
    let mut details = BTreeMap::new();
    details.insert("supervisionTask".to_string(), json!("TAURI-002"));
    details.insert("shellTask".to_string(), json!("TAURI-001"));
    details.insert(
        "loopbackHardened".to_string(),
        json!(is_loopback_http_origin(&gateway)),
    );

    Ok(SidecarStatus {
        running: false,
        mode: if env::var("AURORA_TAURI_REMOTE_GATEWAY_URL").is_ok() {
            "thin".to_string()
        } else {
            "desktop-local-pending-sidecar".to_string()
        },
        pid: None,
        gateway_url: Some(gateway.to_string()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        last_error: None,
        details,
    })
}

#[tauri::command]
async fn aurora_native_capability_manifest() -> Result<NativeCapabilityManifest, AuroraCommandError>
{
    Ok(native_capability_manifest())
}

#[tauri::command]
async fn aurora_shutdown(app: AppHandle) -> Result<(), AuroraCommandError> {
    app.exit(0);
    Ok(())
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
                redacted_fields: vec!["authorization".to_string(), "token".to_string()],
                warnings: Vec::new(),
            },
        },
    }
}

fn native_capability_manifest() -> NativeCapabilityManifest {
    let mut permissions = BTreeMap::new();
    permissions.insert("aurora.request".to_string(), true);
    permissions.insert("aurora.nativeCapabilityManifest".to_string(), true);
    permissions.insert("aurora.sidecarStatus".to_string(), true);
    permissions.insert("aurora.shutdown".to_string(), true);
    permissions.insert("aurora.secureStorage".to_string(), false);
    permissions.insert("aurora.localFileRead".to_string(), false);
    permissions.insert("aurora.localFileWrite".to_string(), false);
    permissions.insert("aurora.shell".to_string(), false);
    permissions.insert("aurora.processSpawn".to_string(), false);

    let mut capabilities = BTreeMap::new();
    capabilities.insert("desktop.thinGateway".to_string(), true);
    capabilities.insert("desktop.localSidecarHealth".to_string(), true);
    capabilities.insert("desktop.localSidecarSupervision".to_string(), false);
    capabilities.insert("native.secureCredentialStorage".to_string(), false);
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
    if is_loopback_http_origin(&url)
        || env::var("AURORA_TAURI_ALLOW_REMOTE_GATEWAY").as_deref() == Ok("1")
    {
        Ok(url)
    } else {
        Err(AuroraCommandError::InvalidGatewayOrigin(raw))
    }
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

fn is_loopback_http_origin(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("::1")
        )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            aurora_request,
            aurora_sidecar_status,
            aurora_native_capability_manifest,
            aurora_shutdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aurora Tauri shell");
}
