use std::ffi::{CStr, CString};
use std::fmt;
use std::os::raw::{c_char, c_float, c_int};
use std::ptr::NonNull;

use super::{
    path_bytes, preflight_existing_readable_file, ErrorCode, KeywordResult, KeywordSpotterConfig,
    VadError, MAX_KWS_RESULT_JSON_BYTES, MAX_KWS_RESULT_STRING_BYTES, MAX_KWS_RESULT_TOKENS,
};

#[repr(C)]
struct SherpaOnnxOnlineTransducerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOnlineParaformerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOnlineZipformer2CtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOnlineNemoCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOnlineToneCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct SherpaOnnxOnlineModelConfig {
    transducer: SherpaOnnxOnlineTransducerModelConfig,
    paraformer: SherpaOnnxOnlineParaformerModelConfig,
    zipformer2_ctc: SherpaOnnxOnlineZipformer2CtcModelConfig,
    tokens: *const c_char,
    num_threads: c_int,
    provider: *const c_char,
    debug: c_int,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    tokens_buf: *const c_char,
    tokens_buf_size: c_int,
    nemo_ctc: SherpaOnnxOnlineNemoCtcModelConfig,
    t_one_ctc: SherpaOnnxOnlineToneCtcModelConfig,
}

#[repr(C)]
struct SherpaOnnxFeatureConfig {
    sample_rate: c_int,
    feature_dim: c_int,
}

#[repr(C)]
struct SherpaOnnxKeywordSpotterConfig {
    feat_config: SherpaOnnxFeatureConfig,
    model_config: SherpaOnnxOnlineModelConfig,
    max_active_paths: c_int,
    num_trailing_blanks: c_int,
    keywords_score: c_float,
    keywords_threshold: c_float,
    keywords_file: *const c_char,
    keywords_buf: *const c_char,
    keywords_buf_size: c_int,
}

#[repr(C)]
struct SherpaOnnxKeywordResult {
    keyword: *const c_char,
    tokens: *const c_char,
    tokens_arr: *const *const c_char,
    count: c_int,
    timestamps: *const c_float,
    start_time: c_float,
    json: *const c_char,
}

enum SherpaOnnxKeywordSpotter {}
enum SherpaOnnxOnlineStream {}

unsafe extern "C" {
    fn SherpaOnnxCreateKeywordSpotter(
        config: *const SherpaOnnxKeywordSpotterConfig,
    ) -> *const SherpaOnnxKeywordSpotter;
    fn SherpaOnnxDestroyKeywordSpotter(spotter: *const SherpaOnnxKeywordSpotter);
    fn SherpaOnnxCreateKeywordStream(
        spotter: *const SherpaOnnxKeywordSpotter,
    ) -> *const SherpaOnnxOnlineStream;
    fn SherpaOnnxDestroyOnlineStream(stream: *const SherpaOnnxOnlineStream);
    fn SherpaOnnxOnlineStreamAcceptWaveform(
        stream: *const SherpaOnnxOnlineStream,
        sample_rate: c_int,
        samples: *const c_float,
        n: c_int,
    );
    fn SherpaOnnxOnlineStreamInputFinished(stream: *const SherpaOnnxOnlineStream);
    fn SherpaOnnxIsKeywordStreamReady(
        spotter: *const SherpaOnnxKeywordSpotter,
        stream: *const SherpaOnnxOnlineStream,
    ) -> c_int;
    fn SherpaOnnxDecodeKeywordStream(
        spotter: *const SherpaOnnxKeywordSpotter,
        stream: *const SherpaOnnxOnlineStream,
    );
    fn SherpaOnnxResetKeywordStream(
        spotter: *const SherpaOnnxKeywordSpotter,
        stream: *const SherpaOnnxOnlineStream,
    );
    fn SherpaOnnxGetKeywordResult(
        spotter: *const SherpaOnnxKeywordSpotter,
        stream: *const SherpaOnnxOnlineStream,
    ) -> *const SherpaOnnxKeywordResult;
    fn SherpaOnnxDestroyKeywordResult(result: *const SherpaOnnxKeywordResult);
}

pub(crate) struct Spotter {
    ptr: NonNull<SherpaOnnxKeywordSpotter>,
}

pub(crate) struct Stream {
    ptr: NonNull<SherpaOnnxOnlineStream>,
}

impl Spotter {
    pub(crate) fn new(config: &KeywordSpotterConfig) -> Result<Self, VadError> {
        for path in [
            config.encoder_path(),
            config.decoder_path(),
            config.joiner_path(),
            config.tokens_path(),
        ] {
            preflight_existing_readable_file(path)?;
        }

        let encoder = path_cstring(config.encoder_path())?;
        let decoder = path_cstring(config.decoder_path())?;
        let joiner = path_cstring(config.joiner_path())?;
        let tokens = path_cstring(config.tokens_path())?;
        let provider = string_cstring(config.provider(), ErrorCode::ConfigProviderNul)?;
        let keywords = string_cstring(config.keywords(), ErrorCode::ConfigKeywordsNul)?;
        let keywords_len =
            i32::try_from(config.keywords().len()).map_err(|_| VadError::InvalidConfig {
                code: ErrorCode::ConfigKeywordsTooLong,
            })?;

        let raw_config = SherpaOnnxKeywordSpotterConfig {
            feat_config: SherpaOnnxFeatureConfig {
                sample_rate: config.sample_rate(),
                feature_dim: config.feature_dim(),
            },
            model_config: SherpaOnnxOnlineModelConfig {
                transducer: SherpaOnnxOnlineTransducerModelConfig {
                    encoder: encoder.as_ptr(),
                    decoder: decoder.as_ptr(),
                    joiner: joiner.as_ptr(),
                },
                paraformer: SherpaOnnxOnlineParaformerModelConfig {
                    encoder: std::ptr::null(),
                    decoder: std::ptr::null(),
                },
                zipformer2_ctc: SherpaOnnxOnlineZipformer2CtcModelConfig {
                    model: std::ptr::null(),
                },
                tokens: tokens.as_ptr(),
                num_threads: config.num_threads(),
                provider: provider.as_ptr(),
                debug: 0,
                model_type: std::ptr::null(),
                modeling_unit: std::ptr::null(),
                bpe_vocab: std::ptr::null(),
                tokens_buf: std::ptr::null(),
                tokens_buf_size: 0,
                nemo_ctc: SherpaOnnxOnlineNemoCtcModelConfig {
                    model: std::ptr::null(),
                },
                t_one_ctc: SherpaOnnxOnlineToneCtcModelConfig {
                    model: std::ptr::null(),
                },
            },
            max_active_paths: config.max_active_paths(),
            num_trailing_blanks: config.num_trailing_blanks(),
            keywords_score: config.keywords_score(),
            keywords_threshold: config.keywords_threshold(),
            keywords_file: std::ptr::null(),
            keywords_buf: keywords.as_ptr(),
            keywords_buf_size: keywords_len,
        };

        let ptr = unsafe { SherpaOnnxCreateKeywordSpotter(&raw_config) };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(VadError::NativeCreateFailed)?;
        Ok(Self { ptr })
    }

    pub(crate) fn create_stream(&self) -> Result<Stream, VadError> {
        let ptr = unsafe { SherpaOnnxCreateKeywordStream(self.ptr.as_ptr()) };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(VadError::NativeStreamCreateFailed)?;
        Ok(Stream { ptr })
    }

    pub(crate) fn accept_waveform(
        &self,
        stream: &mut Stream,
        sample_rate: i32,
        pcm: &[f32],
    ) -> Result<(), VadError> {
        let len = i32::try_from(pcm.len()).map_err(|_| VadError::InvalidWaveform {
            code: ErrorCode::WaveformTooLong,
        })?;
        unsafe {
            SherpaOnnxOnlineStreamAcceptWaveform(
                stream.ptr.as_ptr(),
                sample_rate,
                pcm.as_ptr(),
                len,
            );
        }
        Ok(())
    }

    pub(crate) fn input_finished(&self, stream: &mut Stream) -> Result<(), VadError> {
        unsafe {
            SherpaOnnxOnlineStreamInputFinished(stream.ptr.as_ptr());
        }
        Ok(())
    }

    pub(crate) fn reset(&self, stream: &mut Stream) -> Result<(), VadError> {
        unsafe {
            SherpaOnnxResetKeywordStream(self.ptr.as_ptr(), stream.ptr.as_ptr());
        }
        Ok(())
    }

    pub(crate) fn decode_ready(
        &self,
        stream: &mut Stream,
        max_decode_steps: usize,
    ) -> Result<Vec<KeywordResult>, VadError> {
        let mut detections = Vec::new();
        for _ in 0..max_decode_steps {
            if !self.is_ready(stream) {
                return Ok(detections);
            }
            unsafe {
                SherpaOnnxDecodeKeywordStream(self.ptr.as_ptr(), stream.ptr.as_ptr());
            }
            let result = KeywordResultHandle::new(self.ptr, stream.ptr)?;
            let snapshot = result.snapshot()?;
            if !snapshot.keyword.is_empty() {
                detections.push(snapshot);
                self.reset(stream)?;
            }
        }
        Err(VadError::NativeDecodeStepLimitExceeded)
    }

    fn is_ready(&self, stream: &Stream) -> bool {
        unsafe { SherpaOnnxIsKeywordStreamReady(self.ptr.as_ptr(), stream.ptr.as_ptr()) != 0 }
    }
}

impl Drop for Spotter {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyKeywordSpotter(self.ptr.as_ptr());
        }
    }
}

impl fmt::Debug for Spotter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordSpotter")
            .field("ptr", &"<redacted>")
            .finish()
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyOnlineStream(self.ptr.as_ptr());
        }
    }
}

struct KeywordResultHandle {
    ptr: NonNull<SherpaOnnxKeywordResult>,
}

impl KeywordResultHandle {
    fn new(
        spotter: NonNull<SherpaOnnxKeywordSpotter>,
        stream: NonNull<SherpaOnnxOnlineStream>,
    ) -> Result<Self, VadError> {
        let ptr = unsafe { SherpaOnnxGetKeywordResult(spotter.as_ptr(), stream.as_ptr()) };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(VadError::NativeKeywordResultNull)?;
        Ok(Self { ptr })
    }

    fn snapshot(&self) -> Result<KeywordResult, VadError> {
        let raw = unsafe { self.ptr.as_ref() };
        if raw.count < 0 {
            return Err(VadError::NativeResultTokenCountExceeded);
        }
        let count =
            usize::try_from(raw.count).map_err(|_| VadError::NativeResultTokenCountExceeded)?;
        if count > MAX_KWS_RESULT_TOKENS {
            return Err(VadError::NativeResultTokenCountExceeded);
        }

        let keyword = read_c_string(raw.keyword, MAX_KWS_RESULT_STRING_BYTES)?;
        let json = read_c_string(raw.json, MAX_KWS_RESULT_JSON_BYTES)?;
        let tokens = read_token_array(raw.tokens_arr, count)?;
        let timestamps = read_timestamps(raw.timestamps, count)?;

        Ok(KeywordResult {
            keyword,
            tokens,
            timestamps,
            start_time: raw.start_time,
            json,
        })
    }
}

impl Drop for KeywordResultHandle {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyKeywordResult(self.ptr.as_ptr());
        }
    }
}

fn path_cstring(path: &std::path::Path) -> Result<CString, VadError> {
    CString::new(path_bytes(path)?).map_err(|_| VadError::InvalidConfig {
        code: ErrorCode::ConfigModelPathNul,
    })
}

fn string_cstring(value: &str, code: ErrorCode) -> Result<CString, VadError> {
    CString::new(value).map_err(|_| VadError::InvalidConfig { code })
}

fn read_c_string(ptr: *const c_char, max_bytes: usize) -> Result<String, VadError> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    let bytes = unsafe { CStr::from_ptr(ptr) }.to_bytes();
    if bytes.len() > max_bytes {
        return Err(VadError::NativeResultStringTooLong);
    }
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| VadError::NativeResultInvalidUtf8)
}

fn read_token_array(ptr: *const *const c_char, count: usize) -> Result<Vec<String>, VadError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if ptr.is_null() {
        return Err(VadError::NativeResultTokenCountExceeded);
    }
    let raw_tokens = unsafe { std::slice::from_raw_parts(ptr, count) };
    raw_tokens
        .iter()
        .map(|token| read_c_string(*token, MAX_KWS_RESULT_STRING_BYTES))
        .collect()
}

fn read_timestamps(ptr: *const c_float, count: usize) -> Result<Vec<f32>, VadError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if ptr.is_null() {
        return Ok(Vec::new());
    }
    let values = unsafe { std::slice::from_raw_parts(ptr, count) }.to_vec();
    if values.iter().all(|value| value.is_finite()) {
        Ok(values)
    } else {
        Err(VadError::NativeResultTimestampCount)
    }
}
