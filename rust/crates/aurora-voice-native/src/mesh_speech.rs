//! Contract-aware native mesh STT/TTS request provider.
//!
//! The WebRTC/session owner supplies the call transport. This module owns
//! generated-contract normalization, operation/session identity, byte bounds,
//! credit checks, response fencing, and exact cancellation. It deliberately
//! does not evaluate permissions or select peers.

use async_trait::async_trait;
use aurora_contracts::{ids, method_by_id, normalize_generated_contract};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use thiserror::Error;

const MAX_CHUNK_BYTES: usize = 49_152;
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 4096;
const MAX_CREDITS: u64 = 8;
const MAX_DEADLINE_MS: u64 = 60_000;
const SPEECH_METHODS: &[&str] = &[
    ids::TRANSCRIPTION_TRANSCRIBE,
    ids::TRANSCRIPTION_STREAM_START,
    ids::TRANSCRIPTION_STREAM_CHUNK,
    ids::TRANSCRIPTION_STREAM_END,
    ids::TRANSCRIPTION_STREAM_CANCEL,
    ids::TRANSCRIPTION_STREAM_STATUS,
    ids::TRANSCRIPTION_STREAM_RESULT,
    ids::TTS_SYNTHESIZE,
    ids::TTS_STREAM_PREPARE_V1,
    ids::TTS_STREAM_START,
    ids::TTS_STREAM_CHUNK,
    ids::TTS_STREAM_END,
    ids::TTS_STREAM_CANCEL,
    ids::TTS_STREAM_STATUS,
    ids::TTS_STREAM_RESULT,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpeechFamily { Transcription, Tts }

fn method_family(method_id: &str) -> Option<SpeechFamily> {
    if method_id.starts_with("Transcription.") { Some(SpeechFamily::Transcription) }
    else if method_id.starts_with("TTS.") { Some(SpeechFamily::Tts) }
    else { None }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeMeshSpeechRequest {
    method_id: String,
    request_id: String,
    operation_id: String,
    attempt_id: String,
    session_id: Option<String>,
    payload: Value,
    max_response_bytes: usize,
    deadline_ms: u64,
}

impl NativeMeshSpeechRequest {
    pub fn new(
        method_id: impl Into<String>,
        request_id: impl Into<String>,
        operation_id: impl Into<String>,
        attempt_id: impl Into<String>,
        session_id: Option<String>,
        payload: Value,
        max_response_bytes: usize,
    ) -> Result<Self, MeshSpeechError> {
        let mut request = Self {
            method_id: method_id.into(),
            request_id: request_id.into(),
            operation_id: operation_id.into(),
            attempt_id: attempt_id.into(),
            session_id,
            payload,
            max_response_bytes,
            deadline_ms: MAX_DEADLINE_MS,
        };
        request.payload = request.normalized_payload()?;
        Ok(request)
    }

    pub fn method_id(&self) -> &str { &self.method_id }
    pub fn request_id(&self) -> &str { &self.request_id }
    pub fn operation_id(&self) -> &str { &self.operation_id }
    pub fn attempt_id(&self) -> &str { &self.attempt_id }
    pub fn session_id(&self) -> Option<&str> { self.session_id.as_deref() }
    pub fn max_response_bytes(&self) -> usize { self.max_response_bytes }
    pub fn deadline_ms(&self) -> u64 { self.deadline_ms }
    pub fn payload(&self) -> &Value { &self.payload }

    pub fn with_deadline_ms(mut self, deadline_ms: u64) -> Result<Self, MeshSpeechError> {
        if deadline_ms == 0 || deadline_ms > MAX_DEADLINE_MS { return Err(MeshSpeechError::InvalidRequest); }
        self.deadline_ms = deadline_ms;
        Ok(self)
    }

    fn normalized_payload(&self) -> Result<Value, MeshSpeechError> {
        if !SPEECH_METHODS.contains(&self.method_id.as_str())
            || !valid_identifier(&self.request_id)
            || !valid_identifier(&self.operation_id)
            || !valid_identifier(&self.attempt_id)
            || self.session_id.as_deref().is_some_and(|value| !valid_identifier(value))
            || self.max_response_bytes == 0
            || self.max_response_bytes > MAX_RESPONSE_BYTES
        {
            return Err(MeshSpeechError::InvalidRequest);
        }
        let descriptor = method_by_id(&self.method_id).ok_or(MeshSpeechError::UnknownMethod)?;
        let normalized = normalize_generated_contract(descriptor.input_schema_id, self.payload.clone())
            .map_err(|_| MeshSpeechError::InvalidPayload)?;
        let encoded_len = serde_json::to_vec(&normalized)
            .map_err(|_| MeshSpeechError::InvalidPayload)?
            .len();
        if encoded_len > MAX_INPUT_BYTES {
            return Err(MeshSpeechError::RequestTooLarge);
        }
        if self.method_id == ids::TRANSCRIPTION_TRANSCRIBE {
            let audio = normalized.get("audio_data").and_then(Value::as_str).ok_or(MeshSpeechError::InvalidPayload)?;
            let decoded = BASE64.decode(audio).map_err(|_| MeshSpeechError::InvalidPayload)?;
            if decoded.is_empty() || decoded.len() > MAX_INPUT_BYTES { return Err(MeshSpeechError::RequestTooLarge); }
        }
        if let Some(payload_session) = normalized.get("session_id").and_then(Value::as_str) {
            if self.session_id.as_deref() != Some(payload_session) {
                return Err(MeshSpeechError::InvalidPayload);
            }
        }
        for (field, expected) in [("request_id", self.request_id.as_str()), ("operation_id", self.operation_id.as_str()), ("attempt_id", self.attempt_id.as_str())] {
            if let Some(actual) = normalized.get(field).and_then(Value::as_str) {
                if actual != expected {
                    return Err(MeshSpeechError::InvalidPayload);
                }
            }
        }
        if let Some(payload_attempt) = normalized.get("attempt_id").and_then(Value::as_str) {
            if payload_attempt != self.attempt_id {
                return Err(MeshSpeechError::InvalidPayload);
            }
        }
        if let Some(stream_id) = normalized.get("stream_id").and_then(Value::as_str) {
            if self.session_id.as_deref() != Some(stream_id)
                && matches!(self.method_id.as_str(), ids::TTS_STREAM_CHUNK | ids::TTS_STREAM_END)
            { return Err(MeshSpeechError::InvalidPayload); }
        }
        if self.method_id.ends_with("StreamChunk") {
            if self.method_id == ids::TRANSCRIPTION_STREAM_CHUNK {
                let encoded = normalized.get("audio_data").and_then(Value::as_str)
                    .ok_or(MeshSpeechError::InvalidPayload)?;
                let decoded = BASE64.decode(encoded).map_err(|_| MeshSpeechError::InvalidPayload)?;
                let size = normalized
                    .get("payload_size_bytes")
                    .and_then(Value::as_u64)
                    .ok_or(MeshSpeechError::InvalidPayload)?;
                if size == 0 || size as usize != decoded.len() || decoded.len() > MAX_CHUNK_BYTES {
                    return Err(MeshSpeechError::RequestTooLarge);
                }
            } else {
                let text_bytes = normalized.get("text").and_then(Value::as_str)
                    .ok_or(MeshSpeechError::InvalidPayload)?.as_bytes().len();
                if text_bytes > MAX_TEXT_BYTES { return Err(MeshSpeechError::RequestTooLarge); }
            }
        }
        Ok(normalized)
    }
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(byte) if byte.is_ascii_alphanumeric())
        && value.len() <= 128
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeMeshSpeechCancel {
    pub request_id: String,
    pub operation_id: String,
    pub attempt_id: String,
    pub session_id: Option<String>,
    pub generation: Option<u64>,
    pub cancellation_ref: String,
    pub reason: String,
    pub resource_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeMeshSpeechAdmission {
    pub operation_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub generation: u64,
    pub credits: u64,
    pub max_input_bytes: usize,
    pub max_chunk_bytes: usize,
    pub max_text_bytes: usize,
    pub max_queue: usize,
    pub lease_remaining_ms: u64,
    pub next_sequence: u64,
    pub terminal: bool,
    pub input_closed: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MeshSpeechError {
    #[error("invalid mesh speech request")]
    InvalidRequest,
    #[error("unknown mesh speech method")]
    UnknownMethod,
    #[error("invalid mesh speech payload")]
    InvalidPayload,
    #[error("mesh speech request is too large")]
    RequestTooLarge,
    #[error("mesh speech response is too large")]
    ResponseTooLarge,
    #[error("mesh speech response identity is stale or mismatched")]
    StaleResponse,
    #[error("mesh speech response omitted accepted credits")]
    MissingCredits,
    #[error("mesh speech response credits are invalid")]
    InvalidCredits,
    #[error("mesh speech transport failed")]
    Transport,
}

#[async_trait(?Send)]
pub trait NativeMeshSpeechCallTransport {
    async fn call(&mut self, request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError>;
    async fn cancel(&mut self, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError>;
}

/// Provider facade for finite and admitted streaming speech calls.
pub struct NativeMeshSpeechProvider<T> {
    transport: T,
    admission: Option<NativeMeshSpeechAdmission>,
    input_bytes: usize,
    lease_started: Option<Instant>,
    family: Option<SpeechFamily>,
}

impl<T> NativeMeshSpeechProvider<T> {
    pub fn new(transport: T) -> Self { Self { transport, admission: None, input_bytes: 0, lease_started: None, family: None } }

    fn install_admission(&mut self, admission: NativeMeshSpeechAdmission) -> Result<(), MeshSpeechError> {
        if !valid_identifier(&admission.operation_id) || !valid_identifier(&admission.attempt_id)
            || !valid_identifier(&admission.session_id) || admission.credits > MAX_CREDITS
            || admission.max_input_bytes == 0 || admission.max_input_bytes > MAX_INPUT_BYTES
            || admission.max_chunk_bytes == 0 || admission.max_chunk_bytes > MAX_CHUNK_BYTES
            || admission.max_text_bytes == 0 || admission.max_text_bytes > MAX_TEXT_BYTES
            || admission.max_queue == 0 || admission.max_queue > 4 || admission.credits > admission.max_queue as u64
            || admission.lease_remaining_ms == 0 || admission.terminal
        { return Err(MeshSpeechError::InvalidRequest); }
        self.admission = Some(admission);
        self.input_bytes = 0;
        self.lease_started = Some(Instant::now());
        Ok(())
    }

    fn install_admission_response(&mut self, response: &Value, request: &NativeMeshSpeechRequest) -> Result<(), MeshSpeechError> {
        if response.get("status").and_then(Value::as_str) != Some("admitted") { return Err(MeshSpeechError::StaleResponse); }
        let session_id = response.get("session_id").and_then(Value::as_str).ok_or(MeshSpeechError::StaleResponse)?;
        let operation_id = response.get("operation_id").and_then(Value::as_str).unwrap_or(request.operation_id());
        let attempt_id = response.get("attempt_id").and_then(Value::as_str).unwrap_or(request.attempt_id());
        if operation_id != request.operation_id() || attempt_id != request.attempt_id() { return Err(MeshSpeechError::StaleResponse); }
        let limits = response.get("accepted_limits");
        let max_input_bytes = limits.and_then(|v| v.get("max_input_bytes")).and_then(Value::as_u64).unwrap_or(MAX_INPUT_BYTES as u64).min(MAX_INPUT_BYTES as u64) as usize;
        let max_chunk_bytes = limits.and_then(|v| v.get("max_chunk_bytes")).and_then(Value::as_u64).unwrap_or(MAX_CHUNK_BYTES as u64).min(MAX_CHUNK_BYTES as u64) as usize;
        self.install_admission(NativeMeshSpeechAdmission {
            operation_id: operation_id.to_owned(), attempt_id: attempt_id.to_owned(), session_id: session_id.to_owned(),
            generation: response.get("generation").and_then(Value::as_u64).ok_or(MeshSpeechError::StaleResponse)?,
            credits: response.get("credits").and_then(Value::as_u64).ok_or(MeshSpeechError::MissingCredits)?,
            max_input_bytes, max_chunk_bytes, max_text_bytes: limits.and_then(|v| v.get("max_text_bytes")).and_then(Value::as_u64).unwrap_or(MAX_TEXT_BYTES as u64).min(MAX_TEXT_BYTES as u64) as usize,
            max_queue: limits.and_then(|v| v.get("max_queue")).and_then(Value::as_u64).unwrap_or(4).min(4) as usize,
            lease_remaining_ms: response.get("lease_remaining_ms").and_then(Value::as_u64).ok_or(MeshSpeechError::StaleResponse)?,
            next_sequence: response.get("next_sequence").and_then(Value::as_u64).unwrap_or(0), terminal: false, input_closed: false,
        })?;
        self.family = method_family(request.method_id());
        Ok(())
    }

    pub async fn call(&mut self, request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError>
    where T: NativeMeshSpeechCallTransport {
        let expected_session = request.session_id().map(str::to_owned);
        let expected_attempt = request.attempt_id().to_owned();
        let max_response_bytes = request.max_response_bytes;
        let deadline_ms = request.deadline_ms;
        let method_id = request.method_id().to_owned();
        let request_family = method_family(&method_id).ok_or(MeshSpeechError::UnknownMethod)?;
        if let Some(family) = self.family {
            if family != request_family { return Err(MeshSpeechError::StaleResponse); }
        }
        let expected_identity = ["operation_id", "attempt_id", "generation", "capability_revision"]
            .into_iter()
            .filter_map(|field| request.payload().get(field).map(|value| (field, value.clone())))
            .collect::<Vec<_>>();
        let mut request_input_bytes = 0usize;
        if method_id == ids::TRANSCRIPTION_STREAM_CHUNK || method_id == ids::TTS_STREAM_CHUNK {
            let state = self.admission.as_ref().ok_or(MeshSpeechError::StaleResponse)?;
            if state.operation_id != request.operation_id || state.attempt_id != request.attempt_id
                || state.session_id.as_str() != request.session_id().ok_or(MeshSpeechError::StaleResponse)?
                || state.credits == 0 || state.terminal || state.input_closed
                || self.lease_started.is_some_and(|started| started.elapsed() > Duration::from_millis(state.lease_remaining_ms))
            { return Err(MeshSpeechError::StaleResponse); }
            let generation = request.payload().get("generation").and_then(Value::as_u64)
                .ok_or(MeshSpeechError::InvalidPayload)?;
            if generation != state.generation { return Err(MeshSpeechError::StaleResponse); }
            let sequence = request.payload().get("sequence").and_then(Value::as_u64).ok_or(MeshSpeechError::InvalidPayload)?;
            if sequence != state.next_sequence { return Err(MeshSpeechError::StaleResponse); }
            let bytes = if method_id == ids::TRANSCRIPTION_STREAM_CHUNK {
                BASE64.decode(request.payload().get("audio_data").and_then(Value::as_str).ok_or(MeshSpeechError::InvalidPayload)?)
                    .map_err(|_| MeshSpeechError::InvalidPayload)?.len()
            } else {
                request.payload().get("text").and_then(Value::as_str).ok_or(MeshSpeechError::InvalidPayload)?.as_bytes().len()
            };
            let max_payload_bytes = if method_id == ids::TRANSCRIPTION_STREAM_CHUNK { state.max_chunk_bytes } else { state.max_text_bytes };
            if bytes > max_payload_bytes { return Err(MeshSpeechError::RequestTooLarge); }
            let total = request.payload().get("payload_size_bytes").and_then(Value::as_u64).unwrap_or(bytes as u64) as usize;
            if total > state.max_input_bytes.saturating_sub(self.input_bytes) { return Err(MeshSpeechError::RequestTooLarge); }
            request_input_bytes = total;
        }
        let cancel_request = request.clone();
        if let Some(state) = self.admission.as_ref() {
            if matches!(method_id.as_str(), ids::TRANSCRIPTION_STREAM_START | ids::TRANSCRIPTION_STREAM_CHUNK | ids::TRANSCRIPTION_STREAM_END | ids::TRANSCRIPTION_STREAM_STATUS | ids::TRANSCRIPTION_STREAM_RESULT | ids::TRANSCRIPTION_STREAM_CANCEL | ids::TTS_STREAM_PREPARE_V1 | ids::TTS_STREAM_START | ids::TTS_STREAM_CHUNK | ids::TTS_STREAM_END | ids::TTS_STREAM_STATUS | ids::TTS_STREAM_RESULT | ids::TTS_STREAM_CANCEL)
                && (state.operation_id != request.operation_id || state.attempt_id != request.attempt_id
                    || request.session_id() != Some(state.session_id.as_str()))
            { return Err(MeshSpeechError::StaleResponse); }
        }
        let response = match tokio::time::timeout(Duration::from_millis(deadline_ms), self.transport.call(request)).await {
            Ok(response) => response?,
            Err(_) => {
                if self.admission.is_some() {
                    let _ = self.cancel_owned(&cancel_request, "timed_out").await;
                } else {
                    let _ = self.cancel_unowned(&cancel_request, "timed_out").await;
                }
                return Err(MeshSpeechError::Transport);
            }
        };
        let descriptor = method_by_id(&method_id).ok_or(MeshSpeechError::UnknownMethod)?;
        let mut response = normalize_generated_contract(descriptor.output_schema_id, response)
            .map_err(|_| MeshSpeechError::Transport)?;
        if method_id == ids::TTS_SYNTHESIZE {
            let audio = response.get("audio_data").and_then(Value::as_str).ok_or(MeshSpeechError::InvalidPayload)?;
            let decoded = BASE64.decode(audio).map_err(|_| MeshSpeechError::InvalidPayload)?;
            if decoded.is_empty() { return Err(MeshSpeechError::InvalidPayload); }
        }
        let encoded_len = serde_json::to_vec(&response).map_err(|_| MeshSpeechError::Transport)?.len();
        if encoded_len > max_response_bytes { return Err(MeshSpeechError::ResponseTooLarge); }
        if let Some(session_id) = expected_session {
            if response.get("session_id").is_some()
                && response.get("session_id").and_then(Value::as_str) != Some(session_id.as_str()) {
                return Err(MeshSpeechError::StaleResponse);
            }
        }
        if let Some(response_attempt) = response.get("attempt_id").and_then(Value::as_str) {
            if response_attempt != expected_attempt { return Err(MeshSpeechError::StaleResponse); }
        }
        for (field, expected) in &expected_identity {
            if let Some(actual) = response.get(field) {
                if actual != expected { return Err(MeshSpeechError::StaleResponse); }
            } else if method_id == ids::TTS_STREAM_PREPARE_V1 {
                return Err(MeshSpeechError::StaleResponse);
            }
        }
        if matches!(method_id.as_str(), ids::TRANSCRIPTION_STREAM_START | ids::TTS_STREAM_PREPARE_V1)
            && response.get("status").and_then(Value::as_str) == Some("admitted") {
            self.install_admission_response(&response, &cancel_request)?;
            if let Some(limits) = response.get_mut("accepted_limits").and_then(Value::as_object_mut) {
                let max_chunk = limits.get("max_chunk_bytes").and_then(Value::as_u64)
                    .unwrap_or(MAX_CHUNK_BYTES as u64).min(MAX_CHUNK_BYTES as u64);
                let max_text = limits.get("max_text_bytes").and_then(Value::as_u64)
                    .unwrap_or(MAX_TEXT_BYTES as u64).min(MAX_TEXT_BYTES as u64);
                if let Some(value) = limits.get_mut("max_chunk_bytes") { *value = json!(max_chunk); }
                if let Some(value) = limits.get_mut("max_text_bytes") { *value = json!(max_text); }
            }
        }
        if method_id == ids::TRANSCRIPTION_STREAM_CHUNK {
            let credits = response.get("credits").and_then(Value::as_u64).ok_or(MeshSpeechError::MissingCredits)?;
            if let Some(state) = self.admission.as_ref() {
                if credits > MAX_CREDITS || credits > state.max_queue as u64
                { return Err(MeshSpeechError::InvalidCredits); }
            }
        }
        if method_id == ids::TRANSCRIPTION_STREAM_STATUS || method_id == ids::TTS_STREAM_STATUS {
            if let Some(state) = self.admission.as_mut() {
                let credits = response.get("credits").and_then(Value::as_u64).ok_or(MeshSpeechError::MissingCredits)?;
                let next_sequence = response.get("next_sequence").and_then(Value::as_u64).ok_or(MeshSpeechError::StaleResponse)?;
                let lease_remaining_ms = response.get("lease_remaining_ms").and_then(Value::as_u64).ok_or(MeshSpeechError::StaleResponse)?;
                if credits > MAX_CREDITS || credits > state.max_queue as u64
                    || next_sequence < state.next_sequence || lease_remaining_ms == 0
                { return Err(MeshSpeechError::StaleResponse); }
                let terminal = matches!(response.get("state").and_then(Value::as_str), Some("canceled" | "completed" | "failed" | "revoked" | "timed_out" | "interrupted"));
                state.credits = credits;
                state.next_sequence = next_sequence;
                state.lease_remaining_ms = lease_remaining_ms;
                state.terminal = terminal;
                self.lease_started = Some(Instant::now());
            }
        }
        if method_id == ids::TRANSCRIPTION_STREAM_CHUNK || method_id == ids::TTS_STREAM_CHUNK {
            if let Some(state) = self.admission.as_mut() {
                if let Some(credits) = response.get("credits").and_then(Value::as_u64) {
                    if credits > MAX_CREDITS || credits > state.max_queue as u64 { return Err(MeshSpeechError::InvalidCredits); }
                    state.credits = credits;
                } else { state.credits = state.credits.saturating_sub(1); }
                self.input_bytes = self.input_bytes.saturating_add(request_input_bytes);
                state.next_sequence = state.next_sequence.saturating_add(1);
            }
        }
        if matches!(method_id.as_str(), ids::TRANSCRIPTION_STREAM_CANCEL | ids::TTS_STREAM_CANCEL) {
            self.admission = None;
            self.lease_started = None;
            self.family = None;
        }
        if matches!(method_id.as_str(), ids::TRANSCRIPTION_STREAM_END | ids::TTS_STREAM_END) {
            if let Some(state) = self.admission.as_mut() { state.input_closed = true; }
        }
        if matches!(method_id.as_str(), ids::TRANSCRIPTION_STREAM_RESULT | ids::TTS_STREAM_RESULT) {
            self.admission = None;
            self.lease_started = None;
            self.family = None;
        }
        Ok(response)
    }

    pub async fn cancel_owned(&mut self, request: &NativeMeshSpeechRequest, reason: impl Into<String>) -> Result<(), MeshSpeechError>
    where T: NativeMeshSpeechCallTransport {
        let reason = reason.into();
        if !matches!(reason.as_str(), "canceled" | "timed_out" | "revoked" | "interrupted") { return Err(MeshSpeechError::InvalidRequest); }
        let state = self.admission.as_ref().ok_or(MeshSpeechError::StaleResponse)?;
        if state.operation_id != request.operation_id() || state.attempt_id != request.attempt_id()
            || request.session_id() != Some(state.session_id.as_str())
            || request.payload().get("generation").and_then(Value::as_u64).is_some_and(|generation| generation != state.generation)
        { return Err(MeshSpeechError::StaleResponse); }
        let cancel = NativeMeshSpeechCancel {
            request_id: request.request_id().to_owned(), operation_id: request.operation_id().to_owned(),
            attempt_id: request.attempt_id().to_owned(), session_id: request.session_id().map(str::to_owned),
            generation: Some(state.generation),
            cancellation_ref: format!("{}:{}", request.operation_id(), request.attempt_id()), reason, resource_id: None,
        };
        let result = self.cancel_transport(cancel).await;
        if result.is_ok() {
            self.admission = None;
            self.lease_started = None;
            self.family = None;
        }
        result
    }

    async fn cancel_unowned(&mut self, request: &NativeMeshSpeechRequest, reason: &str) -> Result<(), MeshSpeechError>
    where T: NativeMeshSpeechCallTransport {
        let cancel = NativeMeshSpeechCancel {
            request_id: request.request_id().to_owned(), operation_id: request.operation_id().to_owned(),
            attempt_id: request.attempt_id().to_owned(), session_id: None, generation: None,
            cancellation_ref: format!("{}:{}", request.operation_id(), request.attempt_id()),
            reason: reason.to_owned(), resource_id: None,
        };
        self.cancel_transport(cancel).await
    }

    async fn cancel_transport(&mut self, cancel: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError>
    where T: NativeMeshSpeechCallTransport {
        match tokio::time::timeout(Duration::from_millis(MAX_DEADLINE_MS), self.transport.cancel(cancel)).await {
            Ok(result) => result,
            Err(_) => Err(MeshSpeechError::Transport),
        }
    }

    pub fn into_inner(self) -> T { self.transport }
}

pub fn transcription_audio_chunk_payload(
    session_id: &str, attempt_id: &str, generation: u64, sequence: u64, audio: &[u8],
) -> Result<Value, MeshSpeechError> {
    if audio.is_empty() || audio.len() > MAX_CHUNK_BYTES { return Err(MeshSpeechError::RequestTooLarge); }
    Ok(json!({
        "session_id": session_id, "attempt_id": attempt_id, "generation": generation,
        "sequence": sequence, "payload_kind": "audio", "payload_size_bytes": audio.len(),
        "audio_data": BASE64.encode(audio), "is_final": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct MockTransport { calls: Vec<NativeMeshSpeechRequest>, cancels: Vec<NativeMeshSpeechCancel>, responses: VecDeque<Value> }
    #[async_trait(?Send)]
    impl NativeMeshSpeechCallTransport for MockTransport {
        async fn call(&mut self, request: NativeMeshSpeechRequest) -> Result<Value, MeshSpeechError> {
            self.calls.push(request); self.responses.pop_front().ok_or(MeshSpeechError::Transport)
        }
        async fn cancel(&mut self, request: NativeMeshSpeechCancel) -> Result<(), MeshSpeechError> { self.cancels.push(request); Ok(()) }
    }

    #[test]
    fn builds_bounded_audio_chunk_and_rejects_oversize() {
        let payload = transcription_audio_chunk_payload("s", "a", 1, 0, &[1, 2]).expect("payload");
        assert_eq!(payload["payload_size_bytes"], 2);
        assert!(transcription_audio_chunk_payload("s", "a", 1, 0, &vec![0; MAX_CHUNK_BYTES + 1]).is_err());
    }

    #[tokio::test]
    async fn fences_session_and_requires_actual_chunk_credits() {
        let route = NativeMeshSpeechRequest::new(
            ids::TRANSCRIPTION_STREAM_CHUNK, "r", "o", "a", Some("session".into()),
            json!({"session_id":"session","attempt_id":"a","generation":1,"sequence":0,"payload_kind":"audio","payload_size_bytes":1,"audio_data":"AQ==","is_final":false}), 1024,
        ).expect("request");
        let mut provider = NativeMeshSpeechProvider::new(MockTransport { calls: vec![], cancels: vec![], responses: VecDeque::from([json!({"session_id":"other","state":"active","next_sequence":1,"credits":1,"lease_remaining_ms":10,"accepted_chunks":1,"dropped_chunks":0})]) });
        provider.install_admission(NativeMeshSpeechAdmission {
            operation_id: "o".into(), attempt_id: "a".into(), session_id: "session".into(),
            generation: 1, credits: 1, max_input_bytes: MAX_INPUT_BYTES,
            max_chunk_bytes: MAX_CHUNK_BYTES, lease_remaining_ms: 10, next_sequence: 0, terminal: false, input_closed: false,
            max_queue: 4, max_text_bytes: MAX_TEXT_BYTES,
        }).expect("admission");
        assert_eq!(provider.call(route).await, Err(MeshSpeechError::StaleResponse));
        provider.cancel_owned(&NativeMeshSpeechRequest::new(
            ids::TRANSCRIPTION_STREAM_CHUNK, "r", "o", "a", Some("session".into()),
            json!({"session_id":"session","attempt_id":"a","generation":1,"sequence":0,"payload_kind":"audio","payload_size_bytes":1,"audio_data":"AQ==","is_final":false}), 1024,
        ).expect("cancel request"), "canceled").await.expect("cancel");
        assert_eq!(provider.into_inner().cancels[0].session_id.as_deref(), Some("session"));
    }

    #[test]
    fn rejects_mismatched_payload_identity_and_uses_byte_bounds() {
        let mismatch = NativeMeshSpeechRequest::new(
            ids::TRANSCRIPTION_STREAM_CHUNK, "request", "operation", "attempt",
            Some("session".into()),
            json!({"session_id":"other","attempt_id":"attempt","generation":1,"sequence":0,
                "payload_kind":"audio","payload_size_bytes":1,"audio_data":"AQ==","is_final":false}),
            1024,
        );
        assert_eq!(mismatch, Err(MeshSpeechError::InvalidPayload));

        let oversized_text = "🙂".repeat(MAX_TEXT_BYTES / 4 + 1);
        let request = NativeMeshSpeechRequest::new(
            ids::TTS_STREAM_CHUNK, "request", "operation", "attempt", None,
            json!({"stream_id":"stream","sequence":0,"text": oversized_text}), 1024,
        );
        assert_eq!(request, Err(MeshSpeechError::RequestTooLarge));
        assert!(transcription_audio_chunk_payload("s", "a", 1, 0, &vec![0; MAX_CHUNK_BYTES]).is_ok());
        assert!(transcription_audio_chunk_payload("s", "a", 1, 0, &vec![0; MAX_CHUNK_BYTES + 1]).is_err());
    }

    #[tokio::test]
    async fn admission_enforces_sequence_and_exhausted_credits() {
        let mut provider = NativeMeshSpeechProvider::new(MockTransport {
            calls: vec![], cancels: vec![], responses: VecDeque::from([json!({}), json!({})]),
        });
        provider.install_admission(NativeMeshSpeechAdmission {
            operation_id: "op".into(), attempt_id: "at".into(), session_id: "session".into(),
            generation: 3, credits: 1, max_input_bytes: MAX_INPUT_BYTES,
            max_chunk_bytes: MAX_TEXT_BYTES, max_queue: 1, lease_remaining_ms: 60_000,
            next_sequence: 0, terminal: false, input_closed: false, max_text_bytes: MAX_TEXT_BYTES,
        }).expect("admission");
        let chunk = |sequence| NativeMeshSpeechRequest::new(
            ids::TTS_STREAM_CHUNK, "request", "op", "at", Some("session".into()),
            json!({"stream_id":"session","sequence":sequence,"generation":3,"session_id":"session","text":"hello"}), 1024,
        ).expect("chunk");
        provider.call(chunk(0)).await.expect("first chunk");
        assert_eq!(provider.call(chunk(1)).await, Err(MeshSpeechError::StaleResponse));
    }
}
