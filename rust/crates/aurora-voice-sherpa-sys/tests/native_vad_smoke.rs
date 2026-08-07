#![cfg(all(feature = "native-vad", not(target_arch = "wasm32")))]

use std::env;
use std::path::PathBuf;

use aurora_voice_sherpa_sys::{SileroVadConfig, VoiceActivityDetector};

#[test]
#[ignore = "requires AURORA_SHERPA_ONNX_MODEL and runtime library loader path"]
fn silero_vad_accepts_and_flushes_waveform() {
    let model_path = env::var_os("AURORA_SHERPA_ONNX_MODEL")
        .map(PathBuf::from)
        .expect("AURORA_SHERPA_ONNX_MODEL must point to silero_vad.onnx");
    let config = SileroVadConfig::new(model_path)
        .with_threshold(0.5)
        .with_min_silence_duration(0.1)
        .with_min_speech_duration(0.0)
        .with_max_speech_duration(5.0)
        .with_window_size(512)
        .with_sample_rate(16_000)
        .with_num_threads(1)
        .with_provider("cpu")
        .with_buffer_size_seconds(5.0);

    let mut detector = VoiceActivityDetector::new(&config).expect("detector should be created");
    let silence = vec![0.0; 16_000];
    detector
        .accept_waveform(&silence)
        .expect("silence waveform should be accepted");
    detector.flush().expect("flush should succeed");

    let _detected = detector.detected().expect("detected should be readable");
    let _empty = detector.is_empty().expect("empty should be readable");
    let _segments = detector
        .drain_speech_segments()
        .expect("segments should drain");
    detector.clear().expect("clear should succeed");
    detector.reset().expect("reset should succeed");
}
