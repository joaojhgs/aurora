//! Generated-contract HTTP and SSE transport for a native-owned voice turn.

use std::collections::BTreeSet;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use aurora_contracts::{
    envelope_by_topic, event_by_topic, ids, method_by_id, models, normalize_generated_contract,
    schema_by_id,
};
use aurora_voice_core::{
    AssistantTurnRequest, AssistantTurnResponse, CancellationToken, Generation, SpeechTransport,
    VoiceCoreError,
};
use reqwest::header::{HeaderMap, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value;
use thiserror::Error;
use url::Url;

const EVENT_STREAM_PATH: &str = "api/events/stream";
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_FILTER_COUNT: usize = 16;
const MAX_FILTER_LENGTH: usize = 256;
const ASSISTANT_SOURCE: &str = "native_voice";

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

    pub fn assistant_response(request: &AssistantTurnRequest) -> Result<Self, TransportError> {
        Self::new([ids::ORCHESTRATOR_RESPONSE])?
            .with_kinds(["assistant.delta", "assistant.completed", "assistant.failed"])?
            .with_correlation_id(request.correlation_id.clone())
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
    active_assistant: Option<ActiveAssistantTurn>,
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
            active_assistant: None,
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

    pub async fn invoke_assistant_turn(
        &mut self,
        request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, TransportError> {
        let response = self.invoke_assistant_request(request, cancellation).await?;
        if response.text.is_empty() {
            return Err(TransportError::InvalidResponse);
        }
        Ok(response)
    }

    pub async fn invoke_assistant_streaming(
        &mut self,
        mut request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, TransportError> {
        request.stream = true;
        let subscription = SseSubscription::assistant_response(&request)?;
        let mut stream = self
            .open_event_stream(&subscription, cancellation.clone())
            .await?;
        let _ack = self
            .invoke_assistant_request(request.clone(), cancellation.clone())
            .await?;
        let mut text = String::new();
        loop {
            cancellation_check(&cancellation)?;
            let Some(event) = stream.next_event().await? else {
                return Err(TransportError::InvalidStream);
            };
            match event.assistant_stream_event(&request)? {
                AssistantStreamRead::Ignore => continue,
                AssistantStreamRead::Delta(delta) => text.push_str(&delta),
                AssistantStreamRead::Completed(final_text) => {
                    if !final_text.is_empty() {
                        text = final_text;
                    }
                    if text.is_empty() {
                        return Err(TransportError::InvalidResponse);
                    }
                    self.active_assistant = None;
                    return Ok(AssistantTurnResponse {
                        text,
                        session_id: Some(request.session_id),
                        request_id: Some(request.request_id),
                        correlation_id: Some(request.correlation_id),
                    });
                }
                AssistantStreamRead::Failed => return Err(TransportError::InvalidResponse),
            }
        }
    }

    async fn invoke_assistant_request(
        &mut self,
        request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, TransportError> {
        validate_identifier(&request.session_id)?;
        validate_identifier(&request.request_id)?;
        validate_identifier(&request.correlation_id)?;
        if request.transcript.is_empty() {
            return Err(TransportError::InvalidPayload);
        }
        let descriptor = method_by_id(ids::ORCHESTRATOR_EXTERNAL_USER_INPUT)
            .ok_or(TransportError::UnknownMethod)?;
        let payload = serde_json::json!({
            "text": request.transcript,
            "source": ASSISTANT_SOURCE,
            "stream": request.stream,
            "session_id": request.session_id,
            "request_id": request.request_id,
            "correlation_id": request.correlation_id,
            "client_tts_playback": true,
        });
        let payload = normalize_generated_contract(descriptor.input_schema_id, payload)
            .map_err(|_| TransportError::InvalidPayload)?;
        let typed_request: models::OrchestratorProcessRequest =
            serde_json::from_value(payload.clone()).map_err(|_| TransportError::InvalidPayload)?;
        let payload =
            serde_json::to_value(typed_request).map_err(|_| TransportError::InvalidPayload)?;
        let options = NativeRequestOptions::new(request.request_id.clone())?
            .with_idempotency_key(request.correlation_id.clone())?;
        self.active_assistant = Some(ActiveAssistantTurn {
            generation: request.generation,
            session_id: request.session_id.clone(),
            request_id: request.request_id.clone(),
        });
        let response = self
            .invoke_generated(
                ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                payload,
                &options,
                &cancellation,
            )
            .await?;
        let typed_response: models::OrchestratorResponse =
            serde_json::from_value(response).map_err(|_| TransportError::InvalidResponse)?;
        let response =
            serde_json::to_value(typed_response).map_err(|_| TransportError::InvalidResponse)?;
        if !request.stream {
            self.active_assistant = None;
        }
        Ok(AssistantTurnResponse {
            text: required_string(&response, "text").ok_or(TransportError::InvalidResponse)?,
            session_id: optional_string(&response, "session_id"),
            request_id: optional_string(&response, "request_id"),
            correlation_id: optional_string(&response, "correlation_id"),
        })
    }
}

#[async_trait(?Send)]
impl SpeechTransport for NativeGatewayTransport {
    async fn assistant_turn(
        &mut self,
        request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, VoiceCoreError> {
        self.invoke_assistant_turn(request, cancellation)
            .await
            .map_err(map_transport_error)
    }

    async fn cancel_session(&mut self, generation: Generation) -> Result<(), VoiceCoreError> {
        let active = self
            .active_assistant
            .clone()
            .filter(|active| active.generation == generation)
            .ok_or_else(|| VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned(),
            })?;
        let descriptor = method_by_id(ids::ORCHESTRATOR_INTERRUPT).ok_or_else(|| {
            VoiceCoreError::TransportFault {
                code: "unknown_method".to_owned(),
            }
        })?;
        let payload = serde_json::json!({
            "session_id": active.session_id,
            "request_id": active.request_id,
            "reason": "user_interrupt",
            "scopes": ["generation", "session", "tool_call", "tts_playback"],
        });
        let payload =
            normalize_generated_contract(descriptor.input_schema_id, payload).map_err(|_| {
                VoiceCoreError::TransportFault {
                    code: "invalid_payload".to_owned(),
                }
            })?;
        let typed_request: models::OrchestratorInterruptRequest =
            serde_json::from_value(payload.clone()).map_err(|_| {
                VoiceCoreError::TransportFault {
                    code: "invalid_payload".to_owned(),
                }
            })?;
        let payload =
            serde_json::to_value(typed_request).map_err(|_| VoiceCoreError::TransportFault {
                code: "invalid_payload".to_owned(),
            })?;
        let cleanup_sequence = self.request_sequence.fetch_add(1, Ordering::Relaxed);
        let options = NativeRequestOptions::new(format!("voice-cleanup-{cleanup_sequence}"))
            .map_err(map_transport_error)?;
        let cleanup_token = CancellationToken::new();
        let response = self
            .invoke_generated(
                ids::ORCHESTRATOR_INTERRUPT,
                payload,
                &options,
                &cleanup_token,
            )
            .await
            .map_err(map_transport_error)?;
        let typed_response: models::OrchestratorInterruptResponse =
            serde_json::from_value(response).map_err(|_| VoiceCoreError::TransportFault {
                code: "invalid_response".to_owned(),
            })?;
        let response =
            serde_json::to_value(typed_response).map_err(|_| VoiceCoreError::TransportFault {
                code: "invalid_response".to_owned(),
            })?;
        if required_string(&response, "status").is_none() {
            return Err(VoiceCoreError::TransportFault {
                code: "invalid_response".to_owned(),
            });
        }
        self.active_assistant = None;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActiveAssistantTurn {
    generation: Generation,
    session_id: String,
    request_id: String,
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
    let envelope_descriptor =
        envelope_by_topic(ids::AURORA_EVENT_STREAM).ok_or(TransportError::InvalidConfiguration)?;
    let envelope_value =
        serde_json::from_str::<Value>(&data).map_err(|_| TransportError::InvalidStream)?;
    let envelope_value =
        normalize_generated_contract(envelope_descriptor.schema_id, envelope_value)
            .map_err(|_| TransportError::InvalidStream)?;
    let wire: models::AuroraEventStreamEvent = serde_json::from_value(envelope_value.clone())
        .map_err(|_| TransportError::InvalidStream)?;
    let wire = serde_json::to_value(wire).map_err(|_| TransportError::InvalidStream)?;
    let event_id = required_string(&wire, "event_id").ok_or(TransportError::InvalidStream)?;
    validate_identifier(&event_id).map_err(|_| TransportError::InvalidStream)?;
    let topic = required_string(&wire, "topic").ok_or(TransportError::InvalidStream)?;
    if !allowed_topics.contains(&topic) {
        return Err(TransportError::UnknownEvent);
    }
    let descriptor = event_by_topic(&topic).ok_or(TransportError::UnknownEvent)?;
    let payload = normalize_generated_contract(
        descriptor.schema_id,
        wire.get("payload")
            .cloned()
            .filter(|value| !value.is_null())
            .ok_or(TransportError::InvalidPayload)?,
    )
    .map_err(|_| TransportError::InvalidPayload)?;
    Ok(Some(GatewayEvent {
        event_id,
        topic,
        kind: optional_string(&wire, "kind").unwrap_or_default(),
        category: optional_string(&wire, "category").unwrap_or_else(|| "unknown".to_owned()),
        correlation_id: optional_string(&wire, "correlation_id"),
        payload: Some(payload),
        redacted_payload: wire
            .get("redacted_payload")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        payload_sha256: optional_string(&wire, "payload_sha256").unwrap_or_default(),
    }))
}

enum AssistantStreamRead {
    Ignore,
    Delta(String),
    Completed(String),
    Failed,
}

impl GatewayEvent {
    fn assistant_stream_event(
        &self,
        request: &AssistantTurnRequest,
    ) -> Result<AssistantStreamRead, TransportError> {
        if self.topic != ids::ORCHESTRATOR_RESPONSE
            || self.category != "assistant"
            || self.correlation_id.as_deref() != Some(request.correlation_id.as_str())
        {
            return Ok(AssistantStreamRead::Ignore);
        }
        let Some(payload) = self.payload() else {
            return Err(TransportError::InvalidPayload);
        };
        let typed: models::AssistantStreamEvent =
            serde_json::from_value(payload.clone()).map_err(|_| TransportError::InvalidPayload)?;
        let typed = serde_json::to_value(typed).map_err(|_| TransportError::InvalidPayload)?;
        if optional_string(&typed, "session_id").as_deref() != Some(request.session_id.as_str())
            || optional_string(&typed, "request_id").as_deref() != Some(request.request_id.as_str())
            || optional_string(&typed, "correlation_id").as_deref()
                != Some(request.correlation_id.as_str())
        {
            return Ok(AssistantStreamRead::Ignore);
        }
        match required_string(&typed, "kind").as_deref() {
            Some("assistant.delta") => Ok(AssistantStreamRead::Delta(
                optional_string(&typed, "delta").unwrap_or_default(),
            )),
            Some("assistant.completed") if bool_field(&typed, "is_final") => Ok(
                AssistantStreamRead::Completed(optional_string(&typed, "text").unwrap_or_default()),
            ),
            Some("assistant.failed") if bool_field(&typed, "is_final") => {
                Ok(AssistantStreamRead::Failed)
            }
            _ => Ok(AssistantStreamRead::Ignore),
        }
    }
}

fn required_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
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
            Self::responses([response])
        }

        fn responses(responses: impl IntoIterator<Item = Vec<u8>>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
            let address = listener.local_addr().expect("fixture address");
            let (sender, request) = mpsc::channel();
            let responses = responses.into_iter().collect::<Vec<_>>();
            let thread = thread::spawn(move || {
                for response in responses {
                    let (mut stream, _) = listener.accept().expect("accept fixture request");
                    let captured = read_http_request(&mut stream);
                    sender.send(captured).expect("capture request");
                    stream.write_all(&response).expect("write fixture response");
                }
            });
            Self {
                base_url: Url::parse(&format!("http://{address}/")).expect("fixture URL"),
                request,
                thread: Some(thread),
            }
        }
    }

    fn json_response(body: &[u8]) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
    }

    fn status_response(status: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").into_bytes()
    }

    fn request_body(request: &str) -> Value {
        let (_, body) = request.split_once("\r\n\r\n").expect("request body");
        serde_json::from_str(body).expect("JSON body")
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
        let response = json_response(response_body);
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
    async fn assistant_turn_posts_generated_typed_request_and_reads_finite_text() {
        let response_body = br#"{"text":"answer ready","metadata":{},"session_id":"voice-session-7","request_id":"voice-request-7","correlation_id":"voice-correlation-7"}"#;
        let server = FixtureServer::one_response(json_response(response_body));
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let response = transport
            .invoke_assistant_turn(
                AssistantTurnRequest::from_generation(Generation(7), "hello aurora"),
                CancellationToken::new(),
            )
            .await
            .expect("assistant response");

        assert_eq!(response.text, "answer ready");
        assert_eq!(response.session_id.as_deref(), Some("voice-session-7"));
        let request = server.request.recv().expect("captured request");
        assert!(request.starts_with("POST /api/Orchestrator/ExternalUserInput HTTP/1.1"));
        assert!(request.contains("x-request-id: voice-request-7"));
        assert!(request.contains("idempotency-key: voice-correlation-7"));
        let body = request_body(&request);
        assert_eq!(body["text"], "hello aurora");
        assert_eq!(body["source"], ASSISTANT_SOURCE);
        assert_eq!(body["session_id"], "voice-session-7");
        assert_eq!(body["request_id"], "voice-request-7");
        assert_eq!(body["correlation_id"], "voice-correlation-7");
        assert_eq!(body["stream"], false);
    }

    #[tokio::test]
    async fn assistant_turn_rejects_malformed_and_oversize_finite_response() {
        let malformed = FixtureServer::one_response(json_response(br#"{"metadata":{}}"#));
        let mut transport = NativeGatewayTransport::new(
            malformed.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");
        let result = transport
            .invoke_assistant_turn(
                AssistantTurnRequest::from_generation(Generation(8), "hello aurora"),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(result, Err(TransportError::InvalidResponse));

        let oversized =
            FixtureServer::one_response(json_response(br#"{"text":"answer ready","metadata":{}}"#));
        let mut transport = NativeGatewayTransport::new(
            oversized.base_url.clone(),
            GatewayAuth::None,
            TransportLimits {
                max_response_bytes: 2,
                allow_loopback_http: true,
                ..TransportLimits::default()
            },
        )
        .expect("transport");
        let result = transport
            .invoke_assistant_turn(
                AssistantTurnRequest::from_generation(Generation(9), "hello aurora"),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(result, Err(TransportError::ResponseTooLarge));
    }

    #[tokio::test]
    async fn cancel_session_posts_generated_interrupt_for_active_request() {
        let interrupt_body = br#"{"audit_event":"orchestrator.interrupt.requested","event_topic":"Orchestrator.Interrupted","idempotent":true,"interrupt_id":"interrupt-1","status":"cancelled","request_id":"voice-request-3","session_id":"voice-session-3","requested_scopes":["generation","session","tool_call","tts_playback"],"results":[{"scope":"session","status":"cancelled","cancelled_count":1,"message":""}],"secrets_redacted":true}"#;
        let server = FixtureServer::responses([
            status_response("500 Internal Server Error"),
            json_response(interrupt_body),
        ]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let failed = transport
            .invoke_assistant_turn(
                AssistantTurnRequest::from_generation(Generation(3), "cancel this"),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(failed, Err(TransportError::HttpStatus { status: 500 }));
        transport
            .cancel_session(Generation(3))
            .await
            .expect("interrupt posted");

        let first = server.request.recv().expect("assistant request");
        assert!(first.starts_with("POST /api/Orchestrator/ExternalUserInput HTTP/1.1"));
        let second = server.request.recv().expect("interrupt request");
        assert!(second.starts_with("POST /api/Orchestrator/Interrupt HTTP/1.1"));
        assert!(second.contains("x-request-id: voice-cleanup-0"));
        let body = request_body(&second);
        assert_eq!(body["session_id"], "voice-session-3");
        assert_eq!(body["request_id"], "voice-request-3");
        assert_eq!(body["reason"], "user_interrupt");
        assert_eq!(
            body["scopes"],
            serde_json::json!(["generation", "session", "tool_call", "tts_playback"])
        );
    }

    #[tokio::test]
    async fn cancel_session_rejects_without_active_request() {
        let mut transport = NativeGatewayTransport::new(
            Url::parse("http://127.0.0.1:9/").expect("URL"),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        assert_eq!(
            transport.cancel_session(Generation(1)).await,
            Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned()
            })
        );
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

    fn assistant_frame(payload: Value, overrides: Value) -> Vec<u8> {
        let mut envelope = serde_json::json!({
            "event_id": "event-1",
            "topic": ids::ORCHESTRATOR_RESPONSE,
            "kind": "assistant.delta",
            "category": "assistant",
            "correlation_id": "voice-correlation-9",
            "payload": payload,
            "redacted_payload": {},
            "payload_sha256": "",
        });
        if let (Some(base), Some(overrides)) = (envelope.as_object_mut(), overrides.as_object()) {
            for (key, value) in overrides {
                base.insert(key.clone(), value.clone());
            }
        }
        format!("id: event-1\nevent: assistant.delta\ndata: {envelope}\n\n").into_bytes()
    }

    fn assistant_payload(kind: &str, delta: &str, text: &str, is_final: bool) -> Value {
        serde_json::json!({
            "kind": kind,
            "delta": delta,
            "text": text,
            "is_final": is_final,
            "sequence": 0,
            "session_id": "voice-session-9",
            "request_id": "voice-request-9",
            "correlation_id": "voice-correlation-9",
            "metadata": {},
        })
    }

    #[test]
    fn assistant_sse_accepts_correlated_delta_completed_and_failed() {
        let request = AssistantTurnRequest::from_generation(Generation(9), "hello");
        let allowed = BTreeSet::from([ids::ORCHESTRATOR_RESPONSE.to_owned()]);

        let delta = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hel", "", false),
                serde_json::json!({}),
            ),
            &allowed,
        )
        .expect("delta frame")
        .expect("delta event");
        assert!(matches!(
            delta.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Delta(value)) if value == "hel"
        ));

        let completed = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.completed", "", "hello there", true),
                serde_json::json!({"kind": "assistant.completed"}),
            ),
            &allowed,
        )
        .expect("completed frame")
        .expect("completed event");
        assert!(matches!(
            completed.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Completed(value)) if value == "hello there"
        ));

        let failed = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.failed", "", "", true),
                serde_json::json!({"kind": "assistant.failed"}),
            ),
            &allowed,
        )
        .expect("failed frame")
        .expect("failed event");
        assert!(matches!(
            failed.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Failed)
        ));
    }

    #[test]
    fn assistant_sse_ignores_wrong_category_or_correlation_and_rejects_wrong_topic() {
        let request = AssistantTurnRequest::from_generation(Generation(9), "hello");
        let allowed = BTreeSet::from([ids::ORCHESTRATOR_RESPONSE.to_owned()]);

        let wrong_category = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hidden", "", false),
                serde_json::json!({"category": "audio"}),
            ),
            &allowed,
        )
        .expect("wrong category frame")
        .expect("wrong category event");
        assert!(matches!(
            wrong_category.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Ignore)
        ));

        let wrong_correlation = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hidden", "", false),
                serde_json::json!({"correlation_id": "voice-correlation-other"}),
            ),
            &allowed,
        )
        .expect("wrong correlation frame")
        .expect("wrong correlation event");
        assert!(matches!(
            wrong_correlation.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Ignore)
        ));

        let wrong_session = parse_event_frame(
            &assistant_frame(
                serde_json::json!({
                    "kind": "assistant.delta",
                    "delta": "hidden",
                    "is_final": false,
                    "session_id": "voice-session-other",
                    "request_id": "voice-request-9",
                    "correlation_id": "voice-correlation-9",
                    "metadata": {},
                }),
                serde_json::json!({}),
            ),
            &allowed,
        )
        .expect("wrong session frame")
        .expect("wrong session event");
        assert!(matches!(
            wrong_session.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Ignore)
        ));

        let wrong_topic = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hidden", "", false),
                serde_json::json!({"topic": ids::TTS_AUDIO_CHUNK}),
            ),
            &allowed,
        );
        assert_eq!(wrong_topic, Err(TransportError::UnknownEvent));
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
