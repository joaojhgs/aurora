//! Native Gateway-backed microphone ownership handoff adapter.

use std::fmt;
use std::time::Duration;

use aurora_contracts::{ids, models};
use aurora_voice_core::{
    CancellationToken, CaptureOwnerKind, CaptureStartReason, Generation, RouteRevision,
    TimestampMicros, VoiceCaptureLease, VoiceCoreError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    MicrophoneAudioPolicy, NativeGatewayEndpointClass, NativeGatewayTransport,
    NativeRequestOptions, TransportError,
};

const CAPTURE_POLL_INTERVAL: Duration = Duration::from_millis(5);
const CAPTURE_REQUEST_ID_PREFIX: &str = "native-capture";
const DEFAULT_REQUESTED_TTL: u64 = 300;
const MIN_REQUESTED_TTL: u64 = 1;
const MAX_REQUESTED_TTL: u64 = 3600;

/// Bounded native-side identity and local capture metadata for Gateway handoff.
///
/// `prepare_lease_id` is capability material supplied by the platform host.
/// The native crate validates and redacts it but deliberately does not derive
/// or generate it; desktop/mobile hosts must provide fresh high-entropy opaque
/// material from their platform randomness source.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeGatewayCaptureHandoffConfig {
    owner_id: String,
    prepare_lease_id: String,
    requested_ttl_s: u64,
    surface: String,
    device_route: String,
    start_reason: CaptureStartReason,
    route_revision: RouteRevision,
    background_eligible: bool,
    consent_revision: u64,
}

impl NativeGatewayCaptureHandoffConfig {
    pub fn new(
        owner_id: impl Into<String>,
        prepare_lease_id: impl Into<String>,
        surface: impl Into<String>,
        device_route: impl Into<String>,
    ) -> Result<Self, VoiceCoreError> {
        let owner_id = owner_id.into();
        let prepare_lease_id = prepare_lease_id.into();
        let surface = surface.into();
        let device_route = device_route.into();
        validate_owner_id(&owner_id)?;
        validate_prepare_lease_token(&prepare_lease_id)?;
        validate_route_token(&surface)?;
        validate_route_token(&device_route)?;
        Ok(Self {
            owner_id,
            prepare_lease_id,
            requested_ttl_s: DEFAULT_REQUESTED_TTL,
            surface,
            device_route,
            start_reason: CaptureStartReason::PushToTalk,
            route_revision: RouteRevision(0),
            background_eligible: false,
            consent_revision: 0,
        })
    }

    pub fn with_requested_ttl(mut self, requested_ttl_s: u64) -> Result<Self, VoiceCoreError> {
        validate_requested_ttl(requested_ttl_s)?;
        self.requested_ttl_s = requested_ttl_s;
        Ok(self)
    }

    pub fn with_start_reason(mut self, start_reason: CaptureStartReason) -> Self {
        self.start_reason = start_reason;
        self
    }

    pub fn with_route_revision(mut self, route_revision: RouteRevision) -> Self {
        self.route_revision = route_revision;
        self
    }

    pub fn with_background_eligible(mut self, background_eligible: bool) -> Self {
        self.background_eligible = background_eligible;
        self
    }

    pub fn with_consent_revision(mut self, consent_revision: u64) -> Self {
        self.consent_revision = consent_revision;
        self
    }
}

impl fmt::Debug for NativeGatewayCaptureHandoffConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayCaptureHandoffConfig")
            .field("owner_id", &"[redacted]")
            .field("prepare_lease_id", &"[redacted]")
            .field("requested_ttl_s", &self.requested_ttl_s)
            .field("surface", &self.surface)
            .field("device_route", &"[redacted]")
            .field("start_reason", &self.start_reason)
            .field("route_revision", &self.route_revision)
            .field("background_eligible", &self.background_eligible)
            .field("consent_revision", &self.consent_revision)
            .finish()
    }
}

/// Redacted native grant returned after Python-side capture has been released.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeGatewayCaptureGrant {
    owner_id: String,
    lease_id: String,
    generation: Generation,
    surface: String,
    device_route: String,
    start_reason: CaptureStartReason,
    route_revision: RouteRevision,
    background_eligible: bool,
    consent_revision: u64,
}

impl NativeGatewayCaptureGrant {
    pub fn voice_capture_lease(&self, created_at: TimestampMicros) -> VoiceCaptureLease {
        VoiceCaptureLease {
            owner: CaptureOwnerKind::Native,
            surface: self.surface.clone(),
            device_route: self.device_route.clone(),
            start_reason: self.start_reason.clone(),
            generation: self.generation,
            created_at,
            route_revision: self.route_revision,
            background_eligible: self.background_eligible,
            consent_revision: self.consent_revision,
            heartbeat_at: created_at,
            stop_deadline: None,
        }
    }
}

impl fmt::Debug for NativeGatewayCaptureGrant {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayCaptureGrant")
            .field("owner_id", &"[redacted]")
            .field("lease_id", &"[redacted]")
            .field("generation", &"[redacted]")
            .field("surface", &self.surface)
            .field("device_route", &"[redacted]")
            .field("start_reason", &self.start_reason)
            .field("route_revision", &self.route_revision)
            .field("background_eligible", &self.background_eligible)
            .field("consent_revision", &self.consent_revision)
            .finish()
    }
}

/// Gateway adapter that owns exactly one native microphone handoff.
///
/// A prepare may be retried on this adapter until the backend response is
/// observed. After a successful release or cleanup, the adapter is consumed and
/// must not be reused for a later lease with the same host-supplied token.
pub struct NativeGatewayCaptureHandoff {
    transport: NativeGatewayTransport,
    config: NativeGatewayCaptureHandoffConfig,
    active: Option<ActiveCaptureLease>,
    last_released: Option<ReleasedCaptureLease>,
    active_cancellation: Option<CancellationToken>,
    consumed: bool,
}

impl NativeGatewayCaptureHandoff {
    pub fn new(
        transport: NativeGatewayTransport,
        config: NativeGatewayCaptureHandoffConfig,
    ) -> Result<Self, VoiceCoreError> {
        validate_loopback_transport(&transport)?;
        Ok(Self {
            transport,
            config,
            active: None,
            last_released: None,
            active_cancellation: None,
            consumed: false,
        })
    }

    pub async fn prepare(
        &mut self,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<NativeGatewayCaptureGrant, VoiceCoreError> {
        if self.active.is_some() {
            return Err(VoiceCoreError::OwnerAlreadyActive);
        }
        if self.consumed {
            return Err(consumed_handoff());
        }
        validate_loopback_transport(&self.transport)?;
        if cancellation() {
            return Err(VoiceCoreError::Cancelled);
        }

        let gateway_cancellation = CancellationToken::new();
        self.active_cancellation = Some(gateway_cancellation.clone());
        let result = self
            .invoke_prepare(&gateway_cancellation, cancellation)
            .await;
        self.active_cancellation = None;

        let grant = result?;
        self.last_released = None;
        self.active = Some(ActiveCaptureLease::from_grant(&grant));
        Ok(grant)
    }

    pub async fn release(
        &mut self,
        grant: &NativeGatewayCaptureGrant,
        restart_python_capture: bool,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<(), VoiceCoreError> {
        let Some(active) = self.active.clone() else {
            if self
                .last_released
                .as_ref()
                .is_some_and(|released| released.matches_grant(grant))
            {
                return Ok(());
            }
            return Err(VoiceCoreError::NoOwnerActive);
        };
        if !active.matches_grant(grant) {
            return Err(VoiceCoreError::OwnerMismatch);
        }
        self.release_active(active, restart_python_capture, cancellation)
            .await
    }

    pub async fn cleanup(&mut self, restart_python_capture: bool) -> Result<(), VoiceCoreError> {
        let Some(active) = self.active.clone() else {
            return Ok(());
        };
        self.release_active(active, restart_python_capture, &|| false)
            .await
    }

    pub fn cancel_active_prepare_or_release(&mut self) {
        if let Some(cancellation) = &self.active_cancellation {
            cancellation.cancel();
        }
    }

    async fn release_active(
        &mut self,
        active: ActiveCaptureLease,
        restart_python_capture: bool,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<(), VoiceCoreError> {
        validate_loopback_transport(&self.transport)?;
        if cancellation() {
            return Err(VoiceCoreError::Cancelled);
        }

        let gateway_cancellation = CancellationToken::new();
        self.active_cancellation = Some(gateway_cancellation.clone());
        let result = self
            .invoke_release(
                &active,
                restart_python_capture,
                &gateway_cancellation,
                cancellation,
            )
            .await;
        self.active_cancellation = None;
        result?;

        self.active = None;
        self.last_released = Some(ReleasedCaptureLease {
            owner_id: active.owner_id,
            lease_id: active.lease_id,
            generation: active.generation,
        });
        self.consumed = true;
        Ok(())
    }

    async fn invoke_prepare(
        &self,
        gateway_cancellation: &CancellationToken,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<NativeGatewayCaptureGrant, VoiceCoreError> {
        let options = prepare_options(&self.config.prepare_lease_id)?;
        let payload = prepare_payload(&self.config)?;
        let response = invoke_generated_with_cancellation(
            &self.transport,
            ids::STT_COORDINATOR_CAPTURE_PREPARE,
            payload,
            &options,
            gateway_cancellation,
            cancellation,
        )
        .await?;
        parse_prepare_response(&self.config, &response)
    }

    async fn invoke_release(
        &self,
        active: &ActiveCaptureLease,
        restart_python_capture: bool,
        gateway_cancellation: &CancellationToken,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<(), VoiceCoreError> {
        let options = release_options(active.generation.0)?;
        let payload = release_payload(active, restart_python_capture)?;
        let response = invoke_generated_with_cancellation(
            &self.transport,
            ids::STT_COORDINATOR_CAPTURE_RELEASE,
            payload,
            &options,
            gateway_cancellation,
            cancellation,
        )
        .await?;
        parse_release_response(active, &response)
    }
}

impl fmt::Debug for NativeGatewayCaptureHandoff {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayCaptureHandoff")
            .field("transport", &"[redacted]")
            .field("config", &self.config)
            .field("active", &self.active.as_ref().map(|_| "[redacted]"))
            .field(
                "last_released",
                &self.last_released.as_ref().map(|_| "[redacted]"),
            )
            .field("active_cancellation", &self.active_cancellation.is_some())
            .field("consumed", &self.consumed)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
struct ActiveCaptureLease {
    owner_id: String,
    lease_id: String,
    generation: Generation,
}

impl ActiveCaptureLease {
    fn from_grant(grant: &NativeGatewayCaptureGrant) -> Self {
        Self {
            owner_id: grant.owner_id.clone(),
            lease_id: grant.lease_id.clone(),
            generation: grant.generation,
        }
    }

    fn matches_grant(&self, grant: &NativeGatewayCaptureGrant) -> bool {
        self.owner_id == grant.owner_id
            && self.lease_id == grant.lease_id
            && self.generation == grant.generation
    }
}

#[derive(Clone, PartialEq, Eq)]
struct ReleasedCaptureLease {
    owner_id: String,
    lease_id: String,
    generation: Generation,
}

impl ReleasedCaptureLease {
    fn matches_grant(&self, grant: &NativeGatewayCaptureGrant) -> bool {
        self.owner_id == grant.owner_id
            && self.lease_id == grant.lease_id
            && self.generation == grant.generation
    }
}

fn validate_loopback_transport(transport: &NativeGatewayTransport) -> Result<(), VoiceCoreError> {
    let profile = transport.microphone_audio_profile();
    if profile.endpoint_class() == NativeGatewayEndpointClass::Loopback
        && profile.microphone_audio_policy() == MicrophoneAudioPolicy::LoopbackOnly
    {
        Ok(())
    } else {
        Err(VoiceCoreError::TransportFault {
            code: "unsafe_capture_endpoint".to_owned(),
        })
    }
}

fn prepare_payload(config: &NativeGatewayCaptureHandoffConfig) -> Result<Value, VoiceCoreError> {
    let payload = json!({
        "owner": "native",
        "owner_id": config.owner_id,
        "reason": "native_voice_runtime",
        "requested_ttl_s": config.requested_ttl_s,
        "lease_id": config.prepare_lease_id,
        "correlation_id": Value::Null,
    });
    let typed: models::SttCapturePrepareRequest =
        serde_json::from_value(payload).map_err(|_| invalid_payload())?;
    serde_json::to_value(typed).map_err(|_| invalid_payload())
}

fn release_payload(
    active: &ActiveCaptureLease,
    restart_python_capture: bool,
) -> Result<Value, VoiceCoreError> {
    let payload = json!({
        "owner": "native",
        "owner_id": active.owner_id,
        "lease_id": active.lease_id,
        "generation": active.generation.0,
        "reason": "native_release",
        "restart_python_capture": restart_python_capture,
        "correlation_id": Value::Null,
    });
    let typed: models::SttCaptureReleaseRequest =
        serde_json::from_value(payload).map_err(|_| invalid_payload())?;
    serde_json::to_value(typed).map_err(|_| invalid_payload())
}

async fn invoke_generated_with_cancellation(
    transport: &NativeGatewayTransport,
    method_id: &str,
    payload: Value,
    options: &NativeRequestOptions,
    gateway_cancellation: &CancellationToken,
    cancellation: &dyn Fn() -> bool,
) -> Result<Value, VoiceCoreError> {
    let invoke = transport.invoke_generated(method_id, payload, options, gateway_cancellation);
    tokio::pin!(invoke);

    let response = loop {
        tokio::select! {
            result = &mut invoke => break result.map_err(map_transport_error)?,
            () = tokio::time::sleep(CAPTURE_POLL_INTERVAL) => {
                if cancellation() {
                    gateway_cancellation.cancel();
                    return Err(VoiceCoreError::Cancelled);
                }
            }
        }
    };

    if cancellation() {
        gateway_cancellation.cancel();
        return Err(VoiceCoreError::Cancelled);
    }
    Ok(response)
}

fn parse_prepare_response(
    config: &NativeGatewayCaptureHandoffConfig,
    response: &Value,
) -> Result<NativeGatewayCaptureGrant, VoiceCoreError> {
    let typed: models::SttCapturePrepareResponse =
        serde_json::from_value(response.clone()).map_err(|_| invalid_response())?;
    let value = serde_json::to_value(typed).map_err(|_| invalid_response())?;
    let status = required_str(&value, "status")?;
    let granted = required_bool(&value, "granted")?;
    let owner = required_str(&value, "owner")?;
    let python_capture_active = required_bool(&value, "python_capture_active")?;
    let redacted = value
        .get("redacted")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if status == "unavailable" && !granted && redacted {
        return Err(VoiceCoreError::OwnerAlreadyActive);
    }
    if !matches!(status, "granted" | "already_owned")
        || !granted
        || owner != "native"
        || python_capture_active
        || !redacted
    {
        return Err(invalid_response());
    }
    let lease_id = required_str(&value, "lease_id")?;
    let generation = required_u64(&value, "generation")?;
    validate_opaque_token(lease_id)?;
    if lease_id != config.prepare_lease_id || generation == 0 || generation > 9_007_199_254_740_991
    {
        return Err(invalid_response());
    }
    Ok(NativeGatewayCaptureGrant {
        owner_id: config.owner_id.clone(),
        lease_id: lease_id.to_owned(),
        generation: Generation(generation),
        surface: config.surface.clone(),
        device_route: config.device_route.clone(),
        start_reason: config.start_reason.clone(),
        route_revision: config.route_revision,
        background_eligible: config.background_eligible,
        consent_revision: config.consent_revision,
    })
}

fn parse_release_response(
    active: &ActiveCaptureLease,
    response: &Value,
) -> Result<(), VoiceCoreError> {
    let typed: models::SttCaptureReleaseResponse =
        serde_json::from_value(response.clone()).map_err(|_| invalid_response())?;
    let value = serde_json::to_value(typed).map_err(|_| invalid_response())?;
    let status = required_str(&value, "status")?;
    let released = required_bool(&value, "released")?;
    let owner = required_str(&value, "owner")?;
    let redacted = value
        .get("redacted")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let generation = required_u64(&value, "generation")?;
    if !matches!(
        status,
        "released" | "already_released" | "python_unavailable"
    ) || !released
        || owner == "native"
        || !redacted
        || generation != active.generation.0.saturating_add(1)
    {
        return Err(invalid_response());
    }
    Ok(())
}

fn prepare_options(prepare_lease_id: &str) -> Result<NativeRequestOptions, VoiceCoreError> {
    let key = stable_token_hash(prepare_lease_id);
    NativeRequestOptions::new(format!("{CAPTURE_REQUEST_ID_PREFIX}-prepare"))
        .and_then(|options| {
            options.with_idempotency_key(format!("{CAPTURE_REQUEST_ID_PREFIX}-prepare-{key}"))
        })
        .map_err(map_transport_error)
}

fn release_options(generation: u64) -> Result<NativeRequestOptions, VoiceCoreError> {
    NativeRequestOptions::new(format!("{CAPTURE_REQUEST_ID_PREFIX}-release-{generation}"))
        .and_then(|options| {
            options.with_idempotency_key(format!(
                "{CAPTURE_REQUEST_ID_PREFIX}-release-generation-{generation}"
            ))
        })
        .map_err(map_transport_error)
}

fn validate_owner_id(value: &str) -> Result<(), VoiceCoreError> {
    if !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(VoiceCoreError::InvalidIdentifier)
    }
}

fn stable_token_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"aurora-native-capture-idempotency-v1");
    hasher.update([0]);
    hasher.update(value.as_bytes());
    hex_prefix(&hasher.finalize(), 24)
}

fn validate_prepare_lease_token(value: &str) -> Result<(), VoiceCoreError> {
    if value.len() >= 32 {
        validate_opaque_token(value)
    } else {
        Err(VoiceCoreError::InvalidIdentifier)
    }
}

fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let byte_count = chars.div_ceil(2).min(bytes.len());
    let mut out = String::with_capacity(byte_count * 2);
    for byte in &bytes[..byte_count] {
        out.push(char::from(HEX[(byte >> 4) as usize]));
        out.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    out.truncate(chars);
    out
}

fn validate_requested_ttl(value: u64) -> Result<(), VoiceCoreError> {
    if (MIN_REQUESTED_TTL..=MAX_REQUESTED_TTL).contains(&value) {
        Ok(())
    } else {
        Err(VoiceCoreError::InvalidIdentifier)
    }
}

fn validate_route_token(value: &str) -> Result<(), VoiceCoreError> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b':' | b'-' | b'/'))
    {
        Ok(())
    } else {
        Err(VoiceCoreError::InvalidIdentifier)
    }
}

fn validate_opaque_token(value: &str) -> Result<(), VoiceCoreError> {
    if !value.is_empty()
        && value.len() <= 128
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        Ok(())
    } else {
        Err(invalid_response())
    }
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, VoiceCoreError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(invalid_response)
}

fn required_u64(value: &Value, field: &str) -> Result<u64, VoiceCoreError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(invalid_response)
}

fn required_bool(value: &Value, field: &str) -> Result<bool, VoiceCoreError> {
    value
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(invalid_response)
}

fn map_transport_error(error: TransportError) -> VoiceCoreError {
    if error == TransportError::Cancelled {
        VoiceCoreError::Cancelled
    } else {
        VoiceCoreError::TransportFault {
            code: error.code().to_owned(),
        }
    }
}

fn invalid_payload() -> VoiceCoreError {
    VoiceCoreError::TransportFault {
        code: "invalid_payload".to_owned(),
    }
}

fn invalid_response() -> VoiceCoreError {
    VoiceCoreError::TransportFault {
        code: "invalid_response".to_owned(),
    }
}

fn consumed_handoff() -> VoiceCoreError {
    VoiceCoreError::TransportFault {
        code: "capture_handoff_consumed".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use std::thread;

    use super::*;
    use url::Url;

    struct FixtureServer {
        base_url: Url,
        address: SocketAddr,
        requests: mpsc::Receiver<String>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl FixtureServer {
        fn responses(responses: Vec<Vec<u8>>) -> Self {
            Self::responses_with_first_request_flag(responses, None, Duration::ZERO)
        }

        fn responses_with_first_request_flag(
            responses: Vec<Vec<u8>>,
            first_request_received: Option<Arc<AtomicBool>>,
            first_response_delay: Duration,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
            let address = listener.local_addr().expect("fixture address");
            let (sender, requests) = mpsc::channel();
            let thread = thread::spawn(move || {
                for (index, response) in responses.into_iter().enumerate() {
                    let (mut stream, _) = listener.accept().expect("accept fixture request");
                    let captured = read_http_request(&mut stream);
                    sender.send(captured).expect("capture request");
                    if index == 0 {
                        if let Some(flag) = &first_request_received {
                            flag.store(true, Ordering::SeqCst);
                        }
                        if !first_response_delay.is_zero() {
                            thread::sleep(first_response_delay);
                        }
                    }
                    stream.write_all(&response).expect("write fixture response");
                }
            });
            Self {
                base_url: Url::parse(&format!("http://{address}/")).expect("fixture URL"),
                address,
                requests,
                thread: Some(thread),
            }
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(50));
                thread.join().expect("join fixture server");
            }
        }
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = stream.read(&mut buffer).expect("read fixture request");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn json_response(body: Value) -> Vec<u8> {
        let body = body.to_string();
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.into_bytes())
        .collect()
    }

    fn slow_json_response(body: Value) -> Vec<u8> {
        let body = body.to_string();
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_bytes()
    }

    fn prepare_body(status: &str, granted: bool, lease_id: Option<&str>, generation: u64) -> Value {
        json!({
            "generation": generation,
            "granted": granted,
            "lease_id": lease_id,
            "message": status,
            "owner": if granted { "native" } else { "python" },
            "python_capture_active": !granted,
            "redacted": true,
            "status": status,
            "stopped_python_capture": granted,
        })
    }

    fn release_body(status: &str, generation: u64) -> Value {
        json!({
            "generation": generation,
            "message": status,
            "owner": "none",
            "python_capture_active": false,
            "redacted": true,
            "released": true,
            "restarted_python_capture": false,
            "status": status,
        })
    }

    fn transport(base_url: Url, policy: MicrophoneAudioPolicy) -> NativeGatewayTransport {
        NativeGatewayTransport::new(
            base_url,
            crate::GatewayAuth::Bearer("secret-token".to_owned()),
            crate::TransportLimits {
                allow_loopback_http: true,
                microphone_audio_policy: policy,
                ..crate::TransportLimits::default()
            },
        )
        .expect("transport")
    }

    fn config(owner_id: &str) -> NativeGatewayCaptureHandoffConfig {
        config_with_token(
            owner_id,
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
    }

    fn config_with_token(owner_id: &str, token: &str) -> NativeGatewayCaptureHandoffConfig {
        NativeGatewayCaptureHandoffConfig::new(owner_id, token, "desktop-local", "default-input")
            .expect("config")
            .with_requested_ttl(30)
            .expect("ttl")
            .with_start_reason(CaptureStartReason::PushToTalk)
            .with_route_revision(RouteRevision(7))
            .with_background_eligible(false)
            .with_consent_revision(3)
    }

    fn request_body(request: &str) -> Value {
        let (_, body) = request.split_once("\r\n\r\n").expect("request body");
        serde_json::from_str(body).expect("JSON body")
    }

    #[tokio::test]
    async fn prepare_and_release_use_typed_generated_contracts() {
        let server = FixtureServer::responses(vec![
            json_response(prepare_body(
                "granted",
                true,
                Some("host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                11,
            )),
            json_response(release_body("released", 12)),
        ]);
        let mut adapter = NativeGatewayCaptureHandoff::new(
            transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config("tauri-local"),
        )
        .expect("adapter");

        let grant = adapter.prepare(&|| false).await.expect("prepare");
        let lease = grant.voice_capture_lease(TimestampMicros(123));
        assert_eq!(lease.owner, CaptureOwnerKind::Native);
        assert_eq!(lease.generation, Generation(11));
        assert_eq!(lease.route_revision, RouteRevision(7));

        let prepare_request = server.requests.recv().expect("prepare request");
        let prepare = request_body(&prepare_request);
        assert!(prepare_request.contains("POST /api/STTCoordinator/CapturePrepare"));
        assert_eq!(prepare["owner"], "native");
        assert_eq!(prepare["owner_id"], "tauri-local");
        assert_eq!(prepare["requested_ttl_s"], 30);
        assert_eq!(
            prepare["lease_id"],
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );

        adapter
            .release(&grant, false, &|| false)
            .await
            .expect("release");
        let release_request = server.requests.recv().expect("release request");
        let release = request_body(&release_request);
        assert!(release_request.contains("POST /api/STTCoordinator/CaptureRelease"));
        assert_eq!(release["owner"], "native");
        assert_eq!(release["owner_id"], "tauri-local");
        assert_eq!(
            release["lease_id"],
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(release["generation"], 11);
        assert_eq!(release["restart_python_capture"], false);
    }

    #[tokio::test]
    async fn identical_owner_surface_device_configs_require_distinct_supplied_tokens() {
        let token_a = "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let token_b = "host-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let first = FixtureServer::responses(vec![
            json_response(prepare_body("granted", true, Some(token_a), 11)),
            json_response(release_body("released", 12)),
        ]);
        let second = FixtureServer::responses(vec![
            json_response(prepare_body("granted", true, Some(token_b), 21)),
            json_response(release_body("released", 22)),
        ]);
        let mut first_adapter = NativeGatewayCaptureHandoff::new(
            transport(first.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config_with_token("tauri-local", token_a),
        )
        .expect("first adapter");
        let mut second_adapter = NativeGatewayCaptureHandoff::new(
            transport(second.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config_with_token("tauri-local", token_b),
        )
        .expect("second adapter");

        let first_grant = first_adapter
            .prepare(&|| false)
            .await
            .expect("first prepare");
        let second_grant = second_adapter
            .prepare(&|| false)
            .await
            .expect("second prepare");
        assert_eq!(
            request_body(&first.requests.recv().expect("first request"))["lease_id"],
            token_a
        );
        assert_eq!(
            request_body(&second.requests.recv().expect("second request"))["lease_id"],
            token_b
        );
        first_adapter
            .release(&first_grant, false, &|| false)
            .await
            .expect("first release");
        second_adapter
            .release(&second_grant, false, &|| false)
            .await
            .expect("second release");
    }

    #[tokio::test]
    async fn remote_endpoint_is_rejected_even_with_remote_audio_policy() {
        let remote = NativeGatewayTransport::new(
            Url::parse("https://example.com/").expect("remote URL"),
            crate::GatewayAuth::None,
            crate::TransportLimits {
                microphone_audio_policy: MicrophoneAudioPolicy::ExplicitRemoteConsent,
                ..crate::TransportLimits::default()
            },
        )
        .expect("transport");

        let error = NativeGatewayCaptureHandoff::new(remote, config("tauri-local"))
            .expect_err("remote rejected");
        assert!(
            matches!(error, VoiceCoreError::TransportFault { code } if code == "unsafe_capture_endpoint")
        );
    }

    #[tokio::test]
    async fn unavailable_prepare_does_not_store_active_lease() {
        let server = FixtureServer::responses(vec![
            json_response(prepare_body("unavailable", false, None, 4)),
            json_response(prepare_body(
                "granted",
                true,
                Some("host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                5,
            )),
        ]);
        let mut adapter = NativeGatewayCaptureHandoff::new(
            transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config("tauri-local"),
        )
        .expect("adapter");

        let error = adapter.prepare(&|| false).await.expect_err("unavailable");
        assert_eq!(error, VoiceCoreError::OwnerAlreadyActive);
        let grant = adapter
            .prepare(&|| false)
            .await
            .expect("second prepare can try again");
        assert_eq!(
            grant.voice_capture_lease(TimestampMicros(0)).generation,
            Generation(5)
        );
    }

    #[tokio::test]
    async fn malformed_or_mismatched_prepare_response_is_rejected() {
        for body in [
            json!({"status":"granted"}),
            prepare_body("granted", true, None, 11),
            json!({
                "generation": 11,
                "granted": true,
                "lease_id": "lease",
                "owner": "python",
                "python_capture_active": false,
                "redacted": true,
                "status": "granted"
            }),
            json!({
                "generation": 11,
                "granted": true,
                "lease_id": "lease",
                "owner": "native",
                "python_capture_active": false,
                "redacted": false,
                "status": "granted"
            }),
        ] {
            let server = FixtureServer::responses(vec![json_response(body)]);
            let mut adapter = NativeGatewayCaptureHandoff::new(
                transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
                config("tauri-local"),
            )
            .expect("adapter");
            assert!(matches!(
                adapter.prepare(&|| false).await,
                Err(VoiceCoreError::TransportFault { code }) if code == "invalid_response"
            ));
        }
    }

    #[tokio::test]
    async fn cancellation_does_not_record_active_lease() {
        let first_request_received = Arc::new(AtomicBool::new(false));
        let server = FixtureServer::responses_with_first_request_flag(
            vec![
                slow_json_response(prepare_body(
                    "granted",
                    true,
                    Some("host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                    11,
                )),
                json_response(prepare_body(
                    "already_owned",
                    true,
                    Some("host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                    11,
                )),
                json_response(release_body("released", 12)),
            ],
            Some(first_request_received.clone()),
            Duration::from_millis(50),
        );
        let mut adapter = NativeGatewayCaptureHandoff::new(
            transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config("tauri-local"),
        )
        .expect("adapter");

        let error = adapter
            .prepare(&|| first_request_received.load(Ordering::SeqCst))
            .await
            .expect_err("cancelled");
        assert_eq!(error, VoiceCoreError::Cancelled);
        let first_request = server.requests.recv().expect("cancelled prepare request");
        assert_eq!(
            request_body(&first_request)["lease_id"],
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );

        let grant = adapter.prepare(&|| false).await.expect("retry prepare");
        let retry_request = server.requests.recv().expect("retry prepare request");
        assert_eq!(
            request_body(&retry_request)["lease_id"],
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            grant.voice_capture_lease(TimestampMicros(0)).generation,
            Generation(11)
        );
        adapter.cleanup(false).await.expect("cleanup release");
        let release_request = server.requests.recv().expect("cleanup release request");
        let release = request_body(&release_request);
        assert_eq!(
            release["lease_id"],
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(release["generation"], 11);
    }

    #[tokio::test]
    async fn repeat_prepare_is_excluded_until_release() {
        let server = FixtureServer::responses(vec![
            json_response(prepare_body(
                "granted",
                true,
                Some("host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                11,
            )),
            json_response(release_body("released", 12)),
        ]);
        let mut adapter = NativeGatewayCaptureHandoff::new(
            transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config("tauri-local"),
        )
        .expect("adapter");

        let grant = adapter.prepare(&|| false).await.expect("prepare");
        assert_eq!(
            adapter.prepare(&|| false).await.expect_err("repeat"),
            VoiceCoreError::OwnerAlreadyActive
        );
        adapter
            .release(&grant, false, &|| false)
            .await
            .expect("release");
        assert!(matches!(
            adapter.prepare(&|| false).await,
            Err(VoiceCoreError::TransportFault { code }) if code == "capture_handoff_consumed"
        ));
    }

    #[tokio::test]
    async fn release_is_idempotent_and_cleanup_supports_setup_failure() {
        let server = FixtureServer::responses(vec![
            json_response(prepare_body(
                "granted",
                true,
                Some("host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                11,
            )),
            json_response(release_body("python_unavailable", 12)),
        ]);
        let mut adapter = NativeGatewayCaptureHandoff::new(
            transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config("tauri-local"),
        )
        .expect("adapter");

        let grant = adapter.prepare(&|| false).await.expect("prepare");
        adapter.cleanup(true).await.expect("cleanup release");
        adapter
            .release(&grant, true, &|| false)
            .await
            .expect("idempotent repeated release");
        adapter.cleanup(true).await.expect("idempotent cleanup");
        assert!(matches!(
            adapter.prepare(&|| false).await,
            Err(VoiceCoreError::TransportFault { code }) if code == "capture_handoff_consumed"
        ));
    }

    #[tokio::test]
    async fn mismatched_release_response_is_rejected_without_forgetting_active_lease() {
        let server = FixtureServer::responses(vec![
            json_response(prepare_body(
                "granted",
                true,
                Some("host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                11,
            )),
            json_response(release_body("released", 99)),
            json_response(release_body("released", 12)),
        ]);
        let mut adapter = NativeGatewayCaptureHandoff::new(
            transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config("tauri-local"),
        )
        .expect("adapter");
        let grant = adapter.prepare(&|| false).await.expect("prepare");

        assert!(matches!(
            adapter.release(&grant, false, &|| false).await,
            Err(VoiceCoreError::TransportFault { code }) if code == "invalid_response"
        ));
        adapter
            .release(&grant, false, &|| false)
            .await
            .expect("exact release still possible");
    }

    #[test]
    fn owner_ttl_and_debug_output_are_bounded_and_redacted() {
        assert!(NativeGatewayCaptureHandoffConfig::new(
            "bad owner",
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "desktop",
            "device"
        )
        .is_err());
        assert!(NativeGatewayCaptureHandoffConfig::new(
            "tauri-local",
            "short-token",
            "desktop",
            "device"
        )
        .is_err());
        assert!(NativeGatewayCaptureHandoffConfig::new(
            "tauri-local",
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "desktop",
            "device"
        )
        .expect("config")
        .with_requested_ttl(0)
        .is_err());

        let grant = NativeGatewayCaptureGrant {
            owner_id: "owner-secret".to_owned(),
            lease_id: "lease-secret".to_owned(),
            generation: Generation(44),
            surface: "desktop".to_owned(),
            device_route: "private-device".to_owned(),
            start_reason: CaptureStartReason::PushToTalk,
            route_revision: RouteRevision(1),
            background_eligible: false,
            consent_revision: 1,
        };
        let debug = format!("{grant:?}");
        assert!(!debug.contains("owner-secret"));
        assert!(!debug.contains("lease-secret"));
        assert!(!debug.contains("44"));
        assert!(!debug.contains("private-device"));

        let server = FixtureServer::responses(Vec::new());
        let adapter = NativeGatewayCaptureHandoff::new(
            transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config("owner-secret"),
        )
        .expect("adapter");
        let debug = format!("{adapter:?}");
        for secret in [
            "127.0.0.1",
            &server.address.port().to_string(),
            "secret-token",
            "owner-secret",
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "lease-secret",
            "44",
            "default-input",
        ] {
            assert!(!debug.contains(secret), "debug leaked {secret}");
        }
        let error = NativeGatewayCaptureHandoffConfig::new(
            "tauri-local",
            "short-token",
            "desktop",
            "device",
        )
        .expect_err("short token rejected");
        assert!(!format!("{error:?}").contains("short-token"));
    }
}
