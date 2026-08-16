use std::ffi::CString;
use std::fmt;
use std::os::raw::{c_char, c_float, c_int, c_void};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};

use super::{
    path_bytes_for_tts, ErrorCode, OfflineTtsConfig, OfflineTtsGenerationConfig,
    OfflineTtsModelKind, TtsAudio, TtsError, DEFAULT_TTS_NUM_STEPS, MAX_TTS_CALLBACK_CHUNK_SAMPLES,
};

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsVitsModelConfig {
    model: *const c_char,
    lexicon: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    noise_scale: c_float,
    noise_scale_w: c_float,
    length_scale: c_float,
    dict_dir: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsMatchaModelConfig {
    acoustic_model: *const c_char,
    vocoder: *const c_char,
    lexicon: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    noise_scale: c_float,
    length_scale: c_float,
    dict_dir: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsKokoroModelConfig {
    model: *const c_char,
    voices: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    length_scale: c_float,
    dict_dir: *const c_char,
    lexicon: *const c_char,
    lang: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsKittenModelConfig {
    model: *const c_char,
    voices: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    length_scale: c_float,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsZipvoiceModelConfig {
    tokens: *const c_char,
    encoder: *const c_char,
    decoder: *const c_char,
    vocoder: *const c_char,
    data_dir: *const c_char,
    lexicon: *const c_char,
    feat_scale: c_float,
    t_shift: c_float,
    target_rms: c_float,
    guidance_scale: c_float,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsPocketModelConfig {
    lm_flow: *const c_char,
    lm_main: *const c_char,
    encoder: *const c_char,
    decoder: *const c_char,
    text_conditioner: *const c_char,
    vocab_json: *const c_char,
    token_scores_json: *const c_char,
    voice_embedding_cache_capacity: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsSupertonicModelConfig {
    duration_predictor: *const c_char,
    text_encoder: *const c_char,
    vector_estimator: *const c_char,
    vocoder: *const c_char,
    tts_json: *const c_char,
    unicode_indexer: *const c_char,
    voice_style: *const c_char,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsModelConfig {
    vits: SherpaOnnxOfflineTtsVitsModelConfig,
    num_threads: c_int,
    debug: c_int,
    provider: *const c_char,
    matcha: SherpaOnnxOfflineTtsMatchaModelConfig,
    kokoro: SherpaOnnxOfflineTtsKokoroModelConfig,
    kitten: SherpaOnnxOfflineTtsKittenModelConfig,
    zipvoice: SherpaOnnxOfflineTtsZipvoiceModelConfig,
    pocket: SherpaOnnxOfflineTtsPocketModelConfig,
    supertonic: SherpaOnnxOfflineTtsSupertonicModelConfig,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxOfflineTtsConfig {
    model: SherpaOnnxOfflineTtsModelConfig,
    rule_fsts: *const c_char,
    max_num_sentences: c_int,
    rule_fars: *const c_char,
    silence_scale: c_float,
}

#[repr(C)]
struct SherpaOnnxGeneratedAudio {
    samples: *const c_float,
    n: c_int,
    sample_rate: c_int,
}

#[repr(C)]
#[derive(Default)]
struct SherpaOnnxGenerationConfig {
    silence_scale: c_float,
    speed: c_float,
    sid: c_int,
    reference_audio: *const c_float,
    reference_audio_len: c_int,
    reference_sample_rate: c_int,
    reference_text: *const c_char,
    num_steps: c_int,
    extra: *const c_char,
}

enum SherpaOnnxOfflineTts {}

type ProgressCallback = extern "C" fn(*const c_float, c_int, c_float, *mut c_void) -> c_int;

unsafe extern "C" {
    fn SherpaOnnxCreateOfflineTts(
        config: *const SherpaOnnxOfflineTtsConfig,
    ) -> *const SherpaOnnxOfflineTts;
    fn SherpaOnnxDestroyOfflineTts(tts: *const SherpaOnnxOfflineTts);
    fn SherpaOnnxOfflineTtsSampleRate(tts: *const SherpaOnnxOfflineTts) -> c_int;
    fn SherpaOnnxOfflineTtsNumSpeakers(tts: *const SherpaOnnxOfflineTts) -> c_int;
    fn SherpaOnnxOfflineTtsGenerateWithConfig(
        tts: *const SherpaOnnxOfflineTts,
        text: *const c_char,
        config: *const SherpaOnnxGenerationConfig,
        callback: Option<ProgressCallback>,
        arg: *mut c_void,
    ) -> *const SherpaOnnxGeneratedAudio;
    fn SherpaOnnxDestroyOfflineTtsGeneratedAudio(p: *const SherpaOnnxGeneratedAudio);
}

pub(crate) struct OfflineTts {
    ptr: NonNull<SherpaOnnxOfflineTts>,
}

impl OfflineTts {
    pub(crate) fn new(config: &OfflineTtsConfig) -> Result<Self, TtsError> {
        let provider = string_cstring(config.provider(), ErrorCode::ConfigProviderNul)?;

        let ptr = match config.model_kind() {
            OfflineTtsModelKind::VitsPiper => {
                let model = path_cstring(config.model_path(), ErrorCode::ConfigModelPathEmpty)?;
                let tokens = path_cstring(config.tokens_path(), ErrorCode::ConfigTokensPathEmpty)?;
                let data_dir =
                    path_cstring(config.espeak_data_dir(), ErrorCode::ConfigDataDirEmpty)?;
                let lexicon = config
                    .lexicon_path()
                    .map(|path| path_cstring(path, ErrorCode::ConfigLexiconPathEmpty))
                    .transpose()?;
                let raw = SherpaOnnxOfflineTtsConfig {
                    model: SherpaOnnxOfflineTtsModelConfig {
                        vits: SherpaOnnxOfflineTtsVitsModelConfig {
                            model: model.as_ptr(),
                            lexicon: lexicon
                                .as_ref()
                                .map_or(std::ptr::null(), |value| value.as_ptr()),
                            tokens: tokens.as_ptr(),
                            data_dir: data_dir.as_ptr(),
                            noise_scale: config.noise_scale(),
                            noise_scale_w: config.noise_scale_w(),
                            length_scale: config.length_scale(),
                            dict_dir: std::ptr::null(),
                        },
                        num_threads: config.num_threads(),
                        debug: 0,
                        provider: provider.as_ptr(),
                        ..SherpaOnnxOfflineTtsModelConfig::default()
                    },
                    rule_fsts: std::ptr::null(),
                    max_num_sentences: config.max_num_sentences(),
                    rule_fars: std::ptr::null(),
                    silence_scale: config.silence_scale(),
                };
                unsafe { SherpaOnnxCreateOfflineTts(&raw) }
            }
            OfflineTtsModelKind::Pocket => {
                let files = config.pocket_files().ok_or(TtsError::InvalidConfig {
                    code: ErrorCode::ConfigModelPathEmpty,
                })?;
                let lm_flow = path_cstring(files.lm_flow_path(), ErrorCode::ConfigModelPathEmpty)?;
                let lm_main = path_cstring(files.lm_main_path(), ErrorCode::ConfigModelPathEmpty)?;
                let encoder = path_cstring(files.encoder_path(), ErrorCode::ConfigModelPathEmpty)?;
                let decoder = path_cstring(files.decoder_path(), ErrorCode::ConfigModelPathEmpty)?;
                let text_conditioner = path_cstring(
                    files.text_conditioner_path(),
                    ErrorCode::ConfigModelPathEmpty,
                )?;
                let vocab_json =
                    path_cstring(files.vocab_json_path(), ErrorCode::ConfigTokensPathEmpty)?;
                let token_scores_json = path_cstring(
                    files.token_scores_json_path(),
                    ErrorCode::ConfigTokensPathEmpty,
                )?;
                let raw = SherpaOnnxOfflineTtsConfig {
                    model: SherpaOnnxOfflineTtsModelConfig {
                        pocket: SherpaOnnxOfflineTtsPocketModelConfig {
                            lm_flow: lm_flow.as_ptr(),
                            lm_main: lm_main.as_ptr(),
                            encoder: encoder.as_ptr(),
                            decoder: decoder.as_ptr(),
                            text_conditioner: text_conditioner.as_ptr(),
                            vocab_json: vocab_json.as_ptr(),
                            token_scores_json: token_scores_json.as_ptr(),
                            voice_embedding_cache_capacity: files.voice_embedding_cache_capacity(),
                        },
                        num_threads: config.num_threads(),
                        debug: 0,
                        provider: provider.as_ptr(),
                        ..SherpaOnnxOfflineTtsModelConfig::default()
                    },
                    rule_fsts: std::ptr::null(),
                    max_num_sentences: config.max_num_sentences(),
                    rule_fars: std::ptr::null(),
                    silence_scale: config.silence_scale(),
                };
                unsafe { SherpaOnnxCreateOfflineTts(&raw) }
            }
        };

        let ptr = NonNull::new(ptr.cast_mut()).ok_or(TtsError::NativeCreateFailed)?;
        Ok(Self { ptr })
    }

    pub(crate) fn sample_rate(&self) -> Result<i32, TtsError> {
        Ok(unsafe { SherpaOnnxOfflineTtsSampleRate(self.ptr.as_ptr()) })
    }

    pub(crate) fn num_speakers(&self) -> Result<i32, TtsError> {
        Ok(unsafe { SherpaOnnxOfflineTtsNumSpeakers(self.ptr.as_ptr()) })
    }

    pub(crate) fn generate(
        &self,
        text: &str,
        config: &OfflineTtsGenerationConfig,
        cancellation: &AtomicBool,
    ) -> Result<TtsAudio, TtsError> {
        let text = string_cstring(text, ErrorCode::TextNul)?;
        let reference_text = config
            .reference_text()
            .map(|value| string_cstring(value, ErrorCode::TextNul))
            .transpose()?;
        let extra = config
            .extra()
            .map(|value| string_cstring(value, ErrorCode::ConfigProviderNul))
            .transpose()?;
        let reference_audio = config.reference_audio();
        let reference_audio_len = reference_audio
            .map(|audio| c_int::try_from(audio.samples().len()))
            .transpose()
            .map_err(|_| TtsError::NativeAudioTooLong)?
            .unwrap_or_default();
        let raw_config = SherpaOnnxGenerationConfig {
            silence_scale: config.silence_scale(),
            speed: config.speed(),
            sid: config.speaker_id(),
            reference_audio: reference_audio
                .map_or(std::ptr::null(), |audio| audio.samples().as_ptr()),
            reference_audio_len,
            reference_sample_rate: reference_audio.map_or(0, |audio| audio.sample_rate()),
            reference_text: reference_text
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            num_steps: config.num_steps().unwrap_or(DEFAULT_TTS_NUM_STEPS),
            extra: extra
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
        };
        let mut callback_state = CallbackState {
            cancellation,
            invalid_audio: false,
            cancelled: false,
        };
        let audio = unsafe {
            SherpaOnnxOfflineTtsGenerateWithConfig(
                self.ptr.as_ptr(),
                text.as_ptr(),
                &raw_config,
                Some(progress_callback),
                (&mut callback_state as *mut CallbackState<'_>).cast::<c_void>(),
            )
        };
        if callback_state.invalid_audio {
            destroy_generated_audio_if_present(audio);
            return Err(TtsError::NativeInvalidAudio);
        }
        if callback_state.cancelled || cancellation.load(Ordering::Acquire) {
            destroy_generated_audio_if_present(audio);
            return Err(TtsError::Cancelled);
        }
        let handle = GeneratedAudioHandle::new(audio)?;
        handle.snapshot()
    }
}

impl fmt::Debug for OfflineTts {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OfflineTts")
            .field("ptr", &"<redacted>")
            .finish()
    }
}

impl Drop for OfflineTts {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyOfflineTts(self.ptr.as_ptr());
        }
    }
}

struct GeneratedAudioHandle {
    ptr: NonNull<SherpaOnnxGeneratedAudio>,
}

impl GeneratedAudioHandle {
    fn new(ptr: *const SherpaOnnxGeneratedAudio) -> Result<Self, TtsError> {
        let ptr = NonNull::new(ptr.cast_mut()).ok_or(TtsError::NativeNullAudio)?;
        Ok(Self { ptr })
    }

    fn snapshot(&self) -> Result<TtsAudio, TtsError> {
        let raw = unsafe { self.ptr.as_ref() };
        if raw.n <= 0 || raw.samples.is_null() {
            return Err(TtsError::NativeInvalidAudio);
        }
        let len = usize::try_from(raw.n).map_err(|_| TtsError::NativeAudioTooLong)?;
        let samples = unsafe { std::slice::from_raw_parts(raw.samples, len) }.to_vec();
        TtsAudio::new(raw.sample_rate, samples)
    }
}

impl Drop for GeneratedAudioHandle {
    fn drop(&mut self) {
        unsafe {
            SherpaOnnxDestroyOfflineTtsGeneratedAudio(self.ptr.as_ptr());
        }
    }
}

struct CallbackState<'a> {
    cancellation: &'a AtomicBool,
    invalid_audio: bool,
    cancelled: bool,
}

extern "C" fn progress_callback(
    samples: *const c_float,
    n: c_int,
    _progress: c_float,
    arg: *mut c_void,
) -> c_int {
    if arg.is_null() {
        return 0;
    }
    let state = unsafe { &mut *arg.cast::<CallbackState<'_>>() };
    if state.cancellation.load(Ordering::Acquire) {
        state.cancelled = true;
        return 0;
    }
    if !(0..=MAX_TTS_CALLBACK_CHUNK_SAMPLES).contains(&n) {
        state.invalid_audio = true;
        return 0;
    }
    if n > 0 && samples.is_null() {
        state.invalid_audio = true;
        return 0;
    }
    if n > 0 {
        let slice = unsafe { std::slice::from_raw_parts(samples, n as usize) };
        if slice
            .iter()
            .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
        {
            state.invalid_audio = true;
            return 0;
        }
    }
    1
}

fn destroy_generated_audio_if_present(audio: *const SherpaOnnxGeneratedAudio) {
    if !audio.is_null() {
        unsafe {
            SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
        }
    }
}

fn path_cstring(path: &std::path::Path, empty_code: ErrorCode) -> Result<CString, TtsError> {
    CString::new(path_bytes_for_tts(path, empty_code)?).map_err(|_| TtsError::InvalidConfig {
        code: super::model_path_nul_code(empty_code),
    })
}

fn string_cstring(value: &str, code: ErrorCode) -> Result<CString, TtsError> {
    CString::new(value).map_err(|_| TtsError::InvalidConfig { code })
}
