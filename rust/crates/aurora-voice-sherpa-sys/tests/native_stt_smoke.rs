#![cfg(all(feature = "native-stt", not(target_arch = "wasm32")))]

use std::env;
use std::fs;
use std::io::Read;
use std::os::fd::FromRawFd;
use std::os::raw::c_int;
use std::path::{Path, PathBuf};

use aurora_voice_sherpa_sys::{
    ErrorCode, OfflineSttConfig, OfflineSttRecognizer, OfflineSttResult, SttError,
};

const MOONSHINE_MODEL: &str = "models/extracted/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27";
const EXPECTED_TEXT: &str =
    "Ask not what your country can do for you. Ask what you can do for your country.";

#[test]
fn moonshine_stt_matches_phase4_wav_exactly_and_reuses_new_streams() {
    let config = phase4_config().expect("phase4 config should validate");
    let source_wave = read_pcm16_mono_wav(&phase4_wav_path());
    assert_eq!(source_wave.sample_rate, 24_000);
    let wave = source_wave.resample_to_16khz();
    let mut recognizer = OfflineSttRecognizer::new(&config).expect("recognizer should be created");
    let recognizer_debug = format!("{recognizer:?}");
    assert!(recognizer_debug.contains("inner: \"<redacted>\""));
    assert!(!recognizer_debug.contains(MOONSHINE_MODEL));

    let (first, stderr) = capture_stderr(|| decode_once(&mut recognizer, &wave));
    assert!(
        stderr.is_empty(),
        "16 kHz input should avoid native resampler logs"
    );
    assert!(!stderr.contains(MOONSHINE_MODEL));
    assert_exact_transcript(&first);

    let second = decode_once(&mut recognizer, &wave);
    assert_eq!(second.text(), first.text());
    assert_eq!(second.tokens(), first.tokens());
}

#[test]
fn stt_transcribe_owns_stream_lifecycle_and_reuses_recognizer() {
    let config = phase4_config().expect("phase4 config should validate");
    let wave = read_pcm16_mono_wav(&phase4_wav_path()).resample_to_16khz();
    let mut recognizer = OfflineSttRecognizer::new(&config).expect("recognizer should be created");

    let result = recognizer
        .transcribe(wave.sample_rate, &wave.pcm)
        .expect("single-call transcribe should decode");
    assert_exact_transcript(&result);

    let result = recognizer
        .transcribe(wave.sample_rate, &wave.pcm)
        .expect("recognizer should create a fresh private stream per call");
    assert_exact_transcript(&result);
}

#[test]
fn stt_rejects_malformed_adversarial_and_oversized_inputs_before_native_calls() {
    let config = phase4_config().expect("phase4 config should validate");
    let mut recognizer = OfflineSttRecognizer::new(&config).expect("recognizer should be created");

    let cases: &[(&[f32], ErrorCode)] = &[
        (&[], ErrorCode::WaveformEmpty),
        (&[f32::NAN], ErrorCode::WaveformNonFinite),
        (&[f32::INFINITY], ErrorCode::WaveformNonFinite),
        (&[1.000_1], ErrorCode::WaveformOutOfRange),
        (&[-1.000_1], ErrorCode::WaveformOutOfRange),
    ];
    for (pcm, expected) in cases {
        let error = recognizer
            .transcribe(16_000, pcm)
            .expect_err("invalid pcm should be rejected before native accept");
        assert_eq!(error.code(), *expected);
    }

    let short_bound = phase4_config()
        .expect("phase4 config should validate")
        .with_max_audio_seconds(0.001);
    let mut short_recognizer =
        OfflineSttRecognizer::new(&short_bound).expect("short recognizer should be created");
    let too_long = vec![0.0; 17];
    let error = short_recognizer
        .transcribe(16_000, &too_long)
        .expect_err("oversized utterance should be rejected before native accept");
    assert_eq!(error.code(), ErrorCode::WaveformTooLong);

    let source_wave = read_pcm16_mono_wav(&phase4_wav_path());
    assert_eq!(source_wave.sample_rate, 24_000);
    let error = recognizer
        .transcribe(source_wave.sample_rate, &source_wave.pcm)
        .expect_err("non-canonical sample rate must be rejected before native accept");
    assert_eq!(error.code(), ErrorCode::ConfigSampleRateRange);
}

#[test]
fn stt_config_preflight_is_readable_and_errors_redacted() {
    let secret_missing =
        PathBuf::from("/tmp/private-user-token-do-not-log/missing-encoder-model.ort");
    let config = OfflineSttConfig::moonshine_v2(
        secret_missing.clone(),
        phase4_model_path("decoder_model_merged.ort"),
        phase4_model_path("tokens.txt"),
    );
    let error = config
        .validate()
        .expect_err("missing encoder should fail before native recognizer creation");
    assert_eq!(error.code(), ErrorCode::ConfigEncoderPathUnreadable);
    assert_error_redacted(&error, &secret_missing);

    let debug = format!("{config:?}");
    assert!(debug.contains("encoder_path: \"<redacted>\""));
    assert!(!debug.contains("private-user-token-do-not-log"));
    assert!(!debug.contains("decoder_model_merged"));

    let empty_method = phase4_config()
        .expect("phase4 config should validate")
        .with_decoding_method("");
    let error = empty_method
        .validate()
        .expect_err("empty method should be rejected");
    assert_eq!(error.code(), ErrorCode::ConfigDecodingMethodEmpty);
}

#[test]
fn drop_before_decode_is_safe_and_decode_non_preemptibility_is_documented() {
    let config = phase4_config().expect("phase4 config should validate");
    let wave = read_pcm16_mono_wav(&phase4_wav_path()).resample_to_16khz();
    {
        let _recognizer =
            OfflineSttRecognizer::new(&config).expect("unused recognizer should be droppable");
    }

    let mut recognizer = OfflineSttRecognizer::new(&config).expect("recognizer should be created");
    let result = decode_once(&mut recognizer, &wave);
    assert_exact_transcript(&result);
}

fn decode_once(recognizer: &mut OfflineSttRecognizer, wave: &WavPcm) -> OfflineSttResult {
    recognizer
        .transcribe(wave.sample_rate, &wave.pcm)
        .expect("fixture waveform should decode")
}

fn assert_exact_transcript(result: &OfflineSttResult) {
    assert_eq!(result.text(), EXPECTED_TEXT);
    assert!(result.text().len() <= 16_384);
    assert!(result.tokens().len() <= 4096);
    assert!(result
        .timestamps_millis()
        .is_none_or(|timestamps| result.tokens().len() == timestamps.len()));
    assert!(result
        .segment_timestamps_millis()
        .is_none_or(|timestamps| result.segment_texts().len() == timestamps.len()));
    for token in result.tokens() {
        assert!(!token.is_empty());
        assert!(token.len() <= 256);
    }
    let debug = format!("{result:?}");
    assert!(debug.contains("text: \"<redacted>\""));
    assert!(!debug.contains(EXPECTED_TEXT));
}

fn assert_error_redacted(error: &SttError, secret_path: &Path) {
    let rendered = error.to_string();
    let debug = format!("{error:?}");
    let secret = secret_path.display().to_string();
    assert!(!rendered.contains(&secret));
    assert!(!debug.contains(&secret));
}

fn phase4_config() -> Result<OfflineSttConfig, SttError> {
    let config = OfflineSttConfig::moonshine_v2(
        phase4_model_path("encoder_model.ort"),
        phase4_model_path("decoder_model_merged.ort"),
        phase4_model_path("tokens.txt"),
    )
    .with_sample_rate(16_000)
    .with_feature_dim(80)
    .with_num_threads(1)
    .with_provider("cpu")
    .with_decoding_method("greedy_search")
    .with_max_audio_seconds(60.0);
    config.validate()?;
    Ok(config)
}

fn phase4_model_path(file: &str) -> PathBuf {
    env::var_os("AURORA_SHERPA_ONNX_STT_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| phase4_root().join(MOONSHINE_MODEL))
        .join(file)
}

fn phase4_wav_path() -> PathBuf {
    env::var_os("AURORA_SHERPA_ONNX_STT_TEST_WAV")
        .map(PathBuf::from)
        .unwrap_or_else(|| phase4_root().join(MOONSHINE_MODEL).join("test_wavs/0.wav"))
}

fn phase4_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(".artifacts/pockettts/p4-native-voice")
}

fn read_pcm16_mono_wav(path: &Path) -> WavPcm {
    let bytes = fs::read(path).expect("wav file should be readable");
    assert!(bytes.len() >= 12, "wav file too short");
    assert_eq!(&bytes[0..4], b"RIFF", "wav must be RIFF");
    assert_eq!(&bytes[8..12], b"WAVE", "wav must be WAVE");

    let mut cursor = 12usize;
    let mut format: Option<WavFormat> = None;
    let mut data: Option<&[u8]> = None;

    while cursor.checked_add(8).expect("wav cursor overflow") <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = u32::from_le_bytes(
            bytes[cursor + 4..cursor + 8]
                .try_into()
                .expect("chunk size should be readable"),
        ) as usize;
        cursor += 8;
        let end = cursor.checked_add(size).expect("wav chunk overflow");
        assert!(end <= bytes.len(), "wav chunk extends past file");

        match id {
            b"fmt " => format = Some(parse_format_chunk(&bytes[cursor..end])),
            b"data" => data = Some(&bytes[cursor..end]),
            _ => {}
        }

        cursor = end + (size % 2);
    }

    let format = format.expect("wav fmt chunk should exist");
    assert_eq!(format.audio_format, 1, "wav must be PCM");
    assert_eq!(format.channels, 1, "wav must be mono");
    assert_eq!(format.bits_per_sample, 16, "wav must be PCM16");

    let data = data.expect("wav data chunk should exist");
    assert_eq!(data.len() % 2, 0, "pcm16 data should be aligned");
    let pcm = data
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0)
        .collect();
    WavPcm {
        sample_rate: i32::try_from(format.sample_rate).expect("sample rate should fit i32"),
        pcm,
    }
}

fn parse_format_chunk(chunk: &[u8]) -> WavFormat {
    assert!(chunk.len() >= 16, "fmt chunk too short");
    WavFormat {
        audio_format: u16::from_le_bytes(chunk[0..2].try_into().expect("audio format")),
        channels: u16::from_le_bytes(chunk[2..4].try_into().expect("channels")),
        sample_rate: u32::from_le_bytes(chunk[4..8].try_into().expect("sample rate")),
        bits_per_sample: u16::from_le_bytes(chunk[14..16].try_into().expect("bits per sample")),
    }
}

struct WavFormat {
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
}

struct WavPcm {
    sample_rate: i32,
    pcm: Vec<f32>,
}

impl WavPcm {
    fn resample_to_16khz(&self) -> Self {
        if self.sample_rate == 16_000 {
            return Self {
                sample_rate: self.sample_rate,
                pcm: self.pcm.clone(),
            };
        }
        assert_eq!(
            self.sample_rate, 24_000,
            "fixture resampler is intentionally pinned to the official 24 kHz WAV"
        );
        let output_len = self.pcm.len() * 2 / 3;
        let mut pcm = Vec::with_capacity(output_len);
        for index in 0..output_len {
            let source = index as f64 * self.sample_rate as f64 / 16_000.0;
            let left = source.floor() as usize;
            let right = left.saturating_add(1).min(self.pcm.len().saturating_sub(1));
            let fraction = (source - left as f64) as f32;
            let sample = self.pcm[left] + (self.pcm[right] - self.pcm[left]) * fraction;
            pcm.push(sample.clamp(-1.0, 1.0));
        }
        Self {
            sample_rate: 16_000,
            pcm,
        }
    }
}

fn capture_stderr<T>(action: impl FnOnce() -> T) -> (T, String) {
    unsafe extern "C" {
        fn pipe(fds: *mut c_int) -> c_int;
        fn dup(fd: c_int) -> c_int;
        fn dup2(oldfd: c_int, newfd: c_int) -> c_int;
        fn close(fd: c_int) -> c_int;
    }

    const STDERR_FILENO: c_int = 2;
    let mut fds = [0; 2];
    assert_eq!(unsafe { pipe(fds.as_mut_ptr()) }, 0, "pipe should open");
    let saved = unsafe { dup(STDERR_FILENO) };
    assert!(saved >= 0, "stderr dup should succeed");
    assert_eq!(
        unsafe { dup2(fds[1], STDERR_FILENO) },
        STDERR_FILENO,
        "stderr redirect should succeed"
    );

    let result = action();

    assert_eq!(
        unsafe { dup2(saved, STDERR_FILENO) },
        STDERR_FILENO,
        "stderr restore should succeed"
    );
    unsafe {
        close(saved);
        close(fds[1]);
    }

    let mut stderr = String::new();
    let mut reader = unsafe { fs::File::from_raw_fd(fds[0]) };
    reader
        .read_to_string(&mut stderr)
        .expect("captured stderr should be readable");
    (result, stderr)
}
