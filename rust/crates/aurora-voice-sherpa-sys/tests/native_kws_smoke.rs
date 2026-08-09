#![cfg(all(feature = "native-kws", not(target_arch = "wasm32")))]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use aurora_voice_sherpa_sys::{ErrorCode, KeywordResult, KeywordSession, KeywordSpotterConfig};

const LIGHT_UP_KEYWORD: &str = "▁ L IGHT ▁UP";

#[test]
fn light_up_detection_matches_phase4_wav_with_inline_keywords() {
    let config = kws_config();
    let pcm = read_pcm16_mono_16khz_wav(&env_path("AURORA_SHERPA_ONNX_TEST_WAV"));

    let chunked = run_kws(&config, &pcm, 1600);
    let fullish = run_kws(&config, &pcm, 16_000);

    assert_light_up(&chunked);
    assert_eq!(chunked, fullish);
}

#[test]
fn malformed_and_finished_inputs_are_rejected_without_native_growth() {
    let config = kws_config();
    let mut session = KeywordSession::new(&config).expect("session should be created");
    let session_debug = format!("{session:?}");
    assert!(session_debug.contains("spotter: \"<redacted>\""));
    assert!(session_debug.contains("stream: \"<redacted>\""));

    let malformed = session
        .accept_waveform(16_000, &[f32::NAN])
        .expect_err("nan input should be rejected before native accept");
    assert_eq!(malformed.code(), ErrorCode::WaveformNonFinite);

    session
        .input_finished()
        .expect("input_finished should be idempotent");
    session
        .input_finished()
        .expect("second input_finished should be idempotent");
    let after_finished = session
        .accept_waveform(16_000, &[0.0; 512])
        .expect_err("accept after input_finished should fail closed");
    assert_eq!(after_finished.code(), ErrorCode::WaveformInputFinished);

    session.reset().expect("reset should allow reuse");
    session
        .accept_waveform(16_000, &[0.0; 512])
        .expect("reset stream should accept silence");
    session.cancel().expect("cancel should reset stream");
}

#[test]
fn long_silence_runs_without_detection_or_reset() {
    let config = kws_config();
    let mut session = KeywordSession::new(&config).expect("session should be created");
    let silence = vec![0.0; 16_000 * 35];

    for chunk in silence.chunks(1600) {
        let detections = session
            .accept_waveform(16_000, chunk)
            .expect("long silence should stream");
        assert!(detections.is_empty(), "silence should not trigger");
    }

    let final_detections = session
        .input_finished()
        .expect("silence finish should decode bounded frames");
    assert!(final_detections.is_empty(), "silence should remain quiet");
}

#[test]
fn config_preflights_missing_paths_before_native_create() {
    let mut config = kws_config();
    config = KeywordSpotterConfig::new(
        "/tmp/private-user-token/missing-encoder.onnx",
        config.decoder_path().to_owned(),
        config.joiner_path().to_owned(),
        config.tokens_path().to_owned(),
        LIGHT_UP_KEYWORD,
    );

    let error = KeywordSession::new(&config).expect_err("missing path should be preflighted");
    assert_eq!(error.code(), ErrorCode::ConfigModelPathUnavailable);
    assert!(!error.to_string().contains("private-user-token"));
}

#[test]
fn session_owns_stream_until_after_spotter_use() {
    let config = kws_config();
    for _ in 0..3 {
        let mut session = KeywordSession::new(&config).expect("session should be created");
        session
            .accept_waveform(16_000, &[0.0; 1600])
            .expect("session should accept silence");
    }
}

#[test]
fn keyword_result_debug_redacts_user_derived_content() {
    let result = KeywordResult {
        keyword: "LIGHT UP".to_owned(),
        tokens: vec!["▁".to_owned(), "L".to_owned()],
        timestamps: vec![0.1, 0.2],
        start_time: 0.0,
        json: "{\"keyword\":\"LIGHT UP\"}".to_owned(),
    };

    let debug = format!("{result:?}");
    assert!(debug.contains("keyword: \"<redacted>\""));
    assert!(debug.contains("tokens: \"<redacted>\""));
    assert!(debug.contains("json: \"<redacted>\""));
    assert!(!debug.contains("LIGHT UP"));
    assert!(!debug.contains("▁"));
}

fn run_kws(config: &KeywordSpotterConfig, pcm: &[f32], chunk_size: usize) -> Vec<KeywordResult> {
    let mut session = KeywordSession::new(config).expect("session should be created");
    let mut detections = Vec::new();
    for chunk in pcm.chunks(chunk_size) {
        detections.extend(
            session
                .accept_waveform(16_000, chunk)
                .expect("kws chunk should decode"),
        );
    }
    detections.extend(
        session
            .accept_waveform(16_000, &[0.0; 8000])
            .expect("tail padding should decode"),
    );
    detections.extend(
        session
            .input_finished()
            .expect("finish should decode remaining frames"),
    );
    detections
}

fn assert_light_up(results: &[KeywordResult]) {
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].keyword, "LIGHT UP");
    assert!(!results[0].tokens.is_empty());
    assert_eq!(results[0].tokens.len(), results[0].timestamps.len());
    assert!(results[0].json.contains("LIGHT UP"));
}

fn kws_config() -> KeywordSpotterConfig {
    let dir = env_path("AURORA_SHERPA_ONNX_KWS_DIR");
    KeywordSpotterConfig::new(
        dir.join("encoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
        dir.join("decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
        dir.join("joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        dir.join("tokens.txt"),
        LIGHT_UP_KEYWORD,
    )
}

fn env_path(name: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} must be set"))
}

fn read_pcm16_mono_16khz_wav(path: &Path) -> Vec<f32> {
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
    assert_eq!(format.sample_rate, 16_000, "wav must be 16 kHz");
    assert_eq!(format.bits_per_sample, 16, "wav must be PCM16");

    let data = data.expect("wav data chunk should exist");
    assert_eq!(data.len() % 2, 0, "pcm16 data should be aligned");
    data.chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0)
        .collect()
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
