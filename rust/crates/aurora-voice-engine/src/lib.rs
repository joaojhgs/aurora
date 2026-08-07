//! Platform-independent speech-engine ports.

#![forbid(unsafe_code)]

pub mod model_pack;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use thiserror::Error;

pub use model_pack::*;

pub const VAD_SAMPLE_RATE_HZ: u32 = 16_000;
pub const MONO_CHANNELS: u16 = 1;
pub const VAD_WINDOW_SIZE_SAMPLES: usize = 512;
pub const VAD_DEFAULT_THRESHOLD: f32 = 0.25;
pub const VAD_DEFAULT_MIN_SILENCE_DURATION_MS: u32 = 250;
pub const VAD_DEFAULT_MIN_SPEECH_DURATION_MS: u32 = 250;
pub const VAD_DEFAULT_MAX_SPEECH_DURATION_MS: u32 = 10_000;
pub const VAD_DEFAULT_BUFFER_DURATION_MS: u32 = 30_000;
pub const VAD_MAX_DURATION_MS: u32 = 120_000;
/// Maximum canonical 16 kHz mono frame length accepted by generic streaming ports.
pub const MAX_STREAMING_FRAME_SAMPLES: usize = VAD_SAMPLE_RATE_HZ as usize * 30;
pub const MAX_KWS_PHRASES: usize = 64;
pub const TTS_MIN_SAMPLE_RATE_HZ: u32 = 8_000;
pub const TTS_MAX_SAMPLE_RATE_HZ: u32 = 48_000;
pub const TTS_MIN_CHUNK_SAMPLES: usize = 64;
pub const TTS_MAX_CHUNK_SAMPLES: usize = 48_000;

/// Engine task families the shared runtime can request without choosing a
/// concrete inference backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceTask {
    KeywordSpotting,
    VoiceActivityDetection,
    SpeechToText,
    TextToSpeech,
}

/// High-level task readiness, independent of platform storage details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskReadiness {
    Cold,
    Warming,
    Ready,
    Unavailable,
}

/// Capability metadata that is safe to expose in product state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskCapability {
    languages: Vec<String>,
    streaming: bool,
    local_only: bool,
    binding: TaskPackBinding,
}

impl TaskCapability {
    pub fn new(binding: TaskPackBinding) -> Self {
        let languages = binding
            .languages
            .iter()
            .map(|language| language.language.clone())
            .collect();
        Self {
            languages,
            streaming: false,
            local_only: true,
            binding,
        }
    }

    pub fn streaming(mut self, streaming: bool) -> Self {
        self.streaming = streaming;
        self
    }

    pub fn task(&self) -> VoiceTask {
        self.binding.task
    }

    pub fn languages(&self) -> &[String] {
        &self.languages
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.binding.sample_rate_hz
    }

    pub fn streaming_enabled(&self) -> bool {
        self.streaming
    }

    pub fn local_only(&self) -> bool {
        self.local_only
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.binding
    }
}

/// Current resource use report for one engine provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceReport {
    pub loaded_tasks: Vec<VoiceTask>,
    pub memory_bytes: u64,
    pub active_streams: u32,
    pub readiness: TaskReadiness,
}

impl Default for ResourceReport {
    fn default() -> Self {
        Self {
            loaded_tasks: Vec::new(),
            memory_bytes: 0,
            active_streams: 0,
            readiness: TaskReadiness::Cold,
        }
    }
}

/// A cancellable provider request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequest {
    pub task: VoiceTask,
    pub language: Option<String>,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskPackBinding {
    task: VoiceTask,
    manifest_sha256: String,
    pack_id: String,
    pack_version: String,
    variant_id: String,
    selected_file_ids: Vec<String>,
    compatibility_group_id: String,
    voice_state_compatibility_group_id: String,
    target: RuntimeTarget,
    os: TargetOs,
    arch: TargetArch,
    engine: EngineKind,
    required_browser_features: Vec<BrowserFeature>,
    min_device_memory_mb: Option<u64>,
    runtime_gates: RuntimeGates,
    resource_budget: ResourceBudget,
    variant_abi: AbiRequirements,
    interoperable: bool,
    sample_rate_hz: u32,
    channels: u16,
    frame_size: u32,
    languages: Vec<LanguageSupport>,
}

impl TaskPackBinding {
    pub fn from_selection(
        task: VoiceTask,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<Self, EngineError> {
        if !selection.belongs_to(manifest) || !manifest_supports_task(manifest.manifest(), task) {
            return Err(EngineError::InvalidRequest);
        }
        let variant = manifest
            .manifest()
            .variants
            .iter()
            .find(|candidate| candidate.variant_id == selection.variant_id())
            .ok_or(EngineError::InvalidRequest)?;
        let has_selected_task_file = selection.file_ids().iter().any(|file_id| {
            manifest.manifest().files.iter().any(|file| {
                file.file_id == *file_id
                    && voice_task_matches_pack_task(task, file.task)
                    && !file
                        .revocation
                        .as_ref()
                        .is_some_and(|revocation| revocation.revoked)
            })
        });
        if variant.compatibility.channels != MONO_CHANNELS
            || variant.compatibility.sample_rate_hz == 0
            || manifest.manifest().languages.is_empty()
            || !has_selected_task_file
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            task,
            manifest_sha256: manifest.manifest_sha256().to_owned(),
            pack_id: manifest.manifest().pack_id.clone(),
            pack_version: manifest.manifest().pack_version.clone(),
            variant_id: variant.variant_id.clone(),
            selected_file_ids: selection.file_ids().iter().cloned().collect(),
            compatibility_group_id: variant.compatibility.group_id.clone(),
            voice_state_compatibility_group_id: variant.compatibility.voice_state_group_id.clone(),
            target: variant.target,
            os: variant.os,
            arch: variant.arch,
            engine: variant.engine,
            required_browser_features: variant.required_browser_features.clone(),
            min_device_memory_mb: variant.min_device_memory_mb,
            runtime_gates: variant.runtime_gates.clone(),
            resource_budget: variant.resource_budget.clone(),
            variant_abi: variant.abi.clone(),
            interoperable: variant.compatibility.interoperable,
            sample_rate_hz: variant.compatibility.sample_rate_hz,
            channels: variant.compatibility.channels,
            frame_size: variant.compatibility.frame_size,
            languages: manifest.manifest().languages.clone(),
        })
    }

    pub fn task(&self) -> VoiceTask {
        self.task
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    pub fn pack_id(&self) -> &str {
        &self.pack_id
    }

    pub fn pack_version(&self) -> &str {
        &self.pack_version
    }

    pub fn variant_id(&self) -> &str {
        &self.variant_id
    }

    pub fn selected_file_ids(&self) -> &[String] {
        &self.selected_file_ids
    }

    pub fn compatibility_group_id(&self) -> &str {
        &self.compatibility_group_id
    }

    pub fn voice_state_compatibility_group_id(&self) -> &str {
        &self.voice_state_compatibility_group_id
    }

    pub fn target(&self) -> RuntimeTarget {
        self.target
    }

    pub fn os(&self) -> TargetOs {
        self.os
    }

    pub fn arch(&self) -> TargetArch {
        self.arch
    }

    pub fn engine(&self) -> EngineKind {
        self.engine
    }

    pub fn required_browser_features(&self) -> &[BrowserFeature] {
        &self.required_browser_features
    }

    pub fn min_device_memory_mb(&self) -> Option<u64> {
        self.min_device_memory_mb
    }

    pub fn runtime_gates(&self) -> &RuntimeGates {
        &self.runtime_gates
    }

    pub fn resource_budget(&self) -> &ResourceBudget {
        &self.resource_budget
    }

    pub fn variant_abi(&self) -> &AbiRequirements {
        &self.variant_abi
    }

    pub fn interoperable(&self) -> bool {
        self.interoperable
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn frame_size(&self) -> u32 {
        self.frame_size
    }

    pub fn languages(&self) -> &[LanguageSupport] {
        &self.languages
    }

    pub fn validate_language(&self, language: Option<&str>) -> Result<(), EngineError> {
        validate_binding_language(self, language)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundTaskRequest {
    request: TaskRequest,
    binding: TaskPackBinding,
}

impl BoundTaskRequest {
    pub fn new(request: TaskRequest, binding: TaskPackBinding) -> Result<Self, EngineError> {
        if request.task != binding.task {
            return Err(EngineError::InvalidRequest);
        }
        binding.validate_language(request.language.as_deref())?;
        Ok(Self { request, binding })
    }

    pub fn request(&self) -> &TaskRequest {
        &self.request
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.binding
    }
}

/// Bounded provider fault identifiers safe for UI/log surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineFaultCode {
    Provider,
    HostUnavailable,
    Native,
    Wasm,
    Timeout,
    Internal,
}

impl EngineFaultCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::HostUnavailable => "host_unavailable",
            Self::Native => "native",
            Self::Wasm => "wasm",
            Self::Timeout => "timeout",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for EngineFaultCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Provider errors must stay product-safe and exclude credentials or raw audio.
#[derive(Debug, Clone, Error, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineError {
    #[error("task unavailable")]
    TaskUnavailable,
    #[error("cancelled")]
    Cancelled,
    #[error("resource limit")]
    ResourceLimit,
    #[error("invalid request")]
    InvalidRequest,
    #[error("provider fault: {code}")]
    ProviderFault { code: EngineFaultCode },
}

/// Shared cancellation check for streaming providers.
pub fn check_engine_cancellation(cancellation: &dyn Fn() -> bool) -> Result<(), EngineError> {
    if cancellation() {
        Err(EngineError::Cancelled)
    } else {
        Ok(())
    }
}

/// A backend-neutral stream/session handle owned by the engine provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StreamSessionId(pub u64);

/// Reason a streaming task must discard recurrent/cache state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamResetReason {
    Manual,
    Discontinuity,
    RouteChanged,
    NewGeneration,
}

/// Validated sherpa-onnx Silero VAD shape for Aurora's canonical processing ABI.
#[derive(Debug, Clone, PartialEq)]
pub struct VadConfig {
    sample_rate_hz: u32,
    channels: u16,
    window_size_samples: usize,
    threshold: f32,
    min_silence_duration_ms: u32,
    min_speech_duration_ms: u32,
    max_speech_duration_ms: u32,
    buffer_duration_ms: u32,
}

impl VadConfig {
    pub fn new(
        window_size_samples: usize,
        threshold: f32,
        min_silence_duration_ms: u32,
        min_speech_duration_ms: u32,
        max_speech_duration_ms: u32,
        buffer_duration_ms: u32,
    ) -> Result<Self, EngineError> {
        let config = Self {
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            window_size_samples,
            threshold,
            min_silence_duration_ms,
            min_speech_duration_ms,
            max_speech_duration_ms,
            buffer_duration_ms,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if self.sample_rate_hz != VAD_SAMPLE_RATE_HZ
            || self.channels != MONO_CHANNELS
            || self.window_size_samples != VAD_WINDOW_SIZE_SAMPLES
            || !valid_sherpa_threshold(self.threshold)
            || self.min_silence_duration_ms == 0
            || self.min_speech_duration_ms == 0
            || self.max_speech_duration_ms == 0
            || self.buffer_duration_ms == 0
            || self.min_silence_duration_ms > VAD_MAX_DURATION_MS
            || self.min_speech_duration_ms > VAD_MAX_DURATION_MS
            || self.max_speech_duration_ms > VAD_MAX_DURATION_MS
            || self.buffer_duration_ms > VAD_MAX_DURATION_MS
            || self.max_speech_duration_ms < self.min_speech_duration_ms
            || self.buffer_duration_ms < self.max_speech_duration_ms
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_frame_samples(&self, samples: &[f32]) -> Result<(), EngineError> {
        self.validate()?;
        if samples.len() != self.window_size_samples || !normalized_mono_samples(samples) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_end_tail_samples(&self, samples: &[f32]) -> Result<(), EngineError> {
        self.validate()?;
        if samples.is_empty()
            || samples.len() > self.window_size_samples
            || !normalized_mono_samples(samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn min_silence_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.min_silence_duration_ms, self.sample_rate_hz)
    }

    pub fn min_speech_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.min_speech_duration_ms, self.sample_rate_hz)
    }

    pub fn max_speech_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.max_speech_duration_ms, self.sample_rate_hz)
    }

    pub fn buffer_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.buffer_duration_ms, self.sample_rate_hz)
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::VoiceActivityDetection
            || binding.sample_rate_hz() != self.sample_rate_hz
            || binding.channels() != self.channels
            || binding.frame_size() != self.window_size_samples as u32
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn window_size_samples(&self) -> usize {
        self.window_size_samples
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn min_silence_duration_ms(&self) -> u32 {
        self.min_silence_duration_ms
    }

    pub fn min_speech_duration_ms(&self) -> u32 {
        self.min_speech_duration_ms
    }

    pub fn max_speech_duration_ms(&self) -> u32 {
        self.max_speech_duration_ms
    }

    pub fn buffer_duration_ms(&self) -> u32 {
        self.buffer_duration_ms
    }
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            window_size_samples: VAD_WINDOW_SIZE_SAMPLES,
            threshold: VAD_DEFAULT_THRESHOLD,
            min_silence_duration_ms: VAD_DEFAULT_MIN_SILENCE_DURATION_MS,
            min_speech_duration_ms: VAD_DEFAULT_MIN_SPEECH_DURATION_MS,
            max_speech_duration_ms: VAD_DEFAULT_MAX_SPEECH_DURATION_MS,
            buffer_duration_ms: VAD_DEFAULT_BUFFER_DURATION_MS,
        }
    }
}

/// Borrowed canonical 16 kHz mono frame for streaming inference.
#[derive(Clone, Copy)]
pub struct StreamingAudioFrame<'a> {
    sequence: u64,
    sample_rate_hz: u32,
    channels: u16,
    samples: &'a [f32],
    discontinuity: bool,
    end_tail: bool,
}

impl<'a> StreamingAudioFrame<'a> {
    pub fn new(
        sequence: u64,
        sample_rate_hz: u32,
        channels: u16,
        samples: &'a [f32],
        discontinuity: bool,
    ) -> Result<Self, EngineError> {
        if sample_rate_hz != VAD_SAMPLE_RATE_HZ
            || channels != MONO_CHANNELS
            || samples.len() > MAX_STREAMING_FRAME_SAMPLES
            || !normalized_mono_samples(samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            sequence,
            sample_rate_hz,
            channels,
            samples,
            discontinuity,
            end_tail: false,
        })
    }

    pub fn end_tail(
        sequence: u64,
        sample_rate_hz: u32,
        channels: u16,
        samples: &'a [f32],
        discontinuity: bool,
    ) -> Result<Self, EngineError> {
        if sample_rate_hz != VAD_SAMPLE_RATE_HZ
            || channels != MONO_CHANNELS
            || samples.len() > MAX_STREAMING_FRAME_SAMPLES
            || !normalized_mono_samples(samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            sequence,
            sample_rate_hz,
            channels,
            samples,
            discontinuity,
            end_tail: true,
        })
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn samples(&self) -> &[f32] {
        self.samples
    }

    pub fn discontinuity(&self) -> bool {
        self.discontinuity
    }

    pub fn is_end_tail(&self) -> bool {
        self.end_tail
    }
}

impl fmt::Debug for StreamingAudioFrame<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StreamingAudioFrame")
            .field("sequence", &self.sequence)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("sample_count", &self.samples.len())
            .field("discontinuity", &self.discontinuity)
            .field("end_tail", &self.end_tail)
            .finish()
    }
}

/// One VAD speech interval with owned PCM for downstream STT handoff.
#[derive(Clone, PartialEq)]
pub struct SpeechSegment {
    start_frame: u64,
    end_frame: u64,
    start_sample: u64,
    end_sample_exclusive: u64,
    samples: Vec<f32>,
    flushed: bool,
}

impl SpeechSegment {
    pub fn new(
        start_frame: u64,
        end_frame: u64,
        start_sample: u64,
        samples: Vec<f32>,
        flushed: bool,
    ) -> Result<Self, EngineError> {
        if end_frame < start_frame || !normalized_mono_samples(&samples) {
            return Err(EngineError::InvalidRequest);
        }
        let sample_len = u64::try_from(samples.len()).map_err(|_| EngineError::ResourceLimit)?;
        let end_sample_exclusive = start_sample
            .checked_add(sample_len)
            .ok_or(EngineError::ResourceLimit)?;
        Ok(Self {
            start_frame,
            end_frame,
            start_sample,
            end_sample_exclusive,
            samples,
            flushed,
        })
    }

    pub fn start_frame(&self) -> u64 {
        self.start_frame
    }

    pub fn end_frame(&self) -> u64 {
        self.end_frame
    }

    pub fn start_sample(&self) -> u64 {
        self.start_sample
    }

    pub fn end_sample_exclusive(&self) -> u64 {
        self.end_sample_exclusive
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub fn flushed(&self) -> bool {
        self.flushed
    }
}

impl fmt::Debug for SpeechSegment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechSegment")
            .field("start_frame", &self.start_frame)
            .field("end_frame", &self.end_frame)
            .field("start_sample", &self.start_sample)
            .field("end_sample_exclusive", &self.end_sample_exclusive)
            .field("sample_count", &self.samples.len())
            .field("flushed", &self.flushed)
            .finish()
    }
}

/// Result of accepting one streaming audio frame.
#[derive(Clone, PartialEq)]
pub struct VadAcceptResult {
    detected: bool,
    segments: Vec<SpeechSegment>,
    reset: Option<StreamResetReason>,
}

impl VadAcceptResult {
    pub fn new(
        detected: bool,
        segments: Vec<SpeechSegment>,
        reset: Option<StreamResetReason>,
    ) -> Self {
        Self {
            detected,
            segments,
            reset,
        }
    }

    pub fn detected(&self) -> bool {
        self.detected
    }

    pub fn segments(&self) -> &[SpeechSegment] {
        &self.segments
    }

    pub fn reset(&self) -> Option<StreamResetReason> {
        self.reset
    }
}

impl fmt::Debug for VadAcceptResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VadAcceptResult")
            .field("detected", &self.detected)
            .field("segment_count", &self.segments.len())
            .field("reset", &self.reset)
            .finish()
    }
}

/// Backend-neutral keyword spotting configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct KwsConfig {
    phrase_ids: Vec<String>,
    phrase_set_revision: String,
    threshold: f32,
    cooldown_frames: u32,
    max_results: u8,
}

impl KwsConfig {
    pub fn new(
        phrase_ids: impl IntoIterator<Item = impl Into<String>>,
        phrase_set_revision: impl Into<String>,
        threshold: f32,
        cooldown_frames: u32,
        max_results: u8,
    ) -> Result<Self, EngineError> {
        let config = Self {
            phrase_ids: phrase_ids.into_iter().map(Into::into).collect(),
            phrase_set_revision: phrase_set_revision.into(),
            threshold,
            cooldown_frames,
            max_results,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if self.phrase_ids.is_empty()
            || self.phrase_ids.len() > MAX_KWS_PHRASES
            || self
                .phrase_ids
                .iter()
                .any(|phrase_id| !valid_logical_id(phrase_id))
            || self.phrase_ids.iter().collect::<BTreeSet<_>>().len() != self.phrase_ids.len()
            || !valid_logical_id(&self.phrase_set_revision)
            || !valid_sherpa_threshold(self.threshold)
            || self.max_results == 0
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::KeywordSpotting {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn phrase_ids(&self) -> &[String] {
        &self.phrase_ids
    }

    pub fn phrase_set_revision(&self) -> &str {
        &self.phrase_set_revision
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn cooldown_frames(&self) -> u32 {
        self.cooldown_frames
    }

    pub fn max_results(&self) -> u8 {
        self.max_results
    }
}

/// One keyword match using manifest/application keyword identifiers only.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KeywordMatch {
    keyword_id: String,
    score: f32,
    frame_index: u64,
}

impl KeywordMatch {
    pub fn new(
        keyword_id: impl Into<String>,
        score: f32,
        frame_index: u64,
    ) -> Result<Self, EngineError> {
        let keyword_id = keyword_id.into();
        if !valid_logical_id(&keyword_id) || !valid_probability(score) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            keyword_id,
            score,
            frame_index,
        })
    }

    pub fn keyword_id(&self) -> &str {
        &self.keyword_id
    }

    pub fn score(&self) -> f32 {
        self.score
    }

    pub fn frame_index(&self) -> u64 {
        self.frame_index
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KwsFrameResult {
    matches: Vec<KeywordMatch>,
    reset: Option<StreamResetReason>,
}

impl KwsFrameResult {
    pub fn new(matches: Vec<KeywordMatch>, reset: Option<StreamResetReason>) -> Self {
        Self { matches, reset }
    }

    pub fn matches(&self) -> &[KeywordMatch] {
        &self.matches
    }

    pub fn reset(&self) -> Option<StreamResetReason> {
        self.reset
    }
}

/// Backend-neutral streaming STT configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingSttConfig {
    language: Option<String>,
    emit_partials: bool,
    timestamps: bool,
}

impl StreamingSttConfig {
    pub fn new(
        language: Option<impl Into<String>>,
        emit_partials: bool,
        timestamps: bool,
    ) -> Result<Self, EngineError> {
        let config = Self {
            language: language.map(Into::into),
            emit_partials,
            timestamps,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if self.language.as_ref().is_some_and(|language| {
            language.is_empty()
                || language.len() > 35
                || !language
                    .bytes()
                    .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'-'))
        }) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::SpeechToText {
            return Err(EngineError::InvalidRequest);
        }
        binding.validate_language(self.language())?;
        Ok(())
    }

    pub fn language(&self) -> Option<&str> {
        self.language.as_deref()
    }

    pub fn emit_partials(&self) -> bool {
        self.emit_partials
    }

    pub fn timestamps(&self) -> bool {
        self.timestamps
    }
}

impl Default for StreamingSttConfig {
    fn default() -> Self {
        Self {
            language: None,
            emit_partials: true,
            timestamps: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TranscriptSegment {
    text: String,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    is_final: bool,
}

impl TranscriptSegment {
    pub fn new(
        text: impl Into<String>,
        start_ms: Option<u64>,
        end_ms: Option<u64>,
        is_final: bool,
    ) -> Result<Self, EngineError> {
        let text = text.into();
        if text.is_empty() || end_ms.zip(start_ms).is_some_and(|(end, start)| end < start) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            text,
            start_ms,
            end_ms,
            is_final,
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn start_ms(&self) -> Option<u64> {
        self.start_ms
    }

    pub fn end_ms(&self) -> Option<u64> {
        self.end_ms
    }

    pub fn is_final(&self) -> bool {
        self.is_final
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StreamingSttResult {
    segments: Vec<TranscriptSegment>,
    reset: Option<StreamResetReason>,
    completed: bool,
}

impl StreamingSttResult {
    pub fn new(
        segments: Vec<TranscriptSegment>,
        reset: Option<StreamResetReason>,
        completed: bool,
    ) -> Self {
        Self {
            segments,
            reset,
            completed,
        }
    }

    pub fn segments(&self) -> &[TranscriptSegment] {
        &self.segments
    }

    pub fn reset(&self) -> Option<StreamResetReason> {
        self.reset
    }

    pub fn completed(&self) -> bool {
        self.completed
    }
}

/// TTS synthesis request without provider paths or raw handles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TtsSynthesisConfig {
    logical_voice_id: String,
    voice_state_compatibility_group_id: String,
    sample_rate_hz: u32,
    channels: u16,
    chunk_samples: usize,
    seed: Option<u64>,
}

impl TtsSynthesisConfig {
    pub fn new(
        logical_voice_id: impl Into<String>,
        voice_state_compatibility_group_id: impl Into<String>,
        sample_rate_hz: u32,
        chunk_samples: usize,
        seed: Option<u64>,
    ) -> Result<Self, EngineError> {
        let config = Self {
            logical_voice_id: logical_voice_id.into(),
            voice_state_compatibility_group_id: voice_state_compatibility_group_id.into(),
            sample_rate_hz,
            channels: MONO_CHANNELS,
            chunk_samples,
            seed,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if !valid_logical_id(&self.logical_voice_id)
            || !valid_logical_id(&self.voice_state_compatibility_group_id)
            || !(TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&self.sample_rate_hz)
            || self.channels != MONO_CHANNELS
            || !(TTS_MIN_CHUNK_SAMPLES..=TTS_MAX_CHUNK_SAMPLES).contains(&self.chunk_samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::TextToSpeech
            || binding.sample_rate_hz() != self.sample_rate_hz
            || binding.channels() != self.channels
            || binding.voice_state_compatibility_group_id()
                != self.voice_state_compatibility_group_id
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn logical_voice_id(&self) -> &str {
        &self.logical_voice_id
    }

    pub fn voice_state_compatibility_group_id(&self) -> &str {
        &self.voice_state_compatibility_group_id
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn chunk_samples(&self) -> usize {
        self.chunk_samples
    }

    pub fn seed(&self) -> Option<u64> {
        self.seed
    }
}

impl Default for TtsSynthesisConfig {
    fn default() -> Self {
        Self {
            logical_voice_id: "default".to_owned(),
            voice_state_compatibility_group_id: "default".to_owned(),
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            chunk_samples: 1024,
            seed: None,
        }
    }
}

/// One synthesized audio chunk. Debug output redacts sample values.
#[derive(Clone, PartialEq, Eq)]
pub struct TtsAudioChunk {
    sequence: u64,
    sample_rate_hz: u32,
    channels: u16,
    samples: Vec<i16>,
    final_chunk: bool,
}

impl TtsAudioChunk {
    pub fn new(
        sequence: u64,
        sample_rate_hz: u32,
        channels: u16,
        samples: Vec<i16>,
        final_chunk: bool,
    ) -> Result<Self, EngineError> {
        if sample_rate_hz == 0 || channels != MONO_CHANNELS || samples.is_empty() {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            sequence,
            sample_rate_hz,
            channels,
            samples,
            final_chunk,
        })
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn samples(&self) -> &[i16] {
        &self.samples
    }

    pub fn final_chunk(&self) -> bool {
        self.final_chunk
    }
}

impl fmt::Debug for TtsAudioChunk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TtsAudioChunk")
            .field("sequence", &self.sequence)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("sample_count", &self.samples.len())
            .field("final_chunk", &self.final_chunk)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TtsSynthesisResult {
    chunks: u64,
    cancelled: bool,
}

impl TtsSynthesisResult {
    pub fn new(chunks: u64, cancelled: bool) -> Self {
        Self { chunks, cancelled }
    }

    pub fn chunks(&self) -> u64 {
        self.chunks
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled
    }
}

#[async_trait(?Send)]
pub trait TtsChunkSink {
    async fn push_chunk(&mut self, chunk: TtsAudioChunk) -> Result<(), EngineError>;
}

/// VAD-only streaming provider boundary.
#[async_trait(?Send)]
pub trait VadStreamProvider: TaskProvider {
    async fn start_vad_session(
        &mut self,
        request: BoundTaskRequest,
        config: VadConfig,
    ) -> Result<StreamSessionId, EngineError>;

    async fn push_vad_frame(
        &mut self,
        session: StreamSessionId,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<VadAcceptResult, EngineError>;

    async fn flush_vad_session(
        &mut self,
        session: StreamSessionId,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<SpeechSegment>, EngineError>;

    async fn reset_vad_session(
        &mut self,
        session: StreamSessionId,
        reason: StreamResetReason,
    ) -> Result<(), EngineError>;
}

/// Keyword-spotting-only streaming provider boundary.
#[async_trait(?Send)]
pub trait KwsStreamProvider: TaskProvider {
    async fn start_kws_session(
        &mut self,
        request: BoundTaskRequest,
        config: KwsConfig,
    ) -> Result<StreamSessionId, EngineError>;

    async fn push_kws_frame(
        &mut self,
        session: StreamSessionId,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<KwsFrameResult, EngineError>;

    async fn reset_kws_session(
        &mut self,
        session: StreamSessionId,
        reason: StreamResetReason,
    ) -> Result<(), EngineError>;
}

/// Streaming STT provider boundary.
#[async_trait(?Send)]
pub trait StreamingSttProvider: TaskProvider {
    async fn start_stt_session(
        &mut self,
        request: BoundTaskRequest,
        config: StreamingSttConfig,
    ) -> Result<StreamSessionId, EngineError>;

    async fn push_stt_frame(
        &mut self,
        session: StreamSessionId,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<StreamingSttResult, EngineError>;

    async fn finish_stt_session(
        &mut self,
        session: StreamSessionId,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<StreamingSttResult, EngineError>;

    async fn reset_stt_session(
        &mut self,
        session: StreamSessionId,
        reason: StreamResetReason,
    ) -> Result<(), EngineError>;
}

/// Streaming TTS provider boundary.
#[async_trait(?Send)]
pub trait StreamingTtsProvider: TaskProvider {
    async fn synthesize_streaming(
        &mut self,
        request: BoundTaskRequest,
        text: &str,
        config: TtsSynthesisConfig,
        sink: &mut dyn TtsChunkSink,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError>;
}

fn duration_ms_to_samples(duration_ms: u32, sample_rate_hz: u32) -> Result<u64, EngineError> {
    u64::from(duration_ms)
        .checked_mul(u64::from(sample_rate_hz))
        .and_then(|value| value.checked_add(999))
        .map(|value| value / 1_000)
        .ok_or(EngineError::ResourceLimit)
}

fn valid_probability(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn valid_sherpa_threshold(value: f32) -> bool {
    value.is_finite() && (0.01..1.0).contains(&value)
}

fn valid_logical_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b':'))
}

fn normalized_mono_samples(samples: &[f32]) -> bool {
    !samples.is_empty()
        && samples
            .iter()
            .all(|sample| sample.is_finite() && (-1.0..=1.0).contains(sample))
}

fn manifest_supports_task(manifest: &ModelPackManifest, task: VoiceTask) -> bool {
    manifest
        .tasks
        .iter()
        .copied()
        .any(|pack_task| voice_task_matches_pack_task(task, pack_task))
}

fn voice_task_matches_pack_task(task: VoiceTask, pack_task: PackTask) -> bool {
    match task {
        VoiceTask::KeywordSpotting => matches!(pack_task, PackTask::Kws | PackTask::Wakeword),
        VoiceTask::VoiceActivityDetection => pack_task == PackTask::Vad,
        VoiceTask::SpeechToText => pack_task == PackTask::Stt,
        VoiceTask::TextToSpeech => pack_task == PackTask::Tts,
    }
}

fn validate_binding_language(
    binding: &TaskPackBinding,
    language: Option<&str>,
) -> Result<(), EngineError> {
    match language {
        Some(requested) => {
            if binding.languages.iter().any(|supported| {
                supported.language == requested
                    || supported
                        .locale
                        .as_deref()
                        .is_some_and(|locale| locale == requested)
            }) {
                Ok(())
            } else {
                Err(EngineError::InvalidRequest)
            }
        }
        None if binding.task == VoiceTask::VoiceActivityDetection => Ok(()),
        None if binding
            .languages
            .iter()
            .any(|supported| supported.auto_detect) =>
        {
            Ok(())
        }
        None if binding.languages.len() == 1 => Ok(()),
        None => Err(EngineError::InvalidRequest),
    }
}

/// Engine-independent task provider.
#[async_trait(?Send)]
pub trait TaskProvider {
    fn capabilities(&self) -> Vec<TaskCapability>;

    fn resource_report(&self) -> ResourceReport;

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError>;

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError>;

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError>;
}

/// A minimal finite turn engine boundary. Real sherpa/native/web adapters are
/// intentionally later phases.
#[async_trait(?Send)]
pub trait SpeechEngine: TaskProvider {
    async fn transcribe_finite(
        &mut self,
        request: BoundTaskRequest,
        frames: usize,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<String, EngineError>;

    async fn synthesize_text(
        &mut self,
        request: BoundTaskRequest,
        text: &str,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<i16>, EngineError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::BTreeSet;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

    fn test_license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn test_provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
        }
    }

    fn test_processing() -> ProcessingMetadata {
        ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: HASH.to_owned(),
            preprocessing_abi: "pre-v1".to_owned(),
            postprocessing_abi: "post-v1".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: MONO_CHANNELS,
                frame_size: 512,
                window_size: 1024,
                cache_state: vec!["hidden".to_owned()],
            },
        }
    }

    fn test_file(file_id: &str, task: PackTask) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task,
            byte_size: 100,
            sha256: HASH.to_owned(),
            url: format!("/models/{file_id}"),
            compression: CompressionKind::None,
            installed_size: 100,
            install_order: 0,
            dependencies: Vec::new(),
            license: test_license(),
            provenance: test_provenance(),
            processing: test_processing(),
            raven: None,
            revocation: None,
        }
    }

    fn test_variant(file_id: &str) -> ModelPackVariant {
        ModelPackVariant {
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
                frame_size: 512,
                interoperable: true,
            },
            file_ids: vec![file_id.to_owned()],
            abi: AbiRequirements {
                min_aurora_version: "1.0.0".to_owned(),
                min_runtime_version: "1.0.0".to_owned(),
                min_engine_version: "1.0.0".to_owned(),
                engine_source_revision: "rev1".to_owned(),
                build_flags: vec!["cpu".to_owned()],
            },
            revocation: None,
        }
    }

    fn test_manifest(pack_task: PackTask) -> ModelPackManifest {
        ModelPackManifest {
            schema_version: 1,
            pack_id: "pack".to_owned(),
            pack_version: "1.0.0".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![pack_task],
            license: test_license(),
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
            provenance: test_provenance(),
            files: vec![test_file("model", pack_task)],
            variants: vec![test_variant("model")],
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

    fn selected(pack_task: PackTask) -> (VerifiedManifest, SelectedVariant) {
        let verified = verify_manifest(
            test_manifest(pack_task),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        )
        .expect("verified manifest");
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
        .expect("selected variant");
        (verified, selection)
    }

    struct SurfaceVadProvider;

    #[async_trait(?Send)]
    impl TaskProvider for SurfaceVadProvider {
        fn capabilities(&self) -> Vec<TaskCapability> {
            Vec::new()
        }

        fn resource_report(&self) -> ResourceReport {
            ResourceReport::default()
        }

        async fn warm_task(&mut self, _request: BoundTaskRequest) -> Result<(), EngineError> {
            Ok(())
        }

        async fn unload_task(&mut self, _binding: TaskPackBinding) -> Result<(), EngineError> {
            Ok(())
        }

        async fn cancel_generation(&mut self, _generation: u64) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[async_trait(?Send)]
    impl VadStreamProvider for SurfaceVadProvider {
        async fn start_vad_session(
            &mut self,
            _request: BoundTaskRequest,
            _config: VadConfig,
        ) -> Result<StreamSessionId, EngineError> {
            Ok(StreamSessionId(1))
        }

        async fn push_vad_frame(
            &mut self,
            _session: StreamSessionId,
            _frame: StreamingAudioFrame<'_>,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<VadAcceptResult, EngineError> {
            Ok(VadAcceptResult::new(false, Vec::new(), None))
        }

        async fn flush_vad_session(
            &mut self,
            _session: StreamSessionId,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<Vec<SpeechSegment>, EngineError> {
            Ok(Vec::new())
        }

        async fn reset_vad_session(
            &mut self,
            _session: StreamSessionId,
            _reason: StreamResetReason,
        ) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[test]
    fn task_pack_binding_requires_matching_verified_selection_task_and_language() {
        let (manifest, selection) = selected(PackTask::Stt);
        let binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
                .expect("binding");
        assert_eq!(binding.pack_id(), "pack");
        assert_eq!(binding.variant_id(), "linux");
        assert_eq!(binding.compatibility_group_id(), "group-a");
        assert_eq!(binding.target(), RuntimeTarget::Desktop);
        assert_eq!(binding.os(), TargetOs::Linux);
        assert_eq!(binding.arch(), TargetArch::X86_64);
        assert_eq!(binding.engine(), EngineKind::SherpaOnnx);
        assert_eq!(binding.runtime_gates().min_device_class, DeviceClass::Low);
        assert_eq!(binding.resource_budget().max_memory_bytes, 1024);
        assert_eq!(binding.variant_abi().engine_source_revision, "rev1");
        assert_eq!(
            binding.voice_state_compatibility_group_id(),
            "voice-state-a"
        );
        assert_eq!(binding.selected_file_ids(), &["model".to_owned()]);
        assert!(binding.interoperable());
        assert_eq!(binding.sample_rate_hz(), VAD_SAMPLE_RATE_HZ);
        assert_eq!(binding.channels(), MONO_CHANNELS);
        assert_eq!(binding.frame_size(), 512);
        assert_eq!(binding.languages()[0].language, "en");

        assert_eq!(
            TaskPackBinding::from_selection(VoiceTask::TextToSpeech, &manifest, &selection),
            Err(EngineError::InvalidRequest)
        );

        let request = TaskRequest {
            task: VoiceTask::SpeechToText,
            language: Some("en-US".to_owned()),
            generation: 7,
        };
        assert!(BoundTaskRequest::new(request, binding.clone()).is_ok());
        let wrong_language = TaskRequest {
            task: VoiceTask::SpeechToText,
            language: Some("fr".to_owned()),
            generation: 7,
        };
        assert_eq!(
            BoundTaskRequest::new(wrong_language, binding),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn capabilities_are_inherently_bound_to_verified_selection() {
        let (manifest, selection) = selected(PackTask::Stt);
        let binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
                .expect("binding");
        let capability = TaskCapability::new(binding.clone()).streaming(true);
        assert_eq!(capability.task(), VoiceTask::SpeechToText);
        assert_eq!(capability.sample_rate_hz(), VAD_SAMPLE_RATE_HZ);
        assert_eq!(capability.languages(), &["en".to_owned()]);
        assert_eq!(capability.binding(), &binding);
        assert!(capability.streaming_enabled());
    }

    #[test]
    fn binding_requires_selected_non_revoked_file_for_requested_task() {
        let mut raw = test_manifest(PackTask::Stt);
        raw.files[0].task = PackTask::Tokenizer;
        raw.tasks.push(PackTask::Tokenizer);
        let verified =
            verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier)).expect("valid");
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
        assert_eq!(
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &verified, &selection),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn binding_language_none_requires_unambiguous_or_auto_detect_language() {
        let (manifest, selection) = selected(PackTask::Stt);
        let mut binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
                .expect("binding");
        assert!(binding.validate_language(None).is_ok());

        binding.languages.push(LanguageSupport {
            language: "fr".to_owned(),
            locale: None,
            fixed_language: true,
            auto_detect: false,
        });
        assert_eq!(
            binding.validate_language(None),
            Err(EngineError::InvalidRequest)
        );
        assert!(binding.validate_language(Some("fr")).is_ok());
        assert_eq!(
            binding.validate_language(Some("de")),
            Err(EngineError::InvalidRequest)
        );
        binding.languages[1].auto_detect = true;
        assert!(binding.validate_language(None).is_ok());

        let (manifest, selection) = selected(PackTask::Vad);
        let vad_binding = TaskPackBinding::from_selection(
            VoiceTask::VoiceActivityDetection,
            &manifest,
            &selection,
        )
        .expect("vad binding");
        assert!(vad_binding.validate_language(None).is_ok());
    }

    #[test]
    fn flush_and_reset_surfaces_are_distinct_for_vad_streams() {
        fn assert_vad_surface<T: VadStreamProvider>() {}
        assert_vad_surface::<SurfaceVadProvider>();
    }

    #[test]
    fn vad_config_enforces_sherpa_shape_and_canonical_audio() {
        let config = VadConfig::default();
        assert_eq!(config.min_silence_samples(), Ok(4_000));
        assert_eq!(config.min_speech_samples(), Ok(4_000));
        assert_eq!(config.max_speech_samples(), Ok(160_000));
        assert_eq!(config.buffer_samples(), Ok(480_000));
        assert_eq!(config.sample_rate_hz(), VAD_SAMPLE_RATE_HZ);
        assert_eq!(config.channels(), MONO_CHANNELS);
        assert_eq!(config.window_size_samples(), VAD_WINDOW_SIZE_SAMPLES);
        assert_eq!(config.threshold(), VAD_DEFAULT_THRESHOLD);

        assert_eq!(
            VadConfig::new(0, 0.5, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, f32::NAN, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.009, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert!(VadConfig::new(512, 0.01, 500, 250, 30_000, 60_000).is_ok());
        assert_eq!(
            VadConfig::new(512, 1.0, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 500, 250, 200, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 0, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 500, 250, 30_000, 20_000),
            Err(EngineError::InvalidRequest)
        );
        assert!(VadConfig::new(512, 0.5, 500, 250, 30_000, 30_000).is_ok());
        assert_eq!(
            VadConfig::new(
                512,
                0.5,
                500,
                250,
                VAD_MAX_DURATION_MS + 1,
                VAD_MAX_DURATION_MS + 1
            ),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn vad_samples_validate_exact_windows_and_end_tails() {
        let config = VadConfig::default();
        let exact = vec![0.0; VAD_WINDOW_SIZE_SAMPLES];
        assert!(config.validate_frame_samples(&exact).is_ok());
        assert_eq!(
            config.validate_frame_samples(&[-1.0, 0.0]),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&vec![1.1; VAD_WINDOW_SIZE_SAMPLES]),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&vec![f32::INFINITY; VAD_WINDOW_SIZE_SAMPLES]),
            Err(EngineError::InvalidRequest)
        );
        assert!(
            StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &exact, false).is_ok()
        );
        assert_eq!(
            StreamingAudioFrame::new(1, 8_000, MONO_CHANNELS, &[0.0, 0.0], false).map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, 2, &[0.0, 0.0], false).map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
        let too_long = vec![0.0; MAX_STREAMING_FRAME_SAMPLES + 1];
        assert_eq!(
            StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &too_long, false)
                .map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&[0.0, 0.0]),
            Err(EngineError::InvalidRequest)
        );
        let tail =
            StreamingAudioFrame::end_tail(2, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &[0.0, 0.0], false)
                .expect("valid tail");
        assert!(tail.is_end_tail());
        assert!(config.validate_end_tail_samples(&[0.0, 0.0]).is_ok());
        assert_eq!(
            config.validate_end_tail_samples(&vec![0.0; VAD_WINDOW_SIZE_SAMPLES + 1]),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn speech_segments_and_frame_results_reject_invalid_ranges() {
        let segment = SpeechSegment::new(1, 2, 160, vec![0.1, -0.1], false).expect("valid segment");
        assert_eq!(segment.end_sample_exclusive(), 162);
        assert_eq!(
            SpeechSegment::new(2, 1, 160, vec![0.1], false),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            SpeechSegment::new(1, 2, 160, vec![1.1], false),
            Err(EngineError::InvalidRequest)
        );
        let result = VadAcceptResult::new(true, vec![segment], None);
        assert!(result.detected());
        assert_eq!(result.segments().len(), 1);
    }

    #[test]
    fn reset_discontinuity_and_cancellation_contracts_are_explicit() {
        let frame = StreamingAudioFrame::new(
            7,
            VAD_SAMPLE_RATE_HZ,
            MONO_CHANNELS,
            &[0.0, 0.1, -0.1],
            true,
        )
        .expect("valid frame");
        assert!(frame.discontinuity());
        let result =
            VadAcceptResult::new(false, Vec::new(), Some(StreamResetReason::Discontinuity));
        assert_eq!(result.reset(), Some(StreamResetReason::Discontinuity));

        assert_eq!(
            check_engine_cancellation(&|| true),
            Err(EngineError::Cancelled)
        );
        assert_eq!(check_engine_cancellation(&|| false), Ok(()));
    }

    #[test]
    fn backend_neutral_configs_validate_without_provider_identifiers() {
        let (kws_manifest, kws_selection) = selected(PackTask::Kws);
        let kws_binding = TaskPackBinding::from_selection(
            VoiceTask::KeywordSpotting,
            &kws_manifest,
            &kws_selection,
        )
        .expect("kws binding");
        let kws_config =
            KwsConfig::new(["wake.main"], "phrases:v1", 0.5, 0, 4).expect("valid config");
        assert!(kws_config.validate_binding(&kws_binding).is_ok());
        assert_eq!(
            KwsConfig::new(["wake.main"], "phrases:v1", 0.5, 0, 0),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            KwsConfig::new(["/tmp/model"], "phrases:v1", 0.5, 0, 4),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            KwsConfig::new(["wake.main", "wake.main"], "phrases:v1", 0.5, 0, 4),
            Err(EngineError::InvalidRequest)
        );
        let too_many_phrases = (0..=MAX_KWS_PHRASES).map(|index| format!("wake.{index}"));
        assert_eq!(
            KwsConfig::new(too_many_phrases, "phrases:v1", 0.5, 0, 4),
            Err(EngineError::InvalidRequest)
        );

        let (stt_manifest, stt_selection) = selected(PackTask::Stt);
        let stt_binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &stt_manifest, &stt_selection)
                .expect("stt binding");
        assert!(StreamingSttConfig::new(Some("en-US"), true, true)
            .expect("valid stt")
            .validate_binding(&stt_binding)
            .is_ok());
        assert_eq!(
            StreamingSttConfig::new(Some("/tmp/model"), true, true),
            Err(EngineError::InvalidRequest)
        );

        let (tts_manifest, tts_selection) = selected(PackTask::Tts);
        let tts_binding =
            TaskPackBinding::from_selection(VoiceTask::TextToSpeech, &tts_manifest, &tts_selection)
                .expect("tts binding");
        let tts_config = TtsSynthesisConfig::new(
            "voice.default",
            "voice-state-a",
            VAD_SAMPLE_RATE_HZ,
            1024,
            None,
        )
        .expect("valid tts");
        assert!(tts_config.validate_binding(&tts_binding).is_ok());
        assert!(TtsSynthesisConfig::default().validate().is_ok());
        assert_eq!(
            TtsSynthesisConfig::new("/tmp/voice", "state:v1", VAD_SAMPLE_RATE_HZ, 1024, None),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            TtsSynthesisConfig::new("voice.default", "voice-state-a", 7_999, 1024, None),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            TtsSynthesisConfig::new(
                "voice.default",
                "voice-state-a",
                VAD_SAMPLE_RATE_HZ,
                TTS_MAX_CHUNK_SAMPLES + 1,
                None,
            ),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn debug_output_redacts_audio_sample_values() {
        let frame = StreamingAudioFrame::new(
            1,
            VAD_SAMPLE_RATE_HZ,
            MONO_CHANNELS,
            &[0.123, -0.456],
            false,
        )
        .expect("valid frame");
        let frame_debug = format!("{frame:?}");
        assert!(frame_debug.contains("sample_count: 2"));
        assert!(!frame_debug.contains("0.123"));
        assert!(!frame_debug.contains("-0.456"));

        let segment =
            SpeechSegment::new(1, 1, 0, vec![0.123, -0.456], true).expect("valid segment");
        let segment_debug = format!("{segment:?}");
        assert!(segment_debug.contains("sample_count: 2"));
        assert!(!segment_debug.contains("0.123"));
        assert!(!segment_debug.contains("-0.456"));

        let result = VadAcceptResult::new(true, vec![segment], Some(StreamResetReason::Manual));
        let result_debug = format!("{result:?}");
        assert!(result_debug.contains("segment_count: 1"));
        assert!(!result_debug.contains("0.123"));
        assert!(!result_debug.contains("-0.456"));

        let chunk = TtsAudioChunk::new(1, 16_000, MONO_CHANNELS, vec![123, -456], true)
            .expect("valid chunk");
        let chunk_debug = format!("{chunk:?}");
        assert!(chunk_debug.contains("sample_count: 2"));
        assert!(!chunk_debug.contains("123"));
        assert!(!chunk_debug.contains("-456"));
    }

    #[test]
    fn serializes_product_safe_stream_values() {
        let result = StreamingSttResult::new(
            vec![TranscriptSegment::new("hello", Some(0), Some(100), true).expect("segment")],
            Some(StreamResetReason::Manual),
            true,
        );
        let encoded = serde_json::to_string(&result).expect("serializes");
        assert!(encoded.contains("\"completed\":true"));
        assert!(!encoded.contains("provider"));

        let kws = KwsFrameResult::new(
            vec![KeywordMatch::new("wake-main", 0.9, 10).expect("match")],
            None,
        );
        let encoded = serde_json::to_string(&kws).expect("serializes");
        assert!(encoded.contains("wake-main"));
        assert!(!encoded.contains("provider"));
    }
}
