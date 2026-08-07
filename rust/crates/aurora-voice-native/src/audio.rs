use std::fmt;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use async_trait::async_trait;
use aurora_voice_core::{
    AudioOutput, AudioPlaybackContext, AudioPlaybackReceipt, Generation, TimestampMicros,
    TransitionReason, TtsSynthesisResult, VoiceCoreError,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};

const PLAYBACK_TIMEOUT: Duration = Duration::from_secs(30);
const PLAYBACK_STOP_POLL: Duration = Duration::from_millis(10);
const PLAYBACK_WAIT_SLICE: Duration = Duration::from_millis(10);
const DEFAULT_BACKEND_DRAIN: Duration = Duration::from_millis(75);
const DEFAULT_MAX_PLAYBACK_DURATION: Duration = Duration::from_secs(5 * 60);
const MICROS_PER_SECOND: u128 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeAudioConfig {
    pub playback_timeout: Duration,
    pub backend_drain: Duration,
    pub max_playback_duration: Duration,
}

impl Default for NativeAudioConfig {
    fn default() -> Self {
        Self {
            playback_timeout: PLAYBACK_TIMEOUT,
            backend_drain: DEFAULT_BACKEND_DRAIN,
            max_playback_duration: DEFAULT_MAX_PLAYBACK_DURATION,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeAudioStatus {
    pub output_available: bool,
    pub active_generation: Option<Generation>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
}

#[derive(Debug)]
pub struct CpalAudioOutput {
    config: NativeAudioConfig,
    active_generation: Option<Generation>,
    stop_flag: Arc<AtomicBool>,
    last_status: NativeAudioStatus,
}

impl CpalAudioOutput {
    pub fn new(config: NativeAudioConfig) -> Self {
        Self {
            config,
            active_generation: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            last_status: NativeAudioStatus {
                output_available: false,
                active_generation: None,
                sample_rate_hz: None,
                channels: None,
            },
        }
    }

    pub fn status(&self) -> NativeAudioStatus {
        self.last_status
    }
}

impl Default for CpalAudioOutput {
    fn default() -> Self {
        Self::new(NativeAudioConfig::default())
    }
}

#[async_trait(?Send)]
impl AudioOutput for CpalAudioOutput {
    async fn play(
        &mut self,
        context: AudioPlaybackContext,
        audio: TtsSynthesisResult,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<AudioPlaybackReceipt, VoiceCoreError> {
        if cancellation() || audio.cancelled() {
            return Err(VoiceCoreError::Cancelled);
        }

        let source = collect_source_samples(&audio, self.config.max_playback_duration)?;
        self.stop_flag.store(false, Ordering::SeqCst);
        self.active_generation = Some(context.generation);
        self.last_status.active_generation = self.active_generation;

        let timeout = self.config.playback_timeout;
        let backend_drain = self.config.backend_drain;
        let stop_flag = Arc::clone(&self.stop_flag);
        let mut playback_task = Box::pin(tokio::task::spawn_blocking(move || {
            play_blocking(source, stop_flag, timeout, backend_drain)
        }));
        let result = loop {
            tokio::select! {
                result = &mut playback_task => {
                    break result.map_err(|_| audio_fault("output-task-join"))?;
                }
                _ = tokio::time::sleep(PLAYBACK_STOP_POLL) => {
                    if cancellation() {
                        self.stop_flag.store(true, Ordering::SeqCst);
                    }
                }
            }
        };

        self.active_generation = None;
        self.last_status.active_generation = None;

        let playback = result?;
        self.last_status.output_available = true;
        self.last_status.sample_rate_hz = Some(playback.sample_rate_hz);
        self.last_status.channels = Some(playback.channels);
        if cancellation() {
            return Err(VoiceCoreError::Cancelled);
        }
        Ok(AudioPlaybackReceipt::new(
            context,
            audio.chunk_count(),
            playback.sample_count,
            TimestampMicros(
                context
                    .started_at
                    .0
                    .saturating_add(playback.completed_after_micros),
            ),
        ))
    }

    async fn stop(
        &mut self,
        generation: Generation,
        _reason: TransitionReason,
    ) -> Result<(), VoiceCoreError> {
        if self.active_generation == Some(generation) {
            self.stop_flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PlaybackRun {
    sample_count: u64,
    completed_after_micros: u64,
    sample_rate_hz: u32,
    channels: u16,
}

#[derive(Clone, PartialEq)]
struct SourceAudio {
    samples: Vec<i16>,
    sample_rate_hz: u32,
    channels: u16,
}

impl fmt::Debug for SourceAudio {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SourceAudio")
            .field("sample_count", &self.samples.len())
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .finish()
    }
}

fn collect_source_samples(
    audio: &TtsSynthesisResult,
    max_playback_duration: Duration,
) -> Result<SourceAudio, VoiceCoreError> {
    let mut chunks = audio.chunks().iter();
    let first = chunks
        .next()
        .ok_or_else(|| audio_fault("empty-playback-audio"))?;
    let sample_rate_hz = first.sample_rate_hz();
    let channels = first.channels();
    if sample_rate_hz == 0 || channels == 0 {
        return Err(audio_fault("invalid-playback-format"));
    }

    validate_playback_sample_bound(
        first.samples().len(),
        sample_rate_hz,
        channels,
        max_playback_duration,
    )?;
    let mut samples = first.samples().to_vec();
    for chunk in chunks {
        if chunk.sample_rate_hz() != sample_rate_hz || chunk.channels() != channels {
            return Err(audio_fault("mixed-playback-format"));
        }
        let next_len = samples
            .len()
            .checked_add(chunk.samples().len())
            .ok_or_else(|| audio_fault("playback-audio-too-long"))?;
        validate_playback_sample_bound(next_len, sample_rate_hz, channels, max_playback_duration)?;
        samples.extend_from_slice(chunk.samples());
    }
    if samples.is_empty() {
        return Err(audio_fault("empty-playback-audio"));
    }
    Ok(SourceAudio {
        samples,
        sample_rate_hz,
        channels,
    })
}

fn play_blocking(
    source: SourceAudio,
    stop_flag: Arc<AtomicBool>,
    timeout: Duration,
    backend_drain: Duration,
) -> Result<PlaybackRun, VoiceCoreError> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| audio_fault("output-unavailable"))?;
    let supported = device
        .default_output_config()
        .map_err(|_| audio_fault("output-config-unavailable"))?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    if config.channels == 0 || config.sample_rate == 0 {
        return Err(audio_fault("invalid-output-config"));
    }

    let rendered = render_for_output(
        &source.samples,
        source.sample_rate_hz,
        source.channels,
        config.sample_rate,
        config.channels,
    )?;
    let sample_count = rendered.len() as u64;
    let output_frame_count = output_frames_for_samples(rendered.len(), config.channels)?;
    let playback_duration = frames_to_duration(output_frame_count, config.sample_rate)?;
    let wait_timeout = playback_duration
        .saturating_add(backend_drain)
        .saturating_add(timeout);
    let (signal_tx, signal_rx) = mpsc::sync_channel(2);
    let callback_state = PlaybackCallbackState {
        cursor: Arc::new(AtomicUsize::new(0)),
        queued_sent: Arc::new(AtomicBool::new(false)),
        error_sent: Arc::new(AtomicBool::new(false)),
        signal_tx,
        stop_flag,
        max_callback_samples: Arc::new(AtomicUsize::new(0)),
    };

    let err_state = callback_state.clone();
    let err_fn = move |_| {
        send_error_signal(&err_state, audio_fault("output-stream-error"));
    };

    let stream = match sample_format {
        SampleFormat::F32 => {
            let rendered = Arc::new(rendered);
            let data_fn = output_callback_f32(rendered, callback_state.clone());
            device
                .build_output_stream(config, data_fn, err_fn, None)
                .map_err(|_| audio_fault("output-stream-build"))?
        }
        SampleFormat::I16 => {
            let rendered = Arc::new(rendered);
            let data_fn = output_callback_i16(rendered, callback_state.clone());
            device
                .build_output_stream(config, data_fn, err_fn, None)
                .map_err(|_| audio_fault("output-stream-build"))?
        }
        SampleFormat::U16 => {
            let rendered = Arc::new(rendered);
            let data_fn = output_callback_u16(rendered, callback_state.clone());
            device
                .build_output_stream(config, data_fn, err_fn, None)
                .map_err(|_| audio_fault("output-stream-build"))?
        }
        _ => return Err(audio_fault("unsupported-output-format")),
    };
    stream
        .play()
        .map_err(|_| audio_fault("output-stream-start"))?;

    let started_at = std::time::Instant::now();
    wait_for_queued_signal(
        &signal_rx,
        &callback_state.stop_flag,
        started_at,
        wait_timeout,
    )?;
    let max_callback_samples = callback_state.max_callback_samples.load(Ordering::Acquire);
    let callback_frames = output_frames_for_samples(max_callback_samples, config.channels)?;
    let callback_drain = frames_to_duration(callback_frames, config.sample_rate)?;
    let drain_duration = backend_drain.saturating_add(callback_drain);
    wait_for_backend_drain(
        &signal_rx,
        &callback_state.stop_flag,
        started_at,
        wait_timeout,
        drain_duration,
    )?;

    Ok(PlaybackRun {
        sample_count,
        completed_after_micros: duration_to_micros(
            playback_duration.saturating_add(drain_duration),
        )?,
        sample_rate_hz: config.sample_rate,
        channels: config.channels,
    })
}

fn output_callback_f32(
    rendered: Arc<Vec<f32>>,
    state: PlaybackCallbackState,
) -> impl FnMut(&mut [f32], &cpal::OutputCallbackInfo) + Send + 'static {
    move |data, _| {
        fill_output(data, &rendered, &state, |sample| sample, 0.0);
    }
}

fn output_callback_i16(
    rendered: Arc<Vec<f32>>,
    state: PlaybackCallbackState,
) -> impl FnMut(&mut [i16], &cpal::OutputCallbackInfo) + Send + 'static {
    move |data, _| {
        fill_output(data, &rendered, &state, f32_to_i16, 0);
    }
}

fn output_callback_u16(
    rendered: Arc<Vec<f32>>,
    state: PlaybackCallbackState,
) -> impl FnMut(&mut [u16], &cpal::OutputCallbackInfo) + Send + 'static {
    move |data, _| {
        fill_output(data, &rendered, &state, f32_to_u16, u16_silence());
    }
}

#[derive(Clone)]
struct PlaybackCallbackState {
    cursor: Arc<AtomicUsize>,
    queued_sent: Arc<AtomicBool>,
    error_sent: Arc<AtomicBool>,
    signal_tx: mpsc::SyncSender<PlaybackSignal>,
    stop_flag: Arc<AtomicBool>,
    max_callback_samples: Arc<AtomicUsize>,
}

enum PlaybackSignal {
    Queued,
    Error(VoiceCoreError),
}

fn fill_output<T>(
    data: &mut [T],
    rendered: &[f32],
    state: &PlaybackCallbackState,
    convert: impl Fn(f32) -> T,
    silence: T,
) where
    T: Copy,
{
    record_max_callback_samples(&state.max_callback_samples, data.len());
    for sample in data.iter_mut() {
        let offset = state.cursor.fetch_add(1, Ordering::Relaxed);
        if state.stop_flag.load(Ordering::SeqCst) || offset >= rendered.len() {
            *sample = silence;
        } else {
            *sample = convert(rendered[offset]);
        }
    }
    if state.stop_flag.load(Ordering::SeqCst) {
        send_error_signal(state, VoiceCoreError::Cancelled);
    } else if state.cursor.load(Ordering::Acquire) >= rendered.len() {
        send_queued_signal(state);
    }
}

fn send_queued_signal(state: &PlaybackCallbackState) {
    if state.queued_sent.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = state.signal_tx.try_send(PlaybackSignal::Queued);
}

fn send_error_signal(state: &PlaybackCallbackState, error: VoiceCoreError) {
    if state.error_sent.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = state.signal_tx.try_send(PlaybackSignal::Error(error));
}

fn record_max_callback_samples(max_callback_samples: &AtomicUsize, value: usize) {
    let mut current = max_callback_samples.load(Ordering::Relaxed);
    while value > current {
        match max_callback_samples.compare_exchange_weak(
            current,
            value,
            Ordering::AcqRel,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(next) => current = next,
        }
    }
}

fn wait_for_queued_signal(
    signal_rx: &mpsc::Receiver<PlaybackSignal>,
    stop_flag: &AtomicBool,
    started_at: std::time::Instant,
    timeout: Duration,
) -> Result<(), VoiceCoreError> {
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            return Err(VoiceCoreError::Cancelled);
        }
        let wait_for = remaining_timeout(started_at, timeout)?;
        match signal_rx.recv_timeout(wait_for.min(PLAYBACK_WAIT_SLICE)) {
            Ok(PlaybackSignal::Queued) => return Ok(()),
            Ok(PlaybackSignal::Error(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(audio_fault("output-stream-closed"));
            }
        }
    }
}

fn wait_for_backend_drain(
    signal_rx: &mpsc::Receiver<PlaybackSignal>,
    stop_flag: &AtomicBool,
    started_at: std::time::Instant,
    timeout: Duration,
    drain_duration: Duration,
) -> Result<(), VoiceCoreError> {
    let drain_started_at = std::time::Instant::now();
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            return Err(VoiceCoreError::Cancelled);
        }
        let overall_remaining = remaining_timeout(started_at, timeout)?;
        let drain_elapsed = drain_started_at.elapsed();
        if drain_elapsed >= drain_duration {
            return Ok(());
        }
        let drain_remaining = drain_duration.saturating_sub(drain_elapsed);
        match signal_rx.recv_timeout(
            overall_remaining
                .min(drain_remaining)
                .min(PLAYBACK_WAIT_SLICE),
        ) {
            Ok(PlaybackSignal::Queued) => {}
            Ok(PlaybackSignal::Error(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(audio_fault("output-stream-closed"));
            }
        }
    }
}

fn remaining_timeout(
    started_at: std::time::Instant,
    timeout: Duration,
) -> Result<Duration, VoiceCoreError> {
    let elapsed = started_at.elapsed();
    if elapsed >= timeout {
        return Err(audio_fault("output-timeout"));
    }
    Ok(timeout.saturating_sub(elapsed))
}

fn render_for_output(
    input: &[i16],
    input_rate_hz: u32,
    input_channels: u16,
    output_rate_hz: u32,
    output_channels: u16,
) -> Result<Vec<f32>, VoiceCoreError> {
    if input.is_empty()
        || input_rate_hz == 0
        || output_rate_hz == 0
        || input_channels == 0
        || output_channels == 0
        || input.len() % input_channels as usize != 0
    {
        return Err(audio_fault("invalid-render-format"));
    }

    let input_channels = input_channels as usize;
    let output_channels = output_channels as usize;
    let input_frames = input.len() / input_channels;
    let output_frames = resampled_frame_count(input_frames, input_rate_hz, output_rate_hz)?;
    let output_samples = output_frames
        .checked_mul(output_channels)
        .ok_or_else(|| audio_fault("playback-audio-too-long"))?;
    let mut output = Vec::with_capacity(output_samples);

    for frame in 0..output_frames {
        let position = (frame as f64) * f64::from(input_rate_hz) / f64::from(output_rate_hz);
        for channel in 0..output_channels {
            output.push(interpolated_input_sample(
                input,
                input_frames,
                input_channels,
                output_channels,
                channel,
                position,
            ));
        }
    }
    Ok(output)
}

fn i16_to_f32(sample: i16) -> f32 {
    if sample == i16::MIN {
        -1.0
    } else {
        sample as f32 / i16::MAX as f32
    }
}

fn f32_to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * i16::MAX as f32).round() as i16
}

fn f32_to_u16(sample: f32) -> u16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (((clamped + 1.0) * 0.5) * u16::MAX as f32).round() as u16
}

fn u16_silence() -> u16 {
    f32_to_u16(0.0)
}

fn interpolated_input_sample(
    input: &[i16],
    input_frames: usize,
    input_channels: usize,
    output_channels: usize,
    output_channel: usize,
    position: f64,
) -> f32 {
    let left_frame = position.floor().max(0.0) as usize;
    let right_frame = left_frame
        .saturating_add(1)
        .min(input_frames.saturating_sub(1));
    let fraction = (position - left_frame as f64).clamp(0.0, 1.0) as f32;
    let left = sample_for_output_channel(
        input,
        left_frame.min(input_frames.saturating_sub(1)),
        input_channels,
        output_channels,
        output_channel,
    );
    let right = sample_for_output_channel(
        input,
        right_frame,
        input_channels,
        output_channels,
        output_channel,
    );
    left + (right - left) * fraction
}

fn sample_for_output_channel(
    input: &[i16],
    frame: usize,
    input_channels: usize,
    output_channels: usize,
    output_channel: usize,
) -> f32 {
    if output_channels == input_channels {
        let input_channel = output_channel.min(input_channels.saturating_sub(1));
        return i16_to_f32(input[frame * input_channels + input_channel]);
    }
    mix_input_frame(input, frame, input_channels)
}

fn mix_input_frame(input: &[i16], frame: usize, input_channels: usize) -> f32 {
    let base = frame.saturating_mul(input_channels);
    let sum: f32 = input[base..base + input_channels]
        .iter()
        .map(|sample| i16_to_f32(*sample))
        .sum();
    sum / input_channels as f32
}

fn resampled_frame_count(
    input_frames: usize,
    input_rate_hz: u32,
    output_rate_hz: u32,
) -> Result<usize, VoiceCoreError> {
    let frames = (input_frames as u128)
        .checked_mul(output_rate_hz as u128)
        .ok_or_else(|| audio_fault("playback-audio-too-long"))?
        .checked_div(input_rate_hz as u128)
        .unwrap_or(0)
        .max(1);
    usize::try_from(frames).map_err(|_| audio_fault("playback-audio-too-long"))
}

fn output_frames_for_samples(samples: usize, channels: u16) -> Result<u64, VoiceCoreError> {
    let channels = usize::from(channels);
    if channels == 0 || samples % channels != 0 {
        return Err(audio_fault("invalid-output-config"));
    }
    u64::try_from(samples / channels).map_err(|_| audio_fault("playback-audio-too-long"))
}

fn duration_to_frames(duration: Duration, sample_rate_hz: u32) -> Result<u64, VoiceCoreError> {
    if sample_rate_hz == 0 {
        return Err(audio_fault("invalid-output-config"));
    }
    let micros = duration.as_micros();
    let frames = micros
        .checked_mul(sample_rate_hz as u128)
        .ok_or_else(|| audio_fault("playback-audio-too-long"))?
        .checked_add(MICROS_PER_SECOND - 1)
        .ok_or_else(|| audio_fault("playback-audio-too-long"))?
        / MICROS_PER_SECOND;
    u64::try_from(frames).map_err(|_| audio_fault("playback-audio-too-long"))
}

fn frames_to_samples(frames: u64, channels: u16) -> Result<usize, VoiceCoreError> {
    let samples = (frames as u128)
        .checked_mul(channels as u128)
        .ok_or_else(|| audio_fault("playback-audio-too-long"))?;
    usize::try_from(samples).map_err(|_| audio_fault("playback-audio-too-long"))
}

fn frames_to_micros(frames: u64, sample_rate_hz: u32) -> Result<u64, VoiceCoreError> {
    if sample_rate_hz == 0 {
        return Err(audio_fault("invalid-output-config"));
    }
    let micros = (frames as u128)
        .checked_mul(MICROS_PER_SECOND)
        .ok_or_else(|| audio_fault("playback-audio-too-long"))?
        .checked_div(sample_rate_hz as u128)
        .unwrap_or(0);
    u64::try_from(micros).map_err(|_| audio_fault("playback-audio-too-long"))
}

fn frames_to_duration(frames: u64, sample_rate_hz: u32) -> Result<Duration, VoiceCoreError> {
    Ok(Duration::from_micros(frames_to_micros(
        frames,
        sample_rate_hz,
    )?))
}

fn duration_to_micros(duration: Duration) -> Result<u64, VoiceCoreError> {
    u64::try_from(duration.as_micros()).map_err(|_| audio_fault("playback-audio-too-long"))
}

fn validate_playback_sample_bound(
    sample_count: usize,
    sample_rate_hz: u32,
    channels: u16,
    max_playback_duration: Duration,
) -> Result<(), VoiceCoreError> {
    if sample_rate_hz == 0 || channels == 0 || sample_count == 0 {
        return Err(audio_fault("invalid-playback-format"));
    }
    if sample_count % usize::from(channels) != 0 {
        return Err(audio_fault("invalid-render-format"));
    }
    let max_frames = duration_to_frames(max_playback_duration, sample_rate_hz)?;
    let max_samples = frames_to_samples(max_frames, channels)?;
    if sample_count > max_samples {
        return Err(audio_fault("playback-audio-too-long"));
    }
    Ok(())
}

fn audio_fault(code: &'static str) -> VoiceCoreError {
    VoiceCoreError::TransportFault {
        code: code.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_duplicates_mono_to_output_channels_without_device_identity() {
        let rendered = render_for_output(&[0, i16::MAX], 16_000, 1, 16_000, 2)
            .expect("mono render should succeed");
        assert_eq!(rendered, vec![0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn render_downmixes_by_averaging_source_channels() {
        let rendered = render_for_output(&[0, i16::MAX, i16::MIN, 0], 16_000, 2, 16_000, 1)
            .expect("stereo render should succeed");
        assert_eq!(rendered, vec![0.5, -0.5]);
    }

    #[test]
    fn render_resamples_with_linear_interpolation() {
        let rendered = render_for_output(&[0, i16::MAX], 16_000, 1, 32_000, 1)
            .expect("resample render should succeed");
        assert_eq!(rendered, vec![0.0, 0.5, 1.0, 1.0]);
    }

    #[test]
    fn render_rejects_misaligned_interleaved_input() {
        assert!(matches!(
            render_for_output(&[1, 2, 3], 16_000, 2, 16_000, 1),
            Err(VoiceCoreError::TransportFault { code }) if code == "invalid-render-format"
        ));
    }

    #[test]
    fn sample_conversion_clamps_without_panicking() {
        assert_eq!(i16_to_f32(i16::MIN), -1.0);
        assert_eq!(i16_to_f32(i16::MAX), 1.0);
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
        assert_eq!(f32_to_i16(0.0), 0);
        assert_eq!(f32_to_u16(-1.0), 0);
        assert_eq!(u16_silence(), 32768);
        assert_eq!(f32_to_u16(1.0), u16::MAX);
    }

    #[test]
    fn playback_bounds_reject_audio_longer_than_configured_duration() {
        assert!(matches!(
            validate_playback_sample_bound(32_001, 16_000, 1, Duration::from_secs(2)),
            Err(VoiceCoreError::TransportFault { code }) if code == "playback-audio-too-long"
        ));
    }

    #[test]
    fn completion_timestamp_uses_output_frames_and_drain_micros() {
        let rendered =
            render_for_output(&[0; 16_000], 16_000, 1, 48_000, 2).expect("render should succeed");
        let output_frames =
            output_frames_for_samples(rendered.len(), 2).expect("valid rendered output");
        let playback_duration =
            frames_to_duration(output_frames, 48_000).expect("valid playback duration");
        let callback_drain = frames_to_duration(
            output_frames_for_samples(4096, 2).expect("valid buffer"),
            48_000,
        )
        .expect("valid buffer duration");
        let completed_after = playback_duration
            .saturating_add(Duration::from_millis(75))
            .saturating_add(callback_drain)
            .as_micros();

        assert_eq!(rendered.len(), 96_000);
        assert_eq!(completed_after, 1_117_666);
    }

    #[test]
    fn fill_output_signals_when_final_audio_is_queued() {
        let rendered = vec![0.25, 0.5];
        let (state, signal_rx) = playback_state_for_test(false);
        let mut out = vec![0_i16; 2];

        fill_output(&mut out, &rendered, &state, f32_to_i16, 0);

        assert!(matches!(signal_rx.try_recv(), Ok(PlaybackSignal::Queued)));
        assert_eq!(out, vec![8192, 16384]);
        assert_eq!(state.max_callback_samples.load(Ordering::Acquire), 2);
    }

    #[test]
    fn fill_output_uses_format_silence_after_final_audio() {
        let rendered = vec![0.25];
        let (state, signal_rx) = playback_state_for_test(false);
        let mut out = vec![0_u16; 3];

        fill_output(&mut out, &rendered, &state, f32_to_u16, u16_silence());

        assert!(matches!(signal_rx.try_recv(), Ok(PlaybackSignal::Queued)));
        assert_eq!(out, vec![40959, u16_silence(), u16_silence()]);
    }

    #[test]
    fn wait_for_backend_drain_separates_queued_from_completion() {
        let (state, signal_rx) = playback_state_for_test(false);
        state
            .signal_tx
            .try_send(PlaybackSignal::Queued)
            .expect("queued signal should send");
        let started_at = std::time::Instant::now();

        wait_for_queued_signal(
            &signal_rx,
            &state.stop_flag,
            started_at,
            Duration::from_secs(1),
        )
        .expect("queued signal should be accepted");
        wait_for_backend_drain(
            &signal_rx,
            &state.stop_flag,
            started_at,
            Duration::from_secs(1),
            Duration::from_millis(2),
        )
        .expect("drain should complete after queued signal");
    }

    #[test]
    fn wait_for_backend_drain_reports_error_after_final_audio_is_queued() {
        let (state, signal_rx) = playback_state_for_test(false);
        state
            .signal_tx
            .try_send(PlaybackSignal::Queued)
            .expect("queued signal should send");
        send_error_signal(&state, audio_fault("output-stream-error"));
        let started_at = std::time::Instant::now();

        wait_for_queued_signal(
            &signal_rx,
            &state.stop_flag,
            started_at,
            Duration::from_secs(1),
        )
        .expect("queued signal should be accepted");
        assert!(matches!(
            wait_for_backend_drain(
                &signal_rx,
                &state.stop_flag,
                started_at,
                Duration::from_secs(1),
                Duration::from_millis(10),
            ),
            Err(VoiceCoreError::TransportFault { code }) if code == "output-stream-error"
        ));
    }

    #[test]
    fn fill_output_continues_silence_after_queued_without_duplicate_signal() {
        let rendered = vec![0.25, 0.5];
        let (state, signal_rx) = playback_state_for_test(false);
        let mut out = vec![0_i16; 2];

        fill_output(&mut out, &rendered, &state, f32_to_i16, 0);
        assert!(matches!(signal_rx.try_recv(), Ok(PlaybackSignal::Queued)));

        fill_output(&mut out, &rendered, &state, f32_to_i16, 0);
        assert!(signal_rx.try_recv().is_err());
        assert_eq!(out, vec![0, 0]);
    }

    #[test]
    fn fill_output_cancels_without_waiting_for_drain() {
        let rendered = vec![0.25, 0.5];
        let (state, signal_rx) = playback_state_for_test(true);
        let mut out = vec![0_i16; 2];

        fill_output(&mut out, &rendered, &state, f32_to_i16, 0);

        assert_cancelled_signal(signal_rx.try_recv());
        assert_eq!(out, vec![0, 0]);
    }

    #[test]
    fn source_audio_debug_redacts_pcm_values() {
        let source = SourceAudio {
            samples: vec![123, -456],
            sample_rate_hz: 16_000,
            channels: 1,
        };
        let debug = format!("{source:?}");

        assert!(debug.contains("sample_count: 2"));
        assert!(!debug.contains("123"));
        assert!(!debug.contains("-456"));
    }

    fn playback_state_for_test(
        stopped: bool,
    ) -> (PlaybackCallbackState, mpsc::Receiver<PlaybackSignal>) {
        let (signal_tx, signal_rx) = mpsc::sync_channel(2);
        (
            PlaybackCallbackState {
                cursor: Arc::new(AtomicUsize::new(0)),
                queued_sent: Arc::new(AtomicBool::new(false)),
                error_sent: Arc::new(AtomicBool::new(false)),
                signal_tx,
                stop_flag: Arc::new(AtomicBool::new(stopped)),
                max_callback_samples: Arc::new(AtomicUsize::new(0)),
            },
            signal_rx,
        )
    }

    fn assert_cancelled_signal(signal: Result<PlaybackSignal, mpsc::TryRecvError>) {
        match signal {
            Ok(PlaybackSignal::Error(VoiceCoreError::Cancelled)) => {}
            _ => panic!("expected redacted cancellation signal"),
        }
    }
}
