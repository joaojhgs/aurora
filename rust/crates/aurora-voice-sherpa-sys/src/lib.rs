//! Safe containment for the pinned sherpa-onnx v1.13.4 Silero VAD C ABI.
//!
//! The crate intentionally exposes only a small RAII API. Raw C layouts and all
//! unsafe calls remain private to the native implementation module.

use std::error::Error;
use std::fmt;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::rc::Rc;

#[cfg(all(feature = "native-vad", not(target_arch = "wasm32")))]
mod native;

#[cfg(not(all(feature = "native-vad", not(target_arch = "wasm32"))))]
mod native {
    use super::{SileroVadConfig, SpeechSegment, VadError};

    #[derive(Debug)]
    pub(crate) struct Detector;

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

#[derive(Debug, Clone)]
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
        if path_bytes(&self.model_path).contains(&0) {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigModelPathNul,
            });
        }
        validate_probability(self.threshold, ErrorCode::ConfigThresholdRange)?;
        validate_positive_finite(
            self.min_silence_duration,
            ErrorCode::ConfigMinSilenceDurationRange,
        )?;
        validate_nonnegative_finite(
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
        if self.sample_rate <= 0 {
            return Err(VadError::InvalidConfig {
                code: ErrorCode::ConfigSampleRateRange,
            });
        }
        if self.num_threads <= 0 {
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
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpeechSegment {
    pub start: i32,
    pub samples: Vec<f32>,
}

#[derive(Debug)]
pub struct VoiceActivityDetector {
    inner: native::Detector,
    _not_send_sync: PhantomData<Rc<()>>,
}

impl VoiceActivityDetector {
    pub fn new(config: &SileroVadConfig) -> Result<Self, VadError> {
        config.validate()?;
        let inner = native::Detector::new(config)?;
        Ok(Self {
            inner,
            _not_send_sync: PhantomData,
        })
    }

    pub fn accept_waveform(&mut self, pcm: &[f32]) -> Result<(), VadError> {
        validate_pcm(pcm)?;
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    ConfigModelPathEmpty,
    ConfigModelPathNul,
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
    WaveformEmpty,
    WaveformTooLong,
    WaveformNonFinite,
    WaveformOutOfRange,
    NativeUnavailable,
    NativeCreateFailed,
    NativeNullSegment,
    NativeInvalidSegmentLength,
    NativeInvalidSegmentSamples,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConfigModelPathEmpty => "config.model_path_empty",
            Self::ConfigModelPathNul => "config.model_path_nul",
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
            Self::WaveformEmpty => "waveform.empty",
            Self::WaveformTooLong => "waveform.too_long",
            Self::WaveformNonFinite => "waveform.nonfinite",
            Self::WaveformOutOfRange => "waveform.out_of_range",
            Self::NativeUnavailable => "native.unavailable",
            Self::NativeCreateFailed => "native.create_failed",
            Self::NativeNullSegment => "native.null_segment",
            Self::NativeInvalidSegmentLength => "native.invalid_segment_length",
            Self::NativeInvalidSegmentSamples => "native.invalid_segment_samples",
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
    NativeInvalidSegmentLength,
    NativeInvalidSegmentSamples,
}

impl VadError {
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidConfig { code } | Self::InvalidWaveform { code } => *code,
            Self::NativeUnavailable => ErrorCode::NativeUnavailable,
            Self::NativeCreateFailed => ErrorCode::NativeCreateFailed,
            Self::NativeNullSegment => ErrorCode::NativeNullSegment,
            Self::NativeInvalidSegmentLength => ErrorCode::NativeInvalidSegmentLength,
            Self::NativeInvalidSegmentSamples => ErrorCode::NativeInvalidSegmentSamples,
        }
    }
}

impl fmt::Display for VadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "sherpa vad error: {}", self.code())
    }
}

impl Error for VadError {}

fn validate_probability(value: f32, code: ErrorCode) -> Result<(), VadError> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(VadError::InvalidConfig { code })
    }
}

fn validate_positive_finite(value: f32, code: ErrorCode) -> Result<(), VadError> {
    if value.is_finite() && value > 0.0 {
        Ok(())
    } else {
        Err(VadError::InvalidConfig { code })
    }
}

fn validate_nonnegative_finite(value: f32, code: ErrorCode) -> Result<(), VadError> {
    if value.is_finite() && value >= 0.0 {
        Ok(())
    } else {
        Err(VadError::InvalidConfig { code })
    }
}

pub fn validate_pcm(pcm: &[f32]) -> Result<(), VadError> {
    let _ = pcm_len_i32(pcm)?;
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
pub(crate) fn path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
pub(crate) fn path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str().to_string_lossy().as_bytes().to_vec()
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
    fn invalid_config_cases_are_rejected() {
        let cases = [
            (SileroVadConfig::new(""), ErrorCode::ConfigModelPathEmpty),
            (
                SileroVadConfig::new("silero-vad.onnx").with_min_silence_duration(0.0),
                ErrorCode::ConfigMinSilenceDurationRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_min_speech_duration(-0.1),
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
                SileroVadConfig::new("silero-vad.onnx").with_sample_rate(-16_000),
                ErrorCode::ConfigSampleRateRange,
            ),
            (
                SileroVadConfig::new("silero-vad.onnx").with_num_threads(0),
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
            let error = validate_pcm(pcm).expect_err("pcm should be rejected");
            assert_eq!(error.code(), code);
        }
    }

    #[test]
    fn default_build_does_not_link_native_vad() {
        let config = SileroVadConfig::new("silero-vad.onnx");
        let error = VoiceActivityDetector::new(&config).expect_err("native feature is off");

        assert_eq!(error.code(), ErrorCode::NativeUnavailable);
    }
}
