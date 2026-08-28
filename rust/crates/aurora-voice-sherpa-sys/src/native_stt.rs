use std::ffi::CString;
use std::fmt;
use std::os::raw::{c_char, c_float, c_int};
use std::ptr::NonNull;

use super::{
    path_bytes_for_stt, pcm_len_i32_for_stt, ErrorCode, OfflineSttConfig, OfflineSttModelKind,
    OfflineSttResult, SttError, MAX_OFFLINE_STT_SEGMENTS, MAX_OFFLINE_STT_TEXT_BYTES,
    MAX_OFFLINE_STT_TOKENS, MAX_OFFLINE_STT_TOKEN_BYTES,
};

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
        let language = CString::new(config.language()).map_err(|_| SttError::InvalidConfig {
            code: ErrorCode::ConfigWhisperLanguageNul,
        })?;
        let task = CString::new(config.task()).map_err(|_| SttError::InvalidConfig {
            code: ErrorCode::ConfigWhisperTaskNul,
        })?;

        let mut raw_model = SherpaOnnxOfflineModelConfig {
            tokens: tokens.as_ptr(),
            num_threads: config.num_threads(),
            debug: 0,
            provider: provider.as_ptr(),
            ..SherpaOnnxOfflineModelConfig::default()
        };
        match config.model_kind() {
            OfflineSttModelKind::Moonshine => {
                raw_model.moonshine.encoder = encoder.as_ptr();
                raw_model.moonshine.merged_decoder = decoder.as_ptr();
            }
            OfflineSttModelKind::Whisper => {
                raw_model.whisper.encoder = encoder.as_ptr();
                raw_model.whisper.decoder = decoder.as_ptr();
                raw_model.whisper.language = language.as_ptr();
                raw_model.whisper.task = task.as_ptr();
                raw_model.whisper.tail_paddings = config.whisper_tail_paddings();
                raw_model.whisper.enable_token_timestamps = if config.whisper_token_timestamps() {
                    1
                } else {
                    0
                };
                raw_model.whisper.enable_segment_timestamps = if config.whisper_segment_timestamps()
                {
                    1
                } else {
                    0
                };
            }
        }
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
        snapshot_raw_result(raw)
    }
}

fn snapshot_raw_result(
    raw: &SherpaOnnxOfflineRecognizerResult,
) -> Result<OfflineSttResult, SttError> {
    let text =
        read_bounded_string(raw.text, MAX_OFFLINE_STT_TEXT_BYTES).map_err(|error| match error {
            StringReadError::Null => SttError::NativeInvalidResultText,
            StringReadError::TooLong => SttError::NativeResultTextTooLong,
            StringReadError::Utf8 => SttError::NativeInvalidResultText,
        })?;
    let count = validate_count(raw.count, MAX_OFFLINE_STT_TOKENS)
        .map_err(|_| SttError::NativeResultTokenCountExceeded)?;
    let tokens = read_string_array(raw.tokens_arr, count, MAX_OFFLINE_STT_TOKEN_BYTES)?;
    let timestamps_millis = if raw.timestamps.is_null() {
        None
    } else {
        Some(read_time_array(raw.timestamps, count)?)
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
    let segment_timestamps_millis = if raw.segment_timestamps.is_null() {
        None
    } else {
        Some(read_time_array(raw.segment_timestamps, segment_count)?)
    };
    Ok(OfflineSttResult {
        text,
        tokens,
        timestamps_millis,
        segment_texts,
        segment_timestamps_millis,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;

    #[test]
    fn raw_result_keeps_tokens_when_token_timestamps_are_absent() {
        let text = c"hello";
        let token = c"hello";
        let tokens = [token.as_ptr()];
        let raw = raw_result(text.as_ptr()).with_tokens(&tokens).with_count(1);

        let result = snapshot_raw_result(&raw).expect("tokens without timestamps are valid");

        assert_eq!(result.text(), "hello");
        assert_eq!(result.tokens(), &["hello".to_owned()]);
        assert_eq!(result.timestamps_millis(), None);
    }

    #[test]
    fn raw_result_rejects_token_count_without_token_array() {
        let raw = raw_result(c"hello".as_ptr()).with_count(1);

        let error = snapshot_raw_result(&raw).expect_err("token count needs token array");

        assert_eq!(error.code(), ErrorCode::NativeInvalidResultToken);
    }

    #[test]
    fn raw_result_keeps_segment_texts_when_segment_timestamps_are_absent() {
        let segment = c"segment one";
        let segments = [segment.as_ptr()];
        let raw = raw_result(c"hello".as_ptr())
            .with_segments(&segments)
            .with_segment_count(1);

        let result = snapshot_raw_result(&raw).expect("segment text without timestamps is valid");

        assert_eq!(result.segment_texts(), &["segment one".to_owned()]);
        assert_eq!(result.segment_timestamps_millis(), None);
    }

    #[test]
    fn raw_result_rejects_segment_count_without_segment_text_array() {
        let raw = raw_result(c"hello".as_ptr()).with_segment_count(1);

        let error = snapshot_raw_result(&raw).expect_err("segment count needs text array");

        assert_eq!(error.code(), ErrorCode::NativeInvalidResultToken);
    }

    #[test]
    fn raw_result_aligns_optional_timing_arrays_when_present() {
        let token = c"hello";
        let tokens = [token.as_ptr()];
        let token_times = [0.125_f32];
        let segment = c"segment one";
        let segments = [segment.as_ptr()];
        let segment_times = [0.5_f32];
        let raw = raw_result(c"hello".as_ptr())
            .with_tokens(&tokens)
            .with_count(1)
            .with_token_timestamps(&token_times)
            .with_segments(&segments)
            .with_segment_count(1)
            .with_segment_timestamps(&segment_times);

        let result = snapshot_raw_result(&raw).expect("aligned timing arrays should snapshot");

        assert_eq!(result.timestamps_millis(), Some(&[125][..]));
        assert_eq!(result.segment_timestamps_millis(), Some(&[500][..]));
    }

    fn raw_result(text: *const c_char) -> SherpaOnnxOfflineRecognizerResult {
        SherpaOnnxOfflineRecognizerResult {
            text,
            timestamps: ptr::null_mut(),
            count: 0,
            tokens: ptr::null(),
            tokens_arr: ptr::null(),
            json: ptr::null(),
            lang: ptr::null(),
            emotion: ptr::null(),
            event: ptr::null(),
            durations: ptr::null_mut(),
            ys_log_probs: ptr::null_mut(),
            segment_timestamps: ptr::null(),
            segment_durations: ptr::null(),
            segment_texts: ptr::null(),
            segment_texts_arr: ptr::null(),
            segment_count: 0,
        }
    }

    trait RawResultExt {
        fn with_count(self, count: c_int) -> Self;
        fn with_tokens(self, tokens: &[*const c_char]) -> Self;
        fn with_token_timestamps(self, timestamps: &[c_float]) -> Self;
        fn with_segment_count(self, count: c_int) -> Self;
        fn with_segments(self, segments: &[*const c_char]) -> Self;
        fn with_segment_timestamps(self, timestamps: &[c_float]) -> Self;
    }

    impl RawResultExt for SherpaOnnxOfflineRecognizerResult {
        fn with_count(mut self, count: c_int) -> Self {
            self.count = count;
            self
        }

        fn with_tokens(mut self, tokens: &[*const c_char]) -> Self {
            self.tokens_arr = tokens.as_ptr();
            self
        }

        fn with_token_timestamps(mut self, timestamps: &[c_float]) -> Self {
            self.timestamps = timestamps.as_ptr().cast_mut();
            self
        }

        fn with_segment_count(mut self, count: c_int) -> Self {
            self.segment_count = count;
            self
        }

        fn with_segments(mut self, segments: &[*const c_char]) -> Self {
            self.segment_texts_arr = segments.as_ptr();
            self
        }

        fn with_segment_timestamps(mut self, timestamps: &[c_float]) -> Self {
            self.segment_timestamps = timestamps.as_ptr();
            self
        }
    }
}
