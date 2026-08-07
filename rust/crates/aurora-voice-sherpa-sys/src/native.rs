use std::ffi::CString;
use std::fmt;
use std::os::raw::{c_char, c_float, c_int};
use std::ptr::NonNull;

use super::{
    path_bytes, pcm_len_i32, validate_native_segment_parts, SegmentBounds, SileroVadConfig,
    SpeechSegment, VadError,
};

#[repr(C)]
struct SherpaOnnxSileroVadModelConfig {
    model: *const c_char,
    threshold: c_float,
    min_silence_duration: c_float,
    min_speech_duration: c_float,
    window_size: c_int,
    max_speech_duration: c_float,
}

#[repr(C)]
struct SherpaOnnxTenVadModelConfig {
    model: *const c_char,
    threshold: c_float,
    min_silence_duration: c_float,
    min_speech_duration: c_float,
    window_size: c_int,
    max_speech_duration: c_float,
}

#[repr(C)]
struct SherpaOnnxVadModelConfig {
    silero_vad: SherpaOnnxSileroVadModelConfig,
    sample_rate: c_int,
    num_threads: c_int,
    provider: *const c_char,
    debug: c_int,
    ten_vad: SherpaOnnxTenVadModelConfig,
}

#[repr(C)]
struct SherpaOnnxSpeechSegment {
    start: c_int,
    samples: *mut c_float,
    n: c_int,
}

enum SherpaOnnxVoiceActivityDetector {}

unsafe extern "C" {
    fn SherpaOnnxCreateVoiceActivityDetector(
        config: *const SherpaOnnxVadModelConfig,
        buffer_size_in_seconds: c_float,
    ) -> *const SherpaOnnxVoiceActivityDetector;
    fn SherpaOnnxDestroyVoiceActivityDetector(p: *const SherpaOnnxVoiceActivityDetector);
    fn SherpaOnnxVoiceActivityDetectorAcceptWaveform(
        p: *const SherpaOnnxVoiceActivityDetector,
        samples: *const c_float,
        n: c_int,
    );
    fn SherpaOnnxVoiceActivityDetectorEmpty(p: *const SherpaOnnxVoiceActivityDetector) -> c_int;
    fn SherpaOnnxVoiceActivityDetectorDetected(p: *const SherpaOnnxVoiceActivityDetector) -> c_int;
    fn SherpaOnnxVoiceActivityDetectorPop(p: *const SherpaOnnxVoiceActivityDetector);
    fn SherpaOnnxVoiceActivityDetectorClear(p: *const SherpaOnnxVoiceActivityDetector);
    fn SherpaOnnxVoiceActivityDetectorFront(
        p: *const SherpaOnnxVoiceActivityDetector,
    ) -> *const SherpaOnnxSpeechSegment;
    fn SherpaOnnxDestroySpeechSegment(p: *const SherpaOnnxSpeechSegment);
    fn SherpaOnnxVoiceActivityDetectorReset(p: *const SherpaOnnxVoiceActivityDetector);
    fn SherpaOnnxVoiceActivityDetectorFlush(p: *const SherpaOnnxVoiceActivityDetector);
}

pub(crate) struct Detector {
    ptr: NonNull<SherpaOnnxVoiceActivityDetector>,
    segment_bounds: SegmentBounds,
}

impl Detector {
    pub(crate) fn new(config: &SileroVadConfig) -> Result<Self, VadError> {
        let model = CString::new(path_bytes(config.model_path())?).map_err(|_| {
            VadError::InvalidConfig {
                code: super::ErrorCode::ConfigModelPathNul,
            }
        })?;
        let provider = CString::new(config.provider()).map_err(|_| VadError::InvalidConfig {
            code: super::ErrorCode::ConfigProviderNul,
        })?;
        let raw_config = SherpaOnnxVadModelConfig {
            silero_vad: SherpaOnnxSileroVadModelConfig {
                model: model.as_ptr(),
                threshold: config.threshold(),
                min_silence_duration: config.min_silence_duration(),
                min_speech_duration: config.min_speech_duration(),
                window_size: config.window_size(),
                max_speech_duration: config.max_speech_duration(),
            },
            sample_rate: config.sample_rate(),
            num_threads: config.num_threads(),
            provider: provider.as_ptr(),
            debug: i32::from(config.debug()),
            ten_vad: SherpaOnnxTenVadModelConfig {
                model: std::ptr::null(),
                threshold: 0.0,
                min_silence_duration: 0.0,
                min_speech_duration: 0.0,
                window_size: 0,
                max_speech_duration: 0.0,
            },
        };

        let ptr = unsafe {
            SherpaOnnxCreateVoiceActivityDetector(&raw_config, config.buffer_size_seconds())
        };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(VadError::NativeCreateFailed)?;

        Ok(Self {
            ptr,
            segment_bounds: SegmentBounds::from_config(config)?,
        })
    }

    pub(crate) fn accept_waveform(&mut self, pcm: &[f32]) -> Result<(), VadError> {
        let len = pcm_len_i32(pcm)?;
        unsafe {
            SherpaOnnxVoiceActivityDetectorAcceptWaveform(self.ptr.as_ptr(), pcm.as_ptr(), len);
        }
        Ok(())
    }

    pub(crate) fn detected(&self) -> Result<bool, VadError> {
        let detected = unsafe { SherpaOnnxVoiceActivityDetectorDetected(self.ptr.as_ptr()) };
        Ok(detected != 0)
    }

    pub(crate) fn is_empty(&self) -> Result<bool, VadError> {
        let empty = unsafe { SherpaOnnxVoiceActivityDetectorEmpty(self.ptr.as_ptr()) };
        Ok(empty != 0)
    }

    pub(crate) fn drain_speech_segments(&mut self) -> Result<Vec<SpeechSegment>, VadError> {
        let mut segments = Vec::new();
        while !self.is_empty()? {
            if segments.len() >= self.segment_bounds.max_segments() {
                return Err(VadError::NativeSegmentCountExceeded);
            }
            let segment = SegmentHandle::front(self.ptr)?;
            let snapshot = segment.snapshot(self.segment_bounds);
            drop(segment);
            unsafe {
                SherpaOnnxVoiceActivityDetectorPop(self.ptr.as_ptr());
            }
            segments.push(snapshot?);
        }
        Ok(segments)
    }

    pub(crate) fn clear(&mut self) -> Result<(), VadError> {
        unsafe {
            SherpaOnnxVoiceActivityDetectorClear(self.ptr.as_ptr());
        }
        Ok(())
    }

    pub(crate) fn reset(&mut self) -> Result<(), VadError> {
        unsafe {
            SherpaOnnxVoiceActivityDetectorReset(self.ptr.as_ptr());
        }
        Ok(())
    }

    pub(crate) fn flush(&mut self) -> Result<(), VadError> {
        unsafe {
            SherpaOnnxVoiceActivityDetectorFlush(self.ptr.as_ptr());
        }
        Ok(())
    }
}

impl Drop for Detector {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyVoiceActivityDetector(self.ptr.as_ptr());
        }
    }
}

impl fmt::Debug for Detector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Detector")
            .field("ptr", &"<redacted>")
            .field("segment_bounds", &self.segment_bounds)
            .finish()
    }
}

struct SegmentHandle {
    ptr: NonNull<SherpaOnnxSpeechSegment>,
}

impl SegmentHandle {
    fn front(detector: NonNull<SherpaOnnxVoiceActivityDetector>) -> Result<Self, VadError> {
        let ptr = unsafe { SherpaOnnxVoiceActivityDetectorFront(detector.as_ptr()) };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(VadError::NativeNullSegment)?;
        Ok(Self { ptr })
    }

    fn snapshot(&self, bounds: SegmentBounds) -> Result<SpeechSegment, VadError> {
        let raw = unsafe { self.ptr.as_ref() };
        if raw.start < 0 {
            return Err(VadError::NativeInvalidSegmentStart);
        }
        if raw.n <= 0 {
            return Err(VadError::NativeInvalidSegmentLength);
        }
        let len = usize::try_from(raw.n).map_err(|_| VadError::NativeInvalidSegmentLength)?;
        if len > bounds.max_segment_samples() {
            return Err(VadError::NativeSegmentLengthExceeded);
        }
        if raw.samples.is_null() {
            return Err(VadError::NativeInvalidSegmentSamples);
        }

        let samples = unsafe { std::slice::from_raw_parts(raw.samples, len) }.to_vec();
        validate_native_segment_parts(raw.start, &samples, bounds)?;

        Ok(SpeechSegment {
            start: raw.start,
            samples,
        })
    }
}

impl Drop for SegmentHandle {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroySpeechSegment(self.ptr.as_ptr());
        }
    }
}
