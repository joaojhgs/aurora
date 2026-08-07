//! Safe containment for the pinned sherpa-onnx v1.13.4 speech C ABI.
//!
//! The crate intentionally exposes only a small RAII API. Raw C layouts and all
//! unsafe calls remain private to the native implementation module.

use std::error::Error;
use std::fmt;
use std::fs::File;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[cfg(all(
    any(feature = "native-vad", feature = "native-stt"),
    not(target_arch = "wasm32")
))]
mod native;

#[cfg(not(all(
    any(feature = "native-vad", feature = "native-stt"),
    not(target_arch = "wasm32")
)))]
mod native {
    use super::{
        OfflineSttConfig, OfflineSttResult, SileroVadConfig, SpeechSegment, SttError, VadError,
    };

    pub(crate) struct Detector;

    impl std::fmt::Debug for Detector {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("Detector")
                .field("native", &"unavailable")
                .finish()
        }
    }

    impl Detector {
        pub(crate) fn new(_config: &SileroVadConfig) -> Result<Self, VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn accept_waveform(&mut self, _pcm: &[f32]) -> Result<(), VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn detected(&self) -> Result<bool, VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn is_empty(&self) -> Result<bool, VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn drain_speech_segments(&mut self) -> Result<Vec<SpeechSegment>, VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn clear(&mut self) -> Result<(), VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn reset(&mut self) -> Result<(), VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn flush(&mut self) -> Result<(), VadError> {
            Err(VadError::NativeUnavailable)
        }
    }

    pub(crate) struct OfflineRecognizer;

    impl std::fmt::Debug for OfflineRecognizer {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("OfflineRecognizer")
                .field("native", &"unavailable")
                .finish()
        }
    }

    impl OfflineRecognizer {
        pub(crate) fn new(_config: &OfflineSttConfig) -> Result<Self, SttError> {
            Err(SttError::NativeUnavailable)
        }

        pub(crate) fn create_stream(&self) -> Result<OfflineStream, SttError> {
            Err(SttError::NativeUnavailable)
        }

        pub(crate) fn decode_stream(
            &self,
            _stream: OfflineStream,
        ) -> Result<OfflineSttResult, SttError> {
            Err(SttError::NativeUnavailable)
        }
    }

    pub(crate) struct OfflineStream;

    impl OfflineStream {
        pub(crate) fn accept_waveform(
            &mut self,
            _sample_rate: i32,
            _pcm: &[f32],
        ) -> Result<(), SttError> {
            Err(SttError::NativeUnavailable)
        }
    }
}

pub const SHERPA_ONNX_VERSION: &str = "1.13.4";

const DEFAULT_THRESHOLD: f32 = 0.5;
const DEFAULT_MIN_SILENCE_DURATION: f32 = 0.5;
const DEFAULT_MIN_SPEECH_DURATION: f32 = 0.25;
const DEFAULT_MAX_SPEECH_DURATION: f32 = 10.0;
const DEFAULT_WINDOW_SIZE: i32 = 512;
const DEFAULT_SAMPLE_RATE: i32 = 16_000;
const DEFAULT_NUM_THREADS: i32 = 1;
const DEFAULT_PROVIDER: &str = "cpu";
const DEFAULT_BUFFER_SIZE_SECONDS: f32 = 30.0;
const MIN_DURATION_SECONDS: f32 = 0.001;
const MAX_DURATION_SECONDS: f32 = 300.0;
const MIN_SAMPLE_RATE: i32 = 8_000;
const MAX_SAMPLE_RATE: i32 = 48_000;
const MAX_NUM_THREADS: i32 = 16;
const MAX_WINDOW_SIZE: i32 = 8_192;
const MAX_NATIVE_SEGMENTS: usize = 4096;
const MAX_NATIVE_SEGMENT_SAMPLES: usize = 14_400_000;
const DEFAULT_FEATURE_DIM: i32 = 80;
const DEFAULT_DECODING_METHOD: &str = "greedy_search";
const MAX_OFFLINE_STT_SECONDS: f32 = 60.0;
const MAX_OFFLINE_STT_SAMPLES: usize = 2_880_000;
#[cfg(all(
    any(feature = "native-vad", feature = "native-stt"),
    not(target_arch = "wasm32")
))]
const MAX_OFFLINE_STT_TEXT_BYTES: usize = 16_384;
#[cfg(all(
    any(feature = "native-vad", feature = "native-stt"),
    not(target_arch = "wasm32")
))]
const MAX_OFFLINE_STT_TOKENS: usize = 4096;
#[cfg(all(
    any(feature = "native-vad", feature = "native-stt"),
    not(target_arch = "wasm32")
))]
const MAX_OFFLINE_STT_TOKEN_BYTES: usize = 256;
#[cfg(all(
    any(feature = "native-vad", feature = "native-stt"),
    not(target_arch = "wasm32")
))]
const MAX_OFFLINE_STT_SEGMENTS: usize = 1024;

#[derive(Clone)]
pub struct SileroVadConfig {
    model_path: PathBuf,
    threshold: f32,
    min_silence_duration: f32,
    min_speech_duration: f32,
    max_speech_duration: f32,
    window_size: i32,
    sample_rate: i32,
    num_threads: i32,
    provider: String,
    debug: bool,
    buffer_size_seconds: f32,
}

impl SileroVadConfig {
    pub fn new(model_path: impl Into<PathBuf>) -> Self {
        Self {
            model_path: model_path.into(),
            threshold: DEFAULT_THRESHOLD,
            min_silence_duration: DEFAULT_MIN_SILENCE_DURATION,
            min_speech_duration: DEFAULT_MIN_SPEECH_DURATION,
            max_speech_duration: DEFAULT_MAX_SPEECH_DURATION,
            window_size: DEFAULT_WINDOW_SIZE,
            sample_rate: DEFAULT_SAMPLE_RATE,
            num_threads: DEFAULT_NUM_THREADS,
            provider: DEFAULT_PROVIDER.to_owned(),
            debug: false,
            buffer_size_seconds: DEFAULT_BUFFER_SIZE_SECONDS,
        }
    }

    pub fn model_path(&self) -> &Path {
        &self.model_path
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn min_silence_duration(&self) -> f32 {
        self.min_silence_duration
    }

    pub fn min_speech_duration(&self) -> f32 {
        self.min_speech_duration
    }

    pub fn max_speech_duration(&self) -> f32 {
        self.max_speech_duration
    }

    pub fn window_size(&self) -> i32 {
        self.window_size
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }

    pub fn num_threads(&self) -> i32 {
        self.num_threads
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn debug(&self) -> bool {
        self.debug
    }

    pub fn buffer_size_seconds(&self) -> f32 {
        self.buffer_size_seconds
    }

    pub fn with_threshold(mut self, threshold: f32) -> Self {
        self.threshold = threshold;
        self
    }

    pub fn with_min_silence_duration(mut self, seconds: f32) -> Self {
        self.min_silence_duration = seconds;
        self
    }

    pub fn with_min_speech_duration(mut self, seconds: f32) -> Self {
        self.min_speech_duration = seconds;
        self
    }

    pub fn with_max_speech_duration(mut self, seconds: f32) -> Self {
        self.max_speech_duration = seconds;
        self
    }

    pub fn with_window_size(mut self, samples: i32) -> Self {
        self.window_size = samples;
        self
    }

    pub fn with_sample_rate(mut self, sample_rate: i32) -> Self {
        self.sample_rate = sample_rate;
        self
    }

    pub fn with_num_threads(mut self, num_threads: i32) -> Self {
        self.num_threads = num_threads;
        self
    }

    pub fn with_provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = provider.into();
        self
    }

    pub fn with_debug(mut self, debug: bool) -> Self {
        self.debug = debug;
        self
    }

    pub fn with_buffer_size_seconds(mut self, seconds: f32) -> Self {
        self.buffer_size_seconds = seconds;
        self
    }

    pub fn validate(&self) -> Result<(), VadError> {
        if self.model_path.as_os_str().is_empty() {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigModelPathEmpty,
            });
        }
        let model_path = path_bytes(&self.model_path)?;
        if model_path.contains(&0) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigModelPathNul,
            });
        }
        validate_threshold(self.threshold)?;
        validate_positive_finite(
            self.min_silence_duration,
            ErrorCode::ConfigMinSilenceDurationRange,
        )?;
        validate_positive_finite(
            self.min_speech_duration,
            ErrorCode::ConfigMinSpeechDurationRange,
        )?;
        validate_positive_finite(
            self.max_speech_duration,
            ErrorCode::ConfigMaxSpeechDurationRange,
        )?;
        if self.window_size <= 0 {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigWindowSizeRange,
            });
        }
        if self.window_size > MAX_WINDOW_SIZE {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigWindowSizeRange,
            });
        }
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&self.sample_rate) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigSampleRateRange,
            });
        }
        if !(1..=MAX_NUM_THREADS).contains(&self.num_threads) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigNumThreadsRange,
            });
        }
        if self.provider.is_empty() {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigProviderEmpty,
            });
        }
        if self.provider.as_bytes().contains(&0) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigProviderNul,
            });
        }
        validate_positive_finite(
            self.buffer_size_seconds,
            ErrorCode::ConfigBufferSizeSecondsRange,
        )?;
        if self.buffer_size_seconds < self.max_speech_duration {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigBufferSizeLessThanMaxSpeech,
            });
        }
        let bounds = SegmentBounds::from_config(self)?;
        if bounds.max_segments() == 0 || bounds.max_segment_samples() == 0 {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigBufferSizeSecondsRange,
            });
        }
        Ok(())
    }
}

impl fmt::Debug for SileroVadConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SileroVadConfig")
            .field("model_path", &"<redacted>")
            .field("threshold", &self.threshold)
            .field("min_silence_duration", &self.min_silence_duration)
            .field("min_speech_duration", &self.min_speech_duration)
            .field("max_speech_duration", &self.max_speech_duration)
            .field("window_size", &self.window_size)
            .field("sample_rate", &self.sample_rate)
            .field("num_threads", &self.num_threads)
            .field("provider", &"<redacted>")
            .field("debug", &self.debug)
            .field("buffer_size_seconds", &self.buffer_size_seconds)
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub struct SpeechSegment {
    pub start: i32,
    pub samples: Vec<f32>,
}

impl fmt::Debug for SpeechSegment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechSegment")
            .field("start", &self.start)
            .field("sample_count", &self.samples.len())
            .field("samples", &"<redacted>")
            .finish()
    }
}

pub struct VoiceActivityDetector {
    inner: native::Detector,
    max_accept_samples: i32,
    _not_send_sync: PhantomData<Rc<()>>,
}

#[derive(Clone)]
pub struct OfflineSttConfig {
    encoder_path: PathBuf,
    decoder_path: PathBuf,
    tokens_path: PathBuf,
    sample_rate: i32,
    feature_dim: i32,
    num_threads: i32,
    provider: String,
    decoding_method: String,
    max_active_paths: i32,
    max_audio_seconds: f32,
}

impl OfflineSttConfig {
    pub fn moonshine_v2(
        encoder_path: impl Into<PathBuf>,
        decoder_path: impl Into<PathBuf>,
        tokens_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            encoder_path: encoder_path.into(),
            decoder_path: decoder_path.into(),
            tokens_path: tokens_path.into(),
            sample_rate: DEFAULT_SAMPLE_RATE,
            feature_dim: DEFAULT_FEATURE_DIM,
            num_threads: DEFAULT_NUM_THREADS,
            provider: DEFAULT_PROVIDER.to_owned(),
            decoding_method: DEFAULT_DECODING_METHOD.to_owned(),
            max_active_paths: 4,
            max_audio_seconds: MAX_OFFLINE_STT_SECONDS,
        }
    }

    pub fn encoder_path(&self) -> &Path {
        &self.encoder_path
    }

    pub fn decoder_path(&self) -> &Path {
        &self.decoder_path
    }

    pub fn tokens_path(&self) -> &Path {
        &self.tokens_path
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }

    pub fn feature_dim(&self) -> i32 {
        self.feature_dim
    }

    pub fn num_threads(&self) -> i32 {
        self.num_threads
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn decoding_method(&self) -> &str {
        &self.decoding_method
    }

    pub fn max_active_paths(&self) -> i32 {
        self.max_active_paths
    }

    pub fn max_audio_seconds(&self) -> f32 {
        self.max_audio_seconds
    }

    pub fn with_sample_rate(mut self, sample_rate: i32) -> Self {
        self.sample_rate = sample_rate;
        self
    }

    pub fn with_feature_dim(mut self, feature_dim: i32) -> Self {
        self.feature_dim = feature_dim;
        self
    }

    pub fn with_num_threads(mut self, num_threads: i32) -> Self {
        self.num_threads = num_threads;
        self
    }

    pub fn with_provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = provider.into();
        self
    }

    pub fn with_decoding_method(mut self, decoding_method: impl Into<String>) -> Self {
        self.decoding_method = decoding_method.into();
        self
    }

    pub fn with_max_active_paths(mut self, max_active_paths: i32) -> Self {
        self.max_active_paths = max_active_paths;
        self
    }

    pub fn with_max_audio_seconds(mut self, seconds: f32) -> Self {
        self.max_audio_seconds = seconds;
        self
    }

    pub fn validate(&self) -> Result<(), SttError> {
        validate_model_file(&self.encoder_path, ErrorCode::ConfigEncoderPathEmpty)?;
        validate_model_file(&self.decoder_path, ErrorCode::ConfigDecoderPathEmpty)?;
        validate_model_file(&self.tokens_path, ErrorCode::ConfigTokensPathEmpty)?;
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&self.sample_rate) {
            return Err(SttError::InvalidConfig {
                code: ErrorCode::ConfigSampleRateRange,
            });
        }
        if self.feature_dim != DEFAULT_FEATURE_DIM {
            return Err(SttError::InvalidConfig {
                code: ErrorCode::ConfigFeatureDimRange,
            });
        }
        if !(1..=MAX_NUM_THREADS).contains(&self.num_threads) {
            return Err(SttError::InvalidConfig {
                code: ErrorCode::ConfigNumThreadsRange,
            });
        }
        validate_c_string_value(
            &self.provider,
            ErrorCode::ConfigProviderEmpty,
            ErrorCode::ConfigProviderNul,
        )?;
        validate_c_string_value(
            &self.decoding_method,
            ErrorCode::ConfigDecodingMethodEmpty,
            ErrorCode::ConfigDecodingMethodNul,
        )?;
        if self.max_active_paths <= 0 || self.max_active_paths > 128 {
            return Err(SttError::InvalidConfig {
                code: ErrorCode::ConfigMaxActivePathsRange,
            });
        }
        if !self.max_audio_seconds.is_finite()
            || self.max_audio_seconds < MIN_DURATION_SECONDS
            || self.max_audio_seconds > MAX_OFFLINE_STT_SECONDS
        {
            return Err(SttError::InvalidConfig {
                code: ErrorCode::ConfigMaxAudioSecondsRange,
            });
        }
        Ok(())
    }
}

impl fmt::Debug for OfflineSttConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfflineSttConfig")
            .field("encoder_path", &"<redacted>")
            .field("decoder_path", &"<redacted>")
            .field("tokens_path", &"<redacted>")
            .field("sample_rate", &self.sample_rate)
            .field("feature_dim", &self.feature_dim)
            .field("num_threads", &self.num_threads)
            .field("provider", &"<redacted>")
            .field("decoding_method", &self.decoding_method)
            .field("debug", &false)
            .field("max_active_paths", &self.max_active_paths)
            .field("max_audio_seconds", &self.max_audio_seconds)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct OfflineSttResult {
    text: String,
    tokens: Vec<String>,
    timestamps_millis: Vec<u32>,
    segment_texts: Vec<String>,
    segment_timestamps_millis: Vec<u32>,
}

impl OfflineSttResult {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn tokens(&self) -> &[String] {
        &self.tokens
    }

    pub fn timestamps_millis(&self) -> &[u32] {
        &self.timestamps_millis
    }

    pub fn segment_texts(&self) -> &[String] {
        &self.segment_texts
    }

    pub fn segment_timestamps_millis(&self) -> &[u32] {
        &self.segment_timestamps_millis
    }
}

impl fmt::Debug for OfflineSttResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfflineSttResult")
            .field("text", &"<redacted>")
            .field("text_bytes", &self.text.len())
            .field("token_count", &self.tokens.len())
            .field("timestamp_count", &self.timestamps_millis.len())
            .field("segment_count", &self.segment_texts.len())
            .finish()
    }
}

pub struct OfflineSttRecognizer {
    inner: native::OfflineRecognizer,
    sample_rate: i32,
    max_audio_seconds: f32,
    _not_send_sync: PhantomData<Rc<()>>,
}

impl fmt::Debug for OfflineSttRecognizer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfflineSttRecognizer")
            .field("inner", &"<redacted>")
            .field("sample_rate", &self.sample_rate)
            .field("send_sync", &"!Send + !Sync")
            .finish()
    }
}

impl OfflineSttRecognizer {
    pub fn new(config: &OfflineSttConfig) -> Result<Self, SttError> {
        config.validate()?;
        let inner = native::OfflineRecognizer::new(config)?;
        Ok(Self {
            inner,
            sample_rate: config.sample_rate(),
            max_audio_seconds: config.max_audio_seconds(),
            _not_send_sync: PhantomData,
        })
    }

    pub fn transcribe(
        &mut self,
        sample_rate: i32,
        pcm: &[f32],
    ) -> Result<OfflineSttResult, SttError> {
        let max_accept_samples = max_offline_samples_for_rate(sample_rate, self.max_audio_seconds)?;
        validate_offline_pcm(pcm, max_accept_samples)?;
        let mut stream = self.inner.create_stream()?;
        stream.accept_waveform(sample_rate, pcm)?;
        // sherpa-onnx 1.13.4 offline decoding is synchronous and exposes no
        // preemptive cancellation hook. Dropping this recognizer before or
        // after this call safely releases native resources; an in-flight decode
        // cannot be interrupted until the C call returns.
        self.inner.decode_stream(stream)
    }
}

impl fmt::Debug for VoiceActivityDetector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VoiceActivityDetector")
            .field("inner", &"<redacted>")
            .field("send_sync", &"!Send + !Sync")
            .finish()
    }
}

impl VoiceActivityDetector {
    pub fn new(config: &SileroVadConfig) -> Result<Self, VadError> {
        config.validate()?;
        let inner = native::Detector::new(config)?;
        Ok(Self {
            inner,
            max_accept_samples: config.window_size(),
            _not_send_sync: PhantomData,
        })
    }

    pub fn accept_waveform(&mut self, pcm: &[f32]) -> Result<(), VadError> {
        validate_pcm(pcm, self.max_accept_samples)?;
        self.ensure_no_queued_segment()?;
        self.inner.accept_waveform(pcm)
    }

    pub fn detected(&self) -> Result<bool, VadError> {
        self.inner.detected()
    }

    pub fn is_empty(&self) -> Result<bool, VadError> {
        self.inner.is_empty()
    }

    pub fn drain_speech_segments(&mut self) -> Result<Vec<SpeechSegment>, VadError> {
        self.inner.drain_speech_segments()
    }

    pub fn clear(&mut self) -> Result<(), VadError> {
        self.inner.clear()
    }

    pub fn reset(&mut self) -> Result<(), VadError> {
        self.inner.reset()
    }

    pub fn flush(&mut self) -> Result<(), VadError> {
        self.inner.flush()
    }

    fn ensure_no_queued_segment(&self) -> Result<(), VadError> {
        // sherpa-onnx 1.13.4 stores audio in a fixed CircularBuffer and
        // completed utterances in segments_. Accepting at most one model window
        // while segments_ is empty bounds the native queue without constraining
        // indefinite silence/background listening.
        if self.inner.is_empty()? {
            Ok(())
        } else {
            Err(VadError::InvalidWaveform {
                code: ErrorCode::WaveformQueuedSegmentUndrained,
            })
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    ConfigModelPathEmpty,
    ConfigModelPathNul,
    ConfigModelPathEncoding,
    ConfigThresholdRange,
    ConfigMinSilenceDurationRange,
    ConfigMinSpeechDurationRange,
    ConfigMaxSpeechDurationRange,
    ConfigWindowSizeRange,
    ConfigSampleRateRange,
    ConfigNumThreadsRange,
    ConfigProviderEmpty,
    ConfigProviderNul,
    ConfigBufferSizeSecondsRange,
    ConfigBufferSizeLessThanMaxSpeech,
    ConfigEncoderPathEmpty,
    ConfigEncoderPathNul,
    ConfigEncoderPathEncoding,
    ConfigEncoderPathUnreadable,
    ConfigDecoderPathEmpty,
    ConfigDecoderPathNul,
    ConfigDecoderPathEncoding,
    ConfigDecoderPathUnreadable,
    ConfigTokensPathEmpty,
    ConfigTokensPathNul,
    ConfigTokensPathEncoding,
    ConfigTokensPathUnreadable,
    ConfigFeatureDimRange,
    ConfigDecodingMethodEmpty,
    ConfigDecodingMethodNul,
    ConfigMaxActivePathsRange,
    ConfigMaxAudioSecondsRange,
    WaveformEmpty,
    WaveformTooLong,
    WaveformChunkTooLong,
    WaveformQueuedSegmentUndrained,
    WaveformNonFinite,
    WaveformOutOfRange,
    NativeUnavailable,
    NativeCreateFailed,
    NativeNullSegment,
    NativeSegmentCountExceeded,
    NativeInvalidSegmentStart,
    NativeInvalidSegmentLength,
    NativeSegmentLengthExceeded,
    NativeInvalidSegmentSamples,
    NativeInvalidSegmentSample,
    NativeNullRecognizer,
    NativeNullStream,
    NativeNullResult,
    NativeInvalidResultText,
    NativeInvalidResultToken,
    NativeInvalidResultTimestamp,
    NativeResultTextTooLong,
    NativeResultTokenCountExceeded,
    NativeResultTokenTooLong,
    NativeResultSegmentCountExceeded,
    StreamWaveformMissing,
    StreamWaveformAlreadyAccepted,
    StreamAlreadyDecoded,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConfigModelPathEmpty => "config.model_path_empty",
            Self::ConfigModelPathNul => "config.model_path_nul",
            Self::ConfigModelPathEncoding => "config.model_path_encoding",
            Self::ConfigThresholdRange => "config.threshold_range",
            Self::ConfigMinSilenceDurationRange => "config.min_silence_duration_range",
            Self::ConfigMinSpeechDurationRange => "config.min_speech_duration_range",
            Self::ConfigMaxSpeechDurationRange => "config.max_speech_duration_range",
            Self::ConfigWindowSizeRange => "config.window_size_range",
            Self::ConfigSampleRateRange => "config.sample_rate_range",
            Self::ConfigNumThreadsRange => "config.num_threads_range",
            Self::ConfigProviderEmpty => "config.provider_empty",
            Self::ConfigProviderNul => "config.provider_nul",
            Self::ConfigBufferSizeSecondsRange => "config.buffer_size_seconds_range",
            Self::ConfigBufferSizeLessThanMaxSpeech => "config.buffer_size_less_than_max_speech",
            Self::ConfigEncoderPathEmpty => "config.encoder_path_empty",
            Self::ConfigEncoderPathNul => "config.encoder_path_nul",
            Self::ConfigEncoderPathEncoding => "config.encoder_path_encoding",
            Self::ConfigEncoderPathUnreadable => "config.encoder_path_unreadable",
            Self::ConfigDecoderPathEmpty => "config.decoder_path_empty",
            Self::ConfigDecoderPathNul => "config.decoder_path_nul",
            Self::ConfigDecoderPathEncoding => "config.decoder_path_encoding",
            Self::ConfigDecoderPathUnreadable => "config.decoder_path_unreadable",
            Self::ConfigTokensPathEmpty => "config.tokens_path_empty",
            Self::ConfigTokensPathNul => "config.tokens_path_nul",
            Self::ConfigTokensPathEncoding => "config.tokens_path_encoding",
            Self::ConfigTokensPathUnreadable => "config.tokens_path_unreadable",
            Self::ConfigFeatureDimRange => "config.feature_dim_range",
            Self::ConfigDecodingMethodEmpty => "config.decoding_method_empty",
            Self::ConfigDecodingMethodNul => "config.decoding_method_nul",
            Self::ConfigMaxActivePathsRange => "config.max_active_paths_range",
            Self::ConfigMaxAudioSecondsRange => "config.max_audio_seconds_range",
            Self::WaveformEmpty => "waveform.empty",
            Self::WaveformTooLong => "waveform.too_long",
            Self::WaveformChunkTooLong => "waveform.chunk_too_long",
            Self::WaveformQueuedSegmentUndrained => "waveform.queued_segment_undrained",
            Self::WaveformNonFinite => "waveform.nonfinite",
            Self::WaveformOutOfRange => "waveform.out_of_range",
            Self::NativeUnavailable => "native.unavailable",
            Self::NativeCreateFailed => "native.create_failed",
            Self::NativeNullSegment => "native.null_segment",
            Self::NativeSegmentCountExceeded => "native.segment_count_exceeded",
            Self::NativeInvalidSegmentStart => "native.invalid_segment_start",
            Self::NativeInvalidSegmentLength => "native.invalid_segment_length",
            Self::NativeSegmentLengthExceeded => "native.segment_length_exceeded",
            Self::NativeInvalidSegmentSamples => "native.invalid_segment_samples",
            Self::NativeInvalidSegmentSample => "native.invalid_segment_sample",
            Self::NativeNullRecognizer => "native.null_recognizer",
            Self::NativeNullStream => "native.null_stream",
            Self::NativeNullResult => "native.null_result",
            Self::NativeInvalidResultText => "native.invalid_result_text",
            Self::NativeInvalidResultToken => "native.invalid_result_token",
            Self::NativeInvalidResultTimestamp => "native.invalid_result_timestamp",
            Self::NativeResultTextTooLong => "native.result_text_too_long",
            Self::NativeResultTokenCountExceeded => "native.result_token_count_exceeded",
            Self::NativeResultTokenTooLong => "native.result_token_too_long",
            Self::NativeResultSegmentCountExceeded => "native.result_segment_count_exceeded",
            Self::StreamWaveformMissing => "stream.waveform_missing",
            Self::StreamWaveformAlreadyAccepted => "stream.waveform_already_accepted",
            Self::StreamAlreadyDecoded => "stream.already_decoded",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VadError {
    InvalidConfig { code: ErrorCode },
    InvalidWaveform { code: ErrorCode },
    NativeUnavailable,
    NativeCreateFailed,
    NativeNullSegment,
    NativeSegmentCountExceeded,
    NativeInvalidSegmentStart,
    NativeInvalidSegmentLength,
    NativeSegmentLengthExceeded,
    NativeInvalidSegmentSamples,
    NativeInvalidSegmentSample,
}

impl VadError {
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidConfig { code } | Self::InvalidWaveform { code } => *code,
            Self::NativeUnavailable => ErrorCode::NativeUnavailable,
            Self::NativeCreateFailed => ErrorCode::NativeCreateFailed,
            Self::NativeNullSegment => ErrorCode::NativeNullSegment,
            Self::NativeSegmentCountExceeded => ErrorCode::NativeSegmentCountExceeded,
            Self::NativeInvalidSegmentStart => ErrorCode::NativeInvalidSegmentStart,
            Self::NativeInvalidSegmentLength => ErrorCode::NativeInvalidSegmentLength,
            Self::NativeSegmentLengthExceeded => ErrorCode::NativeSegmentLengthExceeded,
            Self::NativeInvalidSegmentSamples => ErrorCode::NativeInvalidSegmentSamples,
            Self::NativeInvalidSegmentSample => ErrorCode::NativeInvalidSegmentSample,
        }
    }
}

impl fmt::Display for VadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "sherpa vad error: {}", self.code())
    }
}

impl Error for VadError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttError {
    InvalidConfig { code: ErrorCode },
    InvalidWaveform { code: ErrorCode },
    InvalidLifecycle { code: ErrorCode },
    NativeUnavailable,
    NativeCreateFailed,
    NativeNullStream,
    NativeNullResult,
    NativeInvalidResultText,
    NativeInvalidResultToken,
    NativeInvalidResultTimestamp,
    NativeResultTextTooLong,
    NativeResultTokenCountExceeded,
    NativeResultTokenTooLong,
    NativeResultSegmentCountExceeded,
}

impl SttError {
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidConfig { code }
            | Self::InvalidWaveform { code }
            | Self::InvalidLifecycle { code } => *code,
            Self::NativeUnavailable => ErrorCode::NativeUnavailable,
            Self::NativeCreateFailed => ErrorCode::NativeNullRecognizer,
            Self::NativeNullStream => ErrorCode::NativeNullStream,
            Self::NativeNullResult => ErrorCode::NativeNullResult,
            Self::NativeInvalidResultText => ErrorCode::NativeInvalidResultText,
            Self::NativeInvalidResultToken => ErrorCode::NativeInvalidResultToken,
            Self::NativeInvalidResultTimestamp => ErrorCode::NativeInvalidResultTimestamp,
            Self::NativeResultTextTooLong => ErrorCode::NativeResultTextTooLong,
            Self::NativeResultTokenCountExceeded => ErrorCode::NativeResultTokenCountExceeded,
            Self::NativeResultTokenTooLong => ErrorCode::NativeResultTokenTooLong,
            Self::NativeResultSegmentCountExceeded => ErrorCode::NativeResultSegmentCountExceeded,
        }
    }
}

impl fmt::Display for SttError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "sherpa stt error: {}", self.code())
    }
}

impl Error for SttError {}

fn validate_threshold(value: f32) -> Result<(), VadError> {
    if value.is_finite() && (0.01..1.0).contains(&value) {
        Ok(())
    } else {
        Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigThresholdRange,
        })
    }
}

fn validate_positive_finite(value: f32, code: ErrorCode) -> Result<(), VadError> {
    if value.is_finite() && (MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&value) {
        Ok(())
    } else {
        Err(VadError::InvalidConfig { code })
    }
}

pub fn validate_pcm(pcm: &[f32], max_accept_samples: i32) -> Result<(), VadError> {
    let len = pcm_len_i32(pcm)?;
    if len > max_accept_samples {
        return Err(VadError::InvalidWaveform {
            code: ErrorCode::WaveformChunkTooLong,
        });
    }
    for sample in pcm {
        if !sample.is_finite() {
            return Err(VadError::InvalidWaveform {
                code: ErrorCode::WaveformNonFinite,
            });
        }
        if !(-1.0..=1.0).contains(sample) {
            return Err(VadError::InvalidWaveform {
                code: ErrorCode::WaveformOutOfRange,
            });
        }
    }
    Ok(())
}

pub fn validate_offline_pcm(pcm: &[f32], max_accept_samples: i32) -> Result<(), SttError> {
    let len = pcm_len_i32_for_stt(pcm)?;
    if len > max_accept_samples {
        return Err(SttError::InvalidWaveform {
            code: ErrorCode::WaveformTooLong,
        });
    }
    for sample in pcm {
        if !sample.is_finite() {
            return Err(SttError::InvalidWaveform {
                code: ErrorCode::WaveformNonFinite,
            });
        }
        if !(-1.0..=1.0).contains(sample) {
            return Err(SttError::InvalidWaveform {
                code: ErrorCode::WaveformOutOfRange,
            });
        }
    }
    Ok(())
}

fn max_offline_samples_for_rate(sample_rate: i32, max_audio_seconds: f32) -> Result<i32, SttError> {
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
        return Err(SttError::InvalidConfig {
            code: ErrorCode::ConfigSampleRateRange,
        });
    }
    let max = (sample_rate as f32 * max_audio_seconds).ceil();
    if !max.is_finite() || max < 1.0 || max > MAX_OFFLINE_STT_SAMPLES as f32 {
        return Err(SttError::InvalidConfig {
            code: ErrorCode::ConfigMaxAudioSecondsRange,
        });
    }
    i32::try_from(max as usize).map_err(|_| SttError::InvalidConfig {
        code: ErrorCode::ConfigMaxAudioSecondsRange,
    })
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SegmentBounds {
    max_segments: usize,
    max_segment_samples: usize,
}

impl SegmentBounds {
    pub(crate) fn from_config(config: &SileroVadConfig) -> Result<Self, VadError> {
        let max_segments = checked_ceil_to_usize(
            config.buffer_size_seconds() / config.min_speech_duration(),
            MAX_NATIVE_SEGMENTS.saturating_sub(1),
            ErrorCode::ConfigBufferSizeSecondsRange,
        )?
        .checked_add(1)
        .ok_or(VadError::InvalidConfig {
            code: ErrorCode::ConfigBufferSizeSecondsRange,
        })?;
        let max_segment_samples = checked_ceil_to_usize(
            config.sample_rate() as f32 * config.buffer_size_seconds(),
            MAX_NATIVE_SEGMENT_SAMPLES,
            ErrorCode::ConfigBufferSizeSecondsRange,
        )?;

        Ok(Self {
            max_segments,
            max_segment_samples,
        })
    }

    pub(crate) fn max_segments(self) -> usize {
        self.max_segments
    }

    pub(crate) fn max_segment_samples(self) -> usize {
        self.max_segment_samples
    }
}

fn checked_ceil_to_usize(value: f32, max: usize, code: ErrorCode) -> Result<usize, VadError> {
    if !value.is_finite() || value < 1.0 || value > max as f32 {
        return Err(VadError::InvalidConfig { code });
    }
    Ok(value.ceil() as usize)
}

#[cfg(any(
    test,
    all(
        any(feature = "native-vad", feature = "native-stt"),
        not(target_arch = "wasm32")
    )
))]
pub(crate) fn validate_native_segment_parts(
    start: i32,
    samples: &[f32],
    bounds: SegmentBounds,
) -> Result<(), VadError> {
    if start < 0 {
        return Err(VadError::NativeInvalidSegmentStart);
    }
    if samples.is_empty() {
        return Err(VadError::NativeInvalidSegmentLength);
    }
    if samples.len() > bounds.max_segment_samples() {
        return Err(VadError::NativeSegmentLengthExceeded);
    }
    for sample in samples {
        if !sample.is_finite() || !(-1.0..=1.0).contains(sample) {
            return Err(VadError::NativeInvalidSegmentSample);
        }
    }
    Ok(())
}

pub(crate) fn pcm_len_i32(pcm: &[f32]) -> Result<i32, VadError> {
    if pcm.is_empty() {
        return Err(VadError::InvalidWaveform {
            code: ErrorCode::WaveformEmpty,
        });
    }
    i32::try_from(pcm.len()).map_err(|_| VadError::InvalidWaveform {
        code: ErrorCode::WaveformTooLong,
    })
}

pub(crate) fn pcm_len_i32_for_stt(pcm: &[f32]) -> Result<i32, SttError> {
    if pcm.is_empty() {
        return Err(SttError::InvalidWaveform {
            code: ErrorCode::WaveformEmpty,
        });
    }
    i32::try_from(pcm.len()).map_err(|_| SttError::InvalidWaveform {
        code: ErrorCode::WaveformTooLong,
    })
}

fn validate_c_string_value(
    value: &str,
    empty_code: ErrorCode,
    nul_code: ErrorCode,
) -> Result<(), SttError> {
    if value.is_empty() {
        return Err(SttError::InvalidConfig { code: empty_code });
    }
    if value.as_bytes().contains(&0) {
        return Err(SttError::InvalidConfig { code: nul_code });
    }
    Ok(())
}

fn validate_model_file(path: &Path, empty_code: ErrorCode) -> Result<(), SttError> {
    if path.as_os_str().is_empty() {
        return Err(SttError::InvalidConfig { code: empty_code });
    }
    let bytes = path_bytes_for_stt(path, empty_code)?;
    if bytes.contains(&0) {
        return Err(SttError::InvalidConfig {
            code: model_path_nul_code(empty_code),
        });
    }
    let metadata = path.metadata().map_err(|_| SttError::InvalidConfig {
        code: model_path_unreadable_code(empty_code),
    })?;
    if !metadata.is_file() {
        return Err(SttError::InvalidConfig {
            code: model_path_unreadable_code(empty_code),
        });
    }
    File::open(path).map_err(|_| SttError::InvalidConfig {
        code: model_path_unreadable_code(empty_code),
    })?;
    Ok(())
}

fn model_path_nul_code(empty_code: ErrorCode) -> ErrorCode {
    match empty_code {
        ErrorCode::ConfigEncoderPathEmpty => ErrorCode::ConfigEncoderPathNul,
        ErrorCode::ConfigDecoderPathEmpty => ErrorCode::ConfigDecoderPathNul,
        ErrorCode::ConfigTokensPathEmpty => ErrorCode::ConfigTokensPathNul,
        _ => empty_code,
    }
}

#[cfg(not(unix))]
fn model_path_encoding_code(empty_code: ErrorCode) -> ErrorCode {
    match empty_code {
        ErrorCode::ConfigEncoderPathEmpty => ErrorCode::ConfigEncoderPathEncoding,
        ErrorCode::ConfigDecoderPathEmpty => ErrorCode::ConfigDecoderPathEncoding,
        ErrorCode::ConfigTokensPathEmpty => ErrorCode::ConfigTokensPathEncoding,
        _ => empty_code,
    }
}

fn model_path_unreadable_code(empty_code: ErrorCode) -> ErrorCode {
    match empty_code {
        ErrorCode::ConfigEncoderPathEmpty => ErrorCode::ConfigEncoderPathUnreadable,
        ErrorCode::ConfigDecoderPathEmpty => ErrorCode::ConfigDecoderPathUnreadable,
        ErrorCode::ConfigTokensPathEmpty => ErrorCode::ConfigTokensPathUnreadable,
        _ => empty_code,
    }
}

#[cfg(unix)]
pub(crate) fn path_bytes(path: &Path) -> Result<Vec<u8>, VadError> {
    use std::os::unix::ffi::OsStrExt;

    Ok(path.as_os_str().as_bytes().to_vec())
}

#[cfg(unix)]
pub(crate) fn path_bytes_for_stt(path: &Path, _empty_code: ErrorCode) -> Result<Vec<u8>, SttError> {
    use std::os::unix::ffi::OsStrExt;

    Ok(path.as_os_str().as_bytes().to_vec())
}

#[cfg(not(unix))]
pub(crate) fn path_bytes(path: &Path) -> Result<Vec<u8>, VadError> {
    let value = path.as_os_str().to_str().ok_or(VadError::InvalidConfig {
        code: ErrorCode::ConfigModelPathEncoding,
    })?;
    Ok(value.as_bytes().to_vec())
}

#[cfg(not(unix))]
pub(crate) fn path_bytes_for_stt(path: &Path, empty_code: ErrorCode) -> Result<Vec<u8>, SttError> {
    let value = path.as_os_str().to_str().ok_or(SttError::InvalidConfig {
        code: model_path_encoding_code(empty_code),
    })?;
    Ok(value.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_for_model_path_validates() {
        let config = SileroVadConfig::new("silero-vad.onnx");

        assert_eq!(config.threshold(), DEFAULT_THRESHOLD);
        assert_eq!(config.window_size(), DEFAULT_WINDOW_SIZE);
        assert_eq!(config.provider(), DEFAULT_PROVIDER);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn config_validation_uses_stable_redacted_codes() {
        let secret_path = "/tmp/private-user-token/silero-vad.onnx";
        let error = SileroVadConfig::new(secret_path)
            .with_threshold(f32::NAN)
            .validate()
            .expect_err("nan threshold should be rejected");

        assert_eq!(error.code(), ErrorCode::ConfigThresholdRange);
        assert_eq!(
            error.to_string(),
            "sherpa vad error: config.threshold_range"
        );
        assert!(!error.to_string().contains(secret_path));
    }

    #[test]
    fn debug_output_redacts_sensitive_config_and_pcm() {
        let config =
            SileroVadConfig::new("/tmp/private-user-token/silero-vad.onnx").with_provider("cuda");
        let segment = SpeechSegment {
            start: 5728,
            samples: vec![0.1, -0.2, 0.3],
        };
        let detector_error = VoiceActivityDetector::new(&config)
            .expect_err("default build should not create native detector");

        let config_debug = format!("{config:?}");
        let segment_debug = format!("{segment:?}");
        let detector_error_debug = format!("{detector_error:?}");

        assert!(config_debug.contains("model_path: \"<redacted>\""));
        assert!(config_debug.contains("provider: \"<redacted>\""));
        assert!(!config_debug.contains("private-user-token"));
        assert!(!config_debug.contains("cuda"));
        assert!(segment_debug.contains("sample_count: 3"));
        assert!(segment_debug.contains("samples: \"<redacted>\""));
        assert!(!segment_debug.contains("0.1"));
        assert!(!detector_error_debug.contains("private-user-token"));
    }

    #[test]
    fn threshold_edges_match_silero_constraints() {
        let valid = SileroVadConfig::new("silero-vad.onnx").with_threshold(0.01);
        assert!(valid.validate().is_ok());

        for threshold in [0.009_999, 1.0, f32::INFINITY] {
            let error = SileroVadConfig::new("silero-vad.onnx")
                .with_threshold(threshold)
                .validate()
                .expect_err("threshold edge should be rejected");
            assert_eq!(error.code(), ErrorCode::ConfigThresholdRange);
        }
    }

    #[test]
    fn invalid_config_cases_are_rejected() {
        let cases = [
            (SileroVadConfig::new(""), ErrorCode::ConfigModelPathEmpty),
            (
                SileroVadConfig::new("silero-vad.onnx").with_min_silence_duration(0.0),
                ErrorCode::ConfigMinSilenceDurationRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_min_silence_duration(0.000_1),
                ErrorCode::ConfigMinSilenceDurationRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_min_silence_duration(301.0),
                ErrorCode::ConfigMinSilenceDurationRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_min_speech_duration(-0.1),
                ErrorCode::ConfigMinSpeechDurationRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_min_speech_duration(0.0),
                ErrorCode::ConfigMinSpeechDurationRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_max_speech_duration(f32::INFINITY),
                ErrorCode::ConfigMaxSpeechDurationRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_window_size(0),
                ErrorCode::ConfigWindowSizeRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_window_size(MAX_WINDOW_SIZE + 1),
                ErrorCode::ConfigWindowSizeRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_sample_rate(MIN_SAMPLE_RATE - 1),
                ErrorCode::ConfigSampleRateRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_sample_rate(MAX_SAMPLE_RATE + 1),
                ErrorCode::ConfigSampleRateRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_num_threads(0),
                ErrorCode::ConfigNumThreadsRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_num_threads(MAX_NUM_THREADS + 1),
                ErrorCode::ConfigNumThreadsRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_provider(""),
                ErrorCode::ConfigProviderEmpty,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_buffer_size_seconds(0.0),
                ErrorCode::ConfigBufferSizeSecondsRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx")
                    .with_buffer_size_seconds(5.0)
                    .with_max_speech_duration(10.0),
                ErrorCode::ConfigBufferSizeLessThanMaxSpeech,
            ),
        ];

        for (config, code) in cases {
            let error = config.validate().expect_err("config should be rejected");
            assert_eq!(error.code(), code);
        }
    }

    #[test]
    fn waveform_validation_rejects_empty_nonfinite_and_out_of_range() {
        let cases = [
            (&[][..], ErrorCode::WaveformEmpty),
            (&[0.0, f32::NAN][..], ErrorCode::WaveformNonFinite),
            (&[0.0, 1.01][..], ErrorCode::WaveformOutOfRange),
            (&[0.0, -1.01][..], ErrorCode::WaveformOutOfRange),
        ];

        for (pcm, code) in cases {
            let error = validate_pcm(pcm, 512).expect_err("pcm should be rejected");
            assert_eq!(error.code(), code);
        }

        let too_long = vec![0.0; 513];
        let error = validate_pcm(&too_long, 512).expect_err("chunk should be rejected");
        assert_eq!(error.code(), ErrorCode::WaveformChunkTooLong);

        validate_pcm(&too_long[..512], 512).expect("window-sized chunk should validate");
    }

    #[test]
    fn native_segment_validation_rejects_invalid_bounds_and_samples() {
        let derived_bounds = SegmentBounds::from_config(
            &SileroVadConfig::new("silero-vad.onnx")
                .with_min_speech_duration(0.25)
                .with_buffer_size_seconds(30.0),
        )
        .expect("bounds should derive");
        assert_eq!(derived_bounds.max_segments(), 121);
        assert_eq!(derived_bounds.max_segment_samples(), 480_000);

        let bounds = SegmentBounds {
            max_segments: 2,
            max_segment_samples: 3,
        };

        let cases = [
            (
                validate_native_segment_parts(-1, &[0.0], bounds),
                ErrorCode::NativeInvalidSegmentStart,
            ),
            (
                validate_native_segment_parts(1, &[], bounds),
                ErrorCode::NativeInvalidSegmentLength,
            ),
            (
                validate_native_segment_parts(1, &[0.0, 0.0, 0.0, 0.0], bounds),
                ErrorCode::NativeSegmentLengthExceeded,
            ),
            (
                validate_native_segment_parts(1, &[0.0, f32::NAN], bounds),
                ErrorCode::NativeInvalidSegmentSample,
            ),
            (
                validate_native_segment_parts(1, &[0.0, 1.01], bounds),
                ErrorCode::NativeInvalidSegmentSample,
            ),
        ];

        for (result, code) in cases {
            let error = result.expect_err("native segment should be rejected");
            assert_eq!(error.code(), code);
        }

        validate_native_segment_parts(0, &[0.0, -1.0, 1.0], bounds)
            .expect("bounded native segment should validate");
        assert_eq!(bounds.max_segments(), 2);
    }

    #[test]
    fn default_build_does_not_link_native_vad() {
        let config = SileroVadConfig::new("silero-vad.onnx");
        let error = VoiceActivityDetector::new(&config).expect_err("native feature is off");

        assert_eq!(error.code(), ErrorCode::NativeUnavailable);
    }
}
