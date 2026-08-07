//! Platform-independent speech-engine ports.

#![forbid(unsafe_code)]

pub mod model_pack;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

pub use model_pack::*;

pub const VAD_SAMPLE_RATE_HZ: u32 = 16_000;
pub const MONO_CHANNELS: u16 = 1;

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCapability {
    pub task: VoiceTask,
    pub languages: Vec<String>,
    pub sample_rate_hz: u32,
    pub streaming: bool,
    pub local_only: bool,
}

impl TaskCapability {
    pub fn new(task: VoiceTask, sample_rate_hz: u32) -> Self {
        Self {
            task,
            languages: Vec::new(),
            sample_rate_hz,
            streaming: false,
            local_only: true,
        }
    }

    pub fn with_languages(
        mut self,
        languages: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.languages = languages.into_iter().map(Into::into).collect();
        self
    }

    pub fn streaming(mut self, streaming: bool) -> Self {
        self.streaming = streaming;
        self
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
    ProviderFault { code: String },
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
    Flush,
    Discontinuity,
    RouteChanged,
    NewGeneration,
}

/// Validated sherpa-onnx Silero VAD shape for Aurora's canonical processing ABI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VadConfig {
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub window_size_samples: usize,
    pub threshold: f32,
    pub min_silence_duration_ms: u32,
    pub min_speech_duration_ms: u32,
    pub max_speech_duration_ms: u32,
    pub buffer_duration_ms: u32,
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
            || self.window_size_samples == 0
            || !valid_probability(self.threshold)
            || self.min_silence_duration_ms == 0
            || self.min_speech_duration_ms == 0
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
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            window_size_samples: 512,
            threshold: 0.5,
            min_silence_duration_ms: 500,
            min_speech_duration_ms: 250,
            max_speech_duration_ms: 30_000,
            buffer_duration_ms: 60_000,
        }
    }
}

/// Borrowed canonical 16 kHz mono frame for streaming inference.
#[derive(Clone, Copy)]
pub struct StreamingAudioFrame<'a> {
    pub sequence: u64,
    pub samples: &'a [f32],
    pub discontinuity: bool,
    pub end_tail: bool,
}

impl<'a> StreamingAudioFrame<'a> {
    pub fn window(
        sequence: u64,
        samples: &'a [f32],
        discontinuity: bool,
        config: &VadConfig,
    ) -> Result<Self, EngineError> {
        config.validate_frame_samples(samples)?;
        Ok(Self {
            sequence,
            samples,
            discontinuity,
            end_tail: false,
        })
    }

    pub fn end_tail(
        sequence: u64,
        samples: &'a [f32],
        discontinuity: bool,
        config: &VadConfig,
    ) -> Result<Self, EngineError> {
        config.validate_end_tail_samples(samples)?;
        Ok(Self {
            sequence,
            samples,
            discontinuity,
            end_tail: true,
        })
    }
}

impl fmt::Debug for StreamingAudioFrame<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StreamingAudioFrame")
            .field("sequence", &self.sequence)
            .field("sample_count", &self.samples.len())
            .field("discontinuity", &self.discontinuity)
            .field("end_tail", &self.end_tail)
            .finish()
    }
}

/// One VAD speech interval with owned PCM for downstream STT handoff.
#[derive(Clone, PartialEq)]
pub struct SpeechSegment {
    pub start_frame: u64,
    pub end_frame: u64,
    pub start_sample: u64,
    pub end_sample_exclusive: u64,
    pub samples: Vec<f32>,
    pub flushed: bool,
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
    pub detected: bool,
    pub segments: Vec<SpeechSegment>,
    pub reset: Option<StreamResetReason>,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KwsConfig {
    pub threshold: f32,
    pub cooldown_frames: u32,
    pub max_results: u8,
}

impl KwsConfig {
    pub fn validate(&self) -> Result<(), EngineError> {
        if !valid_probability(self.threshold) || self.max_results == 0 {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }
}

impl Default for KwsConfig {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            cooldown_frames: 0,
            max_results: 4,
        }
    }
}

/// One keyword match using manifest/application keyword identifiers only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeywordMatch {
    pub keyword_id: String,
    pub score: f32,
    pub frame_index: u64,
}

impl KeywordMatch {
    pub fn new(
        keyword_id: impl Into<String>,
        score: f32,
        frame_index: u64,
    ) -> Result<Self, EngineError> {
        let keyword_id = keyword_id.into();
        if keyword_id.is_empty() || !valid_probability(score) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            keyword_id,
            score,
            frame_index,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KwsFrameResult {
    pub matches: Vec<KeywordMatch>,
    pub reset: Option<StreamResetReason>,
}

/// Backend-neutral streaming STT configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamingSttConfig {
    pub language: Option<String>,
    pub emit_partials: bool,
    pub timestamps: bool,
}

impl StreamingSttConfig {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamingSttResult {
    pub segments: Vec<TranscriptSegment>,
    pub reset: Option<StreamResetReason>,
    pub completed: bool,
}

/// TTS synthesis request without provider paths or raw handles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TtsSynthesisConfig {
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub chunk_samples: usize,
    pub seed: Option<u64>,
}

impl TtsSynthesisConfig {
    pub fn validate(&self) -> Result<(), EngineError> {
        if self.sample_rate_hz == 0 || self.channels != MONO_CHANNELS || self.chunk_samples == 0 {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }
}

impl Default for TtsSynthesisConfig {
    fn default() -> Self {
        Self {
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
    pub sequence: u64,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub samples: Vec<i16>,
    pub final_chunk: bool,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TtsSynthesisResult {
    pub chunks: u64,
    pub cancelled: bool,
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
        request: TaskRequest,
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
    ) -> Result<Option<SpeechSegment>, EngineError>;

    async fn reset_stream(
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
        request: TaskRequest,
        config: KwsConfig,
    ) -> Result<StreamSessionId, EngineError>;

    async fn push_kws_frame(
        &mut self,
        session: StreamSessionId,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<KwsFrameResult, EngineError>;
}

/// Streaming STT provider boundary.
#[async_trait(?Send)]
pub trait StreamingSttProvider: TaskProvider {
    async fn start_stt_session(
        &mut self,
        request: TaskRequest,
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
}

/// Streaming TTS provider boundary.
#[async_trait(?Send)]
pub trait StreamingTtsProvider: TaskProvider {
    async fn synthesize_streaming(
        &mut self,
        request: TaskRequest,
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

fn normalized_mono_samples(samples: &[f32]) -> bool {
    !samples.is_empty()
        && samples
            .iter()
            .all(|sample| sample.is_finite() && (-1.0..=1.0).contains(sample))
}

/// Engine-independent task provider.
#[async_trait(?Send)]
pub trait TaskProvider {
    fn capabilities(&self) -> Vec<TaskCapability>;

    fn resource_report(&self) -> ResourceReport;

    async fn warm_task(&mut self, request: TaskRequest) -> Result<(), EngineError>;

    async fn unload_task(&mut self, task: VoiceTask) -> Result<(), EngineError>;

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError>;
}

/// A minimal finite turn engine boundary. Real sherpa/native/web adapters are
/// intentionally later phases.
#[async_trait(?Send)]
pub trait SpeechEngine: TaskProvider {
    async fn transcribe_finite(
        &mut self,
        request: TaskRequest,
        frames: usize,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<String, EngineError>;

    async fn synthesize_text(
        &mut self,
        request: TaskRequest,
        text: &str,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<i16>, EngineError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vad_config_enforces_sherpa_shape_and_canonical_audio() {
        let config = VadConfig::new(512, 0.5, 500, 250, 30_000, 60_000).expect("valid config");
        assert_eq!(config.min_silence_samples(), Ok(8_000));
        assert_eq!(config.min_speech_samples(), Ok(4_000));
        assert_eq!(config.max_speech_samples(), Ok(480_000));
        assert_eq!(config.buffer_samples(), Ok(960_000));

        let invalid_rate = VadConfig {
            sample_rate_hz: 8_000,
            ..VadConfig::default()
        };
        assert_eq!(invalid_rate.validate(), Err(EngineError::InvalidRequest));

        let invalid_channels = VadConfig {
            channels: 2,
            ..VadConfig::default()
        };
        assert_eq!(
            invalid_channels.validate(),
            Err(EngineError::InvalidRequest)
        );

        assert_eq!(
            VadConfig::new(0, 0.5, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, f32::NAN, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 500, 250, 200, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 500, 250, 30_000, 20_000),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn vad_samples_validate_exact_windows_and_end_tails() {
        let config = VadConfig::new(4, 0.5, 500, 250, 30_000, 60_000).expect("valid config");
        assert!(config
            .validate_frame_samples(&[-1.0, -0.25, 0.25, 1.0])
            .is_ok());
        assert_eq!(
            config.validate_frame_samples(&[-1.0, 0.0]),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&[-1.1, 0.0, 0.0, 0.0]),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&[f32::INFINITY, 0.0, 0.0, 0.0]),
            Err(EngineError::InvalidRequest)
        );
        assert!(StreamingAudioFrame::window(1, &[0.0, 0.0, 0.0, 0.0], false, &config).is_ok());
        assert_eq!(
            StreamingAudioFrame::window(1, &[0.0, 0.0], false, &config).map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
        let tail =
            StreamingAudioFrame::end_tail(2, &[0.0, 0.0], false, &config).expect("valid tail");
        assert!(tail.end_tail);
        assert_eq!(
            StreamingAudioFrame::end_tail(3, &[0.0, 0.0, 0.0, 0.0, 0.0], false, &config)
                .map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn speech_segments_and_frame_results_reject_invalid_ranges() {
        let segment = SpeechSegment::new(1, 2, 160, vec![0.1, -0.1], false).expect("valid segment");
        assert_eq!(segment.end_sample_exclusive, 162);
        assert_eq!(
            SpeechSegment::new(2, 1, 160, vec![0.1], false),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            SpeechSegment::new(1, 2, 160, vec![1.1], false),
            Err(EngineError::InvalidRequest)
        );
        let result = VadAcceptResult::new(true, vec![segment], None);
        assert!(result.detected);
        assert_eq!(result.segments.len(), 1);
    }

    #[test]
    fn reset_discontinuity_and_cancellation_contracts_are_explicit() {
        let config = VadConfig::new(3, 0.5, 500, 250, 30_000, 60_000).expect("valid config");
        let frame =
            StreamingAudioFrame::window(7, &[0.0, 0.1, -0.1], true, &config).expect("valid frame");
        assert!(frame.discontinuity);
        let result =
            VadAcceptResult::new(false, Vec::new(), Some(StreamResetReason::Discontinuity));
        assert_eq!(result.reset, Some(StreamResetReason::Discontinuity));

        assert_eq!(
            check_engine_cancellation(&|| true),
            Err(EngineError::Cancelled)
        );
        assert_eq!(check_engine_cancellation(&|| false), Ok(()));
    }

    #[test]
    fn backend_neutral_configs_validate_without_provider_identifiers() {
        assert!(KwsConfig::default().validate().is_ok());
        assert_eq!(
            KwsConfig {
                threshold: 0.5,
                cooldown_frames: 0,
                max_results: 0,
            }
            .validate(),
            Err(EngineError::InvalidRequest)
        );

        assert!(StreamingSttConfig {
            language: Some("en-US".to_owned()),
            ..StreamingSttConfig::default()
        }
        .validate()
        .is_ok());
        assert_eq!(
            StreamingSttConfig {
                language: Some("/tmp/model".to_owned()),
                ..StreamingSttConfig::default()
            }
            .validate(),
            Err(EngineError::InvalidRequest)
        );

        assert!(TtsSynthesisConfig::default().validate().is_ok());
        assert_eq!(
            TtsSynthesisConfig {
                channels: 2,
                ..TtsSynthesisConfig::default()
            }
            .validate(),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn debug_output_redacts_audio_sample_values() {
        let config = VadConfig::new(2, 0.5, 500, 250, 30_000, 60_000).expect("valid config");
        let frame =
            StreamingAudioFrame::window(1, &[0.123, -0.456], false, &config).expect("valid frame");
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

        let result = VadAcceptResult::new(true, vec![segment], Some(StreamResetReason::Flush));
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
        let result = StreamingSttResult {
            segments: vec![TranscriptSegment {
                text: "hello".to_owned(),
                start_ms: Some(0),
                end_ms: Some(100),
                is_final: true,
            }],
            reset: Some(StreamResetReason::Flush),
            completed: true,
        };
        let encoded = serde_json::to_string(&result).expect("serializes");
        assert!(encoded.contains("\"completed\":true"));
        assert!(!encoded.contains("provider"));

        let kws = KwsFrameResult {
            matches: vec![KeywordMatch::new("wake-main", 0.9, 10).expect("match")],
            reset: None,
        };
        let encoded = serde_json::to_string(&kws).expect("serializes");
        assert!(encoded.contains("wake-main"));
        assert!(!encoded.contains("provider"));
    }
}
