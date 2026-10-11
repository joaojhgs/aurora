//! Generated-contract HTTP and SSE transport for a native-owned voice turn.

use crate::native_event_observer::{
    begin_native_voice_observation_producer, bound_observed_text, observe_native_voice,
    NativeVoiceObservation, NativeVoiceObservationToken, NativeVoiceTurnIds,
    NativeVoiceTurnSnapshot,
};
use std::collections::BTreeSet;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
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
use aurora_voice_engine::json_text::parse_json_value;
use reqwest::header::{HeaderMap, ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::mpsc;
use url::Url;

const EVENT_STREAM_PATH: &str = "api/events/stream";
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_STREAM_RECONNECTS: usize = 2;
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
    pub microphone_audio_policy: MicrophoneAudioPolicy,
}

/// Policy for generated Gateway methods whose input schema carries audio data.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MicrophoneAudioPolicy {
    #[default]
    Blocked,
    LoopbackOnly,
    ExplicitRemoteConsent,
}

/// Redacted endpoint class used to bind microphone-audio policy decisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeGatewayEndpointClass {
    Loopback,
    Remote,
}

/// Redacted microphone-audio routing profile. It exposes no URL or auth data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeGatewayMicrophoneAudioProfile {
    endpoint_class: NativeGatewayEndpointClass,
    microphone_audio_policy: MicrophoneAudioPolicy,
}

impl NativeGatewayMicrophoneAudioProfile {
    pub fn endpoint_class(self) -> NativeGatewayEndpointClass {
        self.endpoint_class
    }

    pub fn microphone_audio_policy(self) -> MicrophoneAudioPolicy {
        self.microphone_audio_policy
    }
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
            microphone_audio_policy: MicrophoneAudioPolicy::Blocked,
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

/// Non-secret routing hints for a native mesh assistant turn.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NativeMeshAssistantRoute {
    preferred_stable_peer_id: Option<String>,
}

impl NativeMeshAssistantRoute {
    pub fn new(preferred_stable_peer_id: Option<String>) -> Result<Self, TransportError> {
        if let Some(peer_id) = preferred_stable_peer_id.as_deref() {
            validate_identifier(peer_id)?;
        }
        Ok(Self {
            preferred_stable_peer_id,
        })
    }

    pub fn preferred_stable_peer_id(&self) -> Option<&str> {
        self.preferred_stable_peer_id.as_deref()
    }
}

/// Bounded process-local mesh transport settings. Debug output contains no
/// peer credentials, session payloads, or transcript data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeMeshAssistantTransportOptions {
    route: NativeMeshAssistantRoute,
    limits: TransportLimits,
}

impl NativeMeshAssistantTransportOptions {
    pub fn new(
        route: NativeMeshAssistantRoute,
        limits: TransportLimits,
    ) -> Result<Self, TransportError> {
        Ok(Self {
            route,
            limits: limits.validate()?,
        })
    }

    pub fn route(&self) -> &NativeMeshAssistantRoute {
        &self.route
    }

    pub fn limits(&self) -> TransportLimits {
        self.limits
    }
}

/// Typed mesh request for `Orchestrator.ExternalUserInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeMeshExternalUserInput {
    payload: Value,
    request_id: String,
    idempotency_key: String,
    timeout: Duration,
    turn: Option<NativeMeshAssistantTurnLink>,
}

/// Non-secret voice turn identifiers carried to native mesh observation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeMeshAssistantTurnLink {
    generation: u64,
    session_id: String,
    request_id: String,
    correlation_id: String,
}

impl NativeMeshExternalUserInput {
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    pub fn turn(&self) -> Option<&NativeMeshAssistantTurnLink> {
        self.turn.as_ref()
    }
}

impl NativeMeshAssistantTurnLink {
    pub fn new(
        generation: u64,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        correlation_id: impl Into<String>,
    ) -> Self {
        Self {
            generation,
            session_id: session_id.into(),
            request_id: request_id.into(),
            correlation_id: correlation_id.into(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn correlation_id(&self) -> &str {
        &self.correlation_id
    }
}

pub type NativeMeshTerminalFuture = Pin<Box<dyn Future<Output = Result<Value, TransportError>>>>;
type NativeMeshCloseFuture = Pin<Box<dyn Future<Output = Result<(), TransportError>> + Send>>;
type NativeMeshClose = Arc<dyn Fn() -> NativeMeshCloseFuture + Send + Sync>;

/// Real mesh assistant stream: data-channel assistant events plus the
/// authoritative terminal response from `Orchestrator.ExternalUserInput`.
pub struct NativeMeshExternalUserInputStream {
    events: mpsc::Receiver<Result<Value, TransportError>>,
    terminal: NativeMeshTerminalFuture,
    cleanup: Option<Box<dyn FnOnce() + Send + 'static>>,
    terminal_cleanup: Option<NativeMeshClose>,
    abandoned_cleanup: Option<NativeMeshClose>,
    close_result: Option<Result<(), TransportError>>,
}

impl NativeMeshExternalUserInputStream {
    pub fn new(
        events: mpsc::Receiver<Result<Value, TransportError>>,
        terminal: NativeMeshTerminalFuture,
    ) -> Self {
        Self::new_with_cleanup(events, terminal, Box::new(|| {}))
    }

    pub fn new_with_cleanup(
        events: mpsc::Receiver<Result<Value, TransportError>>,
        terminal: NativeMeshTerminalFuture,
        cleanup: Box<dyn FnOnce() + Send + 'static>,
    ) -> Self {
        Self {
            events,
            terminal,
            cleanup: Some(cleanup),
            terminal_cleanup: None,
            abandoned_cleanup: None,
            close_result: None,
        }
    }

    /// Creates a stream with awaited terminal and abandonment cleanup paths.
    ///
    /// The synchronous callback remains best-effort Drop cleanup. Strict close
    /// results come only from the awaited callbacks and are cached per stream.
    pub fn new_with_async_cleanup<T, TFut, A, AFut, D>(
        events: mpsc::Receiver<Result<Value, TransportError>>,
        terminal: NativeMeshTerminalFuture,
        terminal_cleanup: T,
        abandoned_cleanup: A,
        drop_cleanup: D,
    ) -> Self
    where
        T: Fn() -> TFut + Send + Sync + 'static,
        TFut: Future<Output = Result<(), TransportError>> + Send + 'static,
        A: Fn() -> AFut + Send + Sync + 'static,
        AFut: Future<Output = Result<(), TransportError>> + Send + 'static,
        D: FnOnce() + Send + 'static,
    {
        let terminal_cleanup: NativeMeshClose = Arc::new(move || {
            let future: NativeMeshCloseFuture = Box::pin(terminal_cleanup());
            future
        });
        let abandoned_cleanup: NativeMeshClose = Arc::new(move || {
            let future: NativeMeshCloseFuture = Box::pin(abandoned_cleanup());
            future
        });
        Self {
            events,
            terminal,
            cleanup: Some(Box::new(drop_cleanup)),
            terminal_cleanup: Some(terminal_cleanup),
            abandoned_cleanup: Some(abandoned_cleanup),
            close_result: None,
        }
    }

    pub async fn next_event(&mut self) -> Option<Result<Value, TransportError>> {
        self.events.recv().await
    }

    pub async fn terminal_response(mut self) -> Result<Value, TransportError> {
        match self.terminal.as_mut().await {
            Ok(response) => match self.close_terminal().await {
                Ok(()) => Ok(response),
                Err(error) => Err(error),
            },
            Err(primary_error) => match self.close_abandoned().await {
                Ok(()) => Err(primary_error),
                Err(cleanup_error) => Err(cleanup_error),
            },
        }
    }

    async fn close_terminal(&mut self) -> Result<(), TransportError> {
        self.close_with(self.terminal_cleanup.clone()).await
    }

    async fn close_abandoned(&mut self) -> Result<(), TransportError> {
        self.close_with(self.abandoned_cleanup.clone()).await
    }

    async fn close_with(&mut self, cleanup: Option<NativeMeshClose>) -> Result<(), TransportError> {
        if let Some(result) = &self.close_result {
            return result.clone();
        }
        let result = match cleanup {
            Some(cleanup) => cleanup().await,
            // A legacy synchronous-only callback cannot produce an awaited close
            // result. Drop still runs its best-effort callback after this returns.
            None => Err(TransportError::RequestFailed),
        };
        self.close_result = Some(result.clone());
        result
    }

    fn ready(response: Value) -> Self {
        let (_sender, events) = mpsc::channel(1);
        Self {
            events,
            terminal: Box::pin(async move { Ok(response) }),
            cleanup: None,
            terminal_cleanup: Some(Arc::new(|| Box::pin(async { Ok(()) }))),
            abandoned_cleanup: Some(Arc::new(|| Box::pin(async { Ok(()) }))),
            close_result: None,
        }
    }
}

impl Drop for NativeMeshExternalUserInputStream {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup();
        }
    }
}

/// Typed mesh request for `Orchestrator.Interrupt`.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeMeshInterruptRequest {
    payload: Value,
    request_id: String,
    idempotency_key: String,
    timeout: Duration,
}

/// Finite speech RPC supported by the existing authorized native mesh call path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeMeshSpeechMethod {
    Transcribe,
    Synthesize,
}

impl NativeMeshSpeechMethod {
    pub fn method_id(self) -> &'static str {
        match self {
            Self::Transcribe => aurora_contracts::ids::TRANSCRIPTION_TRANSCRIBE,
            Self::Synthesize => aurora_contracts::ids::TTS_SYNTHESIZE,
        }
    }
}

/// Typed-envelope payload for one finite speech call over the native mesh session.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeMeshSpeechCall {
    method: NativeMeshSpeechMethod,
    payload: Value,
    request_id: String,
    timeout: Duration,
}

impl NativeMeshSpeechCall {
    pub fn new(
        method: NativeMeshSpeechMethod,
        payload: Value,
        request_id: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, TransportError> {
        let request_id = request_id.into();
        validate_identifier(&request_id)?;
        if timeout.is_zero() {
            return Err(TransportError::InvalidConfiguration);
        }
        Ok(Self {
            method,
            payload,
            request_id,
            timeout,
        })
    }

    pub fn method(&self) -> NativeMeshSpeechMethod {
        self.method
    }
    pub fn payload(&self) -> &Value {
        &self.payload
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

impl NativeMeshInterruptRequest {
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

/// Per-session mesh transport installed by the Tauri native integration.
#[async_trait(?Send)]
pub trait NativeMeshAssistantTransport {
    async fn external_user_input(
        &mut self,
        request: NativeMeshExternalUserInput,
        cancellation: CancellationToken,
    ) -> Result<Value, TransportError>;

    async fn external_user_input_stream(
        &mut self,
        request: NativeMeshExternalUserInput,
        cancellation: CancellationToken,
    ) -> Result<NativeMeshExternalUserInputStream, TransportError> {
        let response = self.external_user_input(request, cancellation).await?;
        Ok(NativeMeshExternalUserInputStream::ready(response))
    }

    async fn interrupt(
        &mut self,
        request: NativeMeshInterruptRequest,
        cancellation: CancellationToken,
    ) -> Result<Value, TransportError>;

    /// Sends a typed finite STT/TTS method through the same exact-peer session
    /// and advertised-method check used by native assistant calls.
    async fn finite_speech_call(
        &mut self,
        _request: NativeMeshSpeechCall,
        _cancellation: CancellationToken,
    ) -> Result<Value, TransportError> {
        Err(TransportError::UnknownMethod)
    }
}

/// Process-local factory for assistant mesh transport instances.
pub trait NativeMeshAssistantTransportFactory: Send + Sync {
    fn create(
        &self,
        options: NativeMeshAssistantTransportOptions,
    ) -> Result<Box<dyn NativeMeshAssistantTransport>, TransportError>;
}

static MESH_ASSISTANT_TRANSPORT_FACTORY: OnceLock<
    Mutex<Option<Arc<dyn NativeMeshAssistantTransportFactory>>>,
> = OnceLock::new();

pub fn install_native_mesh_assistant_transport_factory(
    factory: Arc<dyn NativeMeshAssistantTransportFactory>,
) {
    let slot = MESH_ASSISTANT_TRANSPORT_FACTORY.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(factory);
    }
}

pub fn clear_native_mesh_assistant_transport_factory() {
    if let Some(slot) = MESH_ASSISTANT_TRANSPORT_FACTORY.get() {
        if let Ok(mut guard) = slot.lock() {
            *guard = None;
        }
    }
}

fn native_mesh_assistant_transport_factory(
) -> Result<Arc<dyn NativeMeshAssistantTransportFactory>, TransportError> {
    let slot = MESH_ASSISTANT_TRANSPORT_FACTORY.get_or_init(|| Mutex::new(None));
    slot.lock()
        .map_err(|_| TransportError::RequestFailed)?
        .as_ref()
        .cloned()
        .ok_or(TransportError::UnknownMethod)
}

/// Speech transport backed by a process-local native WebRTC mesh session.
pub struct NativeMeshAssistantSpeechTransport {
    transport: Box<dyn NativeMeshAssistantTransport>,
    limits: TransportLimits,
    active_assistant: Option<ActiveAssistantTurn>,
}

impl fmt::Debug for NativeMeshAssistantSpeechTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeMeshAssistantSpeechTransport")
            .field("limits", &self.limits)
            .field("active_assistant", &self.active_assistant.is_some())
            .finish_non_exhaustive()
    }
}

impl NativeMeshAssistantSpeechTransport {
    pub fn new(
        route: NativeMeshAssistantRoute,
        limits: TransportLimits,
    ) -> Result<Self, TransportError> {
        let options = NativeMeshAssistantTransportOptions::new(route, limits)?;
        let transport = native_mesh_assistant_transport_factory()?.create(options.clone())?;
        Ok(Self {
            transport,
            limits: options.limits(),
            active_assistant: None,
        })
    }

    pub async fn finite_speech_call(
        &mut self,
        request: NativeMeshSpeechCall,
        cancellation: CancellationToken,
    ) -> Result<Value, TransportError> {
        self.transport
            .finite_speech_call(request, cancellation)
            .await
    }

    async fn invoke_assistant_turn(
        &mut self,
        request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, TransportError> {
        if request.stream {
            return self.invoke_assistant_streaming(request, cancellation).await;
        }
        let generation = request.generation;
        let result = async {
            let request_payload = assistant_external_user_input(&request)?;
            let interrupt_ids = assistant_interrupt_ids(&request)?;
            self.active_assistant = Some(ActiveAssistantTurn {
                generation,
                session_id: request.session_id.clone(),
                request_id: request.request_id.clone(),
                interrupt_request_id: interrupt_ids.request_id,
                interrupt_idempotency_key: interrupt_ids.idempotency_key,
            });
            let mesh_request = NativeMeshExternalUserInput {
                payload: request_payload,
                request_id: request.request_id.clone(),
                idempotency_key: request.correlation_id.clone(),
                timeout: self.limits.request_timeout,
                turn: Some(NativeMeshAssistantTurnLink::new(
                    request.generation.0,
                    request.session_id.clone(),
                    request.request_id.clone(),
                    request.correlation_id.clone(),
                )),
            };
            let response = self
                .transport
                .external_user_input(mesh_request, cancellation.clone())
                .await?;
            let response = assistant_response_value(response)?;
            validate_optional_response_id(&response, "session_id", &request.session_id)?;
            validate_optional_response_id(&response, "request_id", &request.request_id)?;
            validate_optional_response_id(&response, "correlation_id", &request.correlation_id)?;
            let text = required_string(&response, "text").ok_or(TransportError::InvalidResponse)?;
            if text.is_empty() {
                return Err(TransportError::InvalidResponse);
            }
            self.active_assistant = None;
            Ok(AssistantTurnResponse {
                text,
                session_id: optional_string(&response, "session_id"),
                request_id: optional_string(&response, "request_id"),
                correlation_id: optional_string(&response, "correlation_id"),
            })
        }
        .await;
        if result.is_err() {
            let _ = self.cancel_session(generation).await;
        }
        result
    }

    async fn invoke_assistant_streaming(
        &mut self,
        mut request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, TransportError> {
        request.stream = true;
        let generation = request.generation;
        let turn_ids = turn_ids_from_request(&request);
        let observation_token = begin_native_voice_observation_producer();
        if let Some(token) = observation_token {
            observe_turn_snapshot(
                token,
                NativeVoiceTurnSnapshot::new(turn_ids.clone(), "started"),
            );
        }
        let mut failure_observed = false;
        let stream = async {
            let request_payload = assistant_external_user_input(&request)?;
            let interrupt_ids = assistant_interrupt_ids(&request)?;
            self.active_assistant = Some(ActiveAssistantTurn {
                generation,
                session_id: request.session_id.clone(),
                request_id: request.request_id.clone(),
                interrupt_request_id: interrupt_ids.request_id,
                interrupt_idempotency_key: interrupt_ids.idempotency_key,
            });
            let mesh_request = NativeMeshExternalUserInput {
                payload: request_payload,
                request_id: request.request_id.clone(),
                idempotency_key: request.correlation_id.clone(),
                timeout: self.limits.request_timeout,
                turn: Some(NativeMeshAssistantTurnLink::new(
                    request.generation.0,
                    request.session_id.clone(),
                    request.request_id.clone(),
                    request.correlation_id.clone(),
                )),
            };
            self.transport
                .external_user_input_stream(mesh_request, cancellation.clone())
                .await
        }
        .await;
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                if let Some(token) = observation_token {
                    observe_assistant_failed(token, &turn_ids, error.code());
                }
                let _ = self.cancel_session(generation).await;
                return Err(error);
            }
        };
        let read_result = async {
            let mut text = String::new();
            let mut completed_observed = false;
            let mut completed_sequence = None;
            let mut events_open = true;
            let mut assembler = AssistantStreamAssembler::new();
            loop {
                tokio::select! {
                    terminal = &mut stream.terminal => {
                        let response = assistant_response_value(terminal?)?;
                        validate_optional_response_id(&response, "session_id", &request.session_id)?;
                        validate_optional_response_id(&response, "request_id", &request.request_id)?;
                        validate_optional_response_id(&response, "correlation_id", &request.correlation_id)?;
                        let final_text = required_string(&response, "text").ok_or(TransportError::InvalidResponse)?;
                        if final_text.is_empty() {
                            return Err(TransportError::InvalidResponse);
                        }
                        if text.is_empty() || !completed_observed {
                            replace_bounded(&mut text, final_text, self.limits.max_response_bytes)?;
                        }
                        let completion_sequence = completed_sequence
                            .unwrap_or_else(|| assembler.next_sequence());
                        return Ok((AssistantTurnResponse {
                            text,
                            session_id: optional_string(&response, "session_id"),
                            request_id: optional_string(&response, "request_id"),
                            correlation_id: optional_string(&response, "correlation_id"),
                        }, completion_sequence));
                    }
                    event = stream.events.recv(), if events_open => {
                        let Some(event) = event else {
                            events_open = false;
                            continue;
                        };
                        match mesh_assistant_stream_event(event?, &request)? {
                            AssistantStreamRead::Ignore => continue,
                            AssistantStreamRead::Delta { sequence, delta } => {
                                if !assembler.accept(sequence)? {
                                    continue;
                                }
                                append_bounded(&mut text, &delta, self.limits.max_response_bytes)?;
                                if let Some(token) = observation_token {
                                    observe_assistant_delta(token, &turn_ids, sequence, &delta, &text);
                                }
                            }
                            AssistantStreamRead::Completed { sequence, final_text } => {
                                if !assembler.accept(sequence)? {
                                    continue;
                                }
                                if !final_text.is_empty() {
                                    replace_bounded(&mut text, final_text, self.limits.max_response_bytes)?;
                                }
                                completed_observed = true;
                                completed_sequence = Some(sequence);
                            }
                            AssistantStreamRead::Failed => {
                                if let Some(token) = observation_token {
                                    observe_assistant_failed(token, &turn_ids, "assistant_failed");
                                }
                                failure_observed = true;
                                return Err(TransportError::InvalidResponse);
                            }
                        }
                    }
                    _ = tokio::time::sleep(CANCELLATION_POLL_INTERVAL) => {
                        cancellation_check(&cancellation)?;
                    }
                }
            }
        }
        .await;

        let (result, close_failed) = match read_result {
            Ok((response, sequence)) => match stream.close_terminal().await {
                Ok(()) => {
                    if let Some(token) = observation_token {
                        observe_assistant_completed(token, &turn_ids, sequence, &response.text);
                        observe_turn_snapshot(
                            token,
                            NativeVoiceTurnSnapshot::new(turn_ids.clone(), "completed")
                                .with_text(&response.text)
                                .terminal(true),
                        );
                    }
                    self.active_assistant = None;
                    (Ok(response), false)
                }
                Err(error) => (Err(error), true),
            },
            Err(primary_error) => match stream.close_abandoned().await {
                Ok(()) => (Err(primary_error), false),
                Err(cleanup_error) => (Err(cleanup_error), true),
            },
        };
        if let Err(error) = &result {
            if !failure_observed {
                if let Some(token) = observation_token {
                    observe_assistant_failed(token, &turn_ids, error.code());
                }
            }
            if !close_failed {
                let _ = self.cancel_session(generation).await;
            }
        }
        result
    }
}

#[async_trait(?Send)]
impl SpeechTransport for NativeMeshAssistantSpeechTransport {
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
        if self
            .active_assistant
            .as_ref()
            .is_none_or(|active| active.generation != generation)
        {
            return Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned(),
            });
        }
        let active =
            self.active_assistant
                .clone()
                .ok_or_else(|| VoiceCoreError::TransportFault {
                    code: "no_active_session".to_owned(),
                })?;
        let payload = assistant_interrupt_payload(&active).map_err(map_transport_error)?;
        let request = NativeMeshInterruptRequest {
            payload,
            request_id: active.interrupt_request_id,
            idempotency_key: active.interrupt_idempotency_key,
            timeout: self.limits.request_timeout,
        };
        let cancellation = CancellationToken::new();
        let response = self
            .transport
            .interrupt(request, cancellation.clone())
            .await
            .map_err(map_transport_error)?;
        let response = assistant_interrupt_response_value(response).map_err(map_transport_error)?;
        if required_string(&response, "status").is_none() {
            return Err(VoiceCoreError::TransportFault {
                code: "invalid_response".to_owned(),
            });
        }
        self.active_assistant = None;
        Ok(())
    }
}

/// Generated-contract HTTP/SSE transport owned by native runtime state.
pub struct NativeGatewayTransport {
    client: reqwest::Client,
    base_url: Url,
    auth: GatewayAuth,
    limits: TransportLimits,
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
            active_assistant: None,
        })
    }

    pub fn microphone_audio_profile(&self) -> NativeGatewayMicrophoneAudioProfile {
        NativeGatewayMicrophoneAudioProfile {
            endpoint_class: if is_loopback_endpoint(&self.base_url) {
                NativeGatewayEndpointClass::Loopback
            } else {
                NativeGatewayEndpointClass::Remote
            },
            microphone_audio_policy: self.limits.microphone_audio_policy,
        }
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
        if schema_contains_binary(input_schema.schema_json)? {
            self.validate_microphone_audio_policy()?;
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
        let response_text =
            std::str::from_utf8(&response_body).map_err(|_| TransportError::InvalidResponse)?;
        let value = parse_json_value(response_text).map_err(|_| TransportError::InvalidResponse)?;
        normalize_generated_contract(descriptor.output_schema_id, value)
            .map_err(|_| TransportError::InvalidResponse)
    }

    fn validate_microphone_audio_policy(&self) -> Result<(), TransportError> {
        match self.limits.microphone_audio_policy {
            MicrophoneAudioPolicy::Blocked => Err(TransportError::RemoteAudioBlocked),
            MicrophoneAudioPolicy::LoopbackOnly if is_loopback_endpoint(&self.base_url) => Ok(()),
            MicrophoneAudioPolicy::LoopbackOnly => Err(TransportError::RemoteAudioBlocked),
            MicrophoneAudioPolicy::ExplicitRemoteConsent => Ok(()),
        }
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
            allowed_kinds: subscription.kinds.iter().cloned().collect(),
            required_correlation_id: subscription.correlation_id.clone(),
            max_event_bytes: self.limits.max_event_bytes,
            idle_timeout: self.limits.stream_idle_timeout,
            cancellation,
        })
    }

    async fn open_event_stream_with_retries(
        &self,
        subscription: &SseSubscription,
        cancellation: CancellationToken,
        reconnect_count: &mut usize,
    ) -> Result<NativeEventStream, TransportError> {
        loop {
            match self
                .open_event_stream(subscription, cancellation.clone())
                .await
            {
                Ok(stream) => return Ok(stream),
                Err(_error @ (TransportError::RequestFailed | TransportError::Timeout))
                    if *reconnect_count < MAX_STREAM_RECONNECTS =>
                {
                    *reconnect_count += 1;
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub async fn invoke_assistant_turn(
        &mut self,
        request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, TransportError> {
        if request.stream {
            return Err(TransportError::InvalidConfiguration);
        }
        let generation = request.generation;
        let result = self.invoke_assistant_request(request, cancellation).await;
        if result.is_err() {
            let _ = self.cancel_session(generation).await;
        }
        result
    }

    pub async fn invoke_assistant_streaming(
        &mut self,
        mut request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, TransportError> {
        request.stream = true;
        let generation = request.generation;
        let turn_ids = turn_ids_from_request(&request);
        let observation_token = begin_native_voice_observation_producer();
        if let Some(token) = observation_token {
            observe_turn_snapshot(
                token,
                NativeVoiceTurnSnapshot::new(turn_ids.clone(), "started"),
            );
        }
        let subscription = SseSubscription::assistant_response(&request)?;
        let mut reconnect_count = 0;
        let mut stream = self
            .open_event_stream_with_retries(
                &subscription,
                cancellation.clone(),
                &mut reconnect_count,
            )
            .await?;
        let mut last_event_id = None;
        let mut terminal_failure_observed = false;
        let result = async {
            let _ack = self
                .invoke_assistant_request(request.clone(), cancellation.clone())
                .await?;
            let mut text = String::new();
            let mut assembler = AssistantStreamAssembler::new();
            loop {
                cancellation_check(&cancellation)?;
                let event = match stream.next_event().await {
                    Ok(Some(event)) => {
                        last_event_id = Some(event.event_id.clone());
                        event
                    }
                    Ok(None) => {
                        if reconnect_count >= MAX_STREAM_RECONNECTS {
                            return Err(TransportError::InvalidStream);
                        }
                        reconnect_count += 1;
                        let resumed = if let Some(event_id) = last_event_id.as_deref() {
                            subscription.clone().with_last_event_id(event_id)?
                        } else {
                            subscription.clone()
                        };
                        stream = self
                            .open_event_stream_with_retries(
                                &resumed,
                                cancellation.clone(),
                                &mut reconnect_count,
                            )
                            .await?;
                        continue;
                    }
                    Err(error)
                        if matches!(
                            error,
                            TransportError::RequestFailed | TransportError::Timeout
                        ) =>
                    {
                        if reconnect_count >= MAX_STREAM_RECONNECTS {
                            return Err(error);
                        }
                        reconnect_count += 1;
                        let resumed = if let Some(event_id) = last_event_id.as_deref() {
                            subscription.clone().with_last_event_id(event_id)?
                        } else {
                            subscription.clone()
                        };
                        stream = self
                            .open_event_stream_with_retries(
                                &resumed,
                                cancellation.clone(),
                                &mut reconnect_count,
                            )
                            .await?;
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                match event.assistant_stream_event(&request)? {
                    AssistantStreamRead::Ignore => continue,
                    AssistantStreamRead::Delta { sequence, delta } => {
                        if !assembler.accept(sequence)? {
                            continue;
                        }
                        append_bounded(&mut text, &delta, self.limits.max_response_bytes)?;
                        if let Some(token) = observation_token {
                            observe_assistant_delta(token, &turn_ids, sequence, &delta, &text);
                        }
                    }
                    AssistantStreamRead::Completed {
                        sequence,
                        final_text,
                    } => {
                        if !assembler.accept(sequence)? {
                            continue;
                        }
                        if !final_text.is_empty() {
                            replace_bounded(&mut text, final_text, self.limits.max_response_bytes)?;
                        }
                        if text.is_empty() {
                            return Err(TransportError::InvalidResponse);
                        }
                        if let Some(token) = observation_token {
                            observe_assistant_completed(token, &turn_ids, sequence, &text);
                            observe_turn_snapshot(
                                token,
                                NativeVoiceTurnSnapshot::new(turn_ids.clone(), "completed")
                                    .with_text(&text)
                                    .terminal(true),
                            );
                        }
                        self.active_assistant = None;
                        return Ok(AssistantTurnResponse {
                            text,
                            session_id: Some(request.session_id),
                            request_id: Some(request.request_id),
                            correlation_id: Some(request.correlation_id),
                        });
                    }
                    AssistantStreamRead::Failed => {
                        terminal_failure_observed = true;
                        if let Some(token) = observation_token {
                            observe_assistant_failed(token, &turn_ids, "assistant_failed");
                        }
                        return Err(TransportError::InvalidResponse);
                    }
                }
            }
        }
        .await;
        if let Err(error) = &result {
            if !terminal_failure_observed {
                if let Some(token) = observation_token {
                    observe_assistant_failed(token, &turn_ids, error.code());
                }
            }
            let _ = self.cancel_session(generation).await;
        }
        result
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
        let payload = assistant_external_user_input(&request)?;
        let options = NativeRequestOptions::new(request.request_id.clone())?
            .with_idempotency_key(request.correlation_id.clone())?;
        let interrupt_ids = assistant_interrupt_ids(&request)?;
        self.active_assistant = Some(ActiveAssistantTurn {
            generation: request.generation,
            session_id: request.session_id.clone(),
            request_id: request.request_id.clone(),
            interrupt_request_id: interrupt_ids.request_id,
            interrupt_idempotency_key: interrupt_ids.idempotency_key,
        });
        let response = self
            .invoke_generated(
                ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                payload,
                &options,
                &cancellation,
            )
            .await?;
        let response = assistant_response_value(response)?;
        validate_optional_response_id(&response, "session_id", &request.session_id)?;
        validate_optional_response_id(&response, "request_id", &request.request_id)?;
        validate_optional_response_id(&response, "correlation_id", &request.correlation_id)?;
        let text = required_string(&response, "text").ok_or(TransportError::InvalidResponse)?;
        if !request.stream {
            if text.is_empty() {
                return Err(TransportError::InvalidResponse);
            }
            self.active_assistant = None;
        }
        Ok(AssistantTurnResponse {
            text,
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
        self.invoke_assistant_streaming(request, cancellation)
            .await
            .map_err(map_transport_error)
    }

    async fn cancel_session(&mut self, generation: Generation) -> Result<(), VoiceCoreError> {
        if self
            .active_assistant
            .as_ref()
            .is_none_or(|active| active.generation != generation)
        {
            return Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned(),
            });
        }
        let active =
            self.active_assistant
                .clone()
                .ok_or_else(|| VoiceCoreError::TransportFault {
                    code: "no_active_session".to_owned(),
                })?;
        let payload = assistant_interrupt_payload(&active).map_err(map_transport_error)?;
        let options = NativeRequestOptions::new(active.interrupt_request_id)
            .and_then(|options| options.with_idempotency_key(active.interrupt_idempotency_key))
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
        let response = assistant_interrupt_response_value(response).map_err(map_transport_error)?;
        if required_string(&response, "status").is_none() {
            return Err(VoiceCoreError::TransportFault {
                code: "invalid_response".to_owned(),
            });
        }
        self.active_assistant = None;
        Ok(())
    }
}

fn turn_ids_from_request(request: &AssistantTurnRequest) -> NativeVoiceTurnIds {
    NativeVoiceTurnIds::with_assistant_ids(
        request.generation,
        request.session_id.clone(),
        request.request_id.clone(),
        request.correlation_id.clone(),
    )
}

fn observe_turn_snapshot(token: NativeVoiceObservationToken, snapshot: NativeVoiceTurnSnapshot) {
    observe_native_voice(token, NativeVoiceObservation::TurnSnapshot { snapshot });
}

fn observe_assistant_delta(
    token: NativeVoiceObservationToken,
    ids: &NativeVoiceTurnIds,
    sequence: u64,
    delta: &str,
    accumulated_text: &str,
) {
    let (delta, _) = bound_observed_text(delta);
    let (accumulated_text, text_truncated) = bound_observed_text(accumulated_text);
    observe_native_voice(
        token,
        NativeVoiceObservation::AssistantDelta {
            ids: ids.clone(),
            sequence,
            delta,
            accumulated_text: accumulated_text.clone(),
            text_truncated,
        },
    );
    observe_turn_snapshot(
        token,
        NativeVoiceTurnSnapshot::new(ids.clone(), "responding").with_text(&accumulated_text),
    );
}

fn observe_assistant_completed(
    token: NativeVoiceObservationToken,
    ids: &NativeVoiceTurnIds,
    sequence: u64,
    final_text: &str,
) {
    let (final_text, text_truncated) = bound_observed_text(final_text);
    observe_native_voice(
        token,
        NativeVoiceObservation::AssistantCompleted {
            ids: ids.clone(),
            sequence,
            final_text,
            text_truncated,
        },
    );
}

fn observe_assistant_failed(
    token: NativeVoiceObservationToken,
    ids: &NativeVoiceTurnIds,
    reason_code: &str,
) {
    observe_native_voice(
        token,
        NativeVoiceObservation::AssistantFailed {
            ids: ids.clone(),
            reason_code: reason_code.to_owned(),
        },
    );
    observe_turn_snapshot(
        token,
        NativeVoiceTurnSnapshot::new(ids.clone(), "failed").terminal(true),
    );
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActiveAssistantTurn {
    generation: Generation,
    session_id: String,
    request_id: String,
    interrupt_request_id: String,
    interrupt_idempotency_key: String,
}

fn assistant_external_user_input(request: &AssistantTurnRequest) -> Result<Value, TransportError> {
    validate_identifier(&request.session_id)?;
    validate_identifier(&request.request_id)?;
    validate_identifier(&request.correlation_id)?;
    if request.transcript.is_empty() {
        return Err(TransportError::InvalidPayload);
    }
    let descriptor =
        method_by_id(ids::ORCHESTRATOR_EXTERNAL_USER_INPUT).ok_or(TransportError::UnknownMethod)?;
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
    serde_json::to_value(typed_request).map_err(|_| TransportError::InvalidPayload)
}

fn assistant_response_value(response: Value) -> Result<Value, TransportError> {
    let descriptor = method_by_id(ids::ORCHESTRATOR_EXTERNAL_USER_INPUT)
        .ok_or(TransportError::InvalidResponse)?;
    normalize_generated_contract(descriptor.output_schema_id, response)
        .map_err(|_| TransportError::InvalidResponse)
}

fn assistant_interrupt_payload(active: &ActiveAssistantTurn) -> Result<Value, TransportError> {
    let descriptor =
        method_by_id(ids::ORCHESTRATOR_INTERRUPT).ok_or(TransportError::UnknownMethod)?;
    let payload = serde_json::json!({
        "session_id": active.session_id,
        "request_id": active.request_id,
        "reason": "user_interrupt",
        "scopes": ["generation", "session", "tool_call", "tts_playback"],
    });
    let payload = normalize_generated_contract(descriptor.input_schema_id, payload)
        .map_err(|_| TransportError::InvalidPayload)?;
    let typed_request: models::OrchestratorInterruptRequest =
        serde_json::from_value(payload.clone()).map_err(|_| TransportError::InvalidPayload)?;
    serde_json::to_value(typed_request).map_err(|_| TransportError::InvalidPayload)
}

fn assistant_interrupt_response_value(response: Value) -> Result<Value, TransportError> {
    let typed_response: models::OrchestratorInterruptResponse =
        serde_json::from_value(response).map_err(|_| TransportError::InvalidResponse)?;
    serde_json::to_value(typed_response).map_err(|_| TransportError::InvalidResponse)
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
    allowed_kinds: BTreeSet<String>,
    required_correlation_id: Option<String>,
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
            .field("allowed_kind_count", &self.allowed_kinds.len())
            .field(
                "has_required_correlation_id",
                &self.required_correlation_id.is_some(),
            )
            .field("max_event_bytes", &self.max_event_bytes)
            .finish_non_exhaustive()
    }
}

impl NativeEventStream {
    /// Read the next non-comment SSE event. `None` means a clean stream close.
    pub async fn next_event(&mut self) -> Result<Option<GatewayEvent>, TransportError> {
        loop {
            if let Some(frame) = take_sse_frame(&mut self.buffer) {
                if let Some(event) = parse_event_frame(
                    &frame,
                    &self.allowed_topics,
                    &self.allowed_kinds,
                    self.required_correlation_id.as_deref(),
                )? {
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
        || (allow_loopback_http && url.scheme() == "http" && is_loopback_endpoint(url));
    if allowed && url.username().is_empty() && url.password().is_none() {
        Ok(())
    } else {
        Err(TransportError::UnsafeEndpoint)
    }
}

fn is_loopback_endpoint(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
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
    allowed_kinds: &BTreeSet<String>,
    required_correlation_id: Option<&str>,
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
    let envelope_value = parse_json_value(&data).map_err(|_| TransportError::InvalidStream)?;
    let wire = normalize_generated_contract(envelope_descriptor.schema_id, envelope_value)
        .map_err(|_| TransportError::InvalidStream)?;
    let event_id = required_string(&wire, "event_id").ok_or(TransportError::InvalidStream)?;
    validate_identifier(&event_id).map_err(|_| TransportError::InvalidStream)?;
    let topic = required_string(&wire, "topic").ok_or(TransportError::InvalidStream)?;
    if !allowed_topics.contains(&topic) {
        return Err(TransportError::UnknownEvent);
    }
    let kind = optional_string(&wire, "kind").unwrap_or_default();
    if !allowed_kinds.is_empty() && !allowed_kinds.contains(&kind) {
        return Ok(None);
    }
    let correlation_id = optional_string(&wire, "correlation_id");
    if required_correlation_id.is_some() && correlation_id.as_deref() != required_correlation_id {
        return Ok(None);
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
        kind,
        category: optional_string(&wire, "category").unwrap_or_else(|| "unknown".to_owned()),
        correlation_id,
        payload: Some(payload),
        redacted_payload: wire
            .get("redacted_payload")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        payload_sha256: optional_string(&wire, "payload_sha256").unwrap_or_default(),
    }))
}

struct AssistantInterruptIds {
    request_id: String,
    idempotency_key: String,
}

fn assistant_interrupt_ids(
    request: &AssistantTurnRequest,
) -> Result<AssistantInterruptIds, TransportError> {
    let generation = request.generation.0.to_string();
    let hash = stable_hash_64(&[
        request.session_id.as_str(),
        request.request_id.as_str(),
        request.correlation_id.as_str(),
        generation.as_str(),
    ]);
    let request_id = format!("voice-interrupt-{}-{hash:016x}", request.generation.0);
    let idempotency_key = format!("voice-interrupt-idem-{hash:016x}");
    validate_identifier(&request_id)?;
    validate_identifier(&idempotency_key)?;
    Ok(AssistantInterruptIds {
        request_id,
        idempotency_key,
    })
}

fn stable_hash_64(parts: &[&str]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn append_bounded(text: &mut String, delta: &str, limit: usize) -> Result<(), TransportError> {
    let new_len = text
        .len()
        .checked_add(delta.len())
        .ok_or(TransportError::ResponseTooLarge)?;
    if new_len > limit {
        return Err(TransportError::ResponseTooLarge);
    }
    text.push_str(delta);
    Ok(())
}

fn replace_bounded(
    text: &mut String,
    final_text: String,
    limit: usize,
) -> Result<(), TransportError> {
    if final_text.len() > limit {
        return Err(TransportError::ResponseTooLarge);
    }
    *text = final_text;
    Ok(())
}

enum AssistantStreamRead {
    Ignore,
    Delta { sequence: u64, delta: String },
    Completed { sequence: u64, final_text: String },
    Failed,
}

#[derive(Debug)]
struct AssistantStreamAssembler {
    next_sequence: u64,
}

impl AssistantStreamAssembler {
    fn new() -> Self {
        Self { next_sequence: 1 }
    }

    fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    fn accept(&mut self, sequence: u64) -> Result<bool, TransportError> {
        if sequence == self.next_sequence {
            self.next_sequence = self
                .next_sequence
                .checked_add(1)
                .ok_or(TransportError::InvalidStream)?;
            return Ok(true);
        }
        if sequence < self.next_sequence {
            return Ok(false);
        }
        Err(TransportError::InvalidStream)
    }
}

fn mesh_assistant_stream_event(
    frame: Value,
    request: &AssistantTurnRequest,
) -> Result<AssistantStreamRead, TransportError> {
    let frame_type = required_string(&frame, "type").ok_or(TransportError::InvalidPayload)?;
    if frame_type != "event" {
        return Ok(AssistantStreamRead::Ignore);
    }
    let topic = required_string(&frame, "topic").ok_or(TransportError::InvalidPayload)?;
    if topic != ids::ORCHESTRATOR_RESPONSE {
        return Ok(AssistantStreamRead::Ignore);
    }
    if optional_string(&frame, "correlation_id").as_deref() != Some(request.correlation_id.as_str())
        && optional_string(&frame, "correlationId").as_deref()
            != Some(request.correlation_id.as_str())
    {
        return Ok(AssistantStreamRead::Ignore);
    }
    let payload = frame
        .get("params")
        .or_else(|| frame.get("payload"))
        .cloned()
        .ok_or(TransportError::InvalidPayload)?;
    let descriptor =
        event_by_topic(ids::ORCHESTRATOR_RESPONSE).ok_or(TransportError::InvalidPayload)?;
    let typed = normalize_generated_contract(descriptor.schema_id, payload)
        .map_err(|_| TransportError::InvalidPayload)?;
    let payload_kind = required_string(&typed, "kind").ok_or(TransportError::InvalidPayload)?;
    if optional_string(&typed, "session_id").as_deref() != Some(request.session_id.as_str())
        || optional_string(&typed, "request_id").as_deref() != Some(request.request_id.as_str())
        || optional_string(&typed, "correlation_id").as_deref()
            != Some(request.correlation_id.as_str())
    {
        return Ok(AssistantStreamRead::Ignore);
    }
    let sequence = required_u64(&typed, "sequence").ok_or(TransportError::InvalidPayload)?;
    match payload_kind.as_str() {
        "assistant.delta" => Ok(AssistantStreamRead::Delta {
            sequence,
            delta: optional_string(&typed, "delta").unwrap_or_default(),
        }),
        "assistant.completed" if bool_field(&typed, "is_final") => {
            Ok(AssistantStreamRead::Completed {
                sequence,
                final_text: optional_string(&typed, "text").unwrap_or_default(),
            })
        }
        "assistant.failed" if bool_field(&typed, "is_final") => Ok(AssistantStreamRead::Failed),
        _ => Ok(AssistantStreamRead::Ignore),
    }
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
        let typed = payload;
        let payload_kind = required_string(typed, "kind").ok_or(TransportError::InvalidPayload)?;
        if self.kind != payload_kind {
            return Err(TransportError::InvalidStream);
        }
        if optional_string(typed, "session_id").as_deref() != Some(request.session_id.as_str())
            || optional_string(typed, "request_id").as_deref() != Some(request.request_id.as_str())
            || optional_string(typed, "correlation_id").as_deref()
                != Some(request.correlation_id.as_str())
        {
            return Ok(AssistantStreamRead::Ignore);
        }
        let sequence = required_u64(typed, "sequence").ok_or(TransportError::InvalidPayload)?;
        match payload_kind.as_str() {
            "assistant.delta" => Ok(AssistantStreamRead::Delta {
                sequence,
                delta: optional_string(typed, "delta").unwrap_or_default(),
            }),
            "assistant.completed" if bool_field(typed, "is_final") => {
                Ok(AssistantStreamRead::Completed {
                    sequence,
                    final_text: optional_string(typed, "text").unwrap_or_default(),
                })
            }
            "assistant.failed" if bool_field(typed, "is_final") => Ok(AssistantStreamRead::Failed),
            _ => Ok(AssistantStreamRead::Ignore),
        }
    }
}

fn validate_optional_response_id(
    value: &Value,
    field: &str,
    expected: &str,
) -> Result<(), TransportError> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(actual)) if actual == expected => Ok(()),
        Some(_) => Err(TransportError::InvalidResponse),
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

fn required_u64(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    use super::*;
    use aurora_voice_core::AssistantTurnNamespace;

    static MESH_TEST_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[derive(Default)]
    struct MeshTestState {
        options: Vec<NativeMeshAssistantTransportOptions>,
        external_inputs: Vec<NativeMeshExternalUserInput>,
        interrupts: Vec<NativeMeshInterruptRequest>,
        stream_events: Vec<Value>,
        response: Option<Value>,
        interrupt_response: Option<Value>,
        delay: Option<Duration>,
    }

    struct RecordingMeshFactory {
        state: Arc<Mutex<MeshTestState>>,
    }

    impl NativeMeshAssistantTransportFactory for RecordingMeshFactory {
        fn create(
            &self,
            options: NativeMeshAssistantTransportOptions,
        ) -> Result<Box<dyn NativeMeshAssistantTransport>, TransportError> {
            self.state.lock().expect("mesh state").options.push(options);
            Ok(Box::new(RecordingMeshTransport {
                state: Arc::clone(&self.state),
            }))
        }
    }

    struct RecordingMeshTransport {
        state: Arc<Mutex<MeshTestState>>,
    }

    #[async_trait(?Send)]
    impl NativeMeshAssistantTransport for RecordingMeshTransport {
        async fn external_user_input(
            &mut self,
            request: NativeMeshExternalUserInput,
            cancellation: CancellationToken,
        ) -> Result<Value, TransportError> {
            let delay = {
                let mut state = self.state.lock().expect("mesh state");
                state.external_inputs.push(request.clone());
                state.delay
            };
            if let Some(delay) = delay {
                await_timed(tokio::time::sleep(delay), &cancellation, request.timeout()).await?;
            }
            self.state
                .lock()
                .expect("mesh state")
                .response
                .clone()
                .ok_or(TransportError::RequestFailed)
        }

        async fn external_user_input_stream(
            &mut self,
            request: NativeMeshExternalUserInput,
            _cancellation: CancellationToken,
        ) -> Result<NativeMeshExternalUserInputStream, TransportError> {
            let (sender, events) = tokio::sync::mpsc::channel(32);
            let (stream_events, response) = {
                let mut state = self.state.lock().expect("mesh state");
                state.external_inputs.push(request.clone());
                (state.stream_events.clone(), state.response.clone())
            };
            for event in stream_events {
                let _ = sender.try_send(Ok(event));
            }
            drop(sender);
            let terminal: NativeMeshTerminalFuture =
                Box::pin(async move { response.ok_or(TransportError::RequestFailed) });
            Ok(NativeMeshExternalUserInputStream::new_with_async_cleanup(
                events,
                terminal,
                || async { Ok(()) },
                || async { Ok(()) },
                || {},
            ))
        }

        async fn interrupt(
            &mut self,
            request: NativeMeshInterruptRequest,
            _cancellation: CancellationToken,
        ) -> Result<Value, TransportError> {
            let mut state = self.state.lock().expect("mesh state");
            state.interrupts.push(request);
            state
                .interrupt_response
                .clone()
                .ok_or(TransportError::RequestFailed)
        }
    }

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

    fn sse_response(body: &[u8]) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.iter().copied())
        .collect()
    }

    fn assistant_ack_response(generation: u64) -> Vec<u8> {
        let request = assistant_request(generation, "ack");
        let body = serde_json::json!({
            "text": "accepted",
            "metadata": {},
            "session_id": request.session_id,
            "request_id": request.request_id,
            "correlation_id": request.correlation_id,
        })
        .to_string();
        json_response(body.as_bytes())
    }

    fn interrupt_response(generation: u64) -> Vec<u8> {
        let request = assistant_request(generation, "interrupt");
        let body = serde_json::json!({
            "audit_event": "orchestrator.interrupt.requested",
            "event_topic": "Orchestrator.Interrupted",
            "idempotent": true,
            "interrupt_id": "interrupt-1",
            "status": "cancelled",
            "request_id": request.request_id,
            "session_id": request.session_id,
            "requested_scopes": ["generation", "session", "tool_call", "tts_playback"],
            "results": [],
            "secrets_redacted": true,
        })
        .to_string();
        json_response(body.as_bytes())
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

    fn loopback_microphone_limits() -> TransportLimits {
        TransportLimits {
            allow_loopback_http: true,
            microphone_audio_policy: MicrophoneAudioPolicy::LoopbackOnly,
            ..TransportLimits::default()
        }
    }

    fn explicit_microphone_limits() -> TransportLimits {
        TransportLimits {
            allow_loopback_http: true,
            microphone_audio_policy: MicrophoneAudioPolicy::ExplicitRemoteConsent,
            ..TransportLimits::default()
        }
    }

    fn assistant_namespace() -> AssistantTurnNamespace {
        AssistantTurnNamespace::new("native-test").expect("assistant namespace")
    }

    fn assistant_request(generation: u64, transcript: &str) -> AssistantTurnRequest {
        AssistantTurnRequest::from_generation(
            &assistant_namespace(),
            Generation(generation),
            transcript,
        )
    }

    fn assistant_response_value_for(request: &AssistantTurnRequest, text: &str) -> Value {
        serde_json::json!({
            "text": text,
            "metadata": {},
            "session_id": request.session_id,
            "request_id": request.request_id,
            "correlation_id": request.correlation_id,
        })
    }

    fn reader_speech_transport(
        events: Vec<Value>,
        terminal: Option<Result<Value, TransportError>>,
        terminal_cleanup: Arc<StreamCleanupProbe>,
        abandoned_cleanup: Arc<StreamCleanupProbe>,
    ) -> NativeMeshAssistantSpeechTransport {
        let interrupt_calls = Arc::clone(&abandoned_cleanup.interrupt_calls);
        NativeMeshAssistantSpeechTransport {
            transport: Box::new(ReaderMeshTransport {
                events,
                terminal,
                terminal_cleanup,
                abandoned_cleanup,
                interrupt_calls,
            }),
            limits: TransportLimits::default(),
            active_assistant: None,
        }
    }

    fn interrupt_response_value_for(request: &AssistantTurnRequest) -> Value {
        serde_json::json!({
            "audit_event": "orchestrator.interrupt.requested",
            "event_topic": "Orchestrator.Interrupted",
            "idempotent": true,
            "interrupt_id": "interrupt-1",
            "status": "cancelled",
            "request_id": request.request_id,
            "session_id": request.session_id,
            "requested_scopes": ["generation", "session", "tool_call", "tts_playback"],
            "results": [],
            "secrets_redacted": true,
        })
    }

    struct StreamCleanupProbe {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
        calls: AtomicUsize,
        interrupt_calls: Arc<AtomicUsize>,
        result: Result<(), TransportError>,
    }

    impl StreamCleanupProbe {
        fn new(result: Result<(), TransportError>) -> Self {
            Self {
                started: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
                calls: AtomicUsize::new(0),
                interrupt_calls: Arc::new(AtomicUsize::new(0)),
                result,
            }
        }

        async fn close(&self) -> Result<(), TransportError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            self.release.notified().await;
            self.result.clone()
        }
    }

    struct ReaderMeshTransport {
        events: Vec<Value>,
        terminal: Option<Result<Value, TransportError>>,
        terminal_cleanup: Arc<StreamCleanupProbe>,
        abandoned_cleanup: Arc<StreamCleanupProbe>,
        interrupt_calls: Arc<AtomicUsize>,
    }

    #[async_trait(?Send)]
    impl NativeMeshAssistantTransport for ReaderMeshTransport {
        async fn external_user_input(
            &mut self,
            _request: NativeMeshExternalUserInput,
            _cancellation: CancellationToken,
        ) -> Result<Value, TransportError> {
            Err(TransportError::RequestFailed)
        }

        async fn external_user_input_stream(
            &mut self,
            _request: NativeMeshExternalUserInput,
            _cancellation: CancellationToken,
        ) -> Result<NativeMeshExternalUserInputStream, TransportError> {
            let (sender, events) = tokio::sync::mpsc::channel(4);
            for event in self.events.drain(..) {
                let _ = sender.try_send(Ok(event));
            }
            drop(sender);
            let terminal: NativeMeshTerminalFuture = match self.terminal.clone() {
                Some(terminal_result) => Box::pin(async move { terminal_result }),
                None => Box::pin(std::future::pending()),
            };
            let terminal_cleanup_probe = Arc::clone(&self.terminal_cleanup);
            let abandoned_cleanup_probe = Arc::clone(&self.abandoned_cleanup);
            Ok(NativeMeshExternalUserInputStream::new_with_async_cleanup(
                events,
                terminal,
                move || {
                    let probe = Arc::clone(&terminal_cleanup_probe);
                    async move { probe.close().await }
                },
                move || {
                    let probe = Arc::clone(&abandoned_cleanup_probe);
                    async move { probe.close().await }
                },
                || {},
            ))
        }

        async fn interrupt(
            &mut self,
            request: NativeMeshInterruptRequest,
            _cancellation: CancellationToken,
        ) -> Result<Value, TransportError> {
            self.interrupt_calls.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({
                "audit_event": "orchestrator.interrupt.requested",
                "event_topic": "Orchestrator.Interrupted",
                "idempotent": true,
                "interrupt_id": request.request_id(),
                "status": "cancelled",
                "request_id": request.payload().get("request_id"),
                "session_id": request.payload().get("session_id"),
                "requested_scopes": ["generation", "session", "tool_call", "tts_playback"],
                "results": [],
                "secrets_redacted": true,
            }))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mesh_assistant_turn_uses_registered_factory_and_typed_external_input() {
        let _guard = MESH_TEST_GUARD.lock().await;
        clear_native_mesh_assistant_transport_factory();
        let turn = assistant_request(31, "hello mesh");
        let state = Arc::new(Mutex::new(MeshTestState {
            response: Some(assistant_response_value_for(&turn, "mesh response")),
            interrupt_response: Some(interrupt_response_value_for(&turn)),
            ..MeshTestState::default()
        }));
        install_native_mesh_assistant_transport_factory(Arc::new(RecordingMeshFactory {
            state: Arc::clone(&state),
        }));
        let route =
            NativeMeshAssistantRoute::new(Some("stable-peer-1".to_owned())).expect("mesh route");
        let limits = TransportLimits {
            request_timeout: Duration::from_secs(7),
            ..TransportLimits::default()
        };
        let mut transport =
            NativeMeshAssistantSpeechTransport::new(route, limits).expect("mesh transport");

        let response =
            SpeechTransport::assistant_turn(&mut transport, turn.clone(), CancellationToken::new())
                .await
                .expect("mesh assistant response");

        assert_eq!(response.text, "mesh response");
        let state = state.lock().expect("mesh state");
        assert_eq!(state.options.len(), 1);
        assert_eq!(
            state.options[0].route().preferred_stable_peer_id(),
            Some("stable-peer-1")
        );
        assert_eq!(state.external_inputs.len(), 1);
        let request = &state.external_inputs[0];
        assert_eq!(request.request_id(), turn.request_id);
        assert_eq!(request.idempotency_key(), turn.correlation_id);
        assert_eq!(request.timeout(), Duration::from_secs(7));
        assert_eq!(
            required_string(request.payload(), "text").as_deref(),
            Some("hello mesh")
        );
        assert_eq!(
            required_string(request.payload(), "source").as_deref(),
            Some(ASSISTANT_SOURCE)
        );
        assert_eq!(state.interrupts.len(), 0);
        drop(state);
        clear_native_mesh_assistant_transport_factory();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mesh_streaming_observer_close_preserves_native_main_result_without_interrupt() {
        let _guard = MESH_TEST_GUARD.lock().await;
        clear_native_mesh_assistant_transport_factory();
        let turn = assistant_request(35, "hello streaming mesh");
        let stream_events = (1..=33_u64)
            .map(|sequence| {
                serde_json::json!({
                    "kind": "assistant.delta",
                    "delta": "x",
                    "text": "",
                    "is_final": false,
                    "sequence": sequence,
                    "session_id": turn.session_id.clone(),
                    "request_id": turn.request_id.clone(),
                    "correlation_id": turn.correlation_id.clone(),
                    "metadata": {},
                })
            })
            .collect::<Vec<_>>();
        let state = Arc::new(Mutex::new(MeshTestState {
            stream_events,
            response: Some(assistant_response_value_for(
                &turn,
                "terminal mesh response",
            )),
            interrupt_response: Some(interrupt_response_value_for(&turn)),
            ..MeshTestState::default()
        }));
        install_native_mesh_assistant_transport_factory(Arc::new(RecordingMeshFactory {
            state: Arc::clone(&state),
        }));
        let route = NativeMeshAssistantRoute::new(None).expect("mesh route");
        let mut transport =
            NativeMeshAssistantSpeechTransport::new(route, TransportLimits::default())
                .expect("mesh transport");

        let response =
            SpeechTransport::assistant_turn(&mut transport, turn.clone(), CancellationToken::new())
                .await
                .expect("mesh assistant response");

        assert_eq!(response.text, "terminal mesh response");
        let state = state.lock().expect("mesh state");
        assert_eq!(state.external_inputs.len(), 1);
        assert_eq!(state.external_inputs[0].request_id(), turn.request_id);
        assert_eq!(state.interrupts.len(), 0);
        drop(state);
        clear_native_mesh_assistant_transport_factory();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mesh_assistant_turn_cancels_active_turn_after_invalid_response() {
        let _guard = MESH_TEST_GUARD.lock().await;
        clear_native_mesh_assistant_transport_factory();
        let turn = assistant_request(32, "bad mesh");
        let mut invalid_response = assistant_response_value_for(&turn, "wrong id");
        invalid_response["session_id"] = Value::String("other-session".to_owned());
        let state = Arc::new(Mutex::new(MeshTestState {
            response: Some(invalid_response),
            interrupt_response: Some(interrupt_response_value_for(&turn)),
            ..MeshTestState::default()
        }));
        install_native_mesh_assistant_transport_factory(Arc::new(RecordingMeshFactory {
            state: Arc::clone(&state),
        }));
        let route = NativeMeshAssistantRoute::new(None).expect("mesh route");
        let mut transport =
            NativeMeshAssistantSpeechTransport::new(route, TransportLimits::default())
                .expect("mesh transport");

        let error =
            SpeechTransport::assistant_turn(&mut transport, turn.clone(), CancellationToken::new())
                .await
                .expect_err("invalid mesh response");

        assert_eq!(
            error,
            VoiceCoreError::TransportFault {
                code: "invalid_response".to_owned()
            }
        );
        let state = state.lock().expect("mesh state");
        assert_eq!(state.interrupts.len(), 1);
        let interrupt = &state.interrupts[0];
        assert!(interrupt.request_id().starts_with("voice-interrupt-32-"));
        assert!(interrupt
            .idempotency_key()
            .starts_with("voice-interrupt-idem-"));
        assert_eq!(
            required_string(interrupt.payload(), "session_id").as_deref(),
            Some(turn.session_id.as_str())
        );
        drop(state);
        clear_native_mesh_assistant_transport_factory();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mesh_failed_interrupt_keeps_active_turn_retryable() {
        let _guard = MESH_TEST_GUARD.lock().await;
        clear_native_mesh_assistant_transport_factory();
        let turn = assistant_request(34, "retry mesh interrupt");
        let mut invalid_response = assistant_response_value_for(&turn, "wrong id");
        invalid_response["request_id"] = Value::String("other-request".to_owned());
        let state = Arc::new(Mutex::new(MeshTestState {
            response: Some(invalid_response),
            interrupt_response: None,
            ..MeshTestState::default()
        }));
        install_native_mesh_assistant_transport_factory(Arc::new(RecordingMeshFactory {
            state: Arc::clone(&state),
        }));
        let route = NativeMeshAssistantRoute::new(None).expect("mesh route");
        let mut transport =
            NativeMeshAssistantSpeechTransport::new(route, TransportLimits::default())
                .expect("mesh transport");

        let error =
            SpeechTransport::assistant_turn(&mut transport, turn.clone(), CancellationToken::new())
                .await
                .expect_err("invalid mesh response");

        assert_eq!(
            error,
            VoiceCoreError::TransportFault {
                code: "invalid_response".to_owned()
            }
        );
        {
            let mut state = state.lock().expect("mesh state");
            assert_eq!(state.interrupts.len(), 1);
            state.interrupt_response = Some(interrupt_response_value_for(&turn));
        }
        SpeechTransport::cancel_session(&mut transport, Generation(34))
            .await
            .expect("retry interrupt succeeds");
        {
            let state = state.lock().expect("mesh state");
            assert_eq!(state.interrupts.len(), 2);
        }
        assert_eq!(
            SpeechTransport::cancel_session(&mut transport, Generation(34)).await,
            Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned()
            })
        );
        clear_native_mesh_assistant_transport_factory();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mesh_assistant_turn_maps_timeout_without_leaking_payloads() {
        let _guard = MESH_TEST_GUARD.lock().await;
        clear_native_mesh_assistant_transport_factory();
        let turn = assistant_request(33, "slow mesh");
        let state = Arc::new(Mutex::new(MeshTestState {
            response: Some(assistant_response_value_for(&turn, "late")),
            interrupt_response: Some(interrupt_response_value_for(&turn)),
            delay: Some(Duration::from_millis(50)),
            ..MeshTestState::default()
        }));
        install_native_mesh_assistant_transport_factory(Arc::new(RecordingMeshFactory {
            state: Arc::clone(&state),
        }));
        let limits = TransportLimits {
            request_timeout: Duration::from_millis(1),
            ..TransportLimits::default()
        };
        let route = NativeMeshAssistantRoute::new(None).expect("mesh route");
        let mut transport =
            NativeMeshAssistantSpeechTransport::new(route, limits).expect("mesh transport");

        let error = SpeechTransport::assistant_turn(&mut transport, turn, CancellationToken::new())
            .await
            .expect_err("timeout");

        assert_eq!(
            error,
            VoiceCoreError::TransportFault {
                code: "timeout".to_owned()
            }
        );
        let debug = format!("{transport:?}");
        assert!(!debug.contains("slow mesh"));
        clear_native_mesh_assistant_transport_factory();
    }

    #[tokio::test]
    async fn mesh_reader_waits_for_terminal_cleanup_before_success() {
        let request = assistant_request(80, "cleanup wait");
        let terminal_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        let abandoned_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        abandoned_cleanup.release.notify_one();
        let mut transport = reader_speech_transport(
            Vec::new(),
            Some(Ok(assistant_response_value_for(&request, "done"))),
            Arc::clone(&terminal_cleanup),
            abandoned_cleanup,
        );
        let mut read =
            Box::pin(transport.invoke_assistant_streaming(request, CancellationToken::new()));
        let cleanup_started = terminal_cleanup.started.notified();
        tokio::pin!(cleanup_started);
        tokio::select! {
            result = &mut read => panic!("reader returned before cleanup completed: {result:?}"),
            _ = &mut cleanup_started => {}
        }
        assert_eq!(terminal_cleanup.calls.load(Ordering::SeqCst), 1);
        terminal_cleanup.release.notify_one();
        assert_eq!(read.await.expect("terminal response").text, "done");
    }

    #[tokio::test]
    async fn mesh_reader_close_failure_overrides_success_and_validation_failure() {
        let request = assistant_request(81, "cleanup failure");
        let terminal_cleanup =
            Arc::new(StreamCleanupProbe::new(Err(TransportError::RequestFailed)));
        terminal_cleanup.release.notify_one();
        let abandoned_cleanup =
            Arc::new(StreamCleanupProbe::new(Err(TransportError::RequestFailed)));
        abandoned_cleanup.release.notify_one();
        let mut success_transport = reader_speech_transport(
            Vec::new(),
            Some(Ok(assistant_response_value_for(&request, "done"))),
            Arc::clone(&terminal_cleanup),
            Arc::clone(&abandoned_cleanup),
        );
        assert_eq!(
            success_transport
                .invoke_assistant_streaming(request.clone(), CancellationToken::new())
                .await,
            Err(TransportError::RequestFailed)
        );
        assert_eq!(terminal_cleanup.calls.load(Ordering::SeqCst), 1);
        assert!(
            success_transport.active_assistant.is_some(),
            "a failed required close must not clear the active marker"
        );

        let invalid_request = assistant_request(82, "invalid event");
        let terminal_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        terminal_cleanup.release.notify_one();
        let abandoned_cleanup =
            Arc::new(StreamCleanupProbe::new(Err(TransportError::RequestFailed)));
        abandoned_cleanup.release.notify_one();
        let mut invalid_transport = reader_speech_transport(
            vec![serde_json::json!({"not": "an assistant event"})],
            None,
            terminal_cleanup.clone(),
            Arc::clone(&abandoned_cleanup),
        );
        assert_eq!(
            invalid_transport
                .invoke_assistant_streaming(invalid_request, CancellationToken::new())
                .await,
            Err(TransportError::RequestFailed),
            "close failure takes precedence over an earlier event validation error"
        );
        assert_eq!(abandoned_cleanup.calls.load(Ordering::SeqCst), 1);
        assert_eq!(terminal_cleanup.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn failed_setup_close_keeps_reader_marker_until_explicit_interrupt_succeeds() {
        let request = assistant_request(86, "failed setup cleanup");
        let terminal_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        terminal_cleanup.release.notify_one();
        let failed_cleanup = Arc::new(StreamCleanupProbe::new(Err(TransportError::RequestFailed)));
        failed_cleanup.release.notify_one();
        let mut transport = reader_speech_transport(
            Vec::new(),
            Some(Err(TransportError::RequestFailed)),
            terminal_cleanup,
            Arc::clone(&failed_cleanup),
        );

        assert_eq!(
            transport
                .invoke_assistant_streaming(request, CancellationToken::new())
                .await,
            Err(TransportError::RequestFailed)
        );
        assert_eq!(failed_cleanup.interrupt_calls.load(Ordering::SeqCst), 0);
        assert!(
            transport.active_assistant.is_some(),
            "failed close must retain the active marker instead of clearing it through interrupt bookkeeping"
        );

        SpeechTransport::cancel_session(&mut transport, Generation(86))
            .await
            .expect("later explicit interrupt response");
        assert_eq!(failed_cleanup.interrupt_calls.load(Ordering::SeqCst), 1);
        assert!(transport.active_assistant.is_none());
    }

    #[tokio::test]
    async fn mesh_reader_awaits_abandonment_for_cancelled_and_failed_events() {
        let failed_request = assistant_request(83, "failed event");
        let failed_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        failed_cleanup.release.notify_one();
        let unused_terminal_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        unused_terminal_cleanup.release.notify_one();
        let failed_event = serde_json::json!({
            "type": "event",
            "topic": ids::ORCHESTRATOR_RESPONSE,
            "correlation_id": failed_request.correlation_id,
            "params": assistant_payload_for(83, "assistant.failed", "", "", true),
        });
        let mut failed_transport = reader_speech_transport(
            vec![failed_event],
            None,
            Arc::clone(&unused_terminal_cleanup),
            Arc::clone(&failed_cleanup),
        );
        assert_eq!(
            failed_transport
                .invoke_assistant_streaming(failed_request, CancellationToken::new())
                .await,
            Err(TransportError::InvalidResponse)
        );
        assert_eq!(failed_cleanup.calls.load(Ordering::SeqCst), 1);
        assert_eq!(unused_terminal_cleanup.calls.load(Ordering::SeqCst), 0);

        let cancelled_request = assistant_request(84, "cancelled reader");
        let cancelled_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        cancelled_cleanup.release.notify_one();
        let unused_terminal_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        unused_terminal_cleanup.release.notify_one();
        let mut cancelled_transport = reader_speech_transport(
            Vec::new(),
            None,
            unused_terminal_cleanup.clone(),
            Arc::clone(&cancelled_cleanup),
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            cancelled_transport
                .invoke_assistant_streaming(cancelled_request, cancellation)
                .await,
            Err(TransportError::Cancelled)
        );
        assert_eq!(cancelled_cleanup.calls.load(Ordering::SeqCst), 1);
        assert_eq!(unused_terminal_cleanup.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn legacy_sync_only_stream_cleanup_cannot_claim_terminal_success() {
        let (_sender, events) = tokio::sync::mpsc::channel(1);
        let cleanup_called = Arc::new(AtomicBool::new(false));
        let cleanup_called_by_drop = Arc::clone(&cleanup_called);
        let stream = NativeMeshExternalUserInputStream::new_with_cleanup(
            events,
            Box::pin(async { Ok(serde_json::json!({"text": "done"})) }),
            Box::new(move || cleanup_called_by_drop.store(true, Ordering::SeqCst)),
        );
        assert_eq!(
            stream.terminal_response().await,
            Err(TransportError::RequestFailed)
        );
        assert!(cleanup_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn terminal_response_awaits_close_and_close_error_takes_precedence() {
        let (_sender, events) = tokio::sync::mpsc::channel(1);
        let terminal_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        let abandoned_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        abandoned_cleanup.release.notify_one();
        let stream = NativeMeshExternalUserInputStream::new_with_async_cleanup(
            events,
            Box::pin(async { Ok(serde_json::json!({"text": "done"})) }),
            {
                let probe = Arc::clone(&terminal_cleanup);
                move || {
                    let probe = Arc::clone(&probe);
                    async move { probe.close().await }
                }
            },
            move || {
                let probe = Arc::clone(&abandoned_cleanup);
                async move { probe.close().await }
            },
            || {},
        );
        let mut response = Box::pin(stream.terminal_response());
        let cleanup_started = terminal_cleanup.started.notified();
        tokio::pin!(cleanup_started);
        tokio::select! {
            result = &mut response => panic!("terminal returned before close: {result:?}"),
            _ = &mut cleanup_started => {}
        }
        assert_eq!(terminal_cleanup.calls.load(Ordering::SeqCst), 1);
        terminal_cleanup.release.notify_one();
        assert_eq!(
            response.await.expect("terminal response"),
            serde_json::json!({"text": "done"})
        );

        let (_sender, events) = tokio::sync::mpsc::channel(1);
        let terminal_cleanup = Arc::new(StreamCleanupProbe::new(Err(TransportError::Timeout)));
        terminal_cleanup.release.notify_one();
        let abandoned_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        abandoned_cleanup.release.notify_one();
        let stream = NativeMeshExternalUserInputStream::new_with_async_cleanup(
            events,
            Box::pin(async { Ok(serde_json::json!({"text": "done"})) }),
            move || {
                let probe = Arc::clone(&terminal_cleanup);
                async move { probe.close().await }
            },
            move || {
                let probe = Arc::clone(&abandoned_cleanup);
                async move { probe.close().await }
            },
            || {},
        );
        assert_eq!(
            stream.terminal_response().await,
            Err(TransportError::Timeout)
        );

        let (_sender, events) = tokio::sync::mpsc::channel(1);
        let terminal_cleanup =
            Arc::new(StreamCleanupProbe::new(Err(TransportError::RequestFailed)));
        terminal_cleanup.release.notify_one();
        let abandoned_cleanup = Arc::new(StreamCleanupProbe::new(Ok(())));
        abandoned_cleanup.release.notify_one();
        let stream = NativeMeshExternalUserInputStream::new_with_async_cleanup(
            events,
            Box::pin(async { Err(TransportError::InvalidResponse) }),
            {
                let probe = Arc::clone(&terminal_cleanup);
                move || {
                    let probe = Arc::clone(&probe);
                    async move { probe.close().await }
                }
            },
            {
                let probe = Arc::clone(&abandoned_cleanup);
                move || {
                    let probe = Arc::clone(&probe);
                    async move { probe.close().await }
                }
            },
            || {},
        );
        assert_eq!(
            stream.terminal_response().await,
            Err(TransportError::InvalidResponse)
        );
        assert_eq!(terminal_cleanup.calls.load(Ordering::SeqCst), 0);
        assert_eq!(abandoned_cleanup.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mesh_assistant_route_rejects_invalid_preferred_peer_and_missing_factory() {
        let _guard = MESH_TEST_GUARD.lock().await;
        clear_native_mesh_assistant_transport_factory();
        assert!(NativeMeshAssistantRoute::new(Some("bad peer".to_owned())).is_err());
        let route = NativeMeshAssistantRoute::new(Some("peer.ok".to_owned())).expect("route");
        let error = NativeMeshAssistantSpeechTransport::new(route, TransportLimits::default())
            .expect_err("missing mesh factory");
        assert_eq!(error, TransportError::UnknownMethod);
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
        let turn_request = assistant_request(7, "hello aurora");
        let response_body = serde_json::json!({
            "text": "answer ready",
            "metadata": {},
            "session_id": turn_request.session_id,
            "request_id": turn_request.request_id,
            "correlation_id": turn_request.correlation_id,
        })
        .to_string();
        let server = FixtureServer::one_response(json_response(response_body.as_bytes()));
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let response = transport
            .invoke_assistant_turn(turn_request.clone(), CancellationToken::new())
            .await
            .expect("assistant response");

        assert_eq!(response.text, "answer ready");
        assert_eq!(
            response.session_id.as_deref(),
            Some(turn_request.session_id.as_str())
        );
        let request = server.request.recv().expect("captured request");
        assert!(request.starts_with("POST /api/Orchestrator/ExternalUserInput HTTP/1.1"));
        assert!(request.contains(&format!("x-request-id: {}", turn_request.request_id)));
        assert!(request.contains(&format!("idempotency-key: {}", turn_request.correlation_id)));
        let body = request_body(&request);
        assert_eq!(body["text"], "hello aurora");
        assert_eq!(body["source"], ASSISTANT_SOURCE);
        assert_eq!(body["session_id"], turn_request.session_id);
        assert_eq!(body["request_id"], turn_request.request_id);
        assert_eq!(body["correlation_id"], turn_request.correlation_id);
        assert_eq!(body["stream"], false);
        assert!(!request.contains("native-test"));
    }

    #[tokio::test]
    async fn assistant_turn_rejects_stream_flag_before_network() {
        let mut transport = NativeGatewayTransport::new(
            Url::parse("http://127.0.0.1:9/").expect("URL"),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");
        let mut request = assistant_request(10, "hello aurora");
        request.stream = true;

        let result = transport
            .invoke_assistant_turn(request, CancellationToken::new())
            .await;

        assert_eq!(result, Err(TransportError::InvalidConfiguration));
    }

    #[tokio::test]
    async fn assistant_turn_rejects_malformed_and_oversize_finite_response() {
        let malformed =
            FixtureServer::responses([json_response(br#"{"metadata":{}}"#), interrupt_response(8)]);
        let mut transport = NativeGatewayTransport::new(
            malformed.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");
        let result = transport
            .invoke_assistant_turn(
                assistant_request(8, "hello aurora"),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(result, Err(TransportError::InvalidResponse));

        let oversized = FixtureServer::responses([
            json_response(br#"{"text":"answer ready","metadata":{}}"#),
            interrupt_response(9),
        ]);
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
                assistant_request(9, "hello aurora"),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(result, Err(TransportError::ResponseTooLarge));
    }

    #[tokio::test]
    async fn assistant_turn_rejects_mismatched_optional_response_ids_and_cleans_up() {
        for (generation, field) in [
            (13, "session_id"),
            (14, "request_id"),
            (15, "correlation_id"),
        ] {
            let turn_request = assistant_request(generation, "hello aurora");
            let mut response_body = serde_json::json!({
                "text": "answer ready",
                "metadata": {},
                "session_id": turn_request.session_id,
                "request_id": turn_request.request_id,
                "correlation_id": turn_request.correlation_id,
            });
            response_body[field] = serde_json::json!("wrong-id");
            let response_body = response_body.to_string();
            let server = FixtureServer::responses([
                json_response(response_body.as_bytes()),
                interrupt_response(generation),
            ]);
            let mut transport = NativeGatewayTransport::new(
                server.base_url.clone(),
                GatewayAuth::None,
                loopback_limits(),
            )
            .expect("transport");

            let result = transport
                .invoke_assistant_turn(turn_request, CancellationToken::new())
                .await;

            assert_eq!(result, Err(TransportError::InvalidResponse), "{field}");
            assert_eq!(
                transport.cancel_session(Generation(generation)).await,
                Err(VoiceCoreError::TransportFault {
                    code: "no_active_session".to_owned()
                }),
                "{field}"
            );
            let _assistant_request = server.request.recv().expect("assistant request");
            let interrupt_request = server.request.recv().expect("interrupt request");
            assert!(interrupt_request.starts_with("POST /api/Orchestrator/Interrupt HTTP/1.1"));
        }
    }

    #[tokio::test]
    async fn cancel_session_posts_generated_interrupt_for_active_request() {
        let turn_request = assistant_request(3, "cancel this");
        let server = FixtureServer::responses([
            status_response("500 Internal Server Error"),
            interrupt_response(3),
        ]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let failed = transport
            .invoke_assistant_turn(turn_request.clone(), CancellationToken::new())
            .await;
        assert_eq!(failed, Err(TransportError::HttpStatus { status: 500 }));
        assert_eq!(
            transport.cancel_session(Generation(3)).await,
            Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned()
            })
        );

        let first = server.request.recv().expect("assistant request");
        assert!(first.starts_with("POST /api/Orchestrator/ExternalUserInput HTTP/1.1"));
        let second = server.request.recv().expect("interrupt request");
        assert!(second.starts_with("POST /api/Orchestrator/Interrupt HTTP/1.1"));
        assert!(second.contains("x-request-id: voice-interrupt-3-"));
        assert!(second.contains("idempotency-key: voice-interrupt-idem-"));
        let body = request_body(&second);
        assert_eq!(body["session_id"], turn_request.session_id);
        assert_eq!(body["request_id"], turn_request.request_id);
        assert_eq!(body["reason"], "user_interrupt");
        assert_eq!(
            body["scopes"],
            serde_json::json!(["generation", "session", "tool_call", "tts_playback"])
        );
    }

    #[tokio::test]
    async fn failed_cleanup_interrupt_keeps_active_session_retryable() {
        let server = FixtureServer::responses([
            status_response("500 Internal Server Error"),
            status_response("500 Internal Server Error"),
            interrupt_response(4),
        ]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let failed = transport
            .invoke_assistant_turn(
                assistant_request(4, "cancel this"),
                CancellationToken::new(),
            )
            .await;

        assert_eq!(failed, Err(TransportError::HttpStatus { status: 500 }));
        assert_eq!(transport.cancel_session(Generation(4)).await, Ok(()));
        let _assistant_request = server.request.recv().expect("assistant request");
        let failed_interrupt = server.request.recv().expect("failed interrupt request");
        assert!(failed_interrupt.contains("x-request-id: voice-interrupt-4-"));
        let retry_interrupt = server.request.recv().expect("retry interrupt request");
        assert!(retry_interrupt.contains("x-request-id: voice-interrupt-4-"));
        assert_eq!(
            transport.cancel_session(Generation(4)).await,
            Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned()
            })
        );
    }

    #[tokio::test]
    async fn wrong_generation_cancel_preserves_active_session() {
        let turn_request = assistant_request(5, "preserve this");
        let interrupt_ids = assistant_interrupt_ids(&turn_request).expect("interrupt ids");
        let server = FixtureServer::one_response(interrupt_response(5));
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");
        transport.active_assistant = Some(ActiveAssistantTurn {
            generation: turn_request.generation,
            session_id: turn_request.session_id.clone(),
            request_id: turn_request.request_id.clone(),
            interrupt_request_id: interrupt_ids.request_id,
            interrupt_idempotency_key: interrupt_ids.idempotency_key,
        });

        assert_eq!(
            transport.cancel_session(Generation(6)).await,
            Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned()
            })
        );
        transport
            .cancel_session(Generation(5))
            .await
            .expect("correct generation interrupt");

        let interrupt_request = server.request.recv().expect("interrupt request");
        assert!(interrupt_request.starts_with("POST /api/Orchestrator/Interrupt HTTP/1.1"));
        let body = request_body(&interrupt_request);
        assert_eq!(body["session_id"], turn_request.session_id);
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
    async fn microphone_audio_routes_are_blocked_by_default_before_network() {
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
    async fn loopback_microphone_policy_allows_only_loopback_audio_routes() {
        let response_body = br#"{"text":"hello","duration_ms":10.0,"model_used":"realtime","confidence":null,"language":null}"#;
        let server = FixtureServer::one_response(json_response(response_body));
        let transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_microphone_limits(),
        )
        .expect("transport");
        let profile = transport.microphone_audio_profile();
        assert_eq!(
            profile.endpoint_class(),
            NativeGatewayEndpointClass::Loopback
        );
        assert_eq!(
            profile.microphone_audio_policy(),
            MicrophoneAudioPolicy::LoopbackOnly
        );

        let result = transport
            .invoke_generated(
                "Transcription.Transcribe",
                serde_json::json!({
                    "audio_data": "cGNt",
                    "format": "raw",
                    "sample_rate": 16000,
                    "channels": 1,
                    "model": "realtime"
                }),
                &NativeRequestOptions::new("voice-request-loopback").expect("options"),
                &CancellationToken::new(),
            )
            .await
            .expect("loopback audio route");

        assert_eq!(result["text"], "hello");
        let request = server.request.recv().expect("captured request");
        assert!(request.starts_with("POST /api/Transcription/Transcribe HTTP/1.1"));
        assert_eq!(request_body(&request)["audio_data"], "cGNt");

        let remote_transport = NativeGatewayTransport::new(
            Url::parse("https://remote.example.invalid/").expect("URL"),
            GatewayAuth::None,
            TransportLimits {
                microphone_audio_policy: MicrophoneAudioPolicy::LoopbackOnly,
                ..TransportLimits::default()
            },
        )
        .expect("transport");
        assert_eq!(
            remote_transport.validate_microphone_audio_policy(),
            Err(TransportError::RemoteAudioBlocked)
        );
    }

    #[test]
    fn explicit_microphone_consent_allows_configured_remote_audio_routes() {
        let remote_transport = NativeGatewayTransport::new(
            Url::parse("https://remote.example.invalid/").expect("URL"),
            GatewayAuth::Bearer("do-not-render".to_owned()),
            TransportLimits {
                microphone_audio_policy: MicrophoneAudioPolicy::ExplicitRemoteConsent,
                ..TransportLimits::default()
            },
        )
        .expect("transport");

        assert_eq!(remote_transport.validate_microphone_audio_policy(), Ok(()));
        let remote_profile = remote_transport.microphone_audio_profile();
        assert_eq!(
            remote_profile.endpoint_class(),
            NativeGatewayEndpointClass::Remote
        );
        assert_eq!(
            remote_profile.microphone_audio_policy(),
            MicrophoneAudioPolicy::ExplicitRemoteConsent
        );
        let debug = format!("{remote_profile:?}");
        assert!(!debug.contains("remote.example.invalid"));
        assert!(!debug.contains("do-not-render"));

        let blocked_transport = NativeGatewayTransport::new(
            Url::parse("https://remote.example.invalid/").expect("URL"),
            GatewayAuth::None,
            TransportLimits::default(),
        )
        .expect("transport");
        assert_eq!(
            blocked_transport.validate_microphone_audio_policy(),
            Err(TransportError::RemoteAudioBlocked)
        );
    }

    #[tokio::test]
    async fn bounded_http_response_preserves_literal_and_escaped_marker_metadata() {
        let request = assistant_request(91, "http marker response");
        let mut response = assistant_response_value_for(&request, "http response");
        let number_marker = marker_object("$serde_json::private::Number", "7");
        let raw_marker = marker_object("$serde_json::private::RawValue", "not-json");
        response["metadata"] = serde_json::json!({
            "nested": {
                "number": number_marker.clone(),
                "raw": raw_marker.clone(),
            },
            "ordinary": "marker-looking $serde_json::private::Number text",
        });
        let literal = serde_json::to_string(&response).expect("serialize response fixture");
        let escaped = literal
            .replace(
                "\"$serde_json::private::Number\"",
                "\"\\u0024serde_json::private::Number\"",
            )
            .replace(
                "\"$serde_json::private::RawValue\"",
                "\"\\u0024serde_json::private::RawValue\"",
            );
        assert_ne!(
            literal, escaped,
            "escaped fixture must change the wire text"
        );
        assert!(escaped.contains("\\u0024serde_json::private::Number"));
        let input = assistant_external_user_input(&request).expect("request payload");

        for raw in [literal, escaped] {
            let server = FixtureServer::one_response(json_response(raw.as_bytes()));
            let transport = NativeGatewayTransport::new(
                server.base_url.clone(),
                GatewayAuth::None,
                loopback_limits(),
            )
            .expect("transport");
            let result = transport
                .invoke_generated(
                    ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                    input.clone(),
                    &NativeRequestOptions::new("http-marker-response").expect("options"),
                    &CancellationToken::new(),
                )
                .await
                .expect("valid bounded HTTP response");

            assert_eq!(result["metadata"]["nested"]["number"], number_marker);
            assert_eq!(result["metadata"]["nested"]["raw"], raw_marker);
            assert_eq!(
                result["metadata"]["ordinary"],
                "marker-looking $serde_json::private::Number text"
            );
            let captured = server.request.recv().expect("captured generated request");
            assert!(captured.starts_with("POST /api/Orchestrator/ExternalUserInput HTTP/1.1"));
        }
    }

    #[tokio::test]
    async fn bounded_http_response_maps_malformed_utf8_to_invalid_response() {
        let server = FixtureServer::one_response(json_response(
            b"{\"text\":\"response\",\"metadata\":{\"invalid\":\xff}}",
        ));
        let transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");
        let request = assistant_request(92, "http invalid utf8");
        let input = assistant_external_user_input(&request).expect("request payload");

        let result = transport
            .invoke_generated(
                ids::ORCHESTRATOR_EXTERNAL_USER_INPUT,
                input,
                &NativeRequestOptions::new("http-invalid-utf8").expect("options"),
                &CancellationToken::new(),
            )
            .await;

        assert_eq!(result, Err(TransportError::InvalidResponse));
        let _ = server.request.recv().expect("captured generated request");
    }

    #[tokio::test]
    async fn non_audio_generated_methods_are_unaffected_by_microphone_policy() {
        let response_body = br#"{"voices":[],"capability_revision":0,"correlation_id":null}"#;
        let server = FixtureServer::one_response(json_response(response_body));
        let transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let result = transport
            .invoke_generated(
                "TTS.ListVoices",
                serde_json::json!({}),
                &NativeRequestOptions::new("voice-request-non-audio").expect("options"),
                &CancellationToken::new(),
            )
            .await
            .expect("non-audio route");

        assert!(result.is_object());
        let request = server.request.recv().expect("captured request");
        assert!(request.starts_with("POST /api/TTS/ListVoices HTTP/1.1"));
    }

    #[test]
    fn microphone_audio_policy_debug_is_redacted() {
        let transport = NativeGatewayTransport::new(
            Url::parse("https://remote.example.invalid/secret/audio_data").expect("URL"),
            GatewayAuth::Bearer("do-not-render".to_owned()),
            explicit_microphone_limits(),
        )
        .expect("transport");
        let rendered = format!("{transport:?}");

        assert!(rendered.contains("ExplicitRemoteConsent"));
        assert!(!rendered.contains("do-not-render"));
        assert!(!rendered.contains("audio_data"));
        assert!(!rendered.contains("/secret"));
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
    async fn streaming_failure_clears_active_session_and_posts_interrupt() {
        let stream_body = assistant_frame_for(
            11,
            assistant_payload_for(11, "assistant.failed", "", "", true),
            serde_json::json!({"kind": "assistant.failed"}),
        );
        let server = FixtureServer::responses([
            sse_response(&stream_body),
            assistant_ack_response(11),
            interrupt_response(11),
        ]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let result = transport
            .invoke_assistant_streaming(
                assistant_request(11, "fail stream"),
                CancellationToken::new(),
            )
            .await;

        assert_eq!(result, Err(TransportError::InvalidResponse));
        assert_eq!(
            transport.cancel_session(Generation(11)).await,
            Err(VoiceCoreError::TransportFault {
                code: "no_active_session".to_owned()
            })
        );
        let turn_request = assistant_request(11, "fail stream");
        let stream_request = server.request.recv().expect("stream subscription");
        assert!(stream_request.starts_with(&format!(
            "GET /api/events/stream?topic=Orchestrator.Response&kind=assistant.delta&kind=assistant.completed&kind=assistant.failed&correlation_id={}",
            turn_request.correlation_id
        )));
        let assistant_request = server.request.recv().expect("assistant request");
        assert!(assistant_request.contains("\"stream\":true"));
        let interrupt_request = server.request.recv().expect("interrupt request");
        assert!(interrupt_request.starts_with("POST /api/Orchestrator/Interrupt HTTP/1.1"));
        assert!(interrupt_request.contains("x-request-id: voice-interrupt-11-"));
    }

    #[tokio::test]
    async fn streaming_final_text_is_bounded_and_cleanup_is_retry_safe() {
        let oversized_text = "x".repeat(300);
        let stream_body = assistant_frame_for(
            12,
            assistant_payload_for(12, "assistant.completed", "", &oversized_text, true),
            serde_json::json!({"kind": "assistant.completed"}),
        );
        let server = FixtureServer::responses([
            sse_response(&stream_body),
            assistant_ack_response(12),
            interrupt_response(12),
        ]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            TransportLimits {
                max_response_bytes: 256,
                allow_loopback_http: true,
                ..TransportLimits::default()
            },
        )
        .expect("transport");

        let result = transport
            .invoke_assistant_streaming(
                assistant_request(12, "bound stream"),
                CancellationToken::new(),
            )
            .await;

        assert_eq!(result, Err(TransportError::ResponseTooLarge));
        let _stream_request = server.request.recv().expect("stream subscription");
        let _assistant_request = server.request.recv().expect("assistant request");
        let interrupt_request = server.request.recv().expect("interrupt request");
        assert!(interrupt_request.contains("x-request-id: voice-interrupt-12-"));
        assert!(interrupt_request.contains("idempotency-key: voice-interrupt-idem-"));
    }

    #[tokio::test]
    async fn streaming_duplicate_replay_is_ignored_without_corrupting_text() {
        let mut stream_body = Vec::new();
        stream_body.extend(assistant_frame_for(
            16,
            assistant_payload_with_sequence_for(16, 1, "assistant.delta", "he", "", false),
            serde_json::json!({}),
        ));
        stream_body.extend(assistant_frame_for(
            16,
            assistant_payload_with_sequence_for(16, 2, "assistant.delta", "ll", "", false),
            serde_json::json!({}),
        ));
        stream_body.extend(assistant_frame_for(
            16,
            assistant_payload_with_sequence_for(16, 1, "assistant.delta", "MALICIOUS", "", false),
            serde_json::json!({}),
        ));
        stream_body.extend(assistant_frame_for(
            16,
            assistant_payload_with_sequence_for(16, 3, "assistant.completed", "", "", true),
            serde_json::json!({"kind": "assistant.completed"}),
        ));
        let server =
            FixtureServer::responses([sse_response(&stream_body), assistant_ack_response(16)]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let response = transport
            .invoke_assistant_streaming(
                assistant_request(16, "dedupe stream"),
                CancellationToken::new(),
            )
            .await
            .expect("assistant stream");

        assert_eq!(response.text, "hell");
        let _stream_request = server.request.recv().expect("stream subscription");
        let _assistant_request = server.request.recv().expect("assistant request");
    }

    #[tokio::test]
    async fn streaming_reconnects_after_clean_close_and_resumes_from_last_event() {
        let first_stream = assistant_frame_for(
            20,
            assistant_payload_with_sequence_for(20, 1, "assistant.delta", "hel", "", false),
            serde_json::json!({"event_id": "event-1"}),
        );
        let resumed_stream = assistant_frame_for(
            20,
            assistant_payload_with_sequence_for(20, 2, "assistant.completed", "", "hello", true),
            serde_json::json!({"event_id": "event-2", "kind": "assistant.completed"}),
        );
        let server = FixtureServer::responses([
            sse_response(&first_stream),
            assistant_ack_response(20),
            sse_response(&resumed_stream),
        ]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let response = transport
            .invoke_assistant_streaming(
                assistant_request(20, "reconnect stream"),
                CancellationToken::new(),
            )
            .await
            .expect("reconnected assistant stream");

        assert_eq!(response.text, "hello");
        let _initial_stream_request = server.request.recv().expect("initial stream request");
        let _assistant_request = server.request.recv().expect("assistant request");
        let resumed_request = server.request.recv().expect("resumed stream request");
        assert!(resumed_request.contains("last_event_id=event-1"));
    }

    #[tokio::test]
    async fn streaming_retries_transient_initial_subscription_failure() {
        let stream_body = assistant_frame_for(
            21,
            assistant_payload_with_sequence_for(21, 1, "assistant.completed", "", "ready", true),
            serde_json::json!({"kind": "assistant.completed"}),
        );
        let server = FixtureServer::responses([
            Vec::new(),
            sse_response(&stream_body),
            assistant_ack_response(21),
        ]);
        let mut transport = NativeGatewayTransport::new(
            server.base_url.clone(),
            GatewayAuth::None,
            loopback_limits(),
        )
        .expect("transport");

        let response = transport
            .invoke_assistant_streaming(
                assistant_request(21, "retry initial stream"),
                CancellationToken::new(),
            )
            .await
            .expect("assistant stream after transient subscription failure");

        assert_eq!(response.text, "ready");
        let _failed_stream_request = server.request.recv().expect("failed stream request");
        let _retried_stream_request = server.request.recv().expect("retried stream request");
        let _assistant_request = server.request.recv().expect("assistant request");
    }

    #[tokio::test]
    async fn streaming_rejects_gap_reorder_and_bad_completion_sequence() {
        for (generation, frames) in [
            (
                17,
                vec![assistant_frame_for(
                    17,
                    assistant_payload_with_sequence_for(
                        17,
                        2,
                        "assistant.delta",
                        "out-of-order",
                        "",
                        false,
                    ),
                    serde_json::json!({}),
                )],
            ),
            (
                18,
                vec![
                    assistant_frame_for(
                        18,
                        assistant_payload_with_sequence_for(
                            18,
                            1,
                            "assistant.delta",
                            "hel",
                            "",
                            false,
                        ),
                        serde_json::json!({}),
                    ),
                    assistant_frame_for(
                        18,
                        assistant_payload_with_sequence_for(
                            18,
                            3,
                            "assistant.completed",
                            "",
                            "hello",
                            true,
                        ),
                        serde_json::json!({"kind": "assistant.completed"}),
                    ),
                ],
            ),
        ] {
            let stream_body = frames.into_iter().flatten().collect::<Vec<_>>();
            let server = FixtureServer::responses([
                sse_response(&stream_body),
                assistant_ack_response(generation),
                interrupt_response(generation),
            ]);
            let mut transport = NativeGatewayTransport::new(
                server.base_url.clone(),
                GatewayAuth::None,
                loopback_limits(),
            )
            .expect("transport");

            let result = transport
                .invoke_assistant_streaming(
                    assistant_request(generation, "bad sequence"),
                    CancellationToken::new(),
                )
                .await;

            assert_eq!(result, Err(TransportError::InvalidStream));
            let _stream_request = server.request.recv().expect("stream subscription");
            let _assistant_request = server.request.recv().expect("assistant request");
            let interrupt_request = server.request.recv().expect("interrupt request");
            assert!(interrupt_request.starts_with("POST /api/Orchestrator/Interrupt HTTP/1.1"));
        }
    }

    fn assistant_frame(payload: Value, overrides: Value) -> Vec<u8> {
        assistant_frame_for(9, payload, overrides)
    }

    fn assistant_frame_for(generation: u64, payload: Value, overrides: Value) -> Vec<u8> {
        let request = assistant_request(generation, "frame");
        let mut envelope = serde_json::json!({
            "event_id": "event-1",
            "topic": ids::ORCHESTRATOR_RESPONSE,
            "kind": "assistant.delta",
            "category": "assistant",
            "correlation_id": request.correlation_id,
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
        assistant_payload_for(9, kind, delta, text, is_final)
    }

    fn assistant_payload_for(
        generation: u64,
        kind: &str,
        delta: &str,
        text: &str,
        is_final: bool,
    ) -> Value {
        assistant_payload_with_sequence_for(generation, 1, kind, delta, text, is_final)
    }

    fn assistant_payload_with_sequence_for(
        generation: u64,
        sequence: u64,
        kind: &str,
        delta: &str,
        text: &str,
        is_final: bool,
    ) -> Value {
        let request = assistant_request(generation, "payload");
        serde_json::json!({
            "kind": kind,
            "delta": delta,
            "text": text,
            "is_final": is_final,
            "sequence": sequence,
            "session_id": request.session_id,
            "request_id": request.request_id,
            "correlation_id": request.correlation_id,
            "metadata": {},
        })
    }

    fn marker_object(key: &str, value: &str) -> Value {
        Value::Object(serde_json::Map::from_iter([(
            key.to_owned(),
            Value::String(value.to_owned()),
        )]))
    }

    #[test]
    fn assistant_response_normalization_preserves_nested_json_shapes() {
        let marker_cases = [
            (
                "$serde_json::private::Number",
                marker_object("$serde_json::private::Number", "7"),
            ),
            (
                "$serde_json::private::RawValue",
                marker_object("$serde_json::private::RawValue", "not-json"),
            ),
        ];

        for (key, marker) in marker_cases {
            let mut metadata = serde_json::Map::new();
            metadata.insert("nested".to_owned(), marker.clone());
            metadata.insert("ordinary".to_owned(), Value::String("visible".to_owned()));
            metadata.insert(
                "marker-looking-string".to_owned(),
                Value::String("$serde_json::private::Number".to_owned()),
            );
            let response = serde_json::json!({
                "text": "response",
                "metadata": Value::Object(metadata),
            });

            let normalized = assistant_response_value(response).expect("valid response");
            assert_eq!(normalized["metadata"]["nested"], marker, "{key}");
            assert_eq!(normalized["metadata"]["ordinary"], "visible");
            assert_eq!(
                normalized["metadata"]["marker-looking-string"],
                "$serde_json::private::Number"
            );
            assert_eq!(
                assistant_response_value(normalized.clone()).expect("idempotent response"),
                normalized,
                "{key}"
            );
        }

        let mut bounded_metadata = serde_json::Map::new();
        for index in 0..64 {
            bounded_metadata.insert(format!("key-{index}"), Value::Null);
        }
        assert!(assistant_response_value(serde_json::json!({
            "text": "response",
            "metadata": bounded_metadata,
        }))
        .is_ok());

        let mut oversized_metadata = serde_json::Map::new();
        for index in 0..65 {
            oversized_metadata.insert(format!("key-{index}"), Value::Null);
        }
        assert_eq!(
            assistant_response_value(serde_json::json!({
                "text": "response",
                "metadata": oversized_metadata,
            })),
            Err(TransportError::InvalidResponse)
        );
    }

    #[test]
    fn assistant_response_normalization_preserves_escaped_marker_keys() {
        for (escaped_key, value, marker) in [
            (
                "$serde_json::private\\u003a\\u003aNumber",
                "7",
                marker_object("$serde_json::private::Number", "7"),
            ),
            (
                "$serde_json::private\\u003a\\u003aRawValue",
                "not-json",
                marker_object("$serde_json::private::RawValue", "not-json"),
            ),
        ] {
            let marker_json = serde_json::to_string(value).expect("serialize marker string");
            let raw = [
                r#"{"text":"response","metadata":{"nested":{"#,
                "\"",
                escaped_key,
                "\":",
                marker_json.as_str(),
                "}}}",
            ]
            .concat();
            let response = parse_json_value(&raw).expect("valid raw response");
            let normalized = assistant_response_value(response).expect("normalized response");
            assert_eq!(normalized["metadata"]["nested"], marker);
        }
    }

    #[test]
    fn mesh_stream_normalization_preserves_json_metadata_and_enforces_bounds() {
        let request = assistant_request(45, "stream");
        for marker in [
            marker_object("$serde_json::private::Number", "7"),
            marker_object("$serde_json::private::RawValue", "not-json"),
        ] {
            let mut payload = assistant_payload_for(45, "assistant.delta", "delta", "", false);
            payload["metadata"] = serde_json::json!({"nested": marker});
            assert!(matches!(
                mesh_assistant_stream_event(
                    serde_json::json!({
                        "type": "event",
                        "topic": ids::ORCHESTRATOR_RESPONSE,
                        "correlation_id": request.correlation_id,
                        "params": payload,
                    }),
                    &request,
                ),
                Ok(AssistantStreamRead::Delta { sequence: 1, delta }) if delta == "delta"
            ));
        }

        let defaulted_payload = serde_json::json!({
            "kind": "assistant.delta",
            "sequence": 1,
            "session_id": request.session_id,
            "request_id": request.request_id,
            "correlation_id": request.correlation_id,
        });
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "payload": defaulted_payload,
                }),
                &request,
            ),
            Ok(AssistantStreamRead::Delta { sequence: 1, delta }) if delta.is_empty()
        ));

        let max_safe_sequence = 9_007_199_254_740_991_u64;
        let mut bounded_metadata_payload =
            assistant_payload_for(45, "assistant.delta", "", "", false);
        let mut bounded_metadata = serde_json::Map::new();
        for index in 0..64 {
            bounded_metadata.insert(format!("key-{index}"), Value::Null);
        }
        bounded_metadata_payload["metadata"] = Value::Object(bounded_metadata);
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": bounded_metadata_payload,
                }),
                &request,
            ),
            Ok(AssistantStreamRead::Delta { .. })
        ));

        let valid_boundary = assistant_payload_with_sequence_for(
            45,
            max_safe_sequence,
            "assistant.delta",
            "",
            "",
            false,
        );
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": valid_boundary,
                }),
                &request,
            ),
            Ok(AssistantStreamRead::Delta { sequence, .. }) if sequence == max_safe_sequence
        ));

        let invalid_sequence = assistant_payload_with_sequence_for(
            45,
            max_safe_sequence + 1,
            "assistant.delta",
            "",
            "",
            false,
        );
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": invalid_sequence,
                }),
                &request,
            ),
            Err(TransportError::InvalidPayload)
        ));

        let mut oversized_metadata_payload =
            assistant_payload_for(45, "assistant.delta", "", "", false);
        let mut oversized_metadata = serde_json::Map::new();
        for index in 0..65 {
            oversized_metadata.insert(format!("key-{index}"), Value::Null);
        }
        oversized_metadata_payload["metadata"] = Value::Object(oversized_metadata);
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": oversized_metadata_payload,
                }),
                &request,
            ),
            Err(TransportError::InvalidPayload)
        ));
    }

    #[test]
    fn mesh_stream_schema_validation_precedes_inner_identity_checks() {
        let request = assistant_request(46, "stream");
        let mut invalid_payload = assistant_payload("assistant.delta", "", "", false);
        invalid_payload["session_id"] = Value::String("other-session".to_owned());
        let mut oversized_metadata = serde_json::Map::new();
        for index in 0..65 {
            oversized_metadata.insert(format!("key-{index}"), Value::Null);
        }
        invalid_payload["metadata"] = Value::Object(oversized_metadata);
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": invalid_payload,
                }),
                &request,
            ),
            Err(TransportError::InvalidPayload)
        ));

        let mut invalid_sequence = assistant_payload_with_sequence_for(
            46,
            9_007_199_254_740_992_u64,
            "assistant.delta",
            "",
            "",
            false,
        );
        invalid_sequence["request_id"] = Value::String("other-request".to_owned());
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": invalid_sequence,
                }),
                &request,
            ),
            Err(TransportError::InvalidPayload)
        ));

        let valid_payload = assistant_payload("assistant.delta", "valid", "", false);
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": Value::Null,
                    "payload": valid_payload,
                }),
                &request,
            ),
            Err(TransportError::InvalidPayload)
        ));

        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": "Other.Topic",
                    "correlation_id": request.correlation_id,
                    "params": {"sequence": 9_007_199_254_740_992_u64},
                }),
                &request,
            ),
            Ok(AssistantStreamRead::Ignore)
        ));
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "request",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": request.correlation_id,
                    "params": {"sequence": 9_007_199_254_740_992_u64},
                }),
                &request,
            ),
            Ok(AssistantStreamRead::Ignore)
        ));
        assert!(matches!(
            mesh_assistant_stream_event(
                serde_json::json!({
                    "type": "event",
                    "topic": ids::ORCHESTRATOR_RESPONSE,
                    "correlation_id": "other-correlation",
                    "params": {"sequence": 9_007_199_254_740_992_u64},
                }),
                &request,
            ),
            Ok(AssistantStreamRead::Ignore)
        ));
    }

    #[test]
    fn sse_normalized_event_keeps_marker_objects_through_assistant_consumption() {
        let request = assistant_request(47, "stream");
        let allowed = BTreeSet::from([ids::ORCHESTRATOR_RESPONSE.to_owned()]);
        let mut payload = assistant_payload_for(47, "assistant.delta", "next", "", false);
        let marker = marker_object("$serde_json::private::RawValue", "not-json");
        payload["metadata"] = serde_json::json!({"nested": marker});
        let redacted_marker = marker_object("$serde_json::private::Number", "7");
        let event = parse_event_frame(
            &assistant_frame_for(
                47,
                payload,
                serde_json::json!({"redacted_payload": {"marker": redacted_marker}}),
            ),
            &allowed,
            &BTreeSet::new(),
            None,
        )
        .expect("valid SSE frame")
        .expect("event frame");

        assert_eq!(
            event.redacted_payload()["marker"],
            redacted_marker,
            "the normalized envelope must retain opaque redacted JSON"
        );
        assert!(matches!(
            event.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Delta { sequence: 1, delta }) if delta == "next"
        ));

        let tool_result = marker_object("$serde_json::private::Number", "9");
        let tool_error = marker_object("$serde_json::private::RawValue", "not-json");
        let tool_payload = serde_json::json!({
            "kind": "tool.completed",
            "sequence": 1,
            "session_id": request.session_id,
            "request_id": request.request_id,
            "correlation_id": request.correlation_id,
            "tool": {
                "status": "completed",
                "tool_call_id": "call-1",
                "tool_name": "lookup",
                "result_preview": {"opaque": tool_result},
                "error_details": {"opaque": tool_error},
            },
        });
        let tool_event = parse_event_frame(
            &assistant_frame_for(
                47,
                tool_payload,
                serde_json::json!({"kind": "tool.completed", "category": "assistant"}),
            ),
            &allowed,
            &BTreeSet::new(),
            None,
        )
        .expect("valid tool SSE frame")
        .expect("tool event");
        assert_eq!(
            tool_event.payload().expect("tool payload")["tool"]["result_preview"]["opaque"],
            tool_result
        );
        assert_eq!(
            tool_event.payload().expect("tool payload")["tool"]["error_details"]["opaque"],
            tool_error
        );
        assert!(matches!(
            tool_event.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Ignore)
        ));
    }

    #[test]
    fn sse_parser_filters_kind_and_correlation_before_payload_delivery() {
        let allowed = BTreeSet::from([ids::ORCHESTRATOR_RESPONSE.to_owned()]);
        let kinds = BTreeSet::from(["assistant.delta".to_owned()]);
        let request = assistant_request(9, "hello");
        let wrong_kind = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.completed", "", "hidden", true),
                serde_json::json!({"kind": "assistant.completed"}),
            ),
            &allowed,
            &kinds,
            Some(request.correlation_id.as_str()),
        )
        .expect("wrong kind frame");
        assert_eq!(wrong_kind, None);

        let wrong_correlation = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hidden", "", false),
                serde_json::json!({"correlation_id": "voice-correlation-other"}),
            ),
            &allowed,
            &kinds,
            Some(request.correlation_id.as_str()),
        )
        .expect("wrong correlation frame");
        assert_eq!(wrong_correlation, None);

        let accepted = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hel", "", false),
                serde_json::json!({}),
            ),
            &allowed,
            &kinds,
            Some(request.correlation_id.as_str()),
        )
        .expect("accepted frame");
        assert!(accepted.is_some());
    }

    #[test]
    fn assistant_sse_rejects_envelope_payload_kind_mismatch() {
        let request = assistant_request(9, "hello");
        let allowed = BTreeSet::from([ids::ORCHESTRATOR_RESPONSE.to_owned()]);
        let kinds = BTreeSet::from(["assistant.completed".to_owned()]);
        let event = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hidden", "", false),
                serde_json::json!({"kind": "assistant.completed"}),
            ),
            &allowed,
            &kinds,
            Some(request.correlation_id.as_str()),
        )
        .expect("mismatched kind frame")
        .expect("mismatched kind event");

        assert!(matches!(
            event.assistant_stream_event(&request),
            Err(TransportError::InvalidStream)
        ));
    }

    #[test]
    fn assistant_sse_accepts_correlated_delta_completed_and_failed() {
        let request = assistant_request(9, "hello");
        let allowed = BTreeSet::from([ids::ORCHESTRATOR_RESPONSE.to_owned()]);
        let kinds = BTreeSet::new();

        let delta = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hel", "", false),
                serde_json::json!({}),
            ),
            &allowed,
            &kinds,
            None,
        )
        .expect("delta frame")
        .expect("delta event");
        assert!(matches!(
            delta.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Delta { sequence: 1, delta }) if delta == "hel"
        ));

        let completed = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.completed", "", "hello there", true),
                serde_json::json!({"kind": "assistant.completed"}),
            ),
            &allowed,
            &kinds,
            None,
        )
        .expect("completed frame")
        .expect("completed event");
        assert!(matches!(
            completed.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Completed { sequence: 1, final_text }) if final_text == "hello there"
        ));

        let failed = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.failed", "", "", true),
                serde_json::json!({"kind": "assistant.failed"}),
            ),
            &allowed,
            &kinds,
            None,
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
        let request = assistant_request(9, "hello");
        let allowed = BTreeSet::from([ids::ORCHESTRATOR_RESPONSE.to_owned()]);
        let kinds = BTreeSet::new();

        let wrong_category = parse_event_frame(
            &assistant_frame(
                assistant_payload("assistant.delta", "hidden", "", false),
                serde_json::json!({"category": "audio"}),
            ),
            &allowed,
            &kinds,
            None,
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
            &kinds,
            None,
        )
        .expect("wrong correlation frame")
        .expect("wrong correlation event");
        assert!(matches!(
            wrong_correlation.assistant_stream_event(&request),
            Ok(AssistantStreamRead::Ignore)
        ));

        let wrong_session = parse_event_frame(
            &assistant_frame(
                {
                    let request = assistant_request(9, "hello");
                    serde_json::json!({
                        "kind": "assistant.delta",
                        "delta": "hidden",
                        "is_final": false,
                        "session_id": "voice-session-other",
                        "request_id": request.request_id,
                        "correlation_id": request.correlation_id,
                        "metadata": {},
                    })
                },
                serde_json::json!({}),
            ),
            &allowed,
            &kinds,
            None,
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
            &kinds,
            None,
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
