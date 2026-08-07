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
    let config = phase4_config(model_path);

    let first = run_fixture(&config, &pcm);
    assert_segment_parity(&first);

    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");
    let detector_debug = format!("{detector:?}");
    assert!(detector_debug.contains("inner: \"<redacted>\""));
    assert!(!detector_debug.contains("0x"));

    let mut replay = accept_in_windows_and_drain(&mut detector, &pcm);
    detector.flush().expect("first flush should succeed");
    replay.extend(
        detector
            .drain_speech_segments()
            .expect("first drain should succeed"),
    );
    assert_eq!(replay, first);

    detector
        .accept_waveform(&vec![0.0; 512])
        .expect("drain should allow accepting more audio");

    detector.reset().expect("reset should succeed");
    let mut reset_replay = accept_in_windows_and_drain(&mut detector, &pcm);
    detector.flush().expect("replay flush should succeed");
    reset_replay.extend(
        detector
            .drain_speech_segments()
            .expect("replay drain should succeed"),
    );
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
fn silence_streams_past_native_buffer_and_max_speech_without_reset() {
    let model_path = env_path("AURORA_SHERPA_ONNX_MODEL");
    let config = phase4_config(model_path);
    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");
    let silence = vec![0.0; 16_000 * 35];

    for chunk in silence.chunks(512) {
        detector
            .accept_waveform(chunk)
            .expect("long silence should not require reset");
        assert!(
            detector.is_empty().expect("queue state should be readable"),
            "silence should not queue speech"
        );
    }

    detector.flush().expect("silent flush should succeed");
    assert!(
        detector
            .drain_speech_segments()
            .expect("silent drain should succeed")
            .is_empty(),
        "silence should not produce a segment"
    );
}

#[test]
fn queued_segment_blocks_accept_until_drain_clear_or_reset() {
    let model_path = env_path("AURORA_SHERPA_ONNX_MODEL");
    let wav_path = env_path("AURORA_SHERPA_ONNX_TEST_WAV");
    let pcm = read_pcm16_mono_16khz_wav(&wav_path);
    let config = phase4_config(model_path);
    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");

    feed_until_detected(&mut detector, &pcm);
    detector.flush().expect("flush should queue current speech");
    assert_queued_segment_undrained(&mut detector, &vec![0.0; 512]);

    let flushed = detector
        .drain_speech_segments()
        .expect("drain is the explicit recovery path");
    assert_eq!(flushed.len(), 1);
    detector
        .accept_waveform(&vec![0.0; 512])
        .expect("drain should allow reuse");

    detector
        .reset()
        .expect("reset should clear the full stream");
    feed_until_detected(&mut detector, &pcm);
    detector.flush().expect("second flush should queue speech");
    assert_queued_segment_undrained(&mut detector, &vec![0.0; 512]);
    detector.clear().expect("clear should drop queued segments");
    detector
        .accept_waveform(&vec![0.0; 512])
        .expect("clear should allow reuse without a full reset");
}

#[test]
fn clear_preserves_in_progress_speech_while_reset_drops_it() {
    let model_path = env_path("AURORA_SHERPA_ONNX_MODEL");
    let wav_path = env_path("AURORA_SHERPA_ONNX_TEST_WAV");
    let pcm = read_pcm16_mono_16khz_wav(&wav_path);
    let config = phase4_config(model_path);
    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");

    feed_until_detected(&mut detector, &pcm);
    assert!(
        detector.detected().expect("detected should be readable"),
        "fixture should enter active speech"
    );
    assert!(
        detector.is_empty().expect("queue state should be readable"),
        "in-progress speech should not be queued yet"
    );

    detector
        .clear()
        .expect("clear should only drop completed segments");
    assert!(
        detector
            .detected()
            .expect("detected should remain readable after clear"),
        "clear should preserve in-progress native speech state"
    );

    detector.reset().expect("reset should drop stream state");
    assert!(
        !detector
            .detected()
            .expect("detected should remain readable after reset"),
        "reset should clear in-progress native speech state"
    );
}

#[test]
fn malformed_accept_does_not_silently_clear_queued_segment() {
    let model_path = env_path("AURORA_SHERPA_ONNX_MODEL");
    let wav_path = env_path("AURORA_SHERPA_ONNX_TEST_WAV");
    let pcm = read_pcm16_mono_16khz_wav(&wav_path);
    let config = phase4_config(model_path);
    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");

    feed_until_detected(&mut detector, &pcm);
    detector.flush().expect("flush should queue speech");
    let malformed = detector
        .accept_waveform(&[f32::NAN])
        .expect_err("malformed pcm should be rejected before queue checks");
    assert_eq!(malformed.code(), ErrorCode::WaveformNonFinite);
    assert_queued_segment_undrained(&mut detector, &vec![0.0; 512]);
    assert_eq!(
        detector
            .drain_speech_segments()
            .expect("queued segment should still drain")
            .len(),
        1
    );
}

fn phase4_config(model_path: PathBuf) -> SileroVadConfig {
    SileroVadConfig::new(model_path)
        .with_threshold(0.25)
        .with_min_silence_duration(0.25)
        .with_min_speech_duration(0.25)
        .with_max_speech_duration(10.0)
        .with_window_size(512)
        .with_sample_rate(16_000)
        .with_num_threads(1)
        .with_provider("cpu")
        .with_buffer_size_seconds(30.0)
}

fn run_fixture(config: &SileroVadConfig, pcm: &[f32]) -> Vec<SpeechSegment> {
    let mut detector = VoiceActivityDetector::new(config).expect("detector should be created");
    let mut segments = accept_in_windows_and_drain(&mut detector, pcm);
    detector.flush().expect("flush should succeed");
    segments.extend(
        detector
            .drain_speech_segments()
            .expect("segments should drain"),
    );
    segments
}

fn accept_in_windows_and_drain(
    detector: &mut VoiceActivityDetector,
    pcm: &[f32],
) -> Vec<SpeechSegment> {
    let mut segments = Vec::new();
    for chunk in pcm.chunks(512) {
        if !detector.is_empty().expect("queue state should be readable") {
            segments.extend(
                detector
                    .drain_speech_segments()
                    .expect("queued segment should drain"),
            );
        }
        detector
            .accept_waveform(chunk)
            .expect("fixture waveform chunk should be accepted");
    }
    segments
}

fn feed_until_detected(detector: &mut VoiceActivityDetector, pcm: &[f32]) {
    for chunk in pcm.chunks(512) {
        detector
            .accept_waveform(chunk)
            .expect("fixture waveform chunk should be accepted before speech is queued");
        if detector.detected().expect("detected should be readable") {
            return;
        }
    }
    panic!("fixture should enter active speech");
}

fn assert_queued_segment_undrained(detector: &mut VoiceActivityDetector, pcm: &[f32]) {
    let error = detector
        .accept_waveform(pcm)
        .expect_err("accept should be rejected before crossing native FFI");
    assert_eq!(error.code(), ErrorCode::WaveformQueuedSegmentUndrained);
    assert!(
        !detector.is_empty().expect("queue state should be readable"),
        "failed accept should leave the queued segment for explicit drain/clear/reset"
    );
}

fn assert_segment_parity(segments: &[SpeechSegment]) {
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].start, 5728);
    assert_eq!(segments[0].samples.len(), 93_696);
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
