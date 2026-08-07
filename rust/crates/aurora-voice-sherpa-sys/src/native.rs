use std::ffi::CString;
use std::fmt;
use std::os::raw::{c_char, c_float, c_int};
use std::ptr::NonNull;

use super::{
    path_bytes, path_bytes_for_stt, pcm_len_i32, pcm_len_i32_for_stt,
    validate_native_segment_parts, ErrorCode, OfflineSttConfig, OfflineSttResult, SegmentBounds,
    SileroVadConfig, SpeechSegment, SttError, VadError, MAX_OFFLINE_STT_SEGMENTS,
    MAX_OFFLINE_STT_TEXT_BYTES, MAX_OFFLINE_STT_TOKENS, MAX_OFFLINE_STT_TOKEN_BYTES,
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

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxFeatureConfig {
    sample_rate: c_int,
    feature_dim: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTransducerModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    joiner: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineParaformerModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineNemoEncDecCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineWhisperModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    language: *const c_char,
    task: *const c_char,
    tail_paddings: c_int,
    enable_token_timestamps: c_int,
    enable_segment_timestamps: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineCanaryModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    src_lang: *const c_char,
    tgt_lang: *const c_char,
    use_pnc: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineCohereTranscribeModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
    language: *const c_char,
    use_punct: c_int,
    use_itn: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineFireRedAsrModelConfig {
    encoder: *const c_char,
    decoder: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineFireRedAsrCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineMoonshineModelConfig {
    preprocessor: *const c_char,
    encoder: *const c_char,
    uncached_decoder: *const c_char,
    cached_decoder: *const c_char,
    merged_decoder: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTdnnModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineLMConfig {
    model: *const c_char,
    scale: c_float,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineSenseVoiceModelConfig {
    model: *const c_char,
    language: *const c_char,
    use_itn: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineDolphinModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineZipformerCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineWenetCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineOmnilingualAsrCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineMedAsrCtcModelConfig {
    model: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineFunASRNanoModelConfig {
    encoder_adaptor: *const c_char,
    llm: *const c_char,
    embedding: *const c_char,
    tokenizer: *const c_char,
    system_prompt: *const c_char,
    user_prompt: *const c_char,
    max_new_tokens: c_int,
    temperature: c_float,
    top_p: c_float,
    seed: c_int,
    language: *const c_char,
    itn: c_int,
    hotwords: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineQwen3ASRModelConfig {
    conv_frontend: *const c_char,
    encoder: *const c_char,
    decoder: *const c_char,
    tokenizer: *const c_char,
    max_total_len: c_int,
    max_new_tokens: c_int,
    temperature: c_float,
    top_p: c_float,
    seed: c_int,
    hotwords: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxHomophoneReplacerConfig {
    dict_dir: *const c_char,
    lexicon: *const c_char,
    rule_fsts: *const c_char,
    rule_fars: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineModelConfig {
    transducer: SherpaOnnxOfflineTransducerModelConfig,
    paraformer: SherpaOnnxOfflineParaformerModelConfig,
    nemo_ctc: SherpaOnnxOfflineNemoEncDecCtcModelConfig,
    whisper: SherpaOnnxOfflineWhisperModelConfig,
    tdnn: SherpaOnnxOfflineTdnnModelConfig,
    tokens: *const c_char,
    num_threads: c_int,
    debug: c_int,
    provider: *const c_char,
    model_type: *const c_char,
    modeling_unit: *const c_char,
    bpe_vocab: *const c_char,
    telespeech_ctc: *const c_char,
    sense_voice: SherpaOnnxOfflineSenseVoiceModelConfig,
    moonshine: SherpaOnnxOfflineMoonshineModelConfig,
    fire_red_asr: SherpaOnnxOfflineFireRedAsrModelConfig,
    dolphin: SherpaOnnxOfflineDolphinModelConfig,
    zipformer_ctc: SherpaOnnxOfflineZipformerCtcModelConfig,
    canary: SherpaOnnxOfflineCanaryModelConfig,
    wenet_ctc: SherpaOnnxOfflineWenetCtcModelConfig,
    omnilingual: SherpaOnnxOfflineOmnilingualAsrCtcModelConfig,
    medasr: SherpaOnnxOfflineMedAsrCtcModelConfig,
    funasr_nano: SherpaOnnxOfflineFunASRNanoModelConfig,
    fire_red_asr_ctc: SherpaOnnxOfflineFireRedAsrCtcModelConfig,
    qwen3_asr: SherpaOnnxOfflineQwen3ASRModelConfig,
    cohere_transcribe: SherpaOnnxOfflineCohereTranscribeModelConfig,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineRecognizerConfig {
    feat_config: SherpaOnnxFeatureConfig,
    model_config: SherpaOnnxOfflineModelConfig,
    lm_config: SherpaOnnxOfflineLMConfig,
    decoding_method: *const c_char,
    max_active_paths: c_int,
    hotwords_file: *const c_char,
    hotwords_score: c_float,
    rule_fsts: *const c_char,
    rule_fars: *const c_char,
    blank_penalty: c_float,
    hr: SherpaOnnxHomophoneReplacerConfig,
}

enum SherpaOnnxOfflineRecognizer {}
enum SherpaOnnxOfflineStream {}

#[repr(C)]
struct SherpaOnnxOfflineRecognizerResult {
    text: *const c_char,
    timestamps: *mut c_float,
    count: c_int,
    tokens: *const c_char,
    tokens_arr: *const *const c_char,
    json: *const c_char,
    lang: *const c_char,
    emotion: *const c_char,
    event: *const c_char,
    durations: *mut c_float,
    ys_log_probs: *mut c_float,
    segment_timestamps: *const c_float,
    segment_durations: *const c_float,
    segment_texts: *const c_char,
    segment_texts_arr: *const *const c_char,
    segment_count: c_int,
}

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
    fn SherpaOnnxCreateOfflineRecognizer(
        config: *const SherpaOnnxOfflineRecognizerConfig,
    ) -> *const SherpaOnnxOfflineRecognizer;
    fn SherpaOnnxDestroyOfflineRecognizer(p: *const SherpaOnnxOfflineRecognizer);
    fn SherpaOnnxCreateOfflineStream(
        recognizer: *const SherpaOnnxOfflineRecognizer,
    ) -> *const SherpaOnnxOfflineStream;
    fn SherpaOnnxDestroyOfflineStream(stream: *const SherpaOnnxOfflineStream);
    fn SherpaOnnxAcceptWaveformOffline(
        stream: *const SherpaOnnxOfflineStream,
        sample_rate: c_int,
        samples: *const c_float,
        n: c_int,
    );
    fn SherpaOnnxDecodeOfflineStream(
        recognizer: *const SherpaOnnxOfflineRecognizer,
        stream: *const SherpaOnnxOfflineStream,
    );
    fn SherpaOnnxGetOfflineStreamResult(
        stream: *const SherpaOnnxOfflineStream,
    ) -> *const SherpaOnnxOfflineRecognizerResult;
    fn SherpaOnnxDestroyOfflineRecognizerResult(p: *const SherpaOnnxOfflineRecognizerResult);
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

pub(crate) struct OfflineRecognizer {
    ptr: NonNull<SherpaOnnxOfflineRecognizer>,
}

impl OfflineRecognizer {
    pub(crate) fn new(config: &OfflineSttConfig) -> Result<Self, SttError> {
        let encoder = CString::new(path_bytes_for_stt(
            config.encoder_path(),
            ErrorCode::ConfigEncoderPathEmpty,
        )?)
        .map_err(|_| SttError::InvalidConfig {
            code: ErrorCode::ConfigEncoderPathNul,
        })?;
        let decoder = CString::new(path_bytes_for_stt(
            config.decoder_path(),
            ErrorCode::ConfigDecoderPathEmpty,
        )?)
        .map_err(|_| SttError::InvalidConfig {
            code: ErrorCode::ConfigDecoderPathNul,
        })?;
        let tokens = CString::new(path_bytes_for_stt(
            config.tokens_path(),
            ErrorCode::ConfigTokensPathEmpty,
        )?)
        .map_err(|_| SttError::InvalidConfig {
            code: ErrorCode::ConfigTokensPathNul,
        })?;
        let provider = CString::new(config.provider()).map_err(|_| SttError::InvalidConfig {
            code: ErrorCode::ConfigProviderNul,
        })?;
        let decoding_method =
            CString::new(config.decoding_method()).map_err(|_| SttError::InvalidConfig {
                code: ErrorCode::ConfigDecodingMethodNul,
            })?;

        let mut raw_model = SherpaOnnxOfflineModelConfig {
            tokens: tokens.as_ptr(),
            num_threads: config.num_threads(),
            debug: 0,
            provider: provider.as_ptr(),
            ..SherpaOnnxOfflineModelConfig::default()
        };
        raw_model.moonshine.encoder = encoder.as_ptr();
        raw_model.moonshine.merged_decoder = decoder.as_ptr();
        let raw_config = SherpaOnnxOfflineRecognizerConfig {
            feat_config: SherpaOnnxFeatureConfig {
                sample_rate: config.sample_rate(),
                feature_dim: config.feature_dim(),
            },
            model_config: raw_model,
            decoding_method: decoding_method.as_ptr(),
            max_active_paths: config.max_active_paths(),
            ..SherpaOnnxOfflineRecognizerConfig::default()
        };

        let ptr = unsafe { SherpaOnnxCreateOfflineRecognizer(&raw_config) };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(SttError::NativeCreateFailed)?;
        Ok(Self { ptr })
    }

    pub(crate) fn create_stream(&self) -> Result<OfflineStream, SttError> {
        let ptr = unsafe { SherpaOnnxCreateOfflineStream(self.ptr.as_ptr()) };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(SttError::NativeNullStream)?;
        Ok(OfflineStream { ptr })
    }

    pub(crate) fn decode_stream(
        &self,
        stream: OfflineStream,
    ) -> Result<OfflineSttResult, SttError> {
        unsafe {
            SherpaOnnxDecodeOfflineStream(self.ptr.as_ptr(), stream.ptr.as_ptr());
        }
        let result = ResultHandle::from_stream(stream.ptr)?;
        result.snapshot()
    }
}

impl Drop for OfflineRecognizer {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyOfflineRecognizer(self.ptr.as_ptr());
        }
    }
}

impl fmt::Debug for OfflineRecognizer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfflineRecognizer")
            .field("ptr", &"<redacted>")
            .finish()
    }
}

pub(crate) struct OfflineStream {
    ptr: NonNull<SherpaOnnxOfflineStream>,
}

impl OfflineStream {
    pub(crate) fn accept_waveform(
        &mut self,
        sample_rate: i32,
        pcm: &[f32],
    ) -> Result<(), SttError> {
        let len = pcm_len_i32_for_stt(pcm)?;
        unsafe {
            SherpaOnnxAcceptWaveformOffline(self.ptr.as_ptr(), sample_rate, pcm.as_ptr(), len);
        }
        Ok(())
    }
}

impl Drop for OfflineStream {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyOfflineStream(self.ptr.as_ptr());
        }
    }
}

struct ResultHandle {
    ptr: NonNull<SherpaOnnxOfflineRecognizerResult>,
}

impl ResultHandle {
    fn from_stream(stream: NonNull<SherpaOnnxOfflineStream>) -> Result<Self, SttError> {
        let ptr = unsafe { SherpaOnnxGetOfflineStreamResult(stream.as_ptr()) };
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(SttError::NativeNullResult)?;
        Ok(Self { ptr })
    }

    fn snapshot(&self) -> Result<OfflineSttResult, SttError> {
        let raw = unsafe { self.ptr.as_ref() };
        let text =
            read_bounded_string(raw.text, MAX_OFFLINE_STT_TEXT_BYTES).map_err(
                |error| match error {
                    StringReadError::Null => SttError::NativeInvalidResultText,
                    StringReadError::TooLong => SttError::NativeResultTextTooLong,
                    StringReadError::Utf8 => SttError::NativeInvalidResultText,
                },
            )?;
        let (tokens, timestamps_millis) = if raw.timestamps.is_null() {
            (Vec::new(), Vec::new())
        } else {
            let count = validate_count(raw.count, MAX_OFFLINE_STT_TOKENS)
                .map_err(|_| SttError::NativeResultTokenCountExceeded)?;
            (
                read_string_array(raw.tokens_arr, count, MAX_OFFLINE_STT_TOKEN_BYTES)?,
                read_time_array(raw.timestamps, count)?,
            )
        };
        let segment_count = validate_count(raw.segment_count, MAX_OFFLINE_STT_SEGMENTS)
            .map_err(|_| SttError::NativeResultSegmentCountExceeded)?;
        let segment_texts = if segment_count == 0 {
            Vec::new()
        } else {
            read_string_array(
                raw.segment_texts_arr,
                segment_count,
                MAX_OFFLINE_STT_TEXT_BYTES,
            )?
        };
        let segment_timestamps_millis = if segment_count == 0 {
            Vec::new()
        } else if raw.segment_timestamps.is_null() {
            return Err(SttError::NativeInvalidResultTimestamp);
        } else {
            read_time_array(raw.segment_timestamps, segment_count)?
        };
        Ok(OfflineSttResult {
            text,
            tokens,
            timestamps_millis,
            segment_texts,
            segment_timestamps_millis,
        })
    }
}

impl Drop for ResultHandle {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyOfflineRecognizerResult(self.ptr.as_ptr());
        }
    }
}

enum StringReadError {
    Null,
    TooLong,
    Utf8,
}

fn read_bounded_string(ptr: *const c_char, max_bytes: usize) -> Result<String, StringReadError> {
    if ptr.is_null() {
        return Err(StringReadError::Null);
    }
    let bytes = unsafe {
        let mut len = 0usize;
        while len <= max_bytes {
            let byte = *ptr.cast::<u8>().add(len);
            if byte == 0 {
                return std::str::from_utf8(std::slice::from_raw_parts(ptr.cast::<u8>(), len))
                    .map(str::to_owned)
                    .map_err(|_| StringReadError::Utf8);
            }
            len = len.saturating_add(1);
        }
        std::slice::from_raw_parts(ptr.cast::<u8>(), max_bytes)
    };
    let _ = bytes;
    Err(StringReadError::TooLong)
}

fn validate_count(count: c_int, max: usize) -> Result<usize, ()> {
    if count < 0 {
        return Err(());
    }
    let count = usize::try_from(count).map_err(|_| ())?;
    if count > max {
        return Err(());
    }
    Ok(count)
}

fn read_string_array(
    ptr: *const *const c_char,
    count: usize,
    max_bytes: usize,
) -> Result<Vec<String>, SttError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if ptr.is_null() {
        return Err(SttError::NativeInvalidResultToken);
    }
    let values = unsafe { std::slice::from_raw_parts(ptr, count) };
    values
        .iter()
        .map(|value| {
            read_bounded_string(*value, max_bytes).map_err(|error| match error {
                StringReadError::Null | StringReadError::Utf8 => SttError::NativeInvalidResultToken,
                StringReadError::TooLong => SttError::NativeResultTokenTooLong,
            })
        })
        .collect()
}

fn read_time_array(ptr: *const c_float, count: usize) -> Result<Vec<u32>, SttError> {
    if count == 0 || ptr.is_null() {
        return Ok(Vec::new());
    }
    let values = unsafe { std::slice::from_raw_parts(ptr, count) };
    values
        .iter()
        .map(|value| {
            if !value.is_finite() || *value < 0.0 {
                return Err(SttError::NativeInvalidResultTimestamp);
            }
            let millis = (*value * 1000.0).round();
            if !millis.is_finite() || millis < 0.0 || millis > u32::MAX as f32 {
                return Err(SttError::NativeInvalidResultTimestamp);
            }
            Ok(millis as u32)
        })
        .collect()
}
