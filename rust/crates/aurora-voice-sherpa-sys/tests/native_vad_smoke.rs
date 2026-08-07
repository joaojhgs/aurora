#![cfg(all(feature = "native-vad", not(target_arch = "wasm32")))]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use aurora_voice_sherpa_sys::{ErrorCode, SileroVadConfig, SpeechSegment, VoiceActivityDetector};

#[test]
fn silero_vad_matches_phase4_kws_pcm16_fixture() {
    let model_path = env_path("AURORA_SHERPA_ONNX_MODEL");
    let wav_path = env_path("AURORA_SHERPA_ONNX_TEST_WAV");
    let pcm = read_pcm16_mono_16khz_wav(&wav_path);
    let config = SileroVadConfig::new(model_path)
        .with_threshold(0.25)
        .with_min_silence_duration(0.25)
        .with_min_speech_duration(0.25)
        .with_max_speech_duration(10.0)
        .with_window_size(512)
        .with_sample_rate(16_000)
        .with_num_threads(1)
        .with_provider("cpu")
        .with_buffer_size_seconds(30.0);

    let first = run_fixture(&config, &pcm);
    assert_segment_parity(&first);

    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");
    let detector_debug = format!("{detector:?}");
    assert!(detector_debug.contains("inner: \"<redacted>\""));
    assert!(!detector_debug.contains("0x"));
    accept_in_windows(&mut detector, &pcm);
    detector.flush().expect("first flush should succeed");
    let replay = detector
        .drain_speech_segments()
        .expect("first drain should succeed");
    assert_eq!(replay, first);

    detector.reset().expect("reset should succeed");
    accept_in_windows(&mut detector, &pcm);
    detector.flush().expect("replay flush should succeed");
    let reset_replay = detector
        .drain_speech_segments()
        .expect("replay drain should succeed");
    assert_eq!(reset_replay, first);

    detector.flush().expect("second flush should be idempotent");
    let after_second_flush = detector
        .drain_speech_segments()
        .expect("second flush drain should succeed");
    assert!(
        after_second_flush.is_empty(),
        "second flush should not create another segment"
    );
}

#[test]
fn accept_budget_rejects_cumulative_accepts_until_drain_clear_or_reset() {
    let model_path = env_path("AURORA_SHERPA_ONNX_MODEL");
    let config = SileroVadConfig::new(model_path)
        .with_threshold(0.25)
        .with_min_silence_duration(0.001)
        .with_min_speech_duration(0.001)
        .with_max_speech_duration(0.032)
        .with_window_size(512)
        .with_sample_rate(16_000)
        .with_num_threads(1)
        .with_provider("cpu")
        .with_buffer_size_seconds(0.032);
    let exact_window = vec![0.0; 512];
    let short_tail = vec![0.0; 1];

    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");
    detector
        .accept_waveform(&exact_window)
        .expect("exact retained budget should be accepted");
    detector
        .flush()
        .expect("flush should not reset accept budget");
    assert_accept_budget_exceeded(&mut detector, &short_tail);

    detector.clear().expect("clear should reset accept budget");
    detector
        .accept_waveform(&exact_window)
        .expect("clear should allow reuse");

    detector.reset().expect("reset should reset accept budget");
    detector
        .accept_waveform(&exact_window)
        .expect("reset should allow reuse");

    let empty_drain = detector
        .drain_speech_segments()
        .expect("empty drain should succeed without resetting accept budget");
    assert!(
        empty_drain.is_empty(),
        "silent exact window should not enqueue a segment"
    );
    assert_accept_budget_exceeded(&mut detector, &short_tail);

    detector
        .reset()
        .expect("reset should release retained silent window");
    detector
        .accept_waveform(&exact_window[..511])
        .expect("short tail prefix should be accepted");
    detector
        .accept_waveform(&exact_window[..1])
        .expect("short tail should reach exact retained budget");
    assert_accept_budget_exceeded(&mut detector, &short_tail);
}

fn run_fixture(config: &SileroVadConfig, pcm: &[f32]) -> Vec<SpeechSegment> {
    let mut detector = VoiceActivityDetector::new(config).expect("detector should be created");
    accept_in_windows(&mut detector, pcm);
    detector.flush().expect("flush should succeed");
    detector
        .drain_speech_segments()
        .expect("segments should drain")
}

fn accept_in_windows(detector: &mut VoiceActivityDetector, pcm: &[f32]) {
    for chunk in pcm.chunks(512) {
        detector
            .accept_waveform(chunk)
            .expect("fixture waveform chunk should be accepted");
    }
}

fn assert_segment_parity(segments: &[SpeechSegment]) {
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].start, 5728);
    assert_eq!(segments[0].samples.len(), 93_696);
}

fn assert_accept_budget_exceeded(detector: &mut VoiceActivityDetector, pcm: &[f32]) {
    let error = detector
        .accept_waveform(pcm)
        .expect_err("accept should be rejected before crossing native FFI");
    assert_eq!(
        error.code(),
        ErrorCode::WaveformBufferedAcceptBudgetExceeded
    );
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

    let format = format.expect("wav fmt chunk missing");
    assert_eq!(format.audio_format, 1, "wav must be PCM");
    assert_eq!(format.channels, 1, "wav must be mono");
    assert_eq!(format.sample_rate, 16_000, "wav must be 16 kHz");
    assert_eq!(format.bits_per_sample, 16, "wav must be PCM16");
    assert_eq!(format.block_align, 2, "wav block alignment mismatch");

    let data = data.expect("wav data chunk missing");
    assert_eq!(data.len() % 2, 0, "PCM16 data must be sample aligned");
    data.chunks_exact(2)
        .map(|sample| {
            let value = i16::from_le_bytes(sample.try_into().expect("sample should be readable"));
            f32::from(value) / 32768.0
        })
        .collect()
}

#[derive(Debug)]
struct WavFormat {
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    block_align: u16,
    bits_per_sample: u16,
}

fn parse_format_chunk(chunk: &[u8]) -> WavFormat {
    assert!(chunk.len() >= 16, "wav fmt chunk too short");
    WavFormat {
        audio_format: u16::from_le_bytes(chunk[0..2].try_into().expect("format readable")),
        channels: u16::from_le_bytes(chunk[2..4].try_into().expect("channels readable")),
        sample_rate: u32::from_le_bytes(chunk[4..8].try_into().expect("sample rate readable")),
        block_align: u16::from_le_bytes(chunk[12..14].try_into().expect("block align readable")),
        bits_per_sample: u16::from_le_bytes(
            chunk[14..16].try_into().expect("bits per sample readable"),
        ),
    }
}
