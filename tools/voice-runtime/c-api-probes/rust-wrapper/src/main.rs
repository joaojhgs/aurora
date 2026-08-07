use std::env;
use std::ffi::{c_char, c_float, c_int, c_void, CString};
use std::mem;
use std::path::PathBuf;
use std::ptr;

#[repr(C)]
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
struct SherpaOnnxOfflineTtsKittenModelConfig {
    model: *const c_char,
    voices: *const c_char,
    tokens: *const c_char,
    data_dir: *const c_char,
    length_scale: c_float,
}

#[repr(C)]
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
struct SherpaOnnxOfflineTtsConfig {
    model: SherpaOnnxOfflineTtsModelConfig,
    rule_fsts: *const c_char,
    max_num_sentences: c_int,
    rule_fars: *const c_char,
    silence_scale: c_float,
}

#[repr(C)]
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

#[repr(C)]
struct SherpaOnnxGeneratedAudio {
    samples: *const c_float,
    n: c_int,
    sample_rate: c_int,
}

enum SherpaOnnxOfflineTts {}

type ProgressCallback = extern "C" fn(*const c_float, c_int, c_float, *mut c_void) -> c_int;

#[link(name = "sherpa-onnx-c-api")]
extern "C" {
    fn SherpaOnnxCreateOfflineTts(
        config: *const SherpaOnnxOfflineTtsConfig,
    ) -> *const SherpaOnnxOfflineTts;
    fn SherpaOnnxDestroyOfflineTts(tts: *const SherpaOnnxOfflineTts);
    fn SherpaOnnxOfflineTtsNumSpeakers(tts: *const SherpaOnnxOfflineTts) -> c_int;
    fn SherpaOnnxOfflineTtsGenerateWithConfig(
        tts: *const SherpaOnnxOfflineTts,
        text: *const c_char,
        config: *const SherpaOnnxGenerationConfig,
        callback: Option<ProgressCallback>,
        arg: *mut c_void,
    ) -> *const SherpaOnnxGeneratedAudio;
    fn SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio: *const SherpaOnnxGeneratedAudio);
}

#[derive(Default)]
struct CancelState {
    calls: i32,
    total_samples: i32,
    last_samples: i32,
    last_progress: f32,
    stop_after: i32,
}

extern "C" fn cancel_after_callback(
    _samples: *const c_float,
    n: c_int,
    progress: c_float,
    arg: *mut c_void,
) -> c_int {
    let state = unsafe { &mut *(arg as *mut CancelState) };
    state.calls += 1;
    state.total_samples += n;
    state.last_samples = n;
    state.last_progress = progress;
    if state.calls < state.stop_after {
        1
    } else {
        0
    }
}

struct OwnedTts {
    ptr: *const SherpaOnnxOfflineTts,
}

impl Drop for OwnedTts {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { SherpaOnnxDestroyOfflineTts(self.ptr) };
        }
    }
}

struct OwnedAudio {
    ptr: *const SherpaOnnxGeneratedAudio,
}

impl Drop for OwnedAudio {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { SherpaOnnxDestroyOfflineTtsGeneratedAudio(self.ptr) };
        }
    }
}

fn cstring_path(path: PathBuf) -> Result<CString, String> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "path contains NUL".to_string())
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    let tts_dir =
        PathBuf::from(arg_value(&args, "--tts-dir").ok_or("usage: --tts-dir DIR [--text TEXT]")?);
    let text = CString::new(
        arg_value(&args, "--text").unwrap_or_else(|| "Aurora Rust FFI probe.".to_string()),
    )
    .map_err(|_| "text contains NUL".to_string())?;
    let model = cstring_path(tts_dir.join("en_US-ljspeech-medium.onnx"))?;
    let tokens = cstring_path(tts_dir.join("tokens.txt"))?;
    let data_dir = cstring_path(tts_dir.join("espeak-ng-data"))?;
    let provider = CString::new("cpu").expect("literal has no NUL");

    let mut config: SherpaOnnxOfflineTtsConfig = unsafe { mem::zeroed() };
    config.model.vits.model = model.as_ptr();
    config.model.vits.tokens = tokens.as_ptr();
    config.model.vits.data_dir = data_dir.as_ptr();
    config.model.vits.noise_scale = 0.667;
    config.model.vits.noise_scale_w = 0.8;
    config.model.vits.length_scale = 1.0;
    config.model.num_threads = 1;
    config.model.provider = provider.as_ptr();
    config.max_num_sentences = 1;

    let tts = OwnedTts {
        ptr: unsafe { SherpaOnnxCreateOfflineTts(&config) },
    };
    if tts.ptr.is_null() {
        return Err("tts creation failed".to_string());
    }

    let generation = SherpaOnnxGenerationConfig {
        silence_scale: 0.2,
        speed: 1.0,
        sid: 0,
        reference_audio: ptr::null(),
        reference_audio_len: 0,
        reference_sample_rate: 0,
        reference_text: ptr::null(),
        num_steps: 0,
        extra: ptr::null(),
    };
    let mut state = CancelState {
        stop_after: 1,
        ..CancelState::default()
    };
    let audio = OwnedAudio {
        ptr: unsafe {
            SherpaOnnxOfflineTtsGenerateWithConfig(
                tts.ptr,
                text.as_ptr(),
                &generation,
                Some(cancel_after_callback),
                &mut state as *mut CancelState as *mut c_void,
            )
        },
    };
    if audio.ptr.is_null() {
        return Err("tts generation failed".to_string());
    }
    let audio_ref = unsafe { &*audio.ptr };
    let speakers = unsafe { SherpaOnnxOfflineTtsNumSpeakers(tts.ptr) };

    println!(
        "{{\"ok\":true,\"mode\":\"rust_tts_cancel\",\"sample_rate\":{},\"num_speakers\":{},\"audio_samples\":{},\"callback_calls\":{},\"callback_samples\":{},\"last_callback_samples\":{},\"last_progress\":{:.6},\"cancel_requested\":true}}",
        audio_ref.sample_rate,
        speakers,
        audio_ref.n,
        state.calls,
        state.total_samples,
        state.last_samples,
        state.last_progress
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!(
            "{{\"ok\":false,\"reason\":\"{}\"}}",
            error.replace('"', "'")
        );
        std::process::exit(1);
    }
}
