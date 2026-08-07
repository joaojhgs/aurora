//! Safe containment for pinned sherpa-onnx v1.13.4 native speech C ABIs.
//!
//! The crate intentionally exposes only a small RAII API. Raw C layouts and all
//! unsafe calls remain private to the native implementation module.

use std::error::Error;
use std::fmt;
#[cfg(any(
    all(feature = "native-vad", not(target_arch = "wasm32")),
    all(feature = "native-kws", not(target_arch = "wasm32"))
))]
use std::fs;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[cfg(all(feature = "native-vad", not(target_arch = "wasm32")))]
mod native;

#[cfg(not(all(feature = "native-vad", not(target_arch = "wasm32"))))]
mod native {
    use super::{SileroVadConfig, SpeechSegment, VadError};

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
}

#[cfg(all(feature = "native-kws", not(target_arch = "wasm32")))]
mod native_kws;

#[cfg(not(all(feature = "native-kws", not(target_arch = "wasm32"))))]
mod native_kws {
    use super::{KeywordResult, KeywordSpotterConfig, VadError};

    pub(crate) struct Spotter;
    pub(crate) struct Stream;

    impl std::fmt::Debug for Spotter {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("KeywordSpotter")
                .field("native", &"unavailable")
                .finish()
        }
    }

    impl Spotter {
        pub(crate) fn new(_config: &KeywordSpotterConfig) -> Result<Self, VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn create_stream(&self) -> Result<Stream, VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn accept_waveform(
            &self,
            _stream: &mut Stream,
            _sample_rate: i32,
            _pcm: &[f32],
        ) -> Result<(), VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn input_finished(&self, _stream: &mut Stream) -> Result<(), VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn reset(&self, _stream: &mut Stream) -> Result<(), VadError> {
            Err(VadError::NativeUnavailable)
        }

        pub(crate) fn decode_ready(
            &self,
            _stream: &mut Stream,
            _max_decode_steps: usize,
        ) -> Result<Vec<KeywordResult>, VadError> {
            Err(VadError::NativeUnavailable)
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
const DEFAULT_KWS_FEATURE_DIM: i32 = 80;
const DEFAULT_KWS_MAX_ACTIVE_PATHS: i32 = 4;
const DEFAULT_KWS_NUM_TRAILING_BLANKS: i32 = 1;
const DEFAULT_KWS_SCORE: f32 = 3.0;
const DEFAULT_KWS_THRESHOLD: f32 = 0.1;
const DEFAULT_KWS_MAX_DECODE_STEPS: usize = 4096;
const MAX_KWS_CHUNK_SAMPLES: i32 = 16_000;
const MAX_KWS_KEYWORDS_BYTES: usize = 4096;
#[cfg(all(feature = "native-kws", not(target_arch = "wasm32")))]
const MAX_KWS_RESULT_STRING_BYTES: usize = 4096;
#[cfg(all(feature = "native-kws", not(target_arch = "wasm32")))]
const MAX_KWS_RESULT_JSON_BYTES: usize = 8192;
#[cfg(all(feature = "native-kws", not(target_arch = "wasm32")))]
const MAX_KWS_RESULT_TOKENS: usize = 128;

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

#[derive(Clone)]
pub struct KeywordSpotterConfig {
    encoder_path: PathBuf,
    decoder_path: PathBuf,
    joiner_path: PathBuf,
    tokens_path: PathBuf,
    keywords: String,
    sample_rate: i32,
    feature_dim: i32,
    num_threads: i32,
    provider: String,
    max_active_paths: i32,
    num_trailing_blanks: i32,
    keywords_score: f32,
    keywords_threshold: f32,
    max_decode_steps: usize,
}

impl KeywordSpotterConfig {
    pub fn new(
        encoder_path: impl Into<PathBuf>,
        decoder_path: impl Into<PathBuf>,
        joiner_path: impl Into<PathBuf>,
        tokens_path: impl Into<PathBuf>,
        keywords: impl Into<String>,
    ) -> Self {
        Self {
            encoder_path: encoder_path.into(),
            decoder_path: decoder_path.into(),
            joiner_path: joiner_path.into(),
            tokens_path: tokens_path.into(),
            keywords: keywords.into(),
            sample_rate: DEFAULT_SAMPLE_RATE,
            feature_dim: DEFAULT_KWS_FEATURE_DIM,
            num_threads: DEFAULT_NUM_THREADS,
            provider: DEFAULT_PROVIDER.to_owned(),
            max_active_paths: DEFAULT_KWS_MAX_ACTIVE_PATHS,
            num_trailing_blanks: DEFAULT_KWS_NUM_TRAILING_BLANKS,
            keywords_score: DEFAULT_KWS_SCORE,
            keywords_threshold: DEFAULT_KWS_THRESHOLD,
            max_decode_steps: DEFAULT_KWS_MAX_DECODE_STEPS,
        }
    }

    pub fn encoder_path(&self) -> &Path {
        &self.encoder_path
    }

    pub fn decoder_path(&self) -> &Path {
        &self.decoder_path
    }

    pub fn joiner_path(&self) -> &Path {
        &self.joiner_path
    }

    pub fn tokens_path(&self) -> &Path {
        &self.tokens_path
    }

    pub fn keywords(&self) -> &str {
        &self.keywords
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

    pub fn max_active_paths(&self) -> i32 {
        self.max_active_paths
    }

    pub fn num_trailing_blanks(&self) -> i32 {
        self.num_trailing_blanks
    }

    pub fn keywords_score(&self) -> f32 {
        self.keywords_score
    }

    pub fn keywords_threshold(&self) -> f32 {
        self.keywords_threshold
    }

    pub fn max_decode_steps(&self) -> usize {
        self.max_decode_steps
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

    pub fn with_keywords_score(mut self, score: f32) -> Self {
        self.keywords_score = score;
        self
    }

    pub fn with_keywords_threshold(mut self, threshold: f32) -> Self {
        self.keywords_threshold = threshold;
        self
    }

    pub fn with_max_decode_steps(mut self, steps: usize) -> Self {
        self.max_decode_steps = steps;
        self
    }

    pub fn validate(&self) -> Result<(), VadError> {
        for path in [
            &self.encoder_path,
            &self.decoder_path,
            &self.joiner_path,
            &self.tokens_path,
        ] {
            validate_path_syntax(path)?;
        }
        if self.keywords.is_empty() {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigKeywordsEmpty,
            });
        }
        if self.keywords.as_bytes().contains(&0) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigKeywordsNul,
            });
        }
        if self.keywords.len() > MAX_KWS_KEYWORDS_BYTES {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigKeywordsTooLong,
            });
        }
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&self.sample_rate) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigSampleRateRange,
            });
        }
        if !(1..=256).contains(&self.feature_dim) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigFeatureDimRange,
            });
        }
        if !(1..=MAX_NUM_THREADS).contains(&self.num_threads) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigNumThreadsRange,
            });
        }
        validate_provider(&self.provider)?;
        if !(1..=128).contains(&self.max_active_paths) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigMaxActivePathsRange,
            });
        }
        if !(0..=16).contains(&self.num_trailing_blanks) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigNumTrailingBlanksRange,
            });
        }
        validate_positive_score(self.keywords_score, ErrorCode::ConfigKeywordsScoreRange)?;
        validate_threshold(self.keywords_threshold)?;
        if self.max_decode_steps == 0 || self.max_decode_steps > DEFAULT_KWS_MAX_DECODE_STEPS {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigMaxDecodeStepsRange,
            });
        }
        Ok(())
    }
}

impl fmt::Debug for KeywordSpotterConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordSpotterConfig")
            .field("encoder_path", &"<redacted>")
            .field("decoder_path", &"<redacted>")
            .field("joiner_path", &"<redacted>")
            .field("tokens_path", &"<redacted>")
            .field("keywords", &"<redacted>")
            .field("sample_rate", &self.sample_rate)
            .field("feature_dim", &self.feature_dim)
            .field("num_threads", &self.num_threads)
            .field("provider", &"<redacted>")
            .field("max_active_paths", &self.max_active_paths)
            .field("num_trailing_blanks", &self.num_trailing_blanks)
            .field("keywords_score", &self.keywords_score)
            .field("keywords_threshold", &self.keywords_threshold)
            .field("max_decode_steps", &self.max_decode_steps)
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub struct KeywordResult {
    pub keyword: String,
    pub tokens: Vec<String>,
    pub timestamps: Vec<f32>,
    pub start_time: f32,
    pub json: String,
}

impl fmt::Debug for KeywordResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordResult")
            .field("keyword", &"<redacted>")
            .field("token_count", &self.tokens.len())
            .field("tokens", &"<redacted>")
            .field("timestamps", &"<redacted>")
            .field("start_time", &self.start_time)
            .field("json", &"<redacted>")
            .finish()
    }
}

struct KeywordSpotter {
    inner: native_kws::Spotter,
    max_decode_steps: usize,
    _not_send_sync: PhantomData<Rc<()>>,
}

struct KeywordStream {
    inner: native_kws::Stream,
    input_finished: bool,
    _not_send_sync: PhantomData<Rc<()>>,
}

pub struct KeywordSession {
    // Drop order is declaration order. The native stream must be destroyed
    // before the spotter that created it.
    stream: KeywordStream,
    spotter: KeywordSpotter,
    _not_send_sync: PhantomData<Rc<()>>,
}

impl fmt::Debug for KeywordSpotter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordSpotter")
            .field("inner", &"<redacted>")
            .field("send_sync", &"!Send + !Sync")
            .finish()
    }
}

impl fmt::Debug for KeywordStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordStream")
            .field("inner", &"<redacted>")
            .field("input_finished", &self.input_finished)
            .field("send_sync", &"!Send + !Sync")
            .finish()
    }
}

impl fmt::Debug for KeywordSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordSession")
            .field("spotter", &"<redacted>")
            .field("stream", &"<redacted>")
            .field("send_sync", &"!Send + !Sync")
            .finish()
    }
}

impl KeywordSpotter {
    fn new(config: &KeywordSpotterConfig) -> Result<Self, VadError> {
        config.validate()?;
        Ok(Self {
            inner: native_kws::Spotter::new(config)?,
            max_decode_steps: config.max_decode_steps(),
            _not_send_sync: PhantomData,
        })
    }

    fn create_stream(&self) -> Result<KeywordStream, VadError> {
        Ok(KeywordStream {
            inner: self.inner.create_stream()?,
            input_finished: false,
            _not_send_sync: PhantomData,
        })
    }
}

impl KeywordSession {
    pub fn new(config: &KeywordSpotterConfig) -> Result<Self, VadError> {
        let spotter = KeywordSpotter::new(config)?;
        let stream = spotter.create_stream()?;
        Ok(Self {
            stream,
            spotter,
            _not_send_sync: PhantomData,
        })
    }

    pub fn accept_waveform(
        &mut self,
        sample_rate: i32,
        pcm: &[f32],
    ) -> Result<Vec<KeywordResult>, VadError> {
        if self.stream.input_finished {
            return Err(VadError::InvalidWaveform {
                code: ErrorCode::WaveformInputFinished,
            });
        }
        validate_kws_pcm(sample_rate, pcm)?;
        self.spotter
            .inner
            .accept_waveform(&mut self.stream.inner, sample_rate, pcm)?;
        self.spotter
            .inner
            .decode_ready(&mut self.stream.inner, self.spotter.max_decode_steps)
    }

    pub fn input_finished(&mut self) -> Result<Vec<KeywordResult>, VadError> {
        if !self.stream.input_finished {
            self.spotter.inner.input_finished(&mut self.stream.inner)?;
            self.stream.input_finished = true;
        }
        self.spotter
            .inner
            .decode_ready(&mut self.stream.inner, self.spotter.max_decode_steps)
    }

    pub fn reset(&mut self) -> Result<(), VadError> {
        self.spotter.inner.reset(&mut self.stream.inner)?;
        self.stream.input_finished = false;
        Ok(())
    }

    pub fn cancel(&mut self) -> Result<(), VadError> {
        self.reset()
    }
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
    ConfigModelPathUnavailable,
    ConfigThresholdRange,
    ConfigFeatureDimRange,
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
    ConfigKeywordsEmpty,
    ConfigKeywordsNul,
    ConfigKeywordsTooLong,
    ConfigKeywordsScoreRange,
    ConfigMaxActivePathsRange,
    ConfigNumTrailingBlanksRange,
    ConfigMaxDecodeStepsRange,
    WaveformEmpty,
    WaveformTooLong,
    WaveformChunkTooLong,
    WaveformQueuedSegmentUndrained,
    WaveformInputFinished,
    WaveformNonFinite,
    WaveformOutOfRange,
    NativeUnavailable,
    NativeCreateFailed,
    NativeStreamCreateFailed,
    NativeKeywordResultNull,
    NativeDecodeStepLimitExceeded,
    NativeResultStringTooLong,
    NativeResultTokenCountExceeded,
    NativeResultTimestampCount,
    NativeResultInvalidUtf8,
    NativeNullSegment,
    NativeSegmentCountExceeded,
    NativeInvalidSegmentStart,
    NativeInvalidSegmentLength,
    NativeSegmentLengthExceeded,
    NativeInvalidSegmentSamples,
    NativeInvalidSegmentSample,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConfigModelPathEmpty => "config.model_path_empty",
            Self::ConfigModelPathNul => "config.model_path_nul",
            Self::ConfigModelPathEncoding => "config.model_path_encoding",
            Self::ConfigModelPathUnavailable => "config.model_path_unavailable",
            Self::ConfigThresholdRange => "config.threshold_range",
            Self::ConfigFeatureDimRange => "config.feature_dim_range",
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
            Self::ConfigKeywordsEmpty => "config.keywords_empty",
            Self::ConfigKeywordsNul => "config.keywords_nul",
            Self::ConfigKeywordsTooLong => "config.keywords_too_long",
            Self::ConfigKeywordsScoreRange => "config.keywords_score_range",
            Self::ConfigMaxActivePathsRange => "config.max_active_paths_range",
            Self::ConfigNumTrailingBlanksRange => "config.num_trailing_blanks_range",
            Self::ConfigMaxDecodeStepsRange => "config.max_decode_steps_range",
            Self::WaveformEmpty => "waveform.empty",
            Self::WaveformTooLong => "waveform.too_long",
            Self::WaveformChunkTooLong => "waveform.chunk_too_long",
            Self::WaveformQueuedSegmentUndrained => "waveform.queued_segment_undrained",
            Self::WaveformInputFinished => "waveform.input_finished",
            Self::WaveformNonFinite => "waveform.nonfinite",
            Self::WaveformOutOfRange => "waveform.out_of_range",
            Self::NativeUnavailable => "native.unavailable",
            Self::NativeCreateFailed => "native.create_failed",
            Self::NativeStreamCreateFailed => "native.stream_create_failed",
            Self::NativeKeywordResultNull => "native.keyword_result_null",
            Self::NativeDecodeStepLimitExceeded => "native.decode_step_limit_exceeded",
            Self::NativeResultStringTooLong => "native.result_string_too_long",
            Self::NativeResultTokenCountExceeded => "native.result_token_count_exceeded",
            Self::NativeResultTimestampCount => "native.result_timestamp_count",
            Self::NativeResultInvalidUtf8 => "native.result_invalid_utf8",
            Self::NativeNullSegment => "native.null_segment",
            Self::NativeSegmentCountExceeded => "native.segment_count_exceeded",
            Self::NativeInvalidSegmentStart => "native.invalid_segment_start",
            Self::NativeInvalidSegmentLength => "native.invalid_segment_length",
            Self::NativeSegmentLengthExceeded => "native.segment_length_exceeded",
            Self::NativeInvalidSegmentSamples => "native.invalid_segment_samples",
            Self::NativeInvalidSegmentSample => "native.invalid_segment_sample",
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
    NativeStreamCreateFailed,
    NativeKeywordResultNull,
    NativeDecodeStepLimitExceeded,
    NativeResultStringTooLong,
    NativeResultTokenCountExceeded,
    NativeResultTimestampCount,
    NativeResultInvalidUtf8,
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
            Self::NativeStreamCreateFailed => ErrorCode::NativeStreamCreateFailed,
            Self::NativeKeywordResultNull => ErrorCode::NativeKeywordResultNull,
            Self::NativeDecodeStepLimitExceeded => ErrorCode::NativeDecodeStepLimitExceeded,
            Self::NativeResultStringTooLong => ErrorCode::NativeResultStringTooLong,
            Self::NativeResultTokenCountExceeded => ErrorCode::NativeResultTokenCountExceeded,
            Self::NativeResultTimestampCount => ErrorCode::NativeResultTimestampCount,
            Self::NativeResultInvalidUtf8 => ErrorCode::NativeResultInvalidUtf8,
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

fn validate_threshold(value: f32) -> Result<(), VadError> {
    if value.is_finite() && (0.01..1.0).contains(&value) {
        Ok(())
    } else {
        Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigThresholdRange,
        })
    }
}

fn validate_positive_score(value: f32, code: ErrorCode) -> Result<(), VadError> {
    if value.is_finite() && (0.0..=10.0).contains(&value) {
        Ok(())
    } else {
        Err(VadError::InvalidConfig { code })
    }
}

fn validate_positive_finite(value: f32, code: ErrorCode) -> Result<(), VadError> {
    if value.is_finite() && (MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&value) {
        Ok(())
    } else {
        Err(VadError::InvalidConfig { code })
    }
}

fn validate_provider(provider: &str) -> Result<(), VadError> {
    if provider.is_empty() {
        return Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigProviderEmpty,
        });
    }
    if provider.as_bytes().contains(&0) {
        return Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigProviderNul,
        });
    }
    Ok(())
}

fn validate_path_syntax(path: &Path) -> Result<(), VadError> {
    if path.as_os_str().is_empty() {
        return Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigModelPathEmpty,
        });
    }
    let value = path_bytes(path)?;
    if value.contains(&0) {
        return Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigModelPathNul,
        });
    }
    Ok(())
}

#[cfg(any(
    all(feature = "native-vad", not(target_arch = "wasm32")),
    all(feature = "native-kws", not(target_arch = "wasm32"))
))]
pub(crate) fn preflight_existing_readable_file(path: &Path) -> Result<(), VadError> {
    validate_path_syntax(path)?;
    let metadata = fs::metadata(path).map_err(|_| VadError::InvalidConfig {
        code: ErrorCode::ConfigModelPathUnavailable,
    })?;
    if !metadata.is_file() {
        return Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigModelPathUnavailable,
        });
    }
    fs::File::open(path).map_err(|_| VadError::InvalidConfig {
        code: ErrorCode::ConfigModelPathUnavailable,
    })?;
    Ok(())
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

pub fn validate_kws_pcm(sample_rate: i32, pcm: &[f32]) -> Result<(), VadError> {
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
        return Err(VadError::InvalidConfig {
            code: ErrorCode::ConfigSampleRateRange,
        });
    }
    validate_pcm(pcm, MAX_KWS_CHUNK_SAMPLES)
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

#[cfg(any(test, all(feature = "native-vad", not(target_arch = "wasm32"))))]
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

#[cfg(unix)]
pub(crate) fn path_bytes(path: &Path) -> Result<Vec<u8>, VadError> {
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
        let kws_config = KeywordSpotterConfig::new(
            "/tmp/private-user-token/encoder.onnx",
            "/tmp/private-user-token/decoder.onnx",
            "/tmp/private-user-token/joiner.onnx",
            "/tmp/private-user-token/tokens.txt",
            "secret keyword",
        )
        .with_provider("cuda");
        let segment = SpeechSegment {
            start: 5728,
            samples: vec![0.1, -0.2, 0.3],
        };
        let detector_error = VoiceActivityDetector::new(&config)
            .expect_err("default build should not create native detector");

        let config_debug = format!("{config:?}");
        let kws_config_debug = format!("{kws_config:?}");
        let segment_debug = format!("{segment:?}");
        let detector_error_debug = format!("{detector_error:?}");

        assert!(config_debug.contains("model_path: \"<redacted>\""));
        assert!(config_debug.contains("provider: \"<redacted>\""));
        assert!(!config_debug.contains("private-user-token"));
        assert!(!config_debug.contains("cuda"));
        assert!(kws_config_debug.contains("encoder_path: \"<redacted>\""));
        assert!(kws_config_debug.contains("keywords: \"<redacted>\""));
        assert!(!kws_config_debug.contains("private-user-token"));
        assert!(!kws_config_debug.contains("secret keyword"));
        assert!(!kws_config_debug.contains("cuda"));
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
    fn kws_config_validation_uses_stable_redacted_codes() {
        let valid = KeywordSpotterConfig::new(
            "encoder.onnx",
            "decoder.onnx",
            "joiner.onnx",
            "tokens.txt",
            "keyword",
        );
        assert!(valid.validate().is_ok());

        let empty_keywords = KeywordSpotterConfig::new(
            "encoder.onnx",
            "decoder.onnx",
            "joiner.onnx",
            "tokens.txt",
            "",
        )
        .validate()
        .expect_err("empty keyword buffer should fail");
        assert_eq!(empty_keywords.code(), ErrorCode::ConfigKeywordsEmpty);

        let invalid_score = KeywordSpotterConfig::new(
            "encoder.onnx",
            "decoder.onnx",
            "joiner.onnx",
            "tokens.txt",
            "keyword",
        )
        .with_keywords_score(f32::NAN)
        .validate()
        .expect_err("nan keyword score should fail");
        assert_eq!(invalid_score.code(), ErrorCode::ConfigKeywordsScoreRange);
        assert!(!invalid_score.to_string().contains("encoder.onnx"));
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

    #[cfg(not(any(feature = "native-vad", feature = "native-kws")))]
    #[test]
    fn default_build_does_not_link_native_vad() {
        let config = SileroVadConfig::new("silero-vad.onnx");
        let error = VoiceActivityDetector::new(&config).expect_err("native feature is off");

        assert_eq!(error.code(), ErrorCode::NativeUnavailable);
    }
}
