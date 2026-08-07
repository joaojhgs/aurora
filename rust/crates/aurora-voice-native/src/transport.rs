//! Generated-contract HTTP and SSE transport for a native-owned voice turn.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use aurora_contracts::{event_by_topic, method_by_id, normalize_generated_contract, schema_by_id};
use aurora_voice_core::{CancellationToken, Generation, SpeechTransport, VoiceCoreError};
use reqwest::header::{HeaderMap, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;
use url::Url;

const EVENT_STREAM_PATH: &str = "api/events/stream";
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_FILTER_COUNT: usize = 16;
const MAX_FILTER_LENGTH: usize = 256;

/// Authentication material supplied by approved platform credential storage.
#[derive(Clone, PartialEq, Eq)]
pub enum GatewayAuth {
    None,
    Bearer(String),
    ApiKey(String),
}

impl fmt::Debug for GatewayAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::None => "GatewayAuth::None",
            Self::Bearer(_) => "GatewayAuth::Bearer([redacted])",
            Self::ApiKey(_) => "GatewayAuth::ApiKey([redacted])",
        })
    }
}

impl GatewayAuth {
    fn validate(&self) -> Result<(), TransportError> {
        match self {
            Self::None => Ok(()),
            Self::Bearer(value) | Self::ApiKey(value)
                if !value.trim().is_empty() && value.len() <= 4096 =>
            {
                Ok(())
            }
            Self::Bearer(_) | Self::ApiKey(_) => Err(TransportError::InvalidConfiguration),
        }
    }

    fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self {
            Self::None => request,
            Self::Bearer(value) => request.header(AUTHORIZATION, format!("Bearer {value}")),
            Self::ApiKey(value) => request.header("X-API-Key", value),
        }
    }
}

/// Hard request, response, stream, and timeout limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransportLimits {
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub max_event_bytes: usize,
    pub request_timeout: Duration,
    pub stream_idle_timeout: Duration,
    pub allow_loopback_http: bool,
    pub allow_remote_microphone_audio: bool,
}

impl Default for TransportLimits {
    fn default() -> Self {
        Self {
            max_request_bytes: 2 * 1024 * 1024,
            max_response_bytes: 8 * 1024 * 1024,
            max_event_bytes: 2 * 1024 * 1024,
            request_timeout: Duration::from_secs(30),
            stream_idle_timeout: Duration::from_secs(45),
            allow_loopback_http: false,
            allow_remote_microphone_audio: false,
        }
    }
}

impl TransportLimits {
    fn validate(self) -> Result<Self, TransportError> {
        if self.max_request_bytes == 0
            || self.max_response_bytes == 0
            || self.max_event_bytes == 0
            || self.request_timeout.is_zero()
            || self.stream_idle_timeout.is_zero()
        {
            return Err(TransportError::InvalidConfiguration);
        }
        Ok(self)
    }
}

/// Stable request metadata without credentials or payload data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeRequestOptions {
    request_id: String,
    idempotency_key: Option<String>,
    timeout: Option<Duration>,
}

impl NativeRequestOptions {
    pub fn new(request_id: impl Into<String>) -> Result<Self, TransportError> {
        let request_id = request_id.into();
        validate_identifier(&request_id)?;
        Ok(Self {
            request_id,
            idempotency_key: None,
            timeout: None,
        })
    }

    pub fn with_idempotency_key(
        mut self,
        value: impl Into<String>,
    ) -> Result<Self, TransportError> {
        let value = value.into();
        validate_identifier(&value)?;
        self.idempotency_key = Some(value);
        Ok(self)
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Result<Self, TransportError> {
        if timeout.is_zero() {
            return Err(TransportError::InvalidConfiguration);
        }
        self.timeout = Some(timeout);
        Ok(self)
    }
}

/// A bounded, typed subscription to the Gateway event stream.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseSubscription {
    topics: Vec<String>,
    kinds: Vec<String>,
    correlation_id: Option<String>,
    last_event_id: Option<String>,
    backfill: bool,
}

impl SseSubscription {
    pub fn new(
        topics: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, TransportError> {
        let topics = topics.into_iter().map(Into::into).collect::<Vec<_>>();
        validate_filters(&topics, false)?;
        for topic in &topics {
            if event_by_topic(topic).is_none() {
                return Err(TransportError::UnknownEvent);
            }
        }
        Ok(Self {
            topics,
            kinds: Vec::new(),
            correlation_id: None,
            last_event_id: None,
            backfill: false,
        })
    }

    pub fn with_kinds(
        mut self,
        kinds: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, TransportError> {
        let kinds = kinds.into_iter().map(Into::into).collect::<Vec<_>>();
        validate_filters(&kinds, true)?;
        self.kinds = kinds;
        Ok(self)
    }

    pub fn with_correlation_id(mut self, value: impl Into<String>) -> Result<Self, TransportError> {
        let value = value.into();
        validate_identifier(&value)?;
        self.correlation_id = Some(value);
        Ok(self)
    }

    pub fn with_last_event_id(mut self, value: impl Into<String>) -> Result<Self, TransportError> {
        let value = value.into();
        validate_identifier(&value)?;
        self.last_event_id = Some(value);
        Ok(self)
    }

    pub fn with_backfill(mut self, backfill: bool) -> Self {
        self.backfill = backfill;
        self
    }
}

/// Product-safe native transport failures.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TransportError {
    #[error("transport configuration is invalid")]
    InvalidConfiguration,
    #[error("transport endpoint is not permitted")]
    UnsafeEndpoint,
    #[error("transport method is unavailable")]
    UnknownMethod,
    #[error("transport event is unavailable")]
    UnknownEvent,
    #[error("transport payload is invalid")]
    InvalidPayload,
    #[error("remote microphone audio is not permitted")]
    RemoteAudioBlocked,
    #[error("transport request is too large")]
    RequestTooLarge,
    #[error("transport response is too large")]
    ResponseTooLarge,
    #[error("transport event is too large")]
    EventTooLarge,
    #[error("transport request failed")]
    RequestFailed,
    #[error("transport request returned HTTP {status}")]
    HttpStatus { status: u16 },
    #[error("transport response is invalid")]
    InvalidResponse,
    #[error("transport stream is invalid")]
    InvalidStream,
    #[error("transport request timed out")]
    Timeout,
    #[error("transport request was cancelled")]
    Cancelled,
}

impl TransportError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "invalid_configuration",
            Self::UnsafeEndpoint => "unsafe_endpoint",
            Self::UnknownMethod => "unknown_method",
            Self::UnknownEvent => "unknown_event",
            Self::InvalidPayload => "invalid_payload",
            Self::RemoteAudioBlocked => "remote_audio_blocked",
            Self::RequestTooLarge => "request_too_large",
            Self::ResponseTooLarge => "response_too_large",
            Self::EventTooLarge => "event_too_large",
            Self::RequestFailed => "request_failed",
            Self::HttpStatus { .. } => "http_status",
            Self::InvalidResponse => "invalid_response",
            Self::InvalidStream => "invalid_stream",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Generated-contract HTTP/SSE transport owned by native runtime state.
pub struct NativeGatewayTransport {
    client: reqwest::Client,
    base_url: Url,
    auth: GatewayAuth,
    limits: TransportLimits,
    request_sequence: AtomicU64,
}

impl fmt::Debug for NativeGatewayTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayTransport")
            .field("origin", &self.base_url.origin().ascii_serialization())
            .field("auth", &self.auth)
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl NativeGatewayTransport {
    pub fn new(
        base_url: Url,
        auth: GatewayAuth,
        limits: TransportLimits,
    ) -> Result<Self, TransportError> {
        auth.validate()?;
        let limits = limits.validate()?;
        validate_endpoint(&base_url, limits.allow_loopback_http)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| TransportError::InvalidConfiguration)?;
        Ok(Self {
            client,
            base_url,
            auth,
            limits,
            request_sequence: AtomicU64::new(0),
        })
    }

    /// Invoke one generated finite Gateway method with schema validation on
    /// both sides of the wire.
    pub async fn invoke_generated(
        &self,
        method_id: &str,
        payload: Value,
        options: &NativeRequestOptions,
        cancellation: &CancellationToken,
    ) -> Result<Value, TransportError> {
        let descriptor = method_by_id(method_id).ok_or(TransportError::UnknownMethod)?;
        let input_schema =
            schema_by_id(descriptor.input_schema_id).ok_or(TransportError::InvalidConfiguration)?;
        if schema_contains_binary(input_schema.schema_json)?
            && !self.limits.allow_remote_microphone_audio
        {
            return Err(TransportError::RemoteAudioBlocked);
        }
        let payload = normalize_generated_contract(descriptor.input_schema_id, payload)
            .map_err(|_| TransportError::InvalidPayload)?;
        let body = serde_json::to_vec(&payload).map_err(|_| TransportError::InvalidPayload)?;
        if body.len() > self.limits.max_request_bytes {
            return Err(TransportError::RequestTooLarge);
        }
        cancellation_check(cancellation)?;

        let url = self
            .base_url
            .join(descriptor.route_path.trim_start_matches('/'))
            .map_err(|_| TransportError::InvalidConfiguration)?;
        let request = self
            .auth
            .apply(self.client.post(url))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .header("X-Request-ID", &options.request_id)
            .body(body);
        let request = if let Some(idempotency_key) = &options.idempotency_key {
            request.header("Idempotency-Key", idempotency_key)
        } else {
            request
        };
        let response = await_timed(
            request.send(),
            cancellation,
            options.timeout.unwrap_or(self.limits.request_timeout),
        )
        .await?
        .map_err(|_| TransportError::RequestFailed)?;
        if !response.status().is_success() {
            return Err(TransportError::HttpStatus {
                status: response.status().as_u16(),
            });
        }
        let response_body =
            read_bounded_response(response, self.limits.max_response_bytes, cancellation).await?;
        let value = serde_json::from_slice::<Value>(&response_body)
            .map_err(|_| TransportError::InvalidResponse)?;
        normalize_generated_contract(descriptor.output_schema_id, value)
            .map_err(|_| TransportError::InvalidResponse)
    }

    /// Open an authenticated, bounded SSE connection for generated event topics.
    pub async fn open_event_stream(
        &self,
        subscription: &SseSubscription,
        cancellation: CancellationToken,
    ) -> Result<NativeEventStream, TransportError> {
        cancellation_check(&cancellation)?;
        let mut url = self
            .base_url
            .join(EVENT_STREAM_PATH)
            .map_err(|_| TransportError::InvalidConfiguration)?;
        {
            let mut pairs = url.query_pairs_mut();
            for topic in &subscription.topics {
                pairs.append_pair("topic", topic);
            }
            for kind in &subscription.kinds {
                pairs.append_pair("kind", kind);
            }
            if let Some(correlation_id) = &subscription.correlation_id {
                pairs.append_pair("correlation_id", correlation_id);
            }
            if let Some(last_event_id) = &subscription.last_event_id {
                pairs.append_pair("last_event_id", last_event_id);
            }
            if subscription.backfill {
                pairs.append_pair("backfill", "true");
            }
        }
        let request = self
            .auth
            .apply(self.client.get(url))
            .header(ACCEPT, "text/event-stream");
        let response = await_timed(request.send(), &cancellation, self.limits.request_timeout)
            .await?
            .map_err(|_| TransportError::RequestFailed)?;
        if !response.status().is_success() {
            return Err(TransportError::HttpStatus {
                status: response.status().as_u16(),
            });
        }
        if !is_event_stream(response.headers()) {
            return Err(TransportError::InvalidStream);
        }
        Ok(NativeEventStream {
            response,
            buffer: Vec::new(),
            allowed_topics: subscription.topics.iter().cloned().collect(),
            max_event_bytes: self.limits.max_event_bytes,
            idle_timeout: self.limits.stream_idle_timeout,
            cancellation,
        })
    }

    fn next_request_options(&self) -> Result<NativeRequestOptions, TransportError> {
        let sequence = self.request_sequence.fetch_add(1, Ordering::Relaxed);
        NativeRequestOptions::new(format!("voice-native-{sequence}"))
    }
}

#[async_trait(?Send)]
impl SpeechTransport for NativeGatewayTransport {
    async fn invoke_finite(
        &mut self,
        method: &str,
        payload: Value,
        cancellation: CancellationToken,
    ) -> Result<Value, VoiceCoreError> {
        let options = self.next_request_options().map_err(map_transport_error)?;
        self.invoke_generated(method, payload, &options, &cancellation)
            .await
            .map_err(map_transport_error)
    }

    async fn cancel_session(&mut self, _generation: Generation) -> Result<(), VoiceCoreError> {
        // Active finite requests are cancelled by the caller-owned token. A
        // generated server-side interrupt method is wired when its contract is
        // added to the allowlisted Rust projection.
        Ok(())
    }
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

/// One normalized Gateway event. Debug output deliberately excludes payloads.
#[derive(Clone, PartialEq)]
pub struct GatewayEvent {
    pub event_id: String,
    pub topic: String,
    pub kind: String,
    pub category: String,
    pub correlation_id: Option<String>,
    payload: Option<Value>,
    redacted_payload: Value,
    pub payload_sha256: String,
}

impl GatewayEvent {
    pub fn payload(&self) -> Option<&Value> {
        self.payload.as_ref()
    }

    pub fn redacted_payload(&self) -> &Value {
        &self.redacted_payload
    }
}

impl fmt::Debug for GatewayEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayEvent")
            .field("event_id", &self.event_id)
            .field("topic", &self.topic)
            .field("kind", &self.kind)
            .field("category", &self.category)
            .field("correlation_id", &self.correlation_id)
            .field("payload", &"[redacted]")
            .field("redacted_payload", &self.redacted_payload)
            .field("payload_sha256", &self.payload_sha256)
            .finish()
    }
}

#[derive(Deserialize)]
struct GatewayEventWire {
    event_id: String,
    topic: String,
    #[serde(default)]
    kind: String,
    #[serde(default = "unknown_category")]
    category: String,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    payload: Option<Value>,
    #[serde(default)]
    redacted_payload: Value,
    #[serde(default)]
    payload_sha256: String,
}

fn unknown_category() -> String {
    "unknown".to_owned()
}

/// Live native SSE connection with bounded frame buffering and cancellation.
pub struct NativeEventStream {
    response: reqwest::Response,
    buffer: Vec<u8>,
    allowed_topics: BTreeSet<String>,
    max_event_bytes: usize,
    idle_timeout: Duration,
    cancellation: CancellationToken,
}

impl fmt::Debug for NativeEventStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeEventStream")
            .field("buffered_bytes", &self.buffer.len())
            .field("allowed_topic_count", &self.allowed_topics.len())
            .field("max_event_bytes", &self.max_event_bytes)
            .finish_non_exhaustive()
    }
}

impl NativeEventStream {
    /// Read the next non-comment SSE event. `None` means a clean stream close.
    pub async fn next_event(&mut self) -> Result<Option<GatewayEvent>, TransportError> {
        loop {
            if let Some(frame) = take_sse_frame(&mut self.buffer) {
                if let Some(event) = parse_event_frame(&frame, &self.allowed_topics)? {
                    return Ok(Some(event));
                }
                continue;
            }
            if self.buffer.len() > self.max_event_bytes {
                return Err(TransportError::EventTooLarge);
            }
            let chunk = await_timed(self.response.chunk(), &self.cancellation, self.idle_timeout)
                .await?
                .map_err(|_| TransportError::RequestFailed)?;
            let Some(chunk) = chunk else {
                if self.buffer.iter().all(u8::is_ascii_whitespace) {
                    self.buffer.clear();
                    return Ok(None);
                }
                return Err(TransportError::InvalidStream);
            };
            let new_len = self
                .buffer
                .len()
                .checked_add(chunk.len())
                .ok_or(TransportError::EventTooLarge)?;
            if new_len > self.max_event_bytes {
                return Err(TransportError::EventTooLarge);
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }
}

async fn read_bounded_response(
    mut response: reqwest::Response,
    limit: usize,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, TransportError> {
    if response
        .content_length()
        .is_some_and(|length| usize::try_from(length).map_or(true, |length| length > limit))
    {
        return Err(TransportError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    loop {
        let chunk = await_timed(response.chunk(), cancellation, Duration::from_secs(30))
            .await?
            .map_err(|_| TransportError::RequestFailed)?;
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        let new_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or(TransportError::ResponseTooLarge)?;
        if new_len > limit {
            return Err(TransportError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
}

async fn await_timed<F>(
    future: F,
    cancellation: &CancellationToken,
    timeout: Duration,
) -> Result<F::Output, TransportError>
where
    F: std::future::Future,
{
    tokio::pin!(future);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::select! {
            output = &mut future => return Ok(output),
            () = tokio::time::sleep_until(deadline) => return Err(TransportError::Timeout),
            () = tokio::time::sleep(CANCELLATION_POLL_INTERVAL) => {
                cancellation_check(cancellation)?;
            }
        }
    }
}

fn cancellation_check(cancellation: &CancellationToken) -> Result<(), TransportError> {
    if cancellation.is_cancelled() {
        Err(TransportError::Cancelled)
    } else {
        Ok(())
    }
}

fn validate_endpoint(url: &Url, allow_loopback_http: bool) -> Result<(), TransportError> {
    let allowed = url.scheme() == "https"
        || (allow_loopback_http
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")));
    if allowed && url.username().is_empty() && url.password().is_none() {
        Ok(())
    } else {
        Err(TransportError::UnsafeEndpoint)
    }
}

fn validate_identifier(value: &str) -> Result<(), TransportError> {
    if value.trim() == value
        && !value.is_empty()
        && value.len() <= MAX_FILTER_LENGTH
        && value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        Ok(())
    } else {
        Err(TransportError::InvalidConfiguration)
    }
}

fn validate_filters(values: &[String], allow_empty: bool) -> Result<(), TransportError> {
    if values.len() > MAX_FILTER_COUNT || (!allow_empty && values.is_empty()) {
        return Err(TransportError::InvalidConfiguration);
    }
    values
        .iter()
        .try_for_each(|value| validate_identifier(value))
}

fn schema_contains_binary(schema_json: &str) -> Result<bool, TransportError> {
    let schema = serde_json::from_str::<Value>(schema_json)
        .map_err(|_| TransportError::InvalidConfiguration)?;
    Ok(value_contains_binary(&schema))
}

fn value_contains_binary(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            let audio_data_field = object
                .get("properties")
                .and_then(Value::as_object)
                .is_some_and(|properties| properties.contains_key("audio_data"));
            object.get("format").and_then(Value::as_str) == Some("binary")
                || audio_data_field
                || object.values().any(value_contains_binary)
        }
        Value::Array(items) => items.iter().any(value_contains_binary),
        _ => false,
    }
}

fn is_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"))
}

fn take_sse_frame(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let boundary = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4))
        .into_iter()
        .chain(
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| (index, 2)),
        )
        .min_by_key(|(index, _)| *index)?;
    let frame = buffer[..boundary.0].to_vec();
    buffer.drain(..boundary.0 + boundary.1);
    Some(frame)
}

fn parse_event_frame(
    frame: &[u8],
    allowed_topics: &BTreeSet<String>,
) -> Result<Option<GatewayEvent>, TransportError> {
    let frame = std::str::from_utf8(frame).map_err(|_| TransportError::InvalidStream)?;
    let mut data_lines = Vec::new();
    for line in frame.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }
    if data_lines.is_empty() {
        return Ok(None);
    }
    let data = data_lines.join("\n");
    if data == "[DONE]" {
        return Ok(None);
    }
    let wire = serde_json::from_str::<GatewayEventWire>(&data)
        .map_err(|_| TransportError::InvalidStream)?;
    validate_identifier(&wire.event_id).map_err(|_| TransportError::InvalidStream)?;
    if !allowed_topics.contains(&wire.topic) {
        return Err(TransportError::UnknownEvent);
    }
    let descriptor = event_by_topic(&wire.topic).ok_or(TransportError::UnknownEvent)?;
    let payload = normalize_generated_contract(
        descriptor.schema_id,
        wire.payload.ok_or(TransportError::InvalidPayload)?,
    )
    .map_err(|_| TransportError::InvalidPayload)?;
    Ok(Some(GatewayEvent {
        event_id: wire.event_id,
        topic: wire.topic,
        kind: wire.kind,
        category: wire.category,
        correlation_id: wire.correlation_id,
        payload: Some(payload),
        redacted_payload: wire.redacted_payload,
        payload_sha256: wire.payload_sha256,
    }))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;

    use super::*;

    struct FixtureServer {
        base_url: Url,
        request: mpsc::Receiver<String>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl FixtureServer {
        fn one_response(response: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
            let address = listener.local_addr().expect("fixture address");
            let (sender, request) = mpsc::channel();
            let thread = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept fixture request");
                let captured = read_http_request(&mut stream);
                sender.send(captured).expect("capture request");
                stream.write_all(&response).expect("write fixture response");
            });
            Self {
                base_url: Url::parse(&format!("http://{address}/")).expect("fixture URL"),
                request,
                thread: Some(thread),
            }
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
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

    fn loopback_limits() -> TransportLimits {
        TransportLimits {
            allow_loopback_http: true,
            ..TransportLimits::default()
        }
    }

    #[tokio::test]
    async fn finite_requests_use_generated_paths_and_validate_both_payloads() {
        let response_body = br#"{"voices":[],"capability_revision":0,"correlation_id":null}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            response_body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(response_body.iter().copied())
        .collect();
        let server = FixtureServer::one_response(response);
        let transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::Bearer("native-secret".to_owned()),
            loopback_limits(),
        )
        .expect("transport");
        let options = NativeRequestOptions::new("voice-request-1")
            .expect("request options")
            .with_idempotency_key("voice-turn-1")
            .expect("idempotency key");

        let result = transport
            .invoke_generated(
                "TTS.ListVoices",
                serde_json::json!({}),
                &options,
                &CancellationToken::new(),
            )
            .await
            .expect("finite request");

        assert!(result.is_object());
        let request = server.request.recv().expect("captured request");
        assert!(request.starts_with("POST /api/TTS/ListVoices HTTP/1.1"));
        assert!(request.contains("authorization: Bearer native-secret"));
        assert!(request.contains("x-request-id: voice-request-1"));
        assert!(request.contains("idempotency-key: voice-turn-1"));
    }

    #[tokio::test]
    async fn microphone_binary_routes_are_blocked_before_network() {
        let base_url = Url::parse("http://127.0.0.1:9/").expect("URL");
        let transport = NativeGatewayTransport::new(base_url, GatewayAuth::None, loopback_limits())
            .expect("transport");
        let result = transport
            .invoke_generated(
                "Transcription.ProcessAudio",
                serde_json::json!({
                    "data": "microphone-secret",
                    "sample_rate": 16000,
                    "channels": 1
                }),
                &NativeRequestOptions::new("voice-request-2").expect("options"),
                &CancellationToken::new(),
            )
            .await;

        assert_eq!(result, Err(TransportError::RemoteAudioBlocked));

        let finite_audio = transport
            .invoke_generated(
                "Transcription.Transcribe",
                serde_json::json!({}),
                &NativeRequestOptions::new("voice-request-2b").expect("options"),
                &CancellationToken::new(),
            )
            .await;
        assert_eq!(finite_audio, Err(TransportError::RemoteAudioBlocked));
    }

    #[tokio::test]
    async fn sse_stream_parses_and_validates_generated_event_payload() {
        let envelope = serde_json::json!({
            "event_id": "event-1",
            "topic": "TTS.AudioChunk",
            "kind": "audio.chunk",
            "category": "audio",
            "correlation_id": "turn-1",
            "payload": {
                "audio_data": "c3ludGhldGlj",
                "duration_ms": 20.0,
                "format": "pcm_s16le",
                "sample_rate": 16000,
                "sequence": 0,
                "stream_id": "stream-1"
            },
            "redacted_payload": {"sequence": 0},
            "payload_sha256": ""
        });
        let frame = format!("id: event-1\nevent: audio.chunk\ndata: {envelope}\n\n");
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{frame}",
            frame.len()
        )
        .into_bytes();
        let server = FixtureServer::one_response(response);
        let transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::ApiKey("gateway-secret".to_owned()),
            loopback_limits(),
        )
        .expect("transport");
        let subscription = SseSubscription::new(["TTS.AudioChunk"])
            .expect("subscription")
            .with_correlation_id("turn-1")
            .expect("correlation");
        let mut stream = transport
            .open_event_stream(&subscription, CancellationToken::new())
            .await
            .expect("event stream");

        let event = stream
            .next_event()
            .await
            .expect("read event")
            .expect("one event");
        assert_eq!(event.topic, "TTS.AudioChunk");
        assert_eq!(
            event
                .payload()
                .and_then(|payload| payload["sequence"].as_u64()),
            Some(0)
        );
        assert!(!format!("{event:?}").contains("c3ludGhldGlj"));
        let request = server.request.recv().expect("captured request");
        assert!(
            request.contains("GET /api/events/stream?topic=TTS.AudioChunk&correlation_id=turn-1")
        );
        assert!(request.contains("x-api-key: gateway-secret"));
    }

    #[tokio::test]
    async fn cancellation_and_limits_fail_with_redacted_errors() {
        let transport = NativeGatewayTransport::new(
            Url::parse("http://127.0.0.1:9/").expect("URL"),
            GatewayAuth::Bearer("do-not-render".to_owned()),
            TransportLimits {
                max_request_bytes: 2,
                allow_loopback_http: true,
                ..TransportLimits::default()
            },
        )
        .expect("transport");
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let options = NativeRequestOptions::new("voice-request-3").expect("options");
        let cancelled_result = transport
            .invoke_generated(
                "TTS.ListVoices",
                serde_json::json!({}),
                &options,
                &cancelled,
            )
            .await;
        assert_eq!(cancelled_result, Err(TransportError::Cancelled));

        let oversized = transport
            .invoke_generated(
                "TTS.ListVoices",
                serde_json::json!({"language": "en"}),
                &options,
                &CancellationToken::new(),
            )
            .await;
        assert_eq!(oversized, Err(TransportError::RequestTooLarge));
        let rendered = format!(
            "{:?} {}",
            GatewayAuth::Bearer("do-not-render".to_owned()),
            TransportError::RequestFailed
        );
        assert!(!rendered.contains("do-not-render"));
        assert!(!rendered.contains("audio_data"));
    }

    #[test]
    fn rejects_unknown_topics_and_credential_urls() {
        assert_eq!(
            SseSubscription::new(["Orchestrator.Unprojected"]),
            Err(TransportError::UnknownEvent)
        );
        let url = Url::parse("https://user:password@example.invalid/").expect("URL");
        assert_eq!(
            NativeGatewayTransport::new(url, GatewayAuth::None, TransportLimits::default())
                .map(|_| ()),
            Err(TransportError::UnsafeEndpoint)
        );
    }
}
