#![cfg(target_os = "linux")]

use std::env;
use std::f32::consts::TAU;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use aurora_voice_core::{
    AudioInput, AudioOutput, AudioPlaybackContext, CaptureOwnerKind, CaptureStartReason,
    Generation, RouteRevision, TimestampMicros, TransitionReason, VoiceCaptureLease,
    VoiceCoreError,
};
use aurora_voice_engine::{
    BoundTtsSynthesisRequest, RouteTtsBinding, RouteTtsSynthesisRequest, TtsAudioChunk,
    TtsSynthesisConfig, TtsSynthesisResult,
};
use aurora_voice_native::{
    CpalAudioInput, CpalAudioOutput, NativeAudioConfig, NativeCaptureConfig, NativeInputDeviceId,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use tokio::time::{timeout, Instant};

const LIVE_AUDIO_ENV: &str = "AURORA_VOICE_LIVE_AUDIO";
const TTS_SAMPLE_RATE_HZ: u32 = 16_000;
const LOOPBACK_TONE_HZ: f32 = 880.0;
const PRODUCTION_TONE_SECONDS: f32 = 0.004;
const TARGET_CAPTURE_SAMPLES: usize = 8_000;
const TARGET_OUTPUT_CALLBACK_SAMPLES: usize = 1_024;
const MIN_LOOPBACK_RMS: f64 = 0.001;
const CAPTURE_DEADLINE: Duration = Duration::from_secs(5);
const OUTPUT_DEADLINE: Duration = Duration::from_secs(3);
const PLAYBACK_TIMEOUT: Duration = Duration::from_secs(4);
const OUTPUT_ATTEMPTS: usize = 5;
const MID_PLAY_CANCEL_DELAY: Duration = Duration::from_millis(20);

#[tokio::test]
#[ignore = "opens live Linux CPAL input/output devices; set AURORA_VOICE_LIVE_AUDIO=1 to run"]
async fn live_linux_cpal_default_capture_playback_and_cancel() {
    if env::var(LIVE_AUDIO_ENV).ok().as_deref() != Some("1") {
        eprintln!("skipping live CPAL audio test; set {LIVE_AUDIO_ENV}=1 to open devices");
        return;
    }

    let playback_context = live_playback_context(Generation(42));
    let output_status = play_production_output_with_retries(
        playback_context,
        live_tts_audio(
            playback_context.generation,
            PRODUCTION_TONE_SECONDS,
            LOOPBACK_TONE_HZ,
        ),
    )
    .await
    .unwrap_or_else(|error| panic!("production CPAL output did not play: {error:?}"));
    assert!(
        output_status.sample_rate_hz.is_some() && output_status.channels.is_some(),
        "production CPAL output status lacks redacted format details: {output_status:?}"
    );

    let raw_loopback_feeder = LiveLoopbackFeeder::start()
        .await
        .unwrap_or_else(|error| panic!("raw CPAL loopback feeder did not start: {error:?}"));
    raw_loopback_feeder
        .wait_for_output_samples(TARGET_OUTPUT_CALLBACK_SAMPLES)
        .await
        .unwrap_or_else(|error| panic!("raw CPAL loopback feeder produced no samples: {error:?}"));

    let mut input = CpalAudioInput::new(NativeCaptureConfig {
        input_device: NativeInputDeviceId::default_device(),
        queue_blocks: 64,
        max_block_samples: 4096,
    });
    let control = input.control();
    let capture_lease = live_capture_lease(Generation(41));
    input
        .start(capture_lease.clone())
        .await
        .unwrap_or_else(|error| panic!("default CPAL input did not start: {error:?}"));

    let capture = timeout(
        CAPTURE_DEADLINE,
        collect_loopback_samples(&mut input, TARGET_CAPTURE_SAMPLES),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "default CPAL input timed out before {TARGET_CAPTURE_SAMPLES} redacted samples; status={:?}",
            input.status()
        )
    })
    .unwrap_or_else(|error| panic!("default CPAL input failed with redacted error: {error:?}"));
    assert!(
        capture.samples >= TARGET_CAPTURE_SAMPLES,
        "default CPAL input returned too few redacted samples: {capture:?}"
    );
    assert!(
        capture.frames > 0,
        "default CPAL input returned no frames: {capture:?}"
    );
    assert!(
        capture.rms >= MIN_LOOPBACK_RMS,
        "default loopback capture was silent or unrouted: {capture:?}"
    );

    let feeder_summary = raw_loopback_feeder
        .cancel_and_stop()
        .await
        .unwrap_or_else(|error| panic!("raw CPAL loopback feeder cancellation failed: {error:?}"));
    assert!(
        feeder_summary.stream_errors <= feeder_summary.callbacks,
        "raw CPAL loopback feeder produced only redacted stream errors: callbacks={} samples={} stream_errors={} cancel_observed={}",
        feeder_summary.callbacks,
        feeder_summary.samples,
        feeder_summary.stream_errors,
        feeder_summary.cancel_observed
    );

    control.finish(capture_lease.generation);
    drain_finished_capture(&mut input).await;
    input
        .stop(TransitionReason::Stop)
        .await
        .expect("stopping default CPAL input succeeds");
    assert_eq!(input.status().active_generation, None);

    cancel_production_output_mid_playback_with_retries()
        .await
        .unwrap_or_else(|error| {
            panic!("production CPAL output did not cancel mid-playback: {error:?}")
        });
}

#[derive(Debug)]
struct CaptureSummary {
    frames: usize,
    samples: usize,
    rms: f64,
}

async fn collect_loopback_samples(
    input: &mut CpalAudioInput,
    target_samples: usize,
) -> Result<CaptureSummary, VoiceCoreError> {
    let started_at = Instant::now();
    let mut frames = 0_usize;
    let mut samples = 0_usize;
    let mut sum_squares = 0.0_f64;
    while samples < target_samples || rms(sum_squares, samples) < MIN_LOOPBACK_RMS {
        let frame = input
            .next_frame()
            .await?
            .ok_or(VoiceCoreError::BufferClosed)?;
        assert_eq!(frame.generation(), Generation(41));
        assert_eq!(frame.route_revision(), RouteRevision(7));
        assert!(
            frame
                .samples()
                .iter()
                .all(|sample| sample.is_finite() && (-1.0..=1.0).contains(sample)),
            "captured CPAL frame exposed invalid normalized samples"
        );
        frames = frames.saturating_add(1);
        samples = samples.saturating_add(frame.sample_count());
        sum_squares += frame
            .samples()
            .iter()
            .map(|sample| f64::from(*sample) * f64::from(*sample))
            .sum::<f64>();
        if started_at.elapsed() > CAPTURE_DEADLINE {
            return Err(VoiceCoreError::TransportFault {
                code: "live-cpal-capture-timeout".to_owned(),
            });
        }
    }
    Ok(CaptureSummary {
        frames,
        samples,
        rms: rms(sum_squares, samples),
    })
}

fn rms(sum_squares: f64, samples: usize) -> f64 {
    if samples == 0 {
        0.0
    } else {
        (sum_squares / samples as f64).sqrt()
    }
}

async fn drain_finished_capture(input: &mut CpalAudioInput) {
    for _ in 0..8 {
        match timeout(Duration::from_millis(250), input.next_frame()).await {
            Ok(Ok(Some(_))) => {}
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => break,
        }
    }
}

fn live_audio_config() -> NativeAudioConfig {
    NativeAudioConfig {
        playback_timeout: PLAYBACK_TIMEOUT,
        backend_drain: Duration::ZERO,
        max_playback_duration: Duration::from_secs(2),
    }
}

async fn play_production_output_with_retries(
    context: AudioPlaybackContext,
    audio: TtsSynthesisResult,
) -> Result<aurora_voice_native::NativeAudioStatus, VoiceCoreError> {
    let mut last_error = None;
    for _ in 0..OUTPUT_ATTEMPTS {
        let mut output = CpalAudioOutput::new(live_audio_config());
        match timeout(
            OUTPUT_DEADLINE,
            output.play(context, audio.clone(), &|| false),
        )
        .await
        {
            Ok(Ok(receipt)) => {
                assert_eq!(receipt.generation, context.generation);
                assert_eq!(receipt.route_revision, context.route_revision);
                assert!(receipt.sample_count > 0);
                let status = output.status();
                assert!(
                    status.output_available,
                    "production CPAL output unavailable: {status:?}"
                );
                assert_eq!(status.active_generation, None);
                return Ok(status);
            }
            Ok(Err(error)) => last_error = Some(error),
            Err(_) => last_error = Some(live_audio_fault("production-output-timeout")),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(last_error.unwrap_or_else(|| live_audio_fault("production-output-unavailable")))
}

async fn cancel_production_output_mid_playback_with_retries() -> Result<(), VoiceCoreError> {
    let mut last_error = None;
    for attempt in 0..OUTPUT_ATTEMPTS {
        let generation = Generation(43 + attempt as u64);
        let context = live_playback_context(generation);
        let mut output = CpalAudioOutput::new(live_audio_config());
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_signal = Arc::clone(&cancelled);
        tokio::spawn(async move {
            tokio::time::sleep(MID_PLAY_CANCEL_DELAY).await;
            cancel_signal.store(true, Ordering::SeqCst);
        });
        let result = timeout(
            OUTPUT_DEADLINE,
            output.play(context, live_tts_audio(generation, 1.0, 440.0), &|| {
                cancelled.load(Ordering::SeqCst)
            }),
        )
        .await;
        match result {
            Ok(Err(VoiceCoreError::Cancelled)) => {
                assert_eq!(output.status().active_generation, None);
                output.stop(generation, TransitionReason::Cancel).await?;
                assert_eq!(output.status().active_generation, None);
                return Ok(());
            }
            Ok(Ok(_)) => last_error = Some(live_audio_fault("production-output-not-cancelled")),
            Ok(Err(error)) => last_error = Some(error),
            Err(_) => last_error = Some(live_audio_fault("production-output-cancel-timeout")),
        }
        assert_eq!(output.status().active_generation, None);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(last_error.unwrap_or_else(|| live_audio_fault("production-output-cancel-unavailable")))
}

fn live_capture_lease(generation: Generation) -> VoiceCaptureLease {
    VoiceCaptureLease {
        owner: CaptureOwnerKind::Native,
        surface: "desktop-local".to_owned(),
        device_route: "default".to_owned(),
        start_reason: CaptureStartReason::PushToTalk,
        generation,
        created_at: TimestampMicros(100),
        route_revision: RouteRevision(7),
        background_eligible: true,
        consent_revision: 1,
        heartbeat_at: TimestampMicros(100),
        stop_deadline: Some(TimestampMicros(5_100_000)),
    }
}

fn live_playback_context(generation: Generation) -> AudioPlaybackContext {
    AudioPlaybackContext {
        generation,
        route_revision: RouteRevision(7),
        started_at: TimestampMicros(200),
    }
}

fn live_tts_audio(generation: Generation, seconds: f32, tone_hz: f32) -> TtsSynthesisResult {
    let samples = sine_samples(seconds, tone_hz);
    let chunk_samples = samples.len().max(64);
    let route = RouteTtsBinding::new("live-cpal-route", "live-cpal-voice", TTS_SAMPLE_RATE_HZ, 7)
        .expect("valid live CPAL route binding");
    let request = RouteTtsSynthesisRequest::new(route, None, generation.0)
        .expect("valid live CPAL route request");
    let config = TtsSynthesisConfig::new(
        "live-cpal-voice",
        "live-cpal-voice",
        TTS_SAMPLE_RATE_HZ,
        chunk_samples,
        None,
    )
    .expect("valid live CPAL synthesis config");
    let request = BoundTtsSynthesisRequest::new_route(request, "live audio check", config)
        .expect("valid live CPAL synthesis request");
    let chunk = TtsAudioChunk::new(&request, 1, TTS_SAMPLE_RATE_HZ, 1, samples, true)
        .expect("valid live CPAL audio chunk");
    TtsSynthesisResult::new(&request, vec![chunk], false).expect("valid live CPAL audio result")
}

fn sine_samples(seconds: f32, tone_hz: f32) -> Vec<i16> {
    let sample_count = (TTS_SAMPLE_RATE_HZ as f32 * seconds).round() as usize;
    (0..sample_count.max(64))
        .map(|index| {
            let phase = index as f32 * tone_hz * TAU / TTS_SAMPLE_RATE_HZ as f32;
            (phase.sin() * i16::MAX as f32 * 0.20).round() as i16
        })
        .collect()
}

#[derive(Clone)]
struct LiveOutputState {
    cancel: Arc<AtomicBool>,
    cancel_observed: Arc<AtomicBool>,
    samples: Arc<AtomicUsize>,
    callbacks: Arc<AtomicUsize>,
    stream_errors: Arc<AtomicUsize>,
}

impl LiveOutputState {
    fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            cancel_observed: Arc::new(AtomicBool::new(false)),
            samples: Arc::new(AtomicUsize::new(0)),
            callbacks: Arc::new(AtomicUsize::new(0)),
            stream_errors: Arc::new(AtomicUsize::new(0)),
        }
    }
}

struct LiveLoopbackFeeder {
    state: LiveOutputState,
    _stream: cpal::Stream,
}

#[derive(Debug)]
struct LiveFeederSummary {
    callbacks: usize,
    samples: usize,
    stream_errors: usize,
    cancel_observed: bool,
}

impl LiveLoopbackFeeder {
    async fn start() -> Result<Self, VoiceCoreError> {
        tokio::task::spawn_blocking(Self::start_blocking)
            .await
            .map_err(|_| live_audio_fault("output-thread-join"))?
    }

    fn start_blocking() -> Result<Self, VoiceCoreError> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| live_audio_fault("output-unavailable"))?;
        let supported = device
            .default_output_config()
            .map_err(|_| live_audio_fault("output-config-unavailable"))?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        if config.channels == 0 || config.sample_rate == 0 {
            return Err(live_audio_fault("invalid-output-config"));
        }

        let output_rate_hz = config.sample_rate;
        let state = LiveOutputState::new();
        let stream = match sample_format {
            SampleFormat::F32 => device
                .build_output_stream(
                    config,
                    live_output_callback(state.clone(), output_rate_hz, |sample| sample),
                    live_output_error_callback(state.clone()),
                    None,
                )
                .map_err(|_| live_audio_fault("output-stream-build"))?,
            SampleFormat::I16 => device
                .build_output_stream(
                    config,
                    live_output_callback(state.clone(), output_rate_hz, f32_to_i16),
                    live_output_error_callback(state.clone()),
                    None,
                )
                .map_err(|_| live_audio_fault("output-stream-build"))?,
            SampleFormat::U16 => device
                .build_output_stream(
                    config,
                    live_output_callback(state.clone(), output_rate_hz, f32_to_u16),
                    live_output_error_callback(state.clone()),
                    None,
                )
                .map_err(|_| live_audio_fault("output-stream-build"))?,
            _ => return Err(live_audio_fault("unsupported-output-format")),
        };
        stream
            .play()
            .map_err(|_| live_audio_fault("output-stream-start"))?;
        Ok(Self {
            state,
            _stream: stream,
        })
    }

    async fn wait_for_output_samples(&self, samples: usize) -> Result<(), VoiceCoreError> {
        let started_at = Instant::now();
        while self.state.samples.load(Ordering::SeqCst) < samples {
            if started_at.elapsed() > OUTPUT_DEADLINE {
                return Err(live_audio_fault("output-callback-timeout"));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }

    async fn cancel_and_stop(self) -> Result<LiveFeederSummary, VoiceCoreError> {
        self.state.cancel.store(true, Ordering::SeqCst);
        let started_at = Instant::now();
        while !self.state.cancel_observed.load(Ordering::SeqCst) {
            if started_at.elapsed() > OUTPUT_DEADLINE {
                return Err(live_audio_fault("output-cancel-timeout"));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(LiveFeederSummary {
            callbacks: self.state.callbacks.load(Ordering::SeqCst),
            samples: self.state.samples.load(Ordering::SeqCst),
            stream_errors: self.state.stream_errors.load(Ordering::SeqCst),
            cancel_observed: self.state.cancel_observed.load(Ordering::SeqCst),
        })
    }
}

fn live_output_callback<T>(
    state: LiveOutputState,
    sample_rate_hz: u32,
    convert: impl Fn(f32) -> T + Send + 'static,
) -> impl FnMut(&mut [T], &cpal::OutputCallbackInfo) + Send + 'static
where
    T: Copy,
{
    let mut phase = 0.0_f32;
    move |data, _| {
        state.callbacks.fetch_add(1, Ordering::SeqCst);
        if state.cancel.load(Ordering::SeqCst) {
            state.cancel_observed.store(true, Ordering::SeqCst);
        }
        for sample in data.iter_mut() {
            let value = if state.cancel.load(Ordering::SeqCst) {
                0.0
            } else {
                let value = phase.sin() * 0.20;
                phase = (phase + LOOPBACK_TONE_HZ * TAU / sample_rate_hz as f32) % TAU;
                value
            };
            *sample = convert(value);
        }
        state.samples.fetch_add(data.len(), Ordering::SeqCst);
    }
}

fn live_output_error_callback(state: LiveOutputState) -> impl FnMut(cpal::Error) + Send + 'static {
    move |_| {
        state.stream_errors.fetch_add(1, Ordering::SeqCst);
    }
}

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

fn f32_to_u16(sample: f32) -> u16 {
    (((sample.clamp(-1.0, 1.0) + 1.0) * 0.5) * u16::MAX as f32).round() as u16
}

fn live_audio_fault(code: impl Into<String>) -> VoiceCoreError {
    VoiceCoreError::TransportFault { code: code.into() }
}
