//! Bound Sherpa speech adapters.
//!
//! This crate keeps the public provider surface on the shared engine types.
//! Native FFI and browser hosts sit below safe backend traits.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use aurora_voice_engine::{
    check_engine_cancellation, BoundFiniteSttRequest, BoundKwsRequest, BoundStreamSession,
    BoundTaskRequest, BoundTtsSynthesisRequest, BoundVadRequest, EngineError, EngineFaultCode,
    FiniteSttAudio, FiniteSttPort, FiniteSttProviderBinding, FiniteSttResult, KeywordMatch,
    KwsConfig, KwsCooldownState, KwsFrameResult, ResourceReport, SpeechSegment, StreamResetReason,
    StreamSessionId, StreamingAudioFrame, TaskCapability, TaskPackBinding, TaskProvider,
    TaskReadiness, TtsAudioChunk, TtsSynthesisPort, TtsSynthesisProviderBinding,
    TtsSynthesisResult, VadAcceptResult, VadConfig, VadStreamProvider, VoiceTask, MONO_CHANNELS,
    TTS_MAX_SAMPLE_RATE_HZ, TTS_MIN_SAMPLE_RATE_HZ, VAD_SAMPLE_RATE_HZ, VAD_WINDOW_SIZE_SAMPLES,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use thiserror::Error;

const MAX_DRAINED_SEGMENTS: usize = 512;
const MAX_PHRASE_SET_PHRASES: usize = 64;
const MAX_LOGICAL_PHRASE_ID_BYTES: usize = 128;
const MAX_NATIVE_KEYWORD_BYTES: usize = 512;
const MAX_KEYWORD_BUFFER_BYTES: usize = 4096;
const MAX_PHRASE_REVISION_BYTES: usize = 128;
const SHERPA_FINITE_STT_MAX_SECONDS: usize = 60;
const SHERPA_TTS_MAX_SECONDS: usize = 60;
const SHERPA_TTS_MIN_SPEED: f32 = 0.5;
const SHERPA_TTS_MAX_SPEED: f32 = 2.0;

/// Product-safe backend fault classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendFaultCode {
    HostUnavailable,
    NativeFault,
    WasmFault,
    BackendFault,
}

impl BackendFaultCode {
    pub const fn as_engine_fault(self) -> EngineFaultCode {
        match self {
            Self::HostUnavailable => EngineFaultCode::HostUnavailable,
            Self::NativeFault => EngineFaultCode::Native,
            Self::WasmFault => EngineFaultCode::Wasm,
            Self::BackendFault => EngineFaultCode::Provider,
        }
    }
}

impl fmt::Display for BackendFaultCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HostUnavailable => "host_unavailable",
            Self::NativeFault => "native_fault",
            Self::WasmFault => "wasm_fault",
            Self::BackendFault => "backend_fault",
        })
    }
}

/// Adapter errors contain no paths, provider names, pointers, or raw host
/// messages.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum SherpaAdapterError {
    #[error("invalid sherpa configuration")]
    InvalidConfig,
    #[error("invalid audio frame")]
    InvalidFrame,
    #[error("invalid synthesized audio")]
    InvalidAudio,
    #[error("invalid speech segment")]
    InvalidSegment,
    #[error("invalid phrase map")]
    InvalidPhraseMap,
    #[error("invalid transcript")]
    InvalidTranscript,
    #[error("cancelled")]
    Cancelled,
    #[error("backend fault: {code}")]
    BackendFault { code: BackendFaultCode },
}

impl SherpaAdapterError {
    pub fn from_host_fault(_raw_host_message: impl AsRef<str>) -> Self {
        Self::BackendFault {
            code: BackendFaultCode::BackendFault,
        }
    }

    fn into_engine_error(self) -> EngineError {
        match self {
            Self::InvalidConfig
            | Self::InvalidFrame
            | Self::InvalidAudio
            | Self::InvalidSegment
            | Self::InvalidPhraseMap
            | Self::InvalidTranscript => EngineError::InvalidRequest,
            Self::Cancelled => EngineError::Cancelled,
            Self::BackendFault { code } => EngineError::ProviderFault {
                code: code.as_engine_fault(),
            },
        }
    }
}

/// Redacted mapping from Aurora phrase ids to native Sherpa keyword labels.
#[derive(Clone, PartialEq, Eq)]
pub struct SherpaKwsPhraseSet {
    revision: String,
    logical_to_spec: BTreeMap<String, String>,
    native_to_logical: BTreeMap<String, String>,
    keyword_buffer: String,
}

impl SherpaKwsPhraseSet {
    pub fn new(
        revision: impl Into<String>,
        phrases: impl IntoIterator<Item = SherpaKwsPhrase>,
    ) -> Result<Self, EngineError> {
        let revision = revision.into();
        if !valid_plain_field(&revision, 1, MAX_PHRASE_REVISION_BYTES) {
            return Err(EngineError::InvalidRequest);
        }
        let mut logical_to_spec = BTreeMap::new();
        let mut native_to_logical = BTreeMap::new();
        let mut native_specs = BTreeSet::new();
        let mut keyword_buffer = String::new();
        for phrase in phrases {
            if !valid_logical_phrase_id(&phrase.logical_id)
                || !valid_plain_field(&phrase.native_result_label, 1, MAX_NATIVE_KEYWORD_BYTES)
                || !valid_plain_field(&phrase.keyword_spec_line, 1, MAX_NATIVE_KEYWORD_BYTES)
                || logical_to_spec.len() >= MAX_PHRASE_SET_PHRASES
                || logical_to_spec.contains_key(&phrase.logical_id)
                || native_to_logical.contains_key(&phrase.native_result_label)
                || !native_specs.insert(phrase.keyword_spec_line.clone())
            {
                return Err(EngineError::InvalidRequest);
            }
            if !keyword_buffer.is_empty() {
                keyword_buffer.push('\n');
            }
            keyword_buffer.push_str(&phrase.keyword_spec_line);
            if keyword_buffer.len() > MAX_KEYWORD_BUFFER_BYTES {
                return Err(EngineError::InvalidRequest);
            }
            logical_to_spec.insert(phrase.logical_id.clone(), phrase.keyword_spec_line);
            native_to_logical.insert(phrase.native_result_label, phrase.logical_id);
        }
        if logical_to_spec.is_empty() {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            revision,
            logical_to_spec,
            native_to_logical,
            keyword_buffer,
        })
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn keyword_buffer(&self) -> &str {
        &self.keyword_buffer
    }

    pub fn keyword_buffer_for_request(&self, config: &KwsConfig) -> Result<String, EngineError> {
        self.validate_request(config)?;
        let mut buffer = String::new();
        for phrase_id in config.phrase_ids() {
            let Some(spec) = self.keyword_spec_for(phrase_id) else {
                return Err(EngineError::InvalidRequest);
            };
            if !buffer.is_empty() {
                buffer.push('\n');
            }
            buffer.push_str(spec);
        }
        if buffer.is_empty() || buffer.len() > MAX_KEYWORD_BUFFER_BYTES {
            return Err(EngineError::InvalidRequest);
        }
        Ok(buffer)
    }

    pub fn keyword_spec_for(&self, logical_id: &str) -> Option<&str> {
        self.logical_to_spec.get(logical_id).map(String::as_str)
    }

    pub fn logical_id_for_native(&self, native_label: &str) -> Option<&str> {
        self.native_to_logical.get(native_label).map(String::as_str)
    }

    pub fn validate_request(&self, config: &KwsConfig) -> Result<(), EngineError> {
        config.validate()?;
        if config.phrase_set_revision() != self.revision {
            return Err(EngineError::InvalidRequest);
        }
        for phrase_id in config.phrase_ids() {
            if !self.logical_to_spec.contains_key(phrase_id) {
                return Err(EngineError::InvalidRequest);
            }
        }
        Ok(())
    }
}

impl fmt::Debug for SherpaKwsPhraseSet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaKwsPhraseSet")
            .field("revision_bytes", &self.revision.len())
            .field("phrase_count", &self.logical_to_spec.len())
            .field("keyword_buffer_bytes", &self.keyword_buffer.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SherpaKwsPhrase {
    logical_id: String,
    native_result_label: String,
    keyword_spec_line: String,
}

impl SherpaKwsPhrase {
    pub fn new(
        logical_id: impl Into<String>,
        native_result_label: impl Into<String>,
        keyword_spec_line: impl Into<String>,
    ) -> Result<Self, EngineError> {
        let phrase = Self {
            logical_id: logical_id.into(),
            native_result_label: native_result_label.into(),
            keyword_spec_line: keyword_spec_line.into(),
        };
        if !valid_logical_phrase_id(&phrase.logical_id)
            || !valid_plain_field(&phrase.native_result_label, 1, MAX_NATIVE_KEYWORD_BYTES)
            || !valid_plain_field(&phrase.keyword_spec_line, 1, MAX_NATIVE_KEYWORD_BYTES)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(phrase)
    }
}

impl fmt::Debug for SherpaKwsPhrase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaKwsPhrase")
            .field("logical_id_bytes", &self.logical_id.len())
            .field("native_result_label_bytes", &self.native_result_label.len())
            .field("keyword_spec_line_bytes", &self.keyword_spec_line.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SherpaKeywordDetection {
    native_label: String,
}

impl SherpaKeywordDetection {
    pub fn new(native_label: impl Into<String>) -> Result<Self, SherpaAdapterError> {
        let native_label = native_label.into();
        if !valid_plain_field(&native_label, 1, MAX_NATIVE_KEYWORD_BYTES) {
            return Err(SherpaAdapterError::InvalidPhraseMap);
        }
        Ok(Self { native_label })
    }

    pub fn native_label(&self) -> &str {
        &self.native_label
    }
}

impl fmt::Debug for SherpaKeywordDetection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaKeywordDetection")
            .field("native_label_bytes", &self.native_label.len())
            .finish()
    }
}

/// Safe host/backend boundary for streaming keyword spotting.
pub trait SherpaKwsBackend {
    fn start_session(
        &mut self,
        request: &BoundKwsRequest,
        phrase_set: &SherpaKwsPhraseSet,
    ) -> Result<(), SherpaAdapterError>;

    fn accept_waveform(
        &mut self,
        frame: StreamingAudioFrame<'_>,
    ) -> Result<Vec<SherpaKeywordDetection>, SherpaAdapterError>;

    fn reset(&mut self) -> Result<(), SherpaAdapterError>;

    fn cancel(&mut self) -> Result<(), SherpaAdapterError>;
}

/// Safe host/backend boundary for finite STT.
pub trait SherpaSttBackend {
    fn transcribe(
        &mut self,
        sample_rate_hz: u32,
        pcm: &[f32],
        language: Option<&str>,
    ) -> Result<String, SherpaAdapterError>;
}

pub trait SherpaTtsBackend {
    fn synthesize(
        &mut self,
        text: &str,
        speaker_id: i32,
        speed: f32,
        cancellation: &dyn Fn() -> bool,
        cancellation_token: &SherpaTtsCancellationToken,
    ) -> Result<SherpaTtsAudio, SherpaAdapterError>;

    fn cancel(&mut self) -> Result<(), SherpaAdapterError>;
}

#[derive(Clone, PartialEq)]
pub struct SherpaTtsAudio {
    sample_rate_hz: u32,
    samples: Vec<f32>,
}

impl SherpaTtsAudio {
    pub fn new(sample_rate_hz: u32, samples: Vec<f32>) -> Result<Self, SherpaAdapterError> {
        if !(TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&sample_rate_hz)
            || samples.is_empty()
            || samples.len() > sample_rate_hz as usize * SHERPA_TTS_MAX_SECONDS
            || samples
                .iter()
                .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
        {
            return Err(SherpaAdapterError::InvalidAudio);
        }
        Ok(Self {
            sample_rate_hz,
            samples,
        })
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }
}

impl fmt::Debug for SherpaTtsAudio {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaTtsAudio")
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("sample_count", &self.samples.len())
            .field("samples", &"<redacted>")
            .finish()
    }
}

/// Safe host/backend boundary. Implementations may own native FFI or browser
/// state internally, but only shared engine values cross this trait.
pub trait SherpaVadBackend {
    fn accept_waveform(&mut self, frame: StreamingAudioFrame<'_>)
        -> Result<(), SherpaAdapterError>;

    fn is_speech_detected(&mut self) -> Result<bool, SherpaAdapterError>;

    fn pop_completed_segment(&mut self) -> Result<Option<SpeechSegment>, SherpaAdapterError>;

    fn flush(&mut self) -> Result<(), SherpaAdapterError>;

    fn clear_queued_segments(&mut self) -> Result<(), SherpaAdapterError>;

    fn reset(&mut self) -> Result<(), SherpaAdapterError>;
}

#[derive(Debug, Clone, PartialEq)]
struct ActiveVadSession {
    session: BoundStreamSession,
    config: VadConfig,
}

#[derive(Debug, Clone, PartialEq)]
struct ActiveKwsSession {
    session: BoundStreamSession,
    config: KwsConfig,
    cooldown: KwsCooldownState,
    frame_index: u64,
}

/// Corrected bound VAD provider for a single installed Sherpa model selection.
#[derive(Debug)]
pub struct SherpaVadProvider<B> {
    installed_binding: TaskPackBinding,
    backend: B,
    readiness: TaskReadiness,
    active: Option<ActiveVadSession>,
    next_session_id: u64,
    last_backend_fault: Option<BackendFaultCode>,
}

impl<B> SherpaVadProvider<B>
where
    B: SherpaVadBackend,
{
    pub fn new(installed_binding: TaskPackBinding, backend: B) -> Result<Self, EngineError> {
        validate_vad_binding(&installed_binding)?;
        Ok(Self {
            installed_binding,
            backend,
            readiness: TaskReadiness::Ready,
            active: None,
            next_session_id: 1,
            last_backend_fault: None,
        })
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.installed_binding
    }

    pub fn active_session(&self) -> Option<StreamSessionId> {
        self.active
            .as_ref()
            .map(|active| active.session.session_id())
    }

    pub fn last_backend_fault(&self) -> Option<BackendFaultCode> {
        self.last_backend_fault
    }

    pub fn clear_queued_segments(
        &mut self,
        session: &BoundStreamSession,
    ) -> Result<(), EngineError> {
        self.ensure_session(session)?;
        let result = self.backend.clear_queued_segments();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    pub fn into_backend(self) -> B {
        self.backend
    }

    fn ensure_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        if binding == &self.installed_binding {
            Ok(())
        } else {
            Err(EngineError::InvalidRequest)
        }
    }

    fn ensure_request(&self, request: &BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_binding(request.binding())?;
        if request.request().task != VoiceTask::VoiceActivityDetection {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn ensure_session(
        &self,
        session: &BoundStreamSession,
    ) -> Result<&ActiveVadSession, EngineError> {
        match &self.active {
            Some(active)
                if active.session.session_id() == session.session_id()
                    && session.task() == VoiceTask::VoiceActivityDetection
                    && active.session == *session
                    && session.binding() == &self.installed_binding =>
            {
                Ok(active)
            }
            _ => Err(EngineError::InvalidRequest),
        }
    }

    fn cancel_active(&mut self) -> Result<(), EngineError> {
        self.active = None;
        let result = self.backend.reset();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    fn reset_active_backend(&mut self) -> Result<(), EngineError> {
        let result = self.backend.reset();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    fn drain_completed(
        &mut self,
        config: &VadConfig,
        cancellation: &dyn Fn() -> bool,
        flushed: bool,
    ) -> Result<Vec<SpeechSegment>, EngineError> {
        let max_buffer_samples = usize::try_from(
            config
                .buffer_samples()
                .map_err(|_| EngineError::ResourceLimit)?,
        )
        .map_err(|_| EngineError::ResourceLimit)?;
        let max_speech_samples = usize::try_from(
            config
                .max_speech_samples()
                .map_err(|_| EngineError::ResourceLimit)?,
        )
        .map_err(|_| EngineError::ResourceLimit)?;
        let mut segments = Vec::new();
        let mut total_samples = 0_usize;

        for _ in 0..MAX_DRAINED_SEGMENTS {
            if cancellation() {
                self.cancel_active()?;
                return Err(EngineError::Cancelled);
            }
            let result = self.backend.pop_completed_segment();
            let segment = match self
                .capture_backend(result)
                .map_err(SherpaAdapterError::into_engine_error)?
            {
                Some(segment) => segment,
                None => return Ok(segments),
            };
            if cancellation() {
                self.cancel_active()?;
                return Err(EngineError::Cancelled);
            }
            validate_segment(&segment, max_speech_samples)?;
            total_samples = total_samples
                .checked_add(segment.samples().len())
                .ok_or(EngineError::ResourceLimit)?;
            if total_samples > max_buffer_samples {
                let result = self.backend.clear_queued_segments();
                let _ = self.capture_backend(result);
                return Err(EngineError::InvalidRequest);
            }
            segments.push(if flushed && !segment.flushed() {
                SpeechSegment::new(
                    segment.start_frame(),
                    segment.end_frame(),
                    segment.start_sample(),
                    segment.samples().to_vec(),
                    true,
                )?
            } else {
                segment
            });
        }

        let result = self.backend.clear_queued_segments();
        let _ = self.capture_backend(result);
        Err(EngineError::ResourceLimit)
    }

    fn capture_backend<T>(
        &mut self,
        result: Result<T, SherpaAdapterError>,
    ) -> Result<T, SherpaAdapterError> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let SherpaAdapterError::BackendFault { code } = error {
                    self.last_backend_fault = Some(code);
                    Err(SherpaAdapterError::BackendFault { code })
                } else {
                    Err(error)
                }
            }
        }
    }
}

pub struct SherpaKwsProvider<B> {
    installed_binding: TaskPackBinding,
    phrase_set: SherpaKwsPhraseSet,
    backend: B,
    readiness: TaskReadiness,
    active: Option<ActiveKwsSession>,
    next_session_id: u64,
    last_backend_fault: Option<BackendFaultCode>,
}

impl<B> fmt::Debug for SherpaKwsProvider<B> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaKwsProvider")
            .field("installed_binding", &self.installed_binding)
            .field("phrase_set", &self.phrase_set)
            .field("readiness", &self.readiness)
            .field(
                "active_session",
                &self.active.as_ref().map(|a| a.session.session_id()),
            )
            .field("last_backend_fault", &self.last_backend_fault)
            .finish()
    }
}

impl<B> SherpaKwsProvider<B>
where
    B: SherpaKwsBackend,
{
    pub fn new(
        installed_binding: TaskPackBinding,
        phrase_set: SherpaKwsPhraseSet,
        backend: B,
    ) -> Result<Self, EngineError> {
        validate_kws_binding(&installed_binding)?;
        Ok(Self {
            installed_binding,
            phrase_set,
            backend,
            readiness: TaskReadiness::Ready,
            active: None,
            next_session_id: 1,
            last_backend_fault: None,
        })
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.installed_binding
    }

    pub fn phrase_set(&self) -> &SherpaKwsPhraseSet {
        &self.phrase_set
    }

    pub fn active_session(&self) -> Option<StreamSessionId> {
        self.active
            .as_ref()
            .map(|active| active.session.session_id())
    }

    pub fn last_backend_fault(&self) -> Option<BackendFaultCode> {
        self.last_backend_fault
    }

    pub fn into_backend(self) -> B {
        self.backend
    }

    fn ensure_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        if binding == &self.installed_binding {
            Ok(())
        } else {
            Err(EngineError::InvalidRequest)
        }
    }

    fn ensure_request(&self, request: &BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_binding(request.binding())?;
        if request.request().task != VoiceTask::KeywordSpotting {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn ensure_session(
        &self,
        session: &BoundStreamSession,
    ) -> Result<&ActiveKwsSession, EngineError> {
        match &self.active {
            Some(active)
                if active.session.session_id() == session.session_id()
                    && session.task() == VoiceTask::KeywordSpotting
                    && active.session == *session
                    && session.binding() == &self.installed_binding =>
            {
                Ok(active)
            }
            _ => Err(EngineError::InvalidRequest),
        }
    }

    fn cancel_active(&mut self) -> Result<(), EngineError> {
        self.active = None;
        let result = self.backend.cancel();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    fn reset_active_backend(&mut self) -> Result<(), EngineError> {
        if let Some(active) = &mut self.active {
            active.cooldown.reset();
        }
        let result = self.backend.reset();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    fn capture_backend<T>(
        &mut self,
        result: Result<T, SherpaAdapterError>,
    ) -> Result<T, SherpaAdapterError> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let SherpaAdapterError::BackendFault { code } = error {
                    self.last_backend_fault = Some(code);
                    Err(SherpaAdapterError::BackendFault { code })
                } else {
                    Err(error)
                }
            }
        }
    }
}

#[async_trait(?Send)]
impl<B> TaskProvider for SherpaKwsProvider<B>
where
    B: SherpaKwsBackend,
{
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![TaskCapability::new(self.installed_binding.clone()).streaming(true)]
    }

    fn resource_report(&self) -> ResourceReport {
        ResourceReport {
            loaded_tasks: vec![VoiceTask::KeywordSpotting],
            memory_bytes: self.installed_binding.resource_budget().max_memory_bytes,
            active_streams: u32::from(self.active.is_some()),
            readiness: self.readiness,
        }
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_request(&request)
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.ensure_binding(&binding)?;
        self.active = None;
        let result = self.backend.cancel();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.session.generation() == generation)
        {
            self.cancel_active()?;
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl<B> aurora_voice_engine::KwsStreamProvider for SherpaKwsProvider<B>
where
    B: SherpaKwsBackend,
{
    async fn start_kws_session(
        &mut self,
        request: BoundKwsRequest,
    ) -> Result<BoundStreamSession, EngineError> {
        self.ensure_request(request.request())?;
        request.config().validate_binding(&self.installed_binding)?;
        self.phrase_set.validate_request(request.config())?;
        if self.active.is_some() {
            return Err(EngineError::ResourceLimit);
        }
        let result = self.backend.start_session(&request, &self.phrase_set);
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        let session_id = StreamSessionId(self.next_session_id);
        self.next_session_id = self.next_session_id.saturating_add(1);
        let session = BoundStreamSession::new(session_id, request.request())?;
        self.active = Some(ActiveKwsSession {
            session: session.clone(),
            config: request.config().clone(),
            cooldown: KwsCooldownState::new(),
            frame_index: 0,
        });
        Ok(session)
    }

    async fn push_kws_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<KwsFrameResult, EngineError> {
        let active = self.ensure_session(session)?.clone();
        validate_kws_frame(&frame)?;
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }

        let reset = if frame.discontinuity() {
            self.reset_active_backend()?;
            Some(StreamResetReason::Discontinuity)
        } else {
            None
        };

        let detections = {
            let result = self.backend.accept_waveform(frame);
            self.capture_backend(result)
                .map_err(SherpaAdapterError::into_engine_error)?
        };
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }

        let active_mut = self.active.as_mut().ok_or(EngineError::InvalidRequest)?;
        active_mut.frame_index = active_mut.frame_index.saturating_add(1);
        let frame_index = active_mut.frame_index;
        let mut seen = BTreeSet::new();
        let mut matches = Vec::new();
        let next_allowed_frame = active_mut
            .cooldown
            .last_emitted_frame()
            .map(|last| last.saturating_add(u64::from(active_mut.config.cooldown_frames())));
        for detection in detections {
            let Some(logical_id) = self
                .phrase_set
                .logical_id_for_native(detection.native_label())
            else {
                self.cancel_active()?;
                return Err(EngineError::InvalidRequest);
            };
            if !active_mut
                .config
                .phrase_ids()
                .iter()
                .any(|id| id == logical_id)
                || next_allowed_frame.is_some_and(|next| frame_index <= next)
                || !seen.insert(logical_id.to_owned())
            {
                continue;
            }
            if matches.len() >= usize::from(active_mut.config.max_results()) {
                break;
            }
            matches.push(KeywordMatch::new(
                logical_id,
                active_mut.config.threshold(),
                frame_index,
            )?);
        }

        KwsFrameResult::new(&active.config, &mut active_mut.cooldown, matches, reset)
    }

    async fn reset_kws_session(
        &mut self,
        session: &BoundStreamSession,
        _reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        self.ensure_session(session)?;
        self.reset_active_backend()
    }
}

#[derive(Clone)]
pub struct SherpaTtsCancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl SherpaTtsCancellationToken {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn reset(&self) {
        self.cancelled.store(false, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    #[cfg(feature = "native-tts")]
    pub(crate) fn as_atomic(&self) -> &AtomicBool {
        &self.cancelled
    }
}

impl fmt::Debug for SherpaTtsCancellationToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaTtsCancellationToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

pub struct SherpaFiniteSttEngine<B> {
    installed_binding: TaskPackBinding,
    backend: B,
    readiness: TaskReadiness,
    last_backend_fault: Option<BackendFaultCode>,
}

pub struct SherpaTtsProvider<B> {
    installed_binding: TaskPackBinding,
    backend: B,
    readiness: TaskReadiness,
    active_generation: Option<u64>,
    cancellation_token: SherpaTtsCancellationToken,
    speaker_id: i32,
    speed: f32,
    last_backend_fault: Option<BackendFaultCode>,
}

impl<B> fmt::Debug for SherpaTtsProvider<B> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaTtsProvider")
            .field("installed_binding", &self.installed_binding)
            .field("readiness", &self.readiness)
            .field("active_generation", &self.active_generation)
            .field(
                "cancellation_requested",
                &self.cancellation_token.is_cancelled(),
            )
            .field("speaker_id", &self.speaker_id)
            .field("speed", &self.speed)
            .field("last_backend_fault", &self.last_backend_fault)
            .finish()
    }
}

impl<B> SherpaTtsProvider<B>
where
    B: SherpaTtsBackend,
{
    pub fn new(installed_binding: TaskPackBinding, backend: B) -> Result<Self, EngineError> {
        Self::with_voice_options(installed_binding, backend, 0, 1.0)
    }

    pub fn with_voice_options(
        installed_binding: TaskPackBinding,
        backend: B,
        speaker_id: i32,
        speed: f32,
    ) -> Result<Self, EngineError> {
        validate_tts_binding(&installed_binding)?;
        validate_tts_voice_options(speaker_id, speed)?;
        Ok(Self {
            installed_binding,
            backend,
            readiness: TaskReadiness::Ready,
            active_generation: None,
            cancellation_token: SherpaTtsCancellationToken::new(),
            speaker_id,
            speed,
            last_backend_fault: None,
        })
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.installed_binding
    }

    pub fn last_backend_fault(&self) -> Option<BackendFaultCode> {
        self.last_backend_fault
    }

    pub fn cancellation_token(&self) -> SherpaTtsCancellationToken {
        self.cancellation_token.clone()
    }

    pub fn into_backend(self) -> B {
        self.backend
    }

    fn ensure_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        if binding == &self.installed_binding {
            Ok(())
        } else {
            Err(EngineError::InvalidRequest)
        }
    }

    fn ensure_request(&self, request: &BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_binding(request.binding())?;
        if request.request().task != VoiceTask::TextToSpeech {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn validate_synthesis_request(
        &self,
        request: &BoundTtsSynthesisRequest,
    ) -> Result<(), EngineError> {
        let local = request.local_request().ok_or(EngineError::InvalidRequest)?;
        self.ensure_request(local)?;
        request.config().validate_binding(&self.installed_binding)?;
        self.installed_binding
            .validate_language(request.binding().language())?;
        if request.config().seed().is_some() {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn capture_backend<T>(
        &mut self,
        result: Result<T, SherpaAdapterError>,
    ) -> Result<T, SherpaAdapterError> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let SherpaAdapterError::BackendFault { code } = error {
                    self.last_backend_fault = Some(code);
                    Err(SherpaAdapterError::BackendFault { code })
                } else {
                    Err(error)
                }
            }
        }
    }
}

impl<B> fmt::Debug for SherpaFiniteSttEngine<B> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SherpaFiniteSttEngine")
            .field("installed_binding", &self.installed_binding)
            .field("readiness", &self.readiness)
            .field("last_backend_fault", &self.last_backend_fault)
            .finish()
    }
}

#[async_trait(?Send)]
impl<B> TaskProvider for SherpaTtsProvider<B>
where
    B: SherpaTtsBackend,
{
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![TaskCapability::new(self.installed_binding.clone()).streaming(false)]
    }

    fn resource_report(&self) -> ResourceReport {
        ResourceReport {
            loaded_tasks: vec![VoiceTask::TextToSpeech],
            memory_bytes: self.installed_binding.resource_budget().max_memory_bytes,
            active_streams: u32::from(self.active_generation.is_some()),
            readiness: self.readiness,
        }
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_request(&request)
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.ensure_binding(&binding)?;
        self.active_generation = None;
        self.cancellation_token.cancel();
        let result = self.backend.cancel();
        let output = self
            .capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error);
        self.cancellation_token.reset();
        output
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        self.cancel_synthesis_generation(generation).await
    }
}

#[async_trait(?Send)]
impl<B> TtsSynthesisPort for SherpaTtsProvider<B>
where
    B: SherpaTtsBackend,
{
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
        Ok(TtsSynthesisProviderBinding::LocalTask(Box::new(
            self.installed_binding.clone(),
        )))
    }

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError> {
        match binding {
            TtsSynthesisProviderBinding::LocalTask(binding) => self.ensure_binding(&binding),
            TtsSynthesisProviderBinding::Route(_) => Err(EngineError::InvalidRequest),
        }
    }

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        if self.active_generation.is_some() {
            return Err(EngineError::ResourceLimit);
        }
        self.validate_synthesis_request(&request)?;
        check_engine_cancellation(cancellation)?;
        let generation = request.generation();
        self.active_generation = Some(generation);
        self.cancellation_token.reset();
        let cancellation_token = self.cancellation_token.clone();
        let result = self.backend.synthesize(
            request.text(),
            self.speaker_id,
            self.speed,
            &|| cancellation() || cancellation_token.is_cancelled(),
            &cancellation_token,
        );
        let audio = match self.capture_backend(result) {
            Ok(audio) => audio,
            Err(SherpaAdapterError::Cancelled) => {
                self.active_generation = None;
                return Err(EngineError::Cancelled);
            }
            Err(error) => {
                self.active_generation = None;
                return Err(error.into_engine_error());
            }
        };
        if cancellation() || self.cancellation_token.is_cancelled() {
            self.active_generation = None;
            return Err(EngineError::Cancelled);
        }
        let chunks = chunk_tts_audio(&request, &audio)?;
        self.active_generation = None;
        TtsSynthesisResult::new(&request, chunks, false)
    }

    async fn cancel_synthesis_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        if self.active_generation == Some(generation) {
            self.cancellation_token.cancel();
            let result = self.backend.cancel();
            self.capture_backend(result)
                .map_err(SherpaAdapterError::into_engine_error)?;
            self.active_generation = None;
            self.cancellation_token.reset();
        }
        Ok(())
    }
}

impl<B> SherpaFiniteSttEngine<B>
where
    B: SherpaSttBackend,
{
    pub fn new(installed_binding: TaskPackBinding, backend: B) -> Result<Self, EngineError> {
        validate_stt_binding(&installed_binding)?;
        Ok(Self {
            installed_binding,
            backend,
            readiness: TaskReadiness::Ready,
            last_backend_fault: None,
        })
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.installed_binding
    }

    pub fn last_backend_fault(&self) -> Option<BackendFaultCode> {
        self.last_backend_fault
    }

    pub fn into_backend(self) -> B {
        self.backend
    }

    fn ensure_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        if binding == &self.installed_binding {
            Ok(())
        } else {
            Err(EngineError::InvalidRequest)
        }
    }

    fn ensure_request(&self, request: &BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_binding(request.binding())?;
        if request.request().task != VoiceTask::SpeechToText {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn capture_backend<T>(
        &mut self,
        result: Result<T, SherpaAdapterError>,
    ) -> Result<T, SherpaAdapterError> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let SherpaAdapterError::BackendFault { code } = error {
                    self.last_backend_fault = Some(code);
                    Err(SherpaAdapterError::BackendFault { code })
                } else {
                    Err(error)
                }
            }
        }
    }
}

#[async_trait(?Send)]
impl<B> TaskProvider for SherpaFiniteSttEngine<B>
where
    B: SherpaSttBackend,
{
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![TaskCapability::new(self.installed_binding.clone()).streaming(false)]
    }

    fn resource_report(&self) -> ResourceReport {
        ResourceReport {
            loaded_tasks: vec![VoiceTask::SpeechToText],
            memory_bytes: self.installed_binding.resource_budget().max_memory_bytes,
            active_streams: 0,
            readiness: self.readiness,
        }
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_request(&request)
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.ensure_binding(&binding)
    }

    async fn cancel_generation(&mut self, _generation: u64) -> Result<(), EngineError> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl<B> FiniteSttPort for SherpaFiniteSttEngine<B>
where
    B: SherpaSttBackend,
{
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
        Ok(FiniteSttProviderBinding::LocalTask(Box::new(
            self.installed_binding.clone(),
        )))
    }

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError> {
        match binding {
            FiniteSttProviderBinding::LocalTask(binding) => self.ensure_binding(&binding),
            FiniteSttProviderBinding::Route(_) => Err(EngineError::InvalidRequest),
        }
    }

    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        let Some(local_request) = request.local_request() else {
            return Err(EngineError::InvalidRequest);
        };
        self.ensure_request(local_request)?;
        if audio.generation() != request.generation()
            || audio.frames() != request.frames()
            || audio.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
            || audio.channels() != MONO_CHANNELS
        {
            return Err(EngineError::InvalidRequest);
        }
        if audio.samples().len() > VAD_SAMPLE_RATE_HZ as usize * SHERPA_FINITE_STT_MAX_SECONDS {
            return Err(EngineError::ResourceLimit);
        }
        check_engine_cancellation(cancellation)?;
        let result = self.backend.transcribe(
            audio.sample_rate_hz(),
            audio.samples(),
            local_request.request().language.as_deref(),
        );
        let transcript = self
            .capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        FiniteSttResult::new(&request, &audio, transcript)
    }

    async fn cancel_finite_stt_generation(&mut self, _generation: u64) -> Result<(), EngineError> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl<B> TaskProvider for SherpaVadProvider<B>
where
    B: SherpaVadBackend,
{
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![TaskCapability::new(self.installed_binding.clone()).streaming(true)]
    }

    fn resource_report(&self) -> ResourceReport {
        ResourceReport {
            loaded_tasks: vec![VoiceTask::VoiceActivityDetection],
            memory_bytes: self.installed_binding.resource_budget().max_memory_bytes,
            active_streams: u32::from(self.active.is_some()),
            readiness: self.readiness,
        }
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_request(&request)
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.ensure_binding(&binding)?;
        self.active = None;
        let result = self.backend.reset();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.session.generation() == generation)
        {
            self.cancel_active()?;
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl<B> VadStreamProvider for SherpaVadProvider<B>
where
    B: SherpaVadBackend,
{
    async fn start_vad_session(
        &mut self,
        request: BoundVadRequest,
    ) -> Result<BoundStreamSession, EngineError> {
        self.ensure_request(request.request())?;
        request.config().validate_binding(&self.installed_binding)?;
        if self.active.is_some() {
            return Err(EngineError::ResourceLimit);
        }
        let session_id = StreamSessionId(self.next_session_id);
        self.next_session_id = self.next_session_id.saturating_add(1);
        let session = BoundStreamSession::new(session_id, request.request())?;
        self.active = Some(ActiveVadSession {
            session: session.clone(),
            config: request.config().clone(),
        });
        Ok(session)
    }

    async fn push_vad_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<VadAcceptResult, EngineError> {
        let config = self.ensure_session(session)?.config.clone();
        validate_frame(&config, &frame)?;
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }

        let reset = if frame.discontinuity() {
            self.reset_active_backend()?;
            Some(StreamResetReason::Discontinuity)
        } else {
            None
        };

        let result = self.backend.accept_waveform(frame);
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }
        let result = self.backend.is_speech_detected();
        let detected = self
            .capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        let segments = self.drain_completed(&config, cancellation, false)?;
        Ok(VadAcceptResult::new(detected, segments, reset))
    }

    async fn flush_vad_session(
        &mut self,
        session: &BoundStreamSession,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<SpeechSegment>, EngineError> {
        let config = self.ensure_session(session)?.config.clone();
        check_engine_cancellation(cancellation)?;
        let result = self.backend.flush();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }
        self.drain_completed(&config, cancellation, true)
    }

    async fn reset_vad_session(
        &mut self,
        session: &BoundStreamSession,
        _reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        self.ensure_session(session)?;
        self.reset_active_backend()
    }
}

fn validate_vad_binding(binding: &TaskPackBinding) -> Result<(), EngineError> {
    if binding.task() != VoiceTask::VoiceActivityDetection
        || binding.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
        || binding.channels() != MONO_CHANNELS
        || binding.frame_size() != VAD_WINDOW_SIZE_SAMPLES as u32
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn validate_kws_binding(binding: &TaskPackBinding) -> Result<(), EngineError> {
    if binding.task() != VoiceTask::KeywordSpotting
        || binding.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
        || binding.channels() != MONO_CHANNELS
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn validate_stt_binding(binding: &TaskPackBinding) -> Result<(), EngineError> {
    if binding.task() != VoiceTask::SpeechToText
        || binding.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
        || binding.channels() != MONO_CHANNELS
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn validate_tts_binding(binding: &TaskPackBinding) -> Result<(), EngineError> {
    if binding.task() != VoiceTask::TextToSpeech
        || !(TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&binding.sample_rate_hz())
        || binding.channels() != MONO_CHANNELS
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn validate_tts_voice_options(speaker_id: i32, speed: f32) -> Result<(), EngineError> {
    if speaker_id < 0
        || !speed.is_finite()
        || !(SHERPA_TTS_MIN_SPEED..=SHERPA_TTS_MAX_SPEED).contains(&speed)
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn chunk_tts_audio(
    request: &BoundTtsSynthesisRequest,
    audio: &SherpaTtsAudio,
) -> Result<Vec<TtsAudioChunk>, EngineError> {
    if audio.sample_rate_hz() != request.config().sample_rate_hz() {
        return Err(EngineError::InvalidRequest);
    }
    let mut chunks = Vec::new();
    let chunk_samples = request.config().chunk_samples();
    for (index, samples) in audio.samples().chunks(chunk_samples).enumerate() {
        let final_chunk = (index + 1) * chunk_samples >= audio.samples().len();
        chunks.push(TtsAudioChunk::new(
            request,
            u64::try_from(index)
                .map_err(|_| EngineError::ResourceLimit)?
                .saturating_add(1),
            audio.sample_rate_hz(),
            MONO_CHANNELS,
            samples.iter().map(|sample| float_to_i16(*sample)).collect(),
            final_chunk,
        )?);
    }
    Ok(chunks)
}

fn float_to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped <= -1.0 {
        i16::MIN
    } else {
        (clamped * f32::from(i16::MAX)).round() as i16
    }
}

fn validate_frame(config: &VadConfig, frame: &StreamingAudioFrame<'_>) -> Result<(), EngineError> {
    if frame.is_end_tail() {
        config.validate_end_tail_samples(frame.samples())
    } else {
        config.validate_frame_samples(frame.samples())
    }
}

fn validate_segment(segment: &SpeechSegment, max_speech_samples: usize) -> Result<(), EngineError> {
    if segment.samples().is_empty() || segment.samples().len() > max_speech_samples {
        return Err(EngineError::InvalidRequest);
    }
    if segment
        .samples()
        .iter()
        .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
    {
        return Err(EngineError::InvalidRequest);
    }
    let sample_len =
        u64::try_from(segment.samples().len()).map_err(|_| EngineError::ResourceLimit)?;
    if segment.start_sample().checked_add(sample_len) != Some(segment.end_sample_exclusive()) {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn validate_kws_frame(frame: &StreamingAudioFrame<'_>) -> Result<(), EngineError> {
    if frame.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
        || frame.channels() != MONO_CHANNELS
        || frame.samples().is_empty()
        || frame.samples().len() > VAD_SAMPLE_RATE_HZ as usize
        || frame
            .samples()
            .iter()
            .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn valid_logical_phrase_id(value: &str) -> bool {
    valid_plain_field(value, 1, MAX_LOGICAL_PHRASE_ID_BYTES)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_plain_field(value: &str, min_bytes: usize, max_bytes: usize) -> bool {
    let len = value.len();
    len >= min_bytes && len <= max_bytes && !value.chars().any(|ch| ch == '\0' || ch.is_control())
}

#[cfg(feature = "native-vad")]
mod native_backend {
    use super::*;
    use aurora_voice_sherpa_sys::{
        ErrorCode as NativeErrorCode, SileroVadConfig as NativeSileroVadConfig,
        VoiceActivityDetector,
    };
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};

    #[derive(Debug)]
    pub struct NativeVadBackend {
        detector: VoiceActivityDetector,
        pending: VecDeque<SpeechSegment>,
    }

    impl NativeVadBackend {
        pub fn from_selected_model(
            binding: &TaskPackBinding,
            selected_file_id: &str,
            model_path: impl Into<PathBuf>,
            config: &VadConfig,
        ) -> Result<Self, EngineError> {
            validate_vad_binding(binding)?;
            config.validate_binding(binding)?;
            if !binding
                .selected_file_ids()
                .iter()
                .any(|file_id| file_id == selected_file_id)
            {
                return Err(EngineError::InvalidRequest);
            }
            Self::from_path(model_path.into(), config)
        }

        fn from_path(model_path: PathBuf, config: &VadConfig) -> Result<Self, EngineError> {
            let native_config = native_config(&model_path, config)?;
            let detector = VoiceActivityDetector::new(&native_config).map_err(native_error)?;
            Ok(Self {
                detector,
                pending: VecDeque::new(),
            })
        }
    }

    impl SherpaVadBackend for NativeVadBackend {
        fn accept_waveform(
            &mut self,
            frame: StreamingAudioFrame<'_>,
        ) -> Result<(), SherpaAdapterError> {
            match self.detector.accept_waveform(frame.samples()) {
                Ok(()) => Ok(()),
                Err(error) if is_queued_segment_undrained(&error) => {
                    self.drain_native_segments()?;
                    self.detector
                        .accept_waveform(frame.samples())
                        .map_err(native_adapter_error)
                }
                Err(error) => Err(native_adapter_error(error)),
            }
        }

        fn is_speech_detected(&mut self) -> Result<bool, SherpaAdapterError> {
            self.detector.detected().map_err(native_adapter_error)
        }

        fn pop_completed_segment(&mut self) -> Result<Option<SpeechSegment>, SherpaAdapterError> {
            if let Some(segment) = self.pending.pop_front() {
                return Ok(Some(segment));
            }

            self.drain_native_segments()?;
            Ok(self.pending.pop_front())
        }

        fn flush(&mut self) -> Result<(), SherpaAdapterError> {
            self.detector.flush().map_err(native_adapter_error)
        }

        fn clear_queued_segments(&mut self) -> Result<(), SherpaAdapterError> {
            self.pending.clear();
            self.detector.clear().map_err(native_adapter_error)
        }

        fn reset(&mut self) -> Result<(), SherpaAdapterError> {
            self.pending.clear();
            self.detector.reset().map_err(native_adapter_error)
        }
    }

    impl NativeVadBackend {
        fn drain_native_segments(&mut self) -> Result<(), SherpaAdapterError> {
            for segment in self
                .detector
                .drain_speech_segments()
                .map_err(native_adapter_error)?
            {
                self.pending.push_back(native_segment_to_engine(segment)?);
            }
            Ok(())
        }
    }

    fn native_segment_to_engine(
        segment: aurora_voice_sherpa_sys::SpeechSegment,
    ) -> Result<SpeechSegment, SherpaAdapterError> {
        SpeechSegment::new(
            0,
            0,
            u64::try_from(segment.start).map_err(|_| SherpaAdapterError::InvalidSegment)?,
            segment.samples,
            false,
        )
        .map_err(|_| SherpaAdapterError::InvalidSegment)
    }

    fn native_config(
        model_path: &Path,
        config: &VadConfig,
    ) -> Result<NativeSileroVadConfig, EngineError> {
        Ok(NativeSileroVadConfig::new(model_path)
            .with_threshold(config.threshold())
            .with_min_silence_duration(config.min_silence_duration_ms() as f32 / 1_000.0)
            .with_min_speech_duration(config.min_speech_duration_ms() as f32 / 1_000.0)
            .with_max_speech_duration(config.max_speech_duration_ms() as f32 / 1_000.0)
            .with_window_size(
                i32::try_from(config.window_size_samples())
                    .map_err(|_| EngineError::ResourceLimit)?,
            )
            .with_sample_rate(
                i32::try_from(config.sample_rate_hz()).map_err(|_| EngineError::ResourceLimit)?,
            )
            .with_buffer_size_seconds(config.buffer_duration_ms() as f32 / 1_000.0))
    }

    fn native_error(error: aurora_voice_sherpa_sys::VadError) -> EngineError {
        match error {
            aurora_voice_sherpa_sys::VadError::NativeUnavailable => EngineError::ProviderFault {
                code: EngineFaultCode::HostUnavailable,
            },
            aurora_voice_sherpa_sys::VadError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::VadError::InvalidWaveform { .. } => {
                EngineError::InvalidRequest
            }
            _ => EngineError::ProviderFault {
                code: EngineFaultCode::Native,
            },
        }
    }

    fn native_adapter_error(error: aurora_voice_sherpa_sys::VadError) -> SherpaAdapterError {
        match error {
            aurora_voice_sherpa_sys::VadError::NativeUnavailable => {
                SherpaAdapterError::BackendFault {
                    code: BackendFaultCode::HostUnavailable,
                }
            }
            aurora_voice_sherpa_sys::VadError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::VadError::InvalidWaveform { .. } => {
                SherpaAdapterError::InvalidFrame
            }
            _ => SherpaAdapterError::BackendFault {
                code: BackendFaultCode::NativeFault,
            },
        }
    }

    fn is_queued_segment_undrained(error: &aurora_voice_sherpa_sys::VadError) -> bool {
        matches!(
            error,
            aurora_voice_sherpa_sys::VadError::InvalidWaveform {
                code: NativeErrorCode::WaveformQueuedSegmentUndrained
            }
        )
    }
}

#[cfg(feature = "native-kws")]
mod native_kws_backend {
    use super::*;
    use aurora_voice_sherpa_sys::{
        KeywordSession, KeywordSpotterConfig, VadError as NativeKwsError,
    };
    use std::path::{Path, PathBuf};

    const KWS_ENCODER_FILE_ID: &str = "encoder-int8";
    const KWS_DECODER_FILE_ID: &str = "decoder";
    const KWS_JOINER_FILE_ID: &str = "joiner-int8";
    const KWS_TOKENS_FILE_ID: &str = "tokens";

    pub struct NativeKwsBackend {
        encoder_path: PathBuf,
        decoder_path: PathBuf,
        joiner_path: PathBuf,
        tokens_path: PathBuf,
        session: Option<KeywordSession>,
    }

    pub struct NativeKwsModelFiles {
        pub encoder_file_id: String,
        pub encoder_path: PathBuf,
        pub decoder_file_id: String,
        pub decoder_path: PathBuf,
        pub joiner_file_id: String,
        pub joiner_path: PathBuf,
        pub tokens_file_id: String,
        pub tokens_path: PathBuf,
    }

    impl fmt::Debug for NativeKwsModelFiles {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NativeKwsModelFiles")
                .field("encoder_file_id_bytes", &self.encoder_file_id.len())
                .field("encoder_path", &"<redacted>")
                .field("decoder_file_id_bytes", &self.decoder_file_id.len())
                .field("decoder_path", &"<redacted>")
                .field("joiner_file_id_bytes", &self.joiner_file_id.len())
                .field("joiner_path", &"<redacted>")
                .field("tokens_file_id_bytes", &self.tokens_file_id.len())
                .field("tokens_path", &"<redacted>")
                .finish()
        }
    }

    impl fmt::Debug for NativeKwsBackend {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NativeKwsBackend")
                .field("encoder_path", &"<redacted>")
                .field("decoder_path", &"<redacted>")
                .field("joiner_path", &"<redacted>")
                .field("tokens_path", &"<redacted>")
                .field("session_active", &self.session.is_some())
                .finish()
        }
    }

    impl NativeKwsBackend {
        pub fn from_selected_model(
            binding: &TaskPackBinding,
            files: NativeKwsModelFiles,
        ) -> Result<Self, EngineError> {
            validate_kws_binding(binding)?;
            require_selected_file(binding, &files.encoder_file_id, KWS_ENCODER_FILE_ID)?;
            require_selected_file(binding, &files.decoder_file_id, KWS_DECODER_FILE_ID)?;
            require_selected_file(binding, &files.joiner_file_id, KWS_JOINER_FILE_ID)?;
            require_selected_file(binding, &files.tokens_file_id, KWS_TOKENS_FILE_ID)?;
            Ok(Self {
                encoder_path: files.encoder_path,
                decoder_path: files.decoder_path,
                joiner_path: files.joiner_path,
                tokens_path: files.tokens_path,
                session: None,
            })
        }
    }

    impl SherpaKwsBackend for NativeKwsBackend {
        fn start_session(
            &mut self,
            request: &BoundKwsRequest,
            phrase_set: &SherpaKwsPhraseSet,
        ) -> Result<(), SherpaAdapterError> {
            let config = native_config(self, request, phrase_set)?;
            self.session = Some(KeywordSession::new(&config).map_err(native_kws_adapter_error)?);
            Ok(())
        }

        fn accept_waveform(
            &mut self,
            frame: StreamingAudioFrame<'_>,
        ) -> Result<Vec<SherpaKeywordDetection>, SherpaAdapterError> {
            let session = self
                .session
                .as_mut()
                .ok_or(SherpaAdapterError::InvalidConfig)?;
            let results = session
                .accept_waveform(VAD_SAMPLE_RATE_HZ as i32, frame.samples())
                .map_err(native_kws_adapter_error)?;
            results
                .into_iter()
                .map(|result| SherpaKeywordDetection::new(result.keyword))
                .collect()
        }

        fn reset(&mut self) -> Result<(), SherpaAdapterError> {
            if let Some(session) = &mut self.session {
                session.reset().map_err(native_kws_adapter_error)?;
            }
            Ok(())
        }

        fn cancel(&mut self) -> Result<(), SherpaAdapterError> {
            if let Some(mut session) = self.session.take() {
                session.cancel().map_err(native_kws_adapter_error)?;
            }
            Ok(())
        }
    }

    fn native_config(
        backend: &NativeKwsBackend,
        request: &BoundKwsRequest,
        phrase_set: &SherpaKwsPhraseSet,
    ) -> Result<KeywordSpotterConfig, SherpaAdapterError> {
        phrase_set
            .validate_request(request.config())
            .map_err(|_| SherpaAdapterError::InvalidPhraseMap)?;
        Ok(KeywordSpotterConfig::new(
            &backend.encoder_path,
            &backend.decoder_path,
            &backend.joiner_path,
            &backend.tokens_path,
            phrase_set
                .keyword_buffer_for_request(request.config())
                .map_err(|_| SherpaAdapterError::InvalidPhraseMap)?,
        )
        .with_sample_rate(VAD_SAMPLE_RATE_HZ as i32)
        .with_keywords_threshold(request.config().threshold()))
    }

    fn require_selected_file(
        binding: &TaskPackBinding,
        actual_file_id: &str,
        required_file_id: &str,
    ) -> Result<(), EngineError> {
        if actual_file_id != required_file_id
            || !binding
                .selected_file_ids()
                .iter()
                .any(|file_id| file_id == required_file_id)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn native_kws_adapter_error(error: NativeKwsError) -> SherpaAdapterError {
        match error {
            aurora_voice_sherpa_sys::VadError::NativeUnavailable => {
                SherpaAdapterError::BackendFault {
                    code: BackendFaultCode::HostUnavailable,
                }
            }
            aurora_voice_sherpa_sys::VadError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::VadError::InvalidWaveform { .. } => {
                SherpaAdapterError::InvalidFrame
            }
            _ => SherpaAdapterError::BackendFault {
                code: BackendFaultCode::NativeFault,
            },
        }
    }

    #[allow(dead_code)]
    fn _redacted_path(_path: &Path) -> &'static str {
        "<redacted>"
    }
}

#[cfg(feature = "native-stt")]
mod native_stt_backend {
    use super::*;
    use aurora_voice_sherpa_sys::{
        OfflineSttConfig, OfflineSttModelKind, OfflineSttRecognizer, SttError as NativeSttError,
    };
    use std::path::PathBuf;

    const STT_ENCODER_FILE_ID: &str = "encoder";
    const STT_WHISPER_DECODER_FILE_ID: &str = "decoder";
    const STT_MOONSHINE_DECODER_FILE_ID: &str = "decoder-merged";
    const STT_TOKENS_FILE_ID: &str = "tokens";

    pub struct NativeSttModelFiles {
        pub encoder_file_id: String,
        pub encoder_path: PathBuf,
        pub decoder_file_id: String,
        pub decoder_path: PathBuf,
        pub tokens_file_id: String,
        pub tokens_path: PathBuf,
        pub language: Option<String>,
    }

    impl fmt::Debug for NativeSttModelFiles {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NativeSttModelFiles")
                .field("encoder_file_id_bytes", &self.encoder_file_id.len())
                .field("encoder_path", &"<redacted>")
                .field("decoder_file_id_bytes", &self.decoder_file_id.len())
                .field("decoder_path", &"<redacted>")
                .field("tokens_file_id_bytes", &self.tokens_file_id.len())
                .field("tokens_path", &"<redacted>")
                .field("language", &"<redacted>")
                .finish()
        }
    }

    pub struct NativeSttBackend {
        recognizer: OfflineSttRecognizer,
        config: NativeSttRecognizerConfig,
        active_language: Option<String>,
    }

    #[derive(Clone)]
    struct NativeSttRecognizerConfig {
        model_kind: OfflineSttModelKind,
        encoder_path: PathBuf,
        decoder_path: PathBuf,
        tokens_path: PathBuf,
        default_language: Option<String>,
    }

    impl fmt::Debug for NativeSttBackend {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NativeSttBackend")
                .field("recognizer", &"<redacted>")
                .finish()
        }
    }

    impl NativeSttBackend {
        pub fn from_selected_model(
            binding: &TaskPackBinding,
            encoder_file_id: &str,
            encoder_path: impl Into<PathBuf>,
            decoder_file_id: &str,
            decoder_path: impl Into<PathBuf>,
            tokens_file_id: &str,
            tokens_path: impl Into<PathBuf>,
        ) -> Result<Self, EngineError> {
            Self::from_selected_model_files(
                binding,
                NativeSttModelFiles {
                    encoder_file_id: encoder_file_id.to_owned(),
                    encoder_path: encoder_path.into(),
                    decoder_file_id: decoder_file_id.to_owned(),
                    decoder_path: decoder_path.into(),
                    tokens_file_id: tokens_file_id.to_owned(),
                    tokens_path: tokens_path.into(),
                    language: None,
                },
            )
        }

        pub fn from_selected_model_files(
            binding: &TaskPackBinding,
            files: NativeSttModelFiles,
        ) -> Result<Self, EngineError> {
            validate_stt_binding(binding)?;
            require_selected_file(binding, &files.encoder_file_id, STT_ENCODER_FILE_ID)?;
            require_selected_file(binding, &files.tokens_file_id, STT_TOKENS_FILE_ID)?;
            let model_kind = selected_stt_model_kind(binding, &files.decoder_file_id)?;
            let config = NativeSttRecognizerConfig {
                model_kind,
                encoder_path: files.encoder_path,
                decoder_path: files.decoder_path,
                tokens_path: files.tokens_path,
                default_language: files.language,
            };
            let active_language = config.language_for_request(None);
            let recognizer =
                build_recognizer(&config, active_language.as_deref()).map_err(native_stt_error)?;
            Ok(Self {
                recognizer,
                config,
                active_language,
            })
        }
    }

    impl SherpaSttBackend for NativeSttBackend {
        fn transcribe(
            &mut self,
            sample_rate_hz: u32,
            pcm: &[f32],
            language: Option<&str>,
        ) -> Result<String, SherpaAdapterError> {
            self.ensure_language(language)
                .map_err(native_stt_adapter_error)?;
            let sample_rate =
                i32::try_from(sample_rate_hz).map_err(|_| SherpaAdapterError::InvalidConfig)?;
            let result = self
                .recognizer
                .transcribe(sample_rate, pcm)
                .map_err(native_stt_adapter_error)?;
            Ok(result.text().to_owned())
        }
    }

    impl NativeSttBackend {
        fn ensure_language(&mut self, language: Option<&str>) -> Result<(), NativeSttError> {
            let next_language = self.config.language_for_request(language);
            if self.config.model_kind != OfflineSttModelKind::Whisper
                || self.active_language == next_language
            {
                return Ok(());
            }
            self.recognizer = build_recognizer(&self.config, next_language.as_deref())?;
            self.active_language = next_language;
            Ok(())
        }
    }

    impl NativeSttRecognizerConfig {
        fn language_for_request(&self, language: Option<&str>) -> Option<String> {
            if self.model_kind != OfflineSttModelKind::Whisper {
                return None;
            }
            language
                .map(ToOwned::to_owned)
                .or_else(|| self.default_language.clone())
                .filter(|value| !value.is_empty())
        }
    }

    fn build_recognizer(
        config: &NativeSttRecognizerConfig,
        language: Option<&str>,
    ) -> Result<OfflineSttRecognizer, NativeSttError> {
        let config = match config.model_kind {
            OfflineSttModelKind::Moonshine => OfflineSttConfig::moonshine_v2(
                &config.encoder_path,
                &config.decoder_path,
                &config.tokens_path,
            ),
            OfflineSttModelKind::Whisper => {
                let mut stt_config = OfflineSttConfig::whisper(
                    &config.encoder_path,
                    &config.decoder_path,
                    &config.tokens_path,
                );
                if let Some(language) = language {
                    stt_config = stt_config.with_language(language);
                }
                stt_config
            }
        }
        .with_sample_rate(VAD_SAMPLE_RATE_HZ as i32);
        OfflineSttRecognizer::new(&config)
    }

    fn selected_stt_model_kind(
        binding: &TaskPackBinding,
        actual_decoder_file_id: &str,
    ) -> Result<OfflineSttModelKind, EngineError> {
        let has_moonshine_decoder = binding
            .selected_file_ids()
            .iter()
            .any(|file_id| file_id == STT_MOONSHINE_DECODER_FILE_ID);
        let has_whisper_decoder = binding
            .selected_file_ids()
            .iter()
            .any(|file_id| file_id == STT_WHISPER_DECODER_FILE_ID);
        match (
            has_moonshine_decoder,
            has_whisper_decoder,
            actual_decoder_file_id,
        ) {
            (true, false, STT_MOONSHINE_DECODER_FILE_ID) => Ok(OfflineSttModelKind::Moonshine),
            (false, true, STT_WHISPER_DECODER_FILE_ID) => Ok(OfflineSttModelKind::Whisper),
            _ => Err(EngineError::InvalidRequest),
        }
    }

    fn require_selected_file(
        binding: &TaskPackBinding,
        actual_file_id: &str,
        required_file_id: &str,
    ) -> Result<(), EngineError> {
        if actual_file_id != required_file_id
            || !binding
                .selected_file_ids()
                .iter()
                .any(|file_id| file_id == required_file_id)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn native_stt_error(error: NativeSttError) -> EngineError {
        match error {
            aurora_voice_sherpa_sys::SttError::NativeUnavailable => EngineError::ProviderFault {
                code: EngineFaultCode::HostUnavailable,
            },
            aurora_voice_sherpa_sys::SttError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::SttError::InvalidWaveform { .. }
            | aurora_voice_sherpa_sys::SttError::NativeInvalidResultText
            | aurora_voice_sherpa_sys::SttError::NativeInvalidResultToken
            | aurora_voice_sherpa_sys::SttError::NativeInvalidResultTimestamp
            | aurora_voice_sherpa_sys::SttError::NativeResultTextTooLong
            | aurora_voice_sherpa_sys::SttError::NativeResultTokenCountExceeded
            | aurora_voice_sherpa_sys::SttError::NativeResultTokenTooLong
            | aurora_voice_sherpa_sys::SttError::NativeResultSegmentCountExceeded => {
                EngineError::InvalidRequest
            }
            _ => EngineError::ProviderFault {
                code: EngineFaultCode::Native,
            },
        }
    }

    fn native_stt_adapter_error(error: NativeSttError) -> SherpaAdapterError {
        match error {
            aurora_voice_sherpa_sys::SttError::NativeUnavailable => {
                SherpaAdapterError::BackendFault {
                    code: BackendFaultCode::HostUnavailable,
                }
            }
            aurora_voice_sherpa_sys::SttError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::SttError::InvalidWaveform { .. } => {
                SherpaAdapterError::InvalidFrame
            }
            aurora_voice_sherpa_sys::SttError::NativeInvalidResultText
            | aurora_voice_sherpa_sys::SttError::NativeInvalidResultToken
            | aurora_voice_sherpa_sys::SttError::NativeInvalidResultTimestamp
            | aurora_voice_sherpa_sys::SttError::NativeResultTextTooLong
            | aurora_voice_sherpa_sys::SttError::NativeResultTokenCountExceeded
            | aurora_voice_sherpa_sys::SttError::NativeResultTokenTooLong
            | aurora_voice_sherpa_sys::SttError::NativeResultSegmentCountExceeded => {
                SherpaAdapterError::InvalidTranscript
            }
            _ => SherpaAdapterError::BackendFault {
                code: BackendFaultCode::NativeFault,
            },
        }
    }
}

#[cfg(feature = "native-tts")]
mod native_tts_backend {
    use super::*;
    use aurora_voice_sherpa_sys::{
        OfflineTtsConfig, OfflineTtsGenerationConfig, OfflineTtsSynthesizer,
        TtsError as NativeTtsError,
    };
    use std::path::PathBuf;

    const TTS_MODEL_FILE_ID: &str = "model";
    const TTS_TOKENS_FILE_ID: &str = "tokens";
    const TTS_ESPEAK_DATA_FILE_ID: &str = "espeak-ng-data";
    const TTS_LEXICON_FILE_ID: &str = "lexicon";

    pub struct NativeTtsBackend {
        synthesizer: OfflineTtsSynthesizer,
    }

    impl fmt::Debug for NativeTtsBackend {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NativeTtsBackend")
                .field("synthesizer", &"<redacted>")
                .finish()
        }
    }

    impl NativeTtsBackend {
        pub fn from_selected_vits_piper_model(
            binding: &TaskPackBinding,
            files: NativeTtsVitsPiperModelFiles,
        ) -> Result<Self, EngineError> {
            validate_tts_binding(binding)?;
            require_selected_file(binding, &files.model_file_id, TTS_MODEL_FILE_ID)?;
            require_selected_file(binding, &files.tokens_file_id, TTS_TOKENS_FILE_ID)?;
            require_selected_file(binding, &files.espeak_data_file_id, TTS_ESPEAK_DATA_FILE_ID)?;
            match (&files.lexicon_file_id, &files.lexicon_path) {
                (Some(lexicon_file_id), Some(_)) => {
                    require_selected_file(binding, lexicon_file_id, TTS_LEXICON_FILE_ID)?;
                }
                (None, None) => {}
                _ => return Err(EngineError::InvalidRequest),
            }
            let mut config = OfflineTtsConfig::vits_piper(
                files.model_path,
                files.tokens_path,
                files.espeak_data_dir,
            )
            .with_num_threads(1);
            if let Some(lexicon_path) = files.lexicon_path {
                config = config.with_lexicon_path(lexicon_path);
            }
            let synthesizer = OfflineTtsSynthesizer::new(&config).map_err(native_tts_error)?;
            let sample_rate = u32::try_from(synthesizer.sample_rate())
                .map_err(|_| EngineError::InvalidRequest)?;
            if sample_rate != binding.sample_rate_hz() {
                return Err(EngineError::InvalidRequest);
            }
            Ok(Self { synthesizer })
        }
    }

    pub struct NativeTtsVitsPiperModelFiles {
        pub model_file_id: String,
        pub model_path: PathBuf,
        pub tokens_file_id: String,
        pub tokens_path: PathBuf,
        pub espeak_data_file_id: String,
        pub espeak_data_dir: PathBuf,
        pub lexicon_file_id: Option<String>,
        pub lexicon_path: Option<PathBuf>,
    }

    impl fmt::Debug for NativeTtsVitsPiperModelFiles {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter
                .debug_struct("NativeTtsVitsPiperModelFiles")
                .field("model_file_id_bytes", &self.model_file_id.len())
                .field("model_path", &"<redacted>")
                .field("tokens_file_id_bytes", &self.tokens_file_id.len())
                .field("tokens_path", &"<redacted>")
                .field("espeak_data_file_id_bytes", &self.espeak_data_file_id.len())
                .field("espeak_data_dir", &"<redacted>")
                .field(
                    "lexicon_file_id_bytes",
                    &self.lexicon_file_id.as_ref().map(String::len),
                )
                .field("lexicon_path_present", &self.lexicon_path.is_some())
                .finish()
        }
    }

    impl SherpaTtsBackend for NativeTtsBackend {
        fn synthesize(
            &mut self,
            text: &str,
            speaker_id: i32,
            speed: f32,
            cancellation: &dyn Fn() -> bool,
            cancellation_token: &SherpaTtsCancellationToken,
        ) -> Result<SherpaTtsAudio, SherpaAdapterError> {
            if cancellation() {
                return Err(SherpaAdapterError::Cancelled);
            }
            let config = OfflineTtsGenerationConfig::new(speaker_id, speed);
            let audio = self
                .synthesizer
                .generate_with_cancel_flag(text, &config, cancellation_token.as_atomic())
                .map_err(native_tts_adapter_error)?;
            if cancellation() {
                return Err(SherpaAdapterError::Cancelled);
            }
            let sample_rate =
                u32::try_from(audio.sample_rate()).map_err(|_| SherpaAdapterError::InvalidAudio)?;
            SherpaTtsAudio::new(sample_rate, audio.samples().to_vec())
        }

        fn cancel(&mut self) -> Result<(), SherpaAdapterError> {
            Ok(())
        }
    }

    fn require_selected_file(
        binding: &TaskPackBinding,
        actual_file_id: &str,
        required_file_id: &str,
    ) -> Result<(), EngineError> {
        if actual_file_id != required_file_id
            || !binding
                .selected_file_ids()
                .iter()
                .any(|file_id| file_id == required_file_id)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn native_tts_error(error: NativeTtsError) -> EngineError {
        match error {
            aurora_voice_sherpa_sys::TtsError::NativeUnavailable => EngineError::ProviderFault {
                code: EngineFaultCode::HostUnavailable,
            },
            aurora_voice_sherpa_sys::TtsError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::TtsError::InvalidText { .. }
            | aurora_voice_sherpa_sys::TtsError::NativeInvalidAudio
            | aurora_voice_sherpa_sys::TtsError::NativeAudioTooLong
            | aurora_voice_sherpa_sys::TtsError::NativeInvalidSpeakerCount => {
                EngineError::InvalidRequest
            }
            aurora_voice_sherpa_sys::TtsError::Cancelled => EngineError::Cancelled,
            _ => EngineError::ProviderFault {
                code: EngineFaultCode::Native,
            },
        }
    }

    fn native_tts_adapter_error(error: NativeTtsError) -> SherpaAdapterError {
        match error {
            aurora_voice_sherpa_sys::TtsError::NativeUnavailable => {
                SherpaAdapterError::BackendFault {
                    code: BackendFaultCode::HostUnavailable,
                }
            }
            aurora_voice_sherpa_sys::TtsError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::TtsError::InvalidText { .. } => {
                SherpaAdapterError::InvalidConfig
            }
            aurora_voice_sherpa_sys::TtsError::NativeInvalidAudio
            | aurora_voice_sherpa_sys::TtsError::NativeAudioTooLong
            | aurora_voice_sherpa_sys::TtsError::NativeInvalidSpeakerCount => {
                SherpaAdapterError::InvalidAudio
            }
            aurora_voice_sherpa_sys::TtsError::Cancelled => SherpaAdapterError::Cancelled,
            _ => SherpaAdapterError::BackendFault {
                code: BackendFaultCode::NativeFault,
            },
        }
    }
}

#[cfg(feature = "native-kws")]
pub use native_kws_backend::{NativeKwsBackend, NativeKwsModelFiles};

#[cfg(feature = "native-stt")]
pub use native_stt_backend::{NativeSttBackend, NativeSttModelFiles};

#[cfg(feature = "native-tts")]
pub use native_tts_backend::{NativeTtsBackend, NativeTtsVitsPiperModelFiles};

#[cfg(feature = "native-vad")]
pub use native_backend::NativeVadBackend;

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_engine::KwsStreamProvider;
    use aurora_voice_engine::{
        select_verified_variant, verify_manifest, AbiRequirements, CapabilityFlags, Compatibility,
        CompressionKind, DeviceClass, EngineKind, LanguageSupport, LicenseGrant, LicenseInfo,
        ManifestSignature, ModelPackError, ModelPackFile, ModelPackManifest, PackTask,
        ProcessingMetadata, Provenance, ResourceBudget, RuntimeGates, RuntimeSelection,
        RuntimeTarget, SelectedVariant, ShapeMetadata, SignatureVerifier, TargetArch, TargetOs,
        TaskRequest, TrustPolicy, TtsSynthesisConfig, VerifiedManifest,
    };
    use std::cell::Cell;
    use std::collections::{BTreeSet, VecDeque};
    use std::path::{Path, PathBuf};

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    #[allow(dead_code)]
    const KWS_MODEL: &str = "models/extracted/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
    #[allow(dead_code)]
    const STT_MODEL: &str = "models/extracted/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27";
    #[allow(dead_code)]
    const TTS_MODEL: &str = "models/extracted/vits-piper-en_US-ljspeech-medium";
    #[allow(dead_code)]
    const LIGHT_UP_SPEC: &str = "▁ L IGHT ▁UP";
    #[allow(dead_code)]
    const EXPECTED_STT_TEXT: &str =
        "Ask not what your country can do for you. Ask what you can do for your country.";

    #[derive(Debug, Default)]
    struct FakeBackend {
        calls: Vec<&'static str>,
        detected: bool,
        segments: VecDeque<SpeechSegment>,
        repeat_segment: Option<SpeechSegment>,
        fail_on: Option<&'static str>,
        accepted_samples: usize,
    }

    #[derive(Debug, Default)]
    struct FakeKwsBackend {
        calls: Vec<&'static str>,
        detections: VecDeque<Vec<SherpaKeywordDetection>>,
        fail_on: Option<&'static str>,
    }

    impl FakeKwsBackend {
        fn with_detection(native_label: &str) -> Self {
            let mut detections = VecDeque::new();
            detections.push_back(vec![
                SherpaKeywordDetection::new(native_label).expect("detection")
            ]);
            Self {
                detections,
                ..Self::default()
            }
        }

        fn maybe_fail(&self, operation: &'static str) -> Result<(), SherpaAdapterError> {
            if self.fail_on == Some(operation) {
                Err(SherpaAdapterError::from_host_fault(
                    "native=/secret/kws.onnx keyword=LIGHT ptr=0xfeed",
                ))
            } else {
                Ok(())
            }
        }
    }

    impl SherpaKwsBackend for FakeKwsBackend {
        fn start_session(
            &mut self,
            _request: &BoundKwsRequest,
            phrase_set: &SherpaKwsPhraseSet,
        ) -> Result<(), SherpaAdapterError> {
            self.calls.push("start");
            assert_eq!(phrase_set.keyword_buffer(), "TOKENIZED LIGHT UP");
            self.maybe_fail("start")
        }

        fn accept_waveform(
            &mut self,
            _frame: StreamingAudioFrame<'_>,
        ) -> Result<Vec<SherpaKeywordDetection>, SherpaAdapterError> {
            self.calls.push("accept");
            self.maybe_fail("accept")?;
            Ok(self.detections.pop_front().unwrap_or_default())
        }

        fn reset(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("reset");
            self.maybe_fail("reset")
        }

        fn cancel(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("cancel");
            self.maybe_fail("cancel")
        }
    }

    #[derive(Debug)]
    struct FakeSttBackend {
        calls: Vec<&'static str>,
        last_rate: Option<u32>,
        last_samples: Vec<f32>,
        last_language: Option<String>,
        transcript: String,
        fail: bool,
    }

    impl Default for FakeSttBackend {
        fn default() -> Self {
            Self {
                calls: Vec::new(),
                last_rate: None,
                last_samples: Vec::new(),
                last_language: None,
                transcript: "hello aurora".to_owned(),
                fail: false,
            }
        }
    }

    impl SherpaSttBackend for FakeSttBackend {
        fn transcribe(
            &mut self,
            sample_rate_hz: u32,
            pcm: &[f32],
            language: Option<&str>,
        ) -> Result<String, SherpaAdapterError> {
            self.calls.push("transcribe");
            self.last_rate = Some(sample_rate_hz);
            self.last_samples.extend_from_slice(pcm);
            self.last_language = language.map(ToOwned::to_owned);
            if self.fail {
                Err(SherpaAdapterError::from_host_fault(
                    "path=/secret/moonshine transcript=private",
                ))
            } else {
                Ok(self.transcript.clone())
            }
        }
    }

    #[derive(Debug)]
    struct FakeTtsBackend {
        calls: Vec<&'static str>,
        last_text_bytes: Option<usize>,
        last_speaker_id: Option<i32>,
        last_speed: Option<f32>,
        audio: SherpaTtsAudio,
        fail: bool,
    }

    impl Default for FakeTtsBackend {
        fn default() -> Self {
            let mut samples = vec![0.0, 1.0, -1.0, 0.5];
            samples.resize(64, 0.0);
            samples.push(0.25);
            Self {
                calls: Vec::new(),
                last_text_bytes: None,
                last_speaker_id: None,
                last_speed: None,
                audio: SherpaTtsAudio::new(VAD_SAMPLE_RATE_HZ, samples).expect("audio"),
                fail: false,
            }
        }
    }

    impl SherpaTtsBackend for FakeTtsBackend {
        fn synthesize(
            &mut self,
            text: &str,
            speaker_id: i32,
            speed: f32,
            cancellation: &dyn Fn() -> bool,
            _cancellation_token: &SherpaTtsCancellationToken,
        ) -> Result<SherpaTtsAudio, SherpaAdapterError> {
            self.calls.push("synthesize");
            self.last_text_bytes = Some(text.len());
            self.last_speaker_id = Some(speaker_id);
            self.last_speed = Some(speed);
            if cancellation() {
                return Err(SherpaAdapterError::Cancelled);
            }
            if self.fail {
                Err(SherpaAdapterError::from_host_fault(
                    "path=/secret/vits.onnx text=private ptr=0xfeed",
                ))
            } else {
                Ok(self.audio.clone())
            }
        }

        fn cancel(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("cancel");
            Ok(())
        }
    }

    #[derive(Debug)]
    struct BlockingTtsBackend {
        started: std::sync::mpsc::Sender<()>,
    }

    impl SherpaTtsBackend for BlockingTtsBackend {
        fn synthesize(
            &mut self,
            _text: &str,
            _speaker_id: i32,
            _speed: f32,
            cancellation: &dyn Fn() -> bool,
            _cancellation_token: &SherpaTtsCancellationToken,
        ) -> Result<SherpaTtsAudio, SherpaAdapterError> {
            self.started.send(()).expect("started signal");
            while !cancellation() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(SherpaAdapterError::Cancelled)
        }

        fn cancel(&mut self) -> Result<(), SherpaAdapterError> {
            Ok(())
        }
    }

    impl FakeBackend {
        fn with_segment(segment: SpeechSegment) -> Self {
            let mut segments = VecDeque::new();
            segments.push_back(segment);
            Self {
                segments,
                ..Self::default()
            }
        }

        fn maybe_fail(&self, operation: &'static str) -> Result<(), SherpaAdapterError> {
            if self.fail_on == Some(operation) {
                Err(SherpaAdapterError::from_host_fault(
                    "native=/secret/model.onnx provider=private ptr=0xfeed",
                ))
            } else {
                Ok(())
            }
        }
    }

    impl SherpaVadBackend for FakeBackend {
        fn accept_waveform(
            &mut self,
            frame: StreamingAudioFrame<'_>,
        ) -> Result<(), SherpaAdapterError> {
            self.calls.push("accept");
            self.accepted_samples += frame.samples().len();
            self.maybe_fail("accept")
        }

        fn is_speech_detected(&mut self) -> Result<bool, SherpaAdapterError> {
            self.calls.push("detected");
            self.maybe_fail("detected")?;
            Ok(self.detected)
        }

        fn pop_completed_segment(&mut self) -> Result<Option<SpeechSegment>, SherpaAdapterError> {
            self.calls.push("pop");
            self.maybe_fail("pop")?;
            Ok(self
                .segments
                .pop_front()
                .or_else(|| self.repeat_segment.clone()))
        }

        fn flush(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("flush");
            self.maybe_fail("flush")
        }

        fn clear_queued_segments(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("clear");
            self.segments.clear();
            self.repeat_segment = None;
            self.maybe_fail("clear")
        }

        fn reset(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("reset");
            self.segments.clear();
            self.repeat_segment = None;
            self.detected = false;
            self.maybe_fail("reset")
        }
    }

    struct AcceptingVerifier;

    impl SignatureVerifier for AcceptingVerifier {
        fn verify(
            &self,
            _canonical_json: &str,
            signature: &ManifestSignature,
        ) -> Result<bool, ModelPackError> {
            Ok(signature.value == "signed")
        }
    }

    fn provider(backend: FakeBackend) -> SherpaVadProvider<FakeBackend> {
        SherpaVadProvider::new(binding(), backend).expect("valid provider")
    }

    fn kws_provider(backend: FakeKwsBackend) -> SherpaKwsProvider<FakeKwsBackend> {
        SherpaKwsProvider::new(kws_binding(), phrase_set(), backend).expect("valid kws provider")
    }

    fn stt_engine(backend: FakeSttBackend) -> SherpaFiniteSttEngine<FakeSttBackend> {
        SherpaFiniteSttEngine::new(stt_binding(), backend).expect("valid stt engine")
    }

    fn tts_provider<B>(backend: B) -> SherpaTtsProvider<B>
    where
        B: SherpaTtsBackend,
    {
        SherpaTtsProvider::new(tts_binding(), backend).expect("valid tts provider")
    }

    fn binding() -> TaskPackBinding {
        let (manifest, selection) = selected();
        TaskPackBinding::from_selection(VoiceTask::VoiceActivityDetection, &manifest, &selection)
            .expect("binding")
    }

    fn kws_binding() -> TaskPackBinding {
        let (manifest, selection) = selected_for("kws-pack", PackTask::Kws);
        TaskPackBinding::from_selection(VoiceTask::KeywordSpotting, &manifest, &selection)
            .expect("kws binding")
    }

    fn stt_binding() -> TaskPackBinding {
        let (manifest, selection) = selected_for("stt-pack", PackTask::Stt);
        TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
            .expect("stt binding")
    }

    fn tts_binding() -> TaskPackBinding {
        let (manifest, selection) = selected_for("tts-pack", PackTask::Tts);
        TaskPackBinding::from_selection(VoiceTask::TextToSpeech, &manifest, &selection)
            .expect("tts binding")
    }

    fn request(binding: TaskPackBinding, generation: u64) -> BoundTaskRequest {
        BoundTaskRequest::new(
            TaskRequest {
                task: VoiceTask::VoiceActivityDetection,
                language: None,
                generation,
            },
            binding,
        )
        .expect("bound request")
    }

    fn task_request(
        binding: TaskPackBinding,
        task: VoiceTask,
        generation: u64,
    ) -> BoundTaskRequest {
        task_request_with_language(binding, task, generation, None)
    }

    fn task_request_with_language(
        binding: TaskPackBinding,
        task: VoiceTask,
        generation: u64,
        language: Option<&str>,
    ) -> BoundTaskRequest {
        BoundTaskRequest::new(
            TaskRequest {
                task,
                language: language.map(ToOwned::to_owned),
                generation,
            },
            binding,
        )
        .expect("bound request")
    }

    fn vad_request(binding: TaskPackBinding, generation: u64) -> BoundVadRequest {
        BoundVadRequest::new(request(binding, generation), VadConfig::default()).expect("bound vad")
    }

    fn start(provider: &mut SherpaVadProvider<FakeBackend>, generation: u64) -> BoundStreamSession {
        futures_lite(
            vad_request(provider.binding().clone(), generation),
            |request| provider.start_vad_session(request),
        )
        .expect("session starts")
    }

    fn kws_request(binding: TaskPackBinding, generation: u64) -> BoundKwsRequest {
        BoundKwsRequest::new(
            task_request(binding, VoiceTask::KeywordSpotting, generation),
            KwsConfig::new(["wake.main"], "rev-a", 0.7, 2, 1).expect("kws config"),
        )
        .expect("bound kws")
    }

    fn start_kws(
        provider: &mut SherpaKwsProvider<FakeKwsBackend>,
        generation: u64,
    ) -> BoundStreamSession {
        futures_lite(
            kws_request(provider.binding().clone(), generation),
            |request| provider.start_kws_session(request),
        )
        .expect("kws starts")
    }

    fn finite_stt(
        binding: TaskPackBinding,
        generation: u64,
        frames: Vec<Vec<f32>>,
    ) -> (BoundFiniteSttRequest, FiniteSttAudio) {
        FiniteSttAudio::from_frames(
            task_request(binding, VoiceTask::SpeechToText, generation),
            frames,
        )
        .expect("finite stt audio")
    }

    fn tts_request(
        binding: TaskPackBinding,
        generation: u64,
        chunk_samples: usize,
    ) -> BoundTtsSynthesisRequest {
        let config = TtsSynthesisConfig::new(
            "default",
            binding.voice_state_compatibility_group_id(),
            binding.sample_rate_hz(),
            chunk_samples,
            None,
        )
        .expect("tts config");
        BoundTtsSynthesisRequest::new(
            task_request(binding, VoiceTask::TextToSpeech, generation),
            "hello aurora",
            config,
        )
        .expect("tts request")
    }

    fn finite_stt_with_language(
        binding: TaskPackBinding,
        generation: u64,
        language: Option<&str>,
        frames: Vec<Vec<f32>>,
    ) -> (BoundFiniteSttRequest, FiniteSttAudio) {
        FiniteSttAudio::from_frames(
            task_request_with_language(binding, VoiceTask::SpeechToText, generation, language),
            frames,
        )
        .expect("finite stt audio")
    }

    fn frame(samples: &[f32]) -> StreamingAudioFrame<'_> {
        StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, samples, false)
            .expect("valid frame")
    }

    fn tail(samples: &[f32]) -> StreamingAudioFrame<'_> {
        StreamingAudioFrame::end_tail(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, samples, false)
            .expect("valid tail")
    }

    fn discontinuity_frame(samples: &[f32]) -> StreamingAudioFrame<'_> {
        StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, samples, true)
            .expect("valid frame")
    }

    fn window_samples() -> Vec<f32> {
        vec![0.0; VAD_WINDOW_SIZE_SAMPLES]
    }

    fn phrase_set() -> SherpaKwsPhraseSet {
        SherpaKwsPhraseSet::new(
            "rev-a",
            [
                SherpaKwsPhrase::new("wake.main", "LIGHT UP", "TOKENIZED LIGHT UP")
                    .expect("phrase"),
            ],
        )
        .expect("phrase set")
    }

    fn segment(samples: Vec<f32>) -> SpeechSegment {
        SpeechSegment::new(0, 0, 0, samples, false).expect("valid segment")
    }

    #[test]
    fn advertises_only_bound_vad_capability() {
        let provider = provider(FakeBackend::default());
        let capabilities = provider.capabilities();
        assert_eq!(capabilities.len(), 1);
        assert_eq!(capabilities[0].task(), VoiceTask::VoiceActivityDetection);
        assert_eq!(capabilities[0].binding(), provider.binding());
        assert!(capabilities[0].streaming_enabled());
    }

    #[test]
    fn rejects_binding_mismatch_for_warm_unload_and_start() {
        let mut provider = provider(FakeBackend::default());
        let wrong = wrong_binding();
        let wrong_request = request(wrong.clone(), 1);
        assert_eq!(
            futures_lite(wrong_request, |request| provider.warm_task(request)),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            futures_lite(wrong.clone(), |binding| provider.unload_task(binding)),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            futures_lite(vad_request(wrong, 1), |request| {
                provider.start_vad_session(request)
            }),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn start_prevents_stale_session_ids_generation_and_concurrent_sessions() {
        let mut provider = provider(FakeBackend::default());
        let session = start(&mut provider, 42);
        assert_eq!(
            futures_lite(vad_request(provider.binding().clone(), 43), |request| {
                provider.start_vad_session(request)
            }),
            Err(EngineError::ResourceLimit)
        );
        let wrong_id = BoundStreamSession::new(
            StreamSessionId(session.session_id().0 + 99),
            &request(provider.binding().clone(), 42),
        )
        .expect("wrong id handle");
        assert_eq!(
            futures_lite((), |_| provider.flush_vad_session(&wrong_id, &|| false)),
            Err(EngineError::InvalidRequest)
        );
        let stale_generation = BoundStreamSession::new(
            session.session_id(),
            &request(provider.binding().clone(), 43),
        )
        .expect("stale generation handle");
        assert_eq!(
            futures_lite((), |_| provider
                .flush_vad_session(&stale_generation, &|| false)),
            Err(EngineError::InvalidRequest)
        );
        futures_lite((), |_| provider.cancel_generation(42)).expect("cancel");
        assert!(provider.active_session().is_none());
    }

    #[test]
    fn accepts_detects_and_drains_in_deterministic_order() {
        let mut backend = FakeBackend::with_segment(segment(vec![0.1, 0.2]));
        backend.detected = true;
        let mut provider = provider(backend);
        let session = start(&mut provider, 1);
        let samples = window_samples();

        let result = futures_lite((), |_| {
            provider.push_vad_frame(&session, frame(&samples), &|| false)
        })
        .expect("push succeeds");
        assert!(result.detected());
        assert_eq!(result.segments().len(), 1);
        assert_eq!(result.segments()[0].samples(), &[0.1, 0.2]);

        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["accept", "detected", "pop", "pop"]);
        assert_eq!(backend.accepted_samples, VAD_WINDOW_SIZE_SAMPLES);
    }

    #[test]
    fn rejects_non_window_normal_accept_and_preserves_short_tail() {
        let mut provider = provider(FakeBackend::default());
        let session = start(&mut provider, 1);
        assert_eq!(
            futures_lite((), |_| provider.push_vad_frame(
                &session,
                tail(&[0.0]),
                &|| false
            ))
            .expect("tail accepted")
            .segments()
            .len(),
            0
        );
        let short = StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &[0.0], false)
            .expect("generic frame");
        assert_eq!(
            futures_lite((), |_| provider.push_vad_frame(&session, short, &|| false)),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn discontinuity_resets_before_accepting_frame() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        let samples = window_samples();
        let result = futures_lite((), |_| {
            provider.push_vad_frame(&session, discontinuity_frame(&samples), &|| false)
        })
        .expect("push succeeds");
        assert_eq!(result.reset(), Some(StreamResetReason::Discontinuity));
        assert!(result.segments().is_empty());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["reset", "accept", "detected", "pop"]);
    }

    #[test]
    fn cancellation_after_feed_resets_before_detect_or_drain() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        let samples = window_samples();
        let checks = Cell::new(0);
        let cancel_after_feed = || {
            let check = checks.get();
            checks.set(check + 1);
            check == 1
        };
        let result = futures_lite((), |_| {
            provider.push_vad_frame(&session, frame(&samples), &cancel_after_feed)
        });
        assert_eq!(result, Err(EngineError::Cancelled));
        assert!(provider.active_session().is_none());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["accept", "reset"]);
    }

    #[test]
    fn flush_runs_before_completed_segment_drain_and_marks_segments() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        let segments = futures_lite((), |_| provider.flush_vad_session(&session, &|| false))
            .expect("flush succeeds");
        assert_eq!(segments.len(), 1);
        assert!(segments[0].flushed());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["flush", "pop", "pop"]);
    }

    #[test]
    fn clear_queued_segments_is_distinct_from_reset() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        provider
            .clear_queued_segments(&session)
            .expect("clear queued segments");
        let segments = futures_lite((), |_| provider.flush_vad_session(&session, &|| false))
            .expect("flush succeeds");
        assert!(segments.is_empty());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["clear", "flush", "pop"]);
    }

    #[test]
    fn bounded_drain_rejects_faulty_host_and_clears_queue() {
        let backend = FakeBackend {
            repeat_segment: Some(segment(vec![0.0])),
            ..FakeBackend::default()
        };
        let mut provider = provider(backend);
        let session = start(&mut provider, 1);
        assert_eq!(
            futures_lite((), |_| provider.flush_vad_session(&session, &|| false)),
            Err(EngineError::ResourceLimit)
        );
        let backend = provider.into_backend();
        assert_eq!(backend.calls.last(), Some(&"clear"));
    }

    #[test]
    fn rejects_invalid_completed_segments_before_exposing_them() {
        let invalid = SpeechSegment::new(0, 0, 0, vec![1.2], false).expect_err("invalid");
        assert_eq!(invalid, EngineError::InvalidRequest);
        let mut provider = provider(FakeBackend::with_segment(
            SpeechSegment::new(0, 0, 0, vec![0.0; 200_000], false).expect("valid shape"),
        ));
        let session = start(&mut provider, 1);
        assert_eq!(
            futures_lite((), |_| provider.flush_vad_session(&session, &|| false)),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn host_faults_are_redacted_in_error_and_report() {
        let backend = FakeBackend {
            fail_on: Some("accept"),
            ..FakeBackend::default()
        };
        let mut provider = provider(backend);
        let session = start(&mut provider, 1);
        let samples = window_samples();
        let error = futures_lite((), |_| {
            provider.push_vad_frame(&session, frame(&samples), &|| false)
        })
        .expect_err("backend fault");
        let rendered = format!("{error:?} {error}");
        assert!(rendered.contains("provider"));
        assert!(!rendered.contains("/secret"));
        assert!(!rendered.contains("ptr="));
        assert_eq!(
            provider.last_backend_fault(),
            Some(BackendFaultCode::BackendFault)
        );
    }

    #[test]
    fn phrase_set_separates_native_spec_from_result_label_and_redacts_debug() {
        let phrases = phrase_set();
        assert_eq!(phrases.keyword_buffer(), "TOKENIZED LIGHT UP");
        assert_eq!(
            phrases.keyword_spec_for("wake.main"),
            Some("TOKENIZED LIGHT UP")
        );
        assert_eq!(phrases.logical_id_for_native("LIGHT UP"), Some("wake.main"));
        assert_eq!(
            phrases
                .keyword_buffer_for_request(
                    &KwsConfig::new(["wake.main"], "rev-a", 0.7, 2, 1).expect("config")
                )
                .expect("request buffer"),
            "TOKENIZED LIGHT UP"
        );
        let rendered = format!(
            "{phrases:?} {:?}",
            SherpaKeywordDetection::new("LIGHT UP").expect("detection")
        );
        assert!(rendered.contains("phrase_count"));
        assert!(rendered.contains("native_label_bytes"));
        assert!(!rendered.contains("LIGHT UP"));
        assert!(!rendered.contains("TOKENIZED"));
        assert!(SherpaKwsPhrase::new("wake.bad", "LIGHT\nUP", "TOKEN").is_err());
        assert!(SherpaKwsPhrase::new("wake.bad", "LIGHT UP", "TOKEN\nLINE").is_err());
        assert!(SherpaKwsPhraseSet::new(
            "rev-a",
            [
                SherpaKwsPhrase::new("wake.a", "LIGHT UP", "TOKEN").expect("phrase"),
                SherpaKwsPhrase::new("wake.b", "WAKE UP", "TOKEN").expect("phrase"),
            ],
        )
        .is_err());
    }

    #[test]
    fn phrase_set_builds_native_buffer_from_requested_subset_order() {
        let phrases = SherpaKwsPhraseSet::new(
            "rev-a",
            [
                SherpaKwsPhrase::new("wake.a", "ALPHA", "SPEC-A").expect("phrase"),
                SherpaKwsPhrase::new("wake.b", "BETA", "SPEC-B").expect("phrase"),
            ],
        )
        .expect("phrase set");
        let request_config =
            KwsConfig::new(["wake.b", "wake.a"], "rev-a", 0.7, 2, 2).expect("config");
        assert_eq!(
            phrases
                .keyword_buffer_for_request(&request_config)
                .expect("buffer"),
            "SPEC-B\nSPEC-A"
        );
    }

    #[test]
    fn kws_detects_logical_phrase_and_suppresses_cooldown_before_result_validation() {
        let mut backend = FakeKwsBackend::default();
        backend.detections.push_back(vec![
            SherpaKeywordDetection::new("LIGHT UP").expect("detection")
        ]);
        backend.detections.push_back(vec![
            SherpaKeywordDetection::new("LIGHT UP").expect("detection")
        ]);
        backend.detections.push_back(vec![
            SherpaKeywordDetection::new("LIGHT UP").expect("detection")
        ]);
        backend.detections.push_back(vec![
            SherpaKeywordDetection::new("LIGHT UP").expect("detection")
        ]);
        let mut provider = kws_provider(backend);
        let session = start_kws(&mut provider, 7);
        let samples = window_samples();

        let first = futures_lite((), |_| {
            provider.push_kws_frame(&session, frame(&samples), &|| false)
        })
        .expect("first result");
        assert_eq!(first.matches().len(), 1);
        assert_eq!(first.matches()[0].keyword_id(), "wake.main");
        assert_eq!(first.matches()[0].score(), 0.7);

        let suppressed = futures_lite((), |_| {
            provider.push_kws_frame(&session, frame(&samples), &|| false)
        })
        .expect("suppressed result");
        assert!(suppressed.matches().is_empty());

        let still_suppressed = futures_lite((), |_| {
            provider.push_kws_frame(&session, frame(&samples), &|| false)
        })
        .expect("still suppressed at cooldown boundary");
        assert!(still_suppressed.matches().is_empty());

        let allowed = futures_lite((), |_| {
            provider.push_kws_frame(&session, frame(&samples), &|| false)
        })
        .expect("allowed after cooldown");
        assert_eq!(allowed.matches().len(), 1);

        let backend = provider.into_backend();
        assert_eq!(
            backend.calls,
            vec!["start", "accept", "accept", "accept", "accept"]
        );
    }

    #[test]
    fn kws_fails_closed_on_unknown_native_label_and_clears_active() {
        let mut provider = kws_provider(FakeKwsBackend::with_detection("UNKNOWN WAKE"));
        let session = start_kws(&mut provider, 7);
        let samples = window_samples();
        assert_eq!(
            futures_lite((), |_| provider.push_kws_frame(
                &session,
                frame(&samples),
                &|| false
            )),
            Err(EngineError::InvalidRequest)
        );
        assert!(provider.active_session().is_none());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["start", "accept", "cancel"]);
    }

    #[test]
    fn kws_rejects_wrong_binding_concurrent_session_and_cancellation() {
        let mut provider = kws_provider(FakeKwsBackend::default());
        let wrong = binding();
        assert_eq!(
            futures_lite(
                task_request(wrong.clone(), VoiceTask::VoiceActivityDetection, 1),
                |request| provider.warm_task(request)
            ),
            Err(EngineError::InvalidRequest)
        );
        let session = start_kws(&mut provider, 10);
        let samples = window_samples();
        assert_eq!(
            futures_lite(kws_request(provider.binding().clone(), 11), |request| {
                provider.start_kws_session(request)
            }),
            Err(EngineError::ResourceLimit)
        );
        assert_eq!(
            futures_lite((), |_| provider.push_kws_frame(
                &session,
                frame(&samples),
                &|| true
            )),
            Err(EngineError::Cancelled)
        );
        assert!(provider.active_session().is_none());
    }

    #[test]
    fn kws_rejects_forged_session_and_stale_generation() {
        let mut provider = kws_provider(FakeKwsBackend::default());
        let session = start_kws(&mut provider, 42);
        let samples = window_samples();
        let wrong_id = BoundStreamSession::new(
            StreamSessionId(session.session_id().0 + 99),
            &task_request(provider.binding().clone(), VoiceTask::KeywordSpotting, 42),
        )
        .expect("wrong id");
        assert_eq!(
            futures_lite((), |_| provider.push_kws_frame(
                &wrong_id,
                frame(&samples),
                &|| false
            )),
            Err(EngineError::InvalidRequest)
        );
        let stale_generation = BoundStreamSession::new(
            session.session_id(),
            &task_request(provider.binding().clone(), VoiceTask::KeywordSpotting, 43),
        )
        .expect("stale generation");
        assert_eq!(
            futures_lite((), |_| provider
                .reset_kws_session(&stale_generation, StreamResetReason::Manual)),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn kws_discontinuity_resets_backend_and_cooldown_before_accept() {
        let mut backend = FakeKwsBackend::default();
        backend.detections.push_back(vec![
            SherpaKeywordDetection::new("LIGHT UP").expect("detection")
        ]);
        backend.detections.push_back(vec![
            SherpaKeywordDetection::new("LIGHT UP").expect("detection")
        ]);
        let mut provider = kws_provider(backend);
        let session = start_kws(&mut provider, 12);
        let samples = window_samples();
        let first = futures_lite((), |_| {
            provider.push_kws_frame(&session, frame(&samples), &|| false)
        })
        .expect("first");
        assert_eq!(first.matches().len(), 1);
        let reset = futures_lite((), |_| {
            provider.push_kws_frame(&session, discontinuity_frame(&samples), &|| false)
        })
        .expect("reset frame");
        assert_eq!(reset.reset(), Some(StreamResetReason::Discontinuity));
        assert_eq!(reset.matches().len(), 1);
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["start", "accept", "reset", "accept"]);
    }

    #[test]
    fn finite_stt_advertises_only_stt_and_delivers_exact_pcm() {
        let mut engine = stt_engine(FakeSttBackend::default());
        let capabilities = engine.capabilities();
        assert_eq!(capabilities.len(), 1);
        assert_eq!(capabilities[0].task(), VoiceTask::SpeechToText);
        assert!(!capabilities[0].streaming_enabled());

        let (request, audio) =
            finite_stt(engine.binding().clone(), 5, vec![vec![0.25], vec![-0.5]]);
        let result = futures_lite((), |_| engine.transcribe_finite(request, audio, &|| false))
            .expect("transcript");
        assert_eq!(result.transcript(), "hello aurora");
        assert_eq!(result.frames(), 2);
        let backend = engine.into_backend();
        assert_eq!(backend.calls, vec!["transcribe"]);
        assert_eq!(backend.last_rate, Some(VAD_SAMPLE_RATE_HZ));
        assert_eq!(backend.last_samples, vec![0.25, -0.5]);
    }

    #[test]
    fn finite_stt_passes_requested_language_to_backend() {
        let mut engine = stt_engine(FakeSttBackend::default());
        let (request, audio) =
            finite_stt_with_language(engine.binding().clone(), 6, Some("en"), vec![vec![0.25]]);
        futures_lite((), |_| engine.transcribe_finite(request, audio, &|| false))
            .expect("stt result");
        assert_eq!(engine.into_backend().last_language.as_deref(), Some("en"));
    }

    #[test]
    fn finite_stt_cancellation_and_duration_bound_happen_before_backend() {
        let mut engine = stt_engine(FakeSttBackend::default());
        let (request, audio) = finite_stt(engine.binding().clone(), 5, vec![vec![0.25]]);
        assert_eq!(
            futures_lite((), |_| engine.transcribe_finite(request, audio, &|| true)),
            Err(EngineError::Cancelled)
        );
        assert!(engine.into_backend().calls.is_empty());

        let mut engine = stt_engine(FakeSttBackend::default());
        let thirty_seconds = vec![0.0; VAD_SAMPLE_RATE_HZ as usize * 30];
        let (request, audio) = finite_stt(
            engine.binding().clone(),
            6,
            vec![thirty_seconds.clone(), thirty_seconds.clone()],
        );
        futures_lite((), |_| engine.transcribe_finite(request, audio, &|| false))
            .expect("exactly 60 seconds accepted");

        let mut engine = stt_engine(FakeSttBackend::default());
        let (request, audio) = finite_stt(
            engine.binding().clone(),
            7,
            vec![thirty_seconds.clone(), thirty_seconds, vec![0.0]],
        );
        assert_eq!(
            futures_lite((), |_| engine.transcribe_finite(request, audio, &|| false)),
            Err(EngineError::ResourceLimit)
        );
        assert!(engine.into_backend().calls.is_empty());
    }

    #[test]
    fn finite_stt_cancellation_after_decode_drops_result() {
        let mut engine = stt_engine(FakeSttBackend::default());
        let (request, audio) = finite_stt(engine.binding().clone(), 5, vec![vec![0.25]]);
        let checks = Cell::new(0);
        let cancel_after_decode = || {
            let current = checks.get();
            checks.set(current + 1);
            current == 1
        };
        assert_eq!(
            futures_lite((), |_| engine.transcribe_finite(
                request,
                audio,
                &cancel_after_decode
            )),
            Err(EngineError::Cancelled)
        );
        let backend = engine.into_backend();
        assert_eq!(backend.calls, vec!["transcribe"]);
    }

    #[test]
    fn finite_stt_exposes_only_stt_and_faults_are_redacted() {
        let mut engine = stt_engine(FakeSttBackend {
            fail: true,
            ..FakeSttBackend::default()
        });
        let (request, audio) = finite_stt(engine.binding().clone(), 5, vec![vec![0.25]]);
        let error = futures_lite((), |_| engine.transcribe_finite(request, audio, &|| false))
            .expect_err("provider fault");
        let rendered = format!("{error:?} {error} {engine:?}");
        assert!(rendered.contains("provider"));
        assert!(!rendered.contains("/secret"));
        assert!(!rendered.contains("private"));
        assert!(!engine
            .capabilities()
            .iter()
            .any(|capability| capability.task() == VoiceTask::TextToSpeech));
    }

    #[test]
    fn tts_advertises_local_binding_readiness_and_chunks_pcm16() {
        let mut provider = tts_provider(FakeTtsBackend::default());
        let capabilities = provider.capabilities();
        assert_eq!(capabilities.len(), 1);
        assert_eq!(capabilities[0].task(), VoiceTask::TextToSpeech);
        assert!(!capabilities[0].streaming_enabled());
        assert_eq!(provider.resource_report().readiness, TaskReadiness::Ready);
        assert_eq!(
            provider.synthesis_binding().expect("binding"),
            TtsSynthesisProviderBinding::LocalTask(Box::new(provider.binding().clone()))
        );

        let request = tts_request(provider.binding().clone(), 9, 64);
        let result =
            futures_lite((), |_| provider.synthesize_text(request, &|| false)).expect("tts result");
        assert_eq!(result.chunk_count(), 2);
        assert!(!result.cancelled());
        assert_eq!(
            &result.chunks()[0].samples()[..4],
            &[0, i16::MAX, i16::MIN, 16384]
        );
        assert!(!result.chunks()[0].final_chunk());
        assert_eq!(result.chunks()[1].samples(), &[8192]);
        assert!(result.chunks()[1].final_chunk());

        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["synthesize"]);
        assert_eq!(backend.last_text_bytes, Some("hello aurora".len()));
        assert_eq!(backend.last_speaker_id, Some(0));
        assert_eq!(backend.last_speed, Some(1.0));
    }

    #[test]
    fn tts_rejects_wrong_binding_seed_and_concurrent_generation() {
        let mut provider = tts_provider(FakeTtsBackend::default());
        let wrong = stt_binding();
        assert_eq!(
            futures_lite(
                task_request(wrong.clone(), VoiceTask::SpeechToText, 1),
                |request| provider.warm_task(request)
            ),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            futures_lite(
                TtsSynthesisProviderBinding::LocalTask(Box::new(wrong)),
                |binding| provider.warm_synthesis(binding)
            ),
            Err(EngineError::InvalidRequest)
        );

        let seeded_config = TtsSynthesisConfig::new(
            "default",
            provider.binding().voice_state_compatibility_group_id(),
            provider.binding().sample_rate_hz(),
            64,
            Some(7),
        )
        .expect("seed config");
        let seeded = BoundTtsSynthesisRequest::new(
            task_request(provider.binding().clone(), VoiceTask::TextToSpeech, 1),
            "hello aurora",
            seeded_config,
        )
        .expect("seeded request");
        assert_eq!(
            futures_lite((), |_| provider.synthesize_text(seeded, &|| false)),
            Err(EngineError::InvalidRequest)
        );

        provider.active_generation = Some(77);
        assert_eq!(
            futures_lite((), |_| provider.synthesize_text(
                tts_request(provider.binding().clone(), 78, 64),
                &|| false
            )),
            Err(EngineError::ResourceLimit)
        );
        assert_eq!(
            futures_lite((), |_| provider.cancel_synthesis_generation(77)),
            Ok(())
        );
        assert!(provider.active_generation.is_none());
    }

    #[test]
    fn tts_cancellation_and_backend_faults_are_fail_closed_and_redacted() {
        let mut provider = tts_provider(FakeTtsBackend::default());
        assert_eq!(
            futures_lite((), |_| provider.synthesize_text(
                tts_request(provider.binding().clone(), 11, 64),
                &|| true
            )),
            Err(EngineError::Cancelled)
        );
        assert!(provider.into_backend().calls.is_empty());

        let mut provider = tts_provider(FakeTtsBackend {
            fail: true,
            ..FakeTtsBackend::default()
        });
        let error = futures_lite((), |_| {
            provider.synthesize_text(tts_request(provider.binding().clone(), 12, 64), &|| false)
        })
        .expect_err("provider fault");
        let rendered = format!("{error:?} {error} {provider:?}");
        assert!(rendered.contains("provider"));
        assert!(!rendered.contains("/secret"));
        assert!(!rendered.contains("private"));
        assert_eq!(
            provider.last_backend_fault(),
            Some(BackendFaultCode::BackendFault)
        );
    }

    #[test]
    fn tts_shared_cancellation_token_stops_blocking_backend_without_mut_provider() {
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let mut provider = tts_provider(BlockingTtsBackend {
            started: started_tx,
        });
        let token = provider.cancellation_token();
        let request = tts_request(provider.binding().clone(), 13, 64);
        let handle = std::thread::spawn(move || {
            futures_lite((), |_| provider.synthesize_text(request, &|| false))
        });

        started_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("blocking backend should start");
        token.cancel();
        let result = handle.join().expect("synthesis thread should finish");
        assert_eq!(result, Err(EngineError::Cancelled));
        assert!(token.is_cancelled());
        token.reset();
        assert!(!token.is_cancelled());
    }

    #[cfg(all(feature = "native-kws", not(target_arch = "wasm32")))]
    #[test]
    fn native_kws_adapter_detects_light_up_with_manifest_int8_encoder() {
        let binding = binding_with_files(
            "native-kws",
            PackTask::Kws,
            VoiceTask::KeywordSpotting,
            &["encoder-int8", "decoder", "joiner-int8", "tokens"],
        );
        let dir = phase4_path("AURORA_SHERPA_ONNX_KWS_DIR", KWS_MODEL);
        let backend = NativeKwsBackend::from_selected_model(
            &binding,
            NativeKwsModelFiles {
                encoder_file_id: "encoder-int8".to_owned(),
                encoder_path: dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                decoder_file_id: "decoder".to_owned(),
                decoder_path: dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
                joiner_file_id: "joiner-int8".to_owned(),
                joiner_path: dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: dir.join("tokens.txt"),
            },
        )
        .expect("native kws backend");
        let phrase_set = SherpaKwsPhraseSet::new(
            "phase4",
            [SherpaKwsPhrase::new("wake.main", "LIGHT UP", LIGHT_UP_SPEC).expect("phrase")],
        )
        .expect("phrase set");
        let mut provider = SherpaKwsProvider::new(binding, phrase_set, backend).expect("provider");
        let request = BoundKwsRequest::new(
            task_request(provider.binding().clone(), VoiceTask::KeywordSpotting, 77),
            KwsConfig::new(["wake.main"], "phase4", 0.5, 0, 1).expect("config"),
        )
        .expect("request");
        let session =
            futures_lite(request, |request| provider.start_kws_session(request)).expect("session");
        let wav = read_pcm16_mono_wav(&phase4_wav_path("AURORA_SHERPA_ONNX_TEST_WAV", KWS_MODEL));
        assert_eq!(wav.sample_rate, VAD_SAMPLE_RATE_HZ);
        let mut detected = false;
        for chunk in wav.pcm.chunks(1600) {
            let frame =
                StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, chunk, false)
                    .expect("frame");
            let result = futures_lite((), |_| provider.push_kws_frame(&session, frame, &|| false))
                .expect("kws frame");
            if let Some(keyword_match) = result.matches().first() {
                assert_eq!(keyword_match.keyword_id(), "wake.main");
                detected = true;
            }
        }
        let tail = vec![0.0; 8_000];
        let tail_frame =
            StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &tail, false)
                .expect("tail frame");
        let result = futures_lite((), |_| {
            provider.push_kws_frame(&session, tail_frame, &|| false)
        })
        .expect("tail frame");
        if let Some(keyword_match) = result.matches().first() {
            assert_eq!(keyword_match.keyword_id(), "wake.main");
            detected = true;
        }
        assert!(detected, "LIGHT UP should be detected");
        let rendered = format!("{provider:?}");
        assert!(!rendered.contains("LIGHT UP"));
        assert!(!rendered.contains(LIGHT_UP_SPEC));
        assert!(!rendered.contains("encoder-epoch"));
    }

    #[cfg(all(feature = "native-stt", not(target_arch = "wasm32")))]
    #[test]
    fn native_stt_adapter_matches_moonshine_phase4_transcript() {
        let binding = binding_with_files(
            "native-stt",
            PackTask::Stt,
            VoiceTask::SpeechToText,
            &["encoder", "decoder-merged", "tokens"],
        );
        let dir = phase4_path("AURORA_SHERPA_ONNX_STT_MODEL_DIR", STT_MODEL);
        let backend = NativeSttBackend::from_selected_model(
            &binding,
            "encoder",
            dir.join("encoder_model.ort"),
            "decoder-merged",
            dir.join("decoder_model_merged.ort"),
            "tokens",
            dir.join("tokens.txt"),
        )
        .expect("native stt backend");
        let mut engine = SherpaFiniteSttEngine::new(binding, backend).expect("engine");
        let source = read_pcm16_mono_wav(&phase4_wav_path(
            "AURORA_SHERPA_ONNX_STT_TEST_WAV",
            STT_MODEL,
        ));
        assert_eq!(source.sample_rate, 24_000);
        let resampled = source.resample_to_16khz();
        let frames = resampled
            .pcm
            .chunks(16_000)
            .map(|chunk| chunk.to_vec())
            .collect::<Vec<_>>();
        let (request, audio) = finite_stt(engine.binding().clone(), 88, frames);
        let result = futures_lite((), |_| engine.transcribe_finite(request, audio, &|| false))
            .expect("stt result");
        assert_eq!(result.transcript(), EXPECTED_STT_TEXT);
        let rendered = format!("{engine:?} {result:?}");
        assert!(!rendered.contains(EXPECTED_STT_TEXT));
        assert!(!rendered.contains("moonshine"));
    }

    #[cfg(all(feature = "native-stt", not(target_arch = "wasm32")))]
    #[test]
    #[ignore = "requires AURORA_SHERPA_ONNX_WHISPER_MODEL_DIR and AURORA_SHERPA_ONNX_WHISPER_TEST_WAV"]
    fn native_stt_adapter_transcribes_selected_whisper_model() {
        let binding = binding_with_files(
            "native-whisper-stt",
            PackTask::Stt,
            VoiceTask::SpeechToText,
            &["encoder", "decoder", "tokens"],
        );
        let dir = std::env::var_os("AURORA_SHERPA_ONNX_WHISPER_MODEL_DIR")
            .map(PathBuf::from)
            .expect("AURORA_SHERPA_ONNX_WHISPER_MODEL_DIR");
        let wav_path = std::env::var_os("AURORA_SHERPA_ONNX_WHISPER_TEST_WAV")
            .map(PathBuf::from)
            .expect("AURORA_SHERPA_ONNX_WHISPER_TEST_WAV");
        let backend = NativeSttBackend::from_selected_model_files(
            &binding,
            NativeSttModelFiles {
                encoder_file_id: "encoder".to_owned(),
                encoder_path: dir.join("tiny-encoder.int8.onnx"),
                decoder_file_id: "decoder".to_owned(),
                decoder_path: dir.join("tiny-decoder.int8.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: dir.join("tiny-tokens.txt"),
                language: None,
            },
        )
        .expect("native whisper stt backend");
        let mut engine = SherpaFiniteSttEngine::new(binding, backend).expect("engine");
        let source = read_pcm16_mono_wav(&wav_path);
        let source = if source.sample_rate == VAD_SAMPLE_RATE_HZ {
            source
        } else {
            source.resample_to_16khz()
        };
        let frames = source
            .pcm
            .chunks(16_000)
            .map(|chunk| chunk.to_vec())
            .collect::<Vec<_>>();
        let (request, audio) = finite_stt(engine.binding().clone(), 89, frames);
        let result = futures_lite((), |_| engine.transcribe_finite(request, audio, &|| false))
            .expect("stt result");
        println!("whisper transcript: {}", result.transcript());
        assert!(!result.transcript().trim().is_empty());
        assert!(result
            .transcript()
            .to_ascii_lowercase()
            .contains("after early nightfall"));
        let rendered = format!("{engine:?} {result:?}");
        assert!(!rendered.contains(result.transcript()));
        assert!(!rendered.contains("whisper"));
    }

    #[cfg(feature = "native-kws")]
    #[test]
    fn native_kws_constructor_requires_exact_dependency_closed_file_ids() {
        let binding = binding_with_files(
            "native-kws-ids",
            PackTask::Kws,
            VoiceTask::KeywordSpotting,
            &["encoder-int8", "decoder", "joiner-int8", "tokens"],
        );
        let result = NativeKwsBackend::from_selected_model(
            &binding,
            NativeKwsModelFiles {
                encoder_file_id: "encoder".to_owned(),
                encoder_path: PathBuf::from("encoder.onnx"),
                decoder_file_id: "decoder".to_owned(),
                decoder_path: PathBuf::from("decoder.onnx"),
                joiner_file_id: "joiner-int8".to_owned(),
                joiner_path: PathBuf::from("joiner.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: PathBuf::from("tokens.txt"),
            },
        );
        assert!(matches!(result, Err(EngineError::InvalidRequest)));
    }

    #[cfg(feature = "native-stt")]
    #[test]
    fn native_stt_constructor_requires_exact_dependency_closed_file_ids() {
        let binding = binding_with_files(
            "native-stt-ids",
            PackTask::Stt,
            VoiceTask::SpeechToText,
            &["encoder", "decoder-merged", "tokens"],
        );
        let result = NativeSttBackend::from_selected_model(
            &binding,
            "encoder",
            "encoder.ort",
            "decoder",
            "decoder.ort",
            "tokens",
            "tokens.txt",
        );
        assert!(matches!(result, Err(EngineError::InvalidRequest)));
    }

    #[cfg(feature = "native-stt")]
    #[test]
    fn native_stt_constructor_accepts_only_selected_whisper_file_ids() {
        let binding = binding_with_files(
            "native-whisper-stt-ids",
            PackTask::Stt,
            VoiceTask::SpeechToText,
            &["encoder", "decoder", "tokens"],
        );
        let moonshine_decoder = NativeSttBackend::from_selected_model(
            &binding,
            "encoder",
            "encoder.onnx",
            "decoder-merged",
            "decoder.onnx",
            "tokens",
            "tokens.txt",
        );
        assert!(matches!(
            moonshine_decoder,
            Err(EngineError::InvalidRequest)
        ));

        let missing_token = NativeSttBackend::from_selected_model_files(
            &binding,
            NativeSttModelFiles {
                encoder_file_id: "encoder".to_owned(),
                encoder_path: PathBuf::from("encoder.onnx"),
                decoder_file_id: "decoder".to_owned(),
                decoder_path: PathBuf::from("decoder.onnx"),
                tokens_file_id: "tokens-extra".to_owned(),
                tokens_path: PathBuf::from("tokens.txt"),
                language: Some("en".to_owned()),
            },
        );
        assert!(matches!(missing_token, Err(EngineError::InvalidRequest)));
    }

    #[cfg(feature = "native-stt")]
    #[test]
    fn native_stt_constructor_rejects_ambiguous_decoder_selection() {
        let binding = binding_with_files(
            "native-ambiguous-stt-ids",
            PackTask::Stt,
            VoiceTask::SpeechToText,
            &["encoder", "decoder", "decoder-merged", "tokens"],
        );
        let result = NativeSttBackend::from_selected_model_files(
            &binding,
            NativeSttModelFiles {
                encoder_file_id: "encoder".to_owned(),
                encoder_path: PathBuf::from("encoder.onnx"),
                decoder_file_id: "decoder".to_owned(),
                decoder_path: PathBuf::from("decoder.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: PathBuf::from("tokens.txt"),
                language: None,
            },
        );
        assert!(matches!(result, Err(EngineError::InvalidRequest)));

        let rendered = format!(
            "{:?}",
            NativeSttModelFiles {
                encoder_file_id: "encoder".to_owned(),
                encoder_path: PathBuf::from("/private/model/encoder.onnx"),
                decoder_file_id: "decoder".to_owned(),
                decoder_path: PathBuf::from("/private/model/decoder.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: PathBuf::from("/private/model/tokens.txt"),
                language: Some("zz-private-language".to_owned()),
            }
        );
        assert!(!rendered.contains("/private"));
        assert!(!rendered.contains("zz-private-language"));
    }

    #[cfg(feature = "native-tts")]
    #[test]
    fn native_tts_constructor_requires_exact_dependency_closed_file_ids() {
        let binding = binding_with_files(
            "native-tts-ids",
            PackTask::Tts,
            VoiceTask::TextToSpeech,
            &["model", "tokens", "espeak-ng-data"],
        );
        let result = NativeTtsBackend::from_selected_vits_piper_model(
            &binding,
            NativeTtsVitsPiperModelFiles {
                model_file_id: "voice-model".to_owned(),
                model_path: PathBuf::from("model.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: PathBuf::from("tokens.txt"),
                espeak_data_file_id: "espeak-ng-data".to_owned(),
                espeak_data_dir: PathBuf::from("espeak-ng-data"),
                lexicon_file_id: None,
                lexicon_path: None,
            },
        );
        assert!(matches!(result, Err(EngineError::InvalidRequest)));

        let binding = binding_with_files(
            "native-tts-lexicon-ids",
            PackTask::Tts,
            VoiceTask::TextToSpeech,
            &["model", "tokens", "espeak-ng-data", "lexicon"],
        );
        let result = NativeTtsBackend::from_selected_vits_piper_model(
            &binding,
            NativeTtsVitsPiperModelFiles {
                model_file_id: "model".to_owned(),
                model_path: PathBuf::from("model.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: PathBuf::from("tokens.txt"),
                espeak_data_file_id: "espeak-ng-data".to_owned(),
                espeak_data_dir: PathBuf::from("espeak-ng-data"),
                lexicon_file_id: None,
                lexicon_path: Some(PathBuf::from("lexicon.txt")),
            },
        );
        assert!(matches!(result, Err(EngineError::InvalidRequest)));
    }

    #[cfg(all(feature = "native-tts", not(target_arch = "wasm32")))]
    #[test]
    fn native_tts_adapter_generates_vits_piper_chunks_when_available() {
        if !live_tts_smoke_enabled() {
            eprintln!("skipping live native TTS smoke; set AURORA_SHERPA_ONNX_ENABLE_LIVE_TTS=1");
            return;
        }
        let binding = binding_with_files_and_sample_rate(
            "native-tts",
            PackTask::Tts,
            VoiceTask::TextToSpeech,
            &["model", "tokens", "espeak-ng-data"],
            22_050,
        );
        let dir = phase4_path("AURORA_SHERPA_ONNX_TTS_MODEL_DIR", TTS_MODEL);
        let backend = NativeTtsBackend::from_selected_vits_piper_model(
            &binding,
            NativeTtsVitsPiperModelFiles {
                model_file_id: "model".to_owned(),
                model_path: dir.join("en_US-ljspeech-medium.onnx"),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: dir.join("tokens.txt"),
                espeak_data_file_id: "espeak-ng-data".to_owned(),
                espeak_data_dir: dir.join("espeak-ng-data"),
                lexicon_file_id: None,
                lexicon_path: None,
            },
        )
        .expect("native tts backend");
        let mut provider = SherpaTtsProvider::new(binding, backend).expect("provider");
        let request = tts_request(provider.binding().clone(), 99, 1600);
        let result = futures_lite((), |_| provider.synthesize_text(request, &|| false))
            .expect("native tts result");
        assert!(!result.cancelled());
        assert!(result.chunk_count() > 0);
        assert!(result.chunks().iter().all(|chunk| {
            chunk.sample_rate_hz() == 22_050
                && chunk.channels() == MONO_CHANNELS
                && !chunk.samples().is_empty()
        }));
        assert!(result
            .chunks()
            .last()
            .is_some_and(TtsAudioChunk::final_chunk));
        let rendered = format!("{provider:?} {result:?}");
        assert!(!rendered.contains("en_US-ljspeech"));
        assert!(!rendered.contains("hello aurora"));
    }

    #[cfg(feature = "native-vad")]
    #[test]
    fn native_feature_constructor_is_bound_to_selected_file() {
        let binding = binding();
        let result = NativeVadBackend::from_selected_model(
            &binding,
            "missing",
            "model.onnx",
            &VadConfig::default(),
        );
        assert!(matches!(result, Err(EngineError::InvalidRequest)));
    }

    fn futures_lite<T, F, Fut, R>(input: T, f: F) -> R
    where
        F: FnOnce(T) -> Fut,
        Fut: std::future::Future<Output = R>,
    {
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        let mut future = Box::pin(f(input));
        loop {
            match std::future::Future::poll(future.as_mut(), &mut context) {
                std::task::Poll::Ready(output) => return output,
                std::task::Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn selected() -> (VerifiedManifest, SelectedVariant) {
        selected_for("pack", PackTask::Vad)
    }

    fn selected_for(pack_id: &str, task: PackTask) -> (VerifiedManifest, SelectedVariant) {
        let verified = verify_manifest(
            manifest(pack_id, task),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        )
        .expect("verified");
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
                device_memory_mb: None,
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
                cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Low,
                require_interoperable: true,
            },
        )
        .expect("selected");
        (verified, selection)
    }

    #[allow(dead_code)]
    fn binding_with_files(
        pack_id: &str,
        pack_task: PackTask,
        voice_task: VoiceTask,
        file_ids: &[&str],
    ) -> TaskPackBinding {
        binding_with_files_and_sample_rate(
            pack_id,
            pack_task,
            voice_task,
            file_ids,
            VAD_SAMPLE_RATE_HZ,
        )
    }

    #[allow(dead_code)]
    fn binding_with_files_and_sample_rate(
        pack_id: &str,
        pack_task: PackTask,
        voice_task: VoiceTask,
        file_ids: &[&str],
        sample_rate_hz: u32,
    ) -> TaskPackBinding {
        let mut raw = manifest(pack_id, pack_task);
        raw.variants[0].compatibility.sample_rate_hz = sample_rate_hz;
        raw.files = file_ids
            .iter()
            .enumerate()
            .map(|(index, file_id)| ModelPackFile {
                file_id: (*file_id).to_owned(),
                asset_id: (*file_id).to_owned(),
                task: pack_task,
                byte_size: 100,
                sha256: HASH.to_owned(),
                url: format!("/models/{file_id}"),
                compression: CompressionKind::None,
                installed_size: 100,
                install_order: u32::try_from(index).expect("install order"),
                dependencies: Vec::new(),
                license: license(),
                provenance: provenance(),
                processing: processing(),
                raven: None,
                revocation: None,
            })
            .collect();
        raw.variants[0].file_ids = file_ids
            .iter()
            .map(|file_id| (*file_id).to_owned())
            .collect();
        let verified = verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("verified");
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
                device_memory_mb: None,
                max_download_bytes: 4096,
                max_installed_bytes: 4096,
                max_memory_bytes: 4096,
                cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Low,
                require_interoperable: true,
            },
        )
        .expect("selected");
        TaskPackBinding::from_selection(voice_task, &verified, &selection).expect("binding")
    }

    #[allow(dead_code)]
    fn phase4_path(env_name: &str, model_subdir: &str) -> PathBuf {
        let path = std::env::var_os(env_name)
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("{env_name} must be set for native adapter smoke"));
        assert!(
            path.ends_with(model_subdir),
            "{env_name} should point at the expected model directory"
        );
        path
    }

    #[allow(dead_code)]
    fn phase4_wav_path(env_name: &str, model_subdir: &str) -> PathBuf {
        let path = std::env::var_os(env_name)
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("{env_name} must be set for native adapter smoke"));
        assert!(
            path.ends_with(PathBuf::from(model_subdir).join("test_wavs/0.wav")),
            "{env_name} should point at the expected test wav"
        );
        path
    }

    #[allow(dead_code)]
    fn live_tts_smoke_enabled() -> bool {
        std::env::var("AURORA_SHERPA_ONNX_ENABLE_LIVE_TTS").as_deref() == Ok("1")
    }

    #[allow(dead_code)]
    #[derive(Debug, Clone)]
    struct WavPcm {
        sample_rate: u32,
        pcm: Vec<f32>,
    }

    impl WavPcm {
        #[allow(dead_code)]
        fn resample_to_16khz(&self) -> Self {
            assert_eq!(self.sample_rate, 24_000);
            let mut pcm = Vec::with_capacity(self.pcm.len() * 2 / 3);
            for out_index in 0..(self.pcm.len() * 2 / 3) {
                let position = out_index as f64 * 1.5;
                let base = position.floor() as usize;
                let frac = (position - base as f64) as f32;
                let a = self.pcm[base];
                let b = self
                    .pcm
                    .get(base + 1)
                    .copied()
                    .unwrap_or_else(|| self.pcm[base]);
                pcm.push(a + (b - a) * frac);
            }
            Self {
                sample_rate: VAD_SAMPLE_RATE_HZ,
                pcm,
            }
        }
    }

    #[allow(dead_code)]
    fn read_pcm16_mono_wav(path: &Path) -> WavPcm {
        let bytes = std::fs::read(path).expect("wav file should be readable");
        assert!(bytes.len() >= 12, "wav file too short");
        assert_eq!(&bytes[0..4], b"RIFF", "wav must be RIFF");
        assert_eq!(&bytes[8..12], b"WAVE", "wav must be WAVE");

        let mut cursor = 12usize;
        let mut format: Option<WavFormat> = None;
        let mut data: Option<&[u8]> = None;

        while cursor.checked_add(8).expect("wav cursor overflow") <= bytes.len() {
            let id = &bytes[cursor..cursor + 4];
            let size = u32::from_le_bytes(
                bytes[cursor + 4..cursor + 8]
                    .try_into()
                    .expect("chunk size"),
            ) as usize;
            cursor += 8;
            let end = cursor.checked_add(size).expect("wav chunk overflow");
            assert!(end <= bytes.len(), "wav chunk extends past file");
            match id {
                b"fmt " => format = Some(parse_format_chunk(&bytes[cursor..end])),
                b"data" => data = Some(&bytes[cursor..end]),
                _ => {}
            }
            cursor = end + (size % 2);
        }

        let format = format.expect("wav fmt chunk should exist");
        assert_eq!(format.audio_format, 1, "wav must be PCM");
        assert_eq!(format.channels, 1, "wav must be mono");
        assert_eq!(format.bits_per_sample, 16, "wav must be PCM16");
        let data = data.expect("wav data chunk should exist");
        assert_eq!(data.len() % 2, 0, "pcm16 data should be aligned");
        let pcm = data
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0)
            .collect();
        WavPcm {
            sample_rate: format.sample_rate,
            pcm,
        }
    }

    #[allow(dead_code)]
    fn parse_format_chunk(chunk: &[u8]) -> WavFormat {
        assert!(chunk.len() >= 16, "fmt chunk too short");
        WavFormat {
            audio_format: u16::from_le_bytes(chunk[0..2].try_into().expect("audio format")),
            channels: u16::from_le_bytes(chunk[2..4].try_into().expect("channels")),
            sample_rate: u32::from_le_bytes(chunk[4..8].try_into().expect("sample rate")),
            bits_per_sample: u16::from_le_bytes(chunk[14..16].try_into().expect("bits per sample")),
        }
    }

    #[allow(dead_code)]
    struct WavFormat {
        audio_format: u16,
        channels: u16,
        sample_rate: u32,
        bits_per_sample: u16,
    }

    fn wrong_binding() -> TaskPackBinding {
        let verified = verify_manifest(
            manifest("other", PackTask::Vad),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        )
        .expect("verified");
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
                device_memory_mb: None,
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
                cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Low,
                require_interoperable: true,
            },
        )
        .expect("selected");
        TaskPackBinding::from_selection(VoiceTask::VoiceActivityDetection, &verified, &selection)
            .expect("wrong binding")
    }

    fn manifest(pack_id: &str, task: PackTask) -> ModelPackManifest {
        ModelPackManifest {
            schema_version: 1,
            pack_id: pack_id.to_owned(),
            pack_version: "1.0.0".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![task],
            license: license(),
            languages: vec![LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }],
            capabilities: CapabilityFlags {
                streaming: true,
                cancellation: true,
            },
            provenance: provenance(),
            files: vec![ModelPackFile {
                file_id: "model".to_owned(),
                asset_id: "model".to_owned(),
                task,
                byte_size: 100,
                sha256: HASH.to_owned(),
                url: "/models/model".to_owned(),
                compression: CompressionKind::None,
                installed_size: 100,
                install_order: 0,
                dependencies: Vec::new(),
                license: license(),
                provenance: provenance(),
                processing: processing(),
                raven: None,
                revocation: None,
            }],
            variants: vec![aurora_voice_engine::ModelPackVariant {
                variant_id: "linux".to_owned(),
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                engine: EngineKind::SherpaOnnx,
                required_browser_features: Vec::new(),
                min_device_memory_mb: None,
                runtime_gates: RuntimeGates {
                    min_cpu_threads: 1,
                    max_rtf_millis_per_second: 1_000,
                    min_device_class: DeviceClass::Low,
                },
                resource_budget: ResourceBudget {
                    max_download_bytes: 1024,
                    max_installed_bytes: 1024,
                    max_memory_bytes: 1024,
                },
                compatibility: Compatibility {
                    group_id: "group-a".to_owned(),
                    voice_state_group_id: "voice-state-a".to_owned(),
                    preprocessing_abi: "pre-v1".to_owned(),
                    postprocessing_abi: "post-v1".to_owned(),
                    sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                    channels: MONO_CHANNELS,
                    frame_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                    interoperable: true,
                },
                file_ids: vec!["model".to_owned()],
                abi: AbiRequirements {
                    min_aurora_version: "1.0.0".to_owned(),
                    min_runtime_version: "1.0.0".to_owned(),
                    min_engine_version: "1.0.0".to_owned(),
                    engine_source_revision: "rev1".to_owned(),
                    build_flags: vec!["cpu".to_owned()],
                },
                revocation: None,
            }],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key1".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        }
    }

    fn license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
        }
    }

    fn processing() -> ProcessingMetadata {
        ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: HASH.to_owned(),
            preprocessing_abi: "pre-v1".to_owned(),
            postprocessing_abi: "post-v1".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: MONO_CHANNELS,
                frame_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                window_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                cache_state: vec!["hidden".to_owned()],
            },
        }
    }
}
