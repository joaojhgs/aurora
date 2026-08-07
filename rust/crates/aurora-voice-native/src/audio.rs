use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
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
type PlaybackDoneSender = mpsc::Sender<Result<(), VoiceCoreError>>;
type SharedPlaybackDone = Arc<Mutex<Option<PlaybackDoneSender>>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeAudioConfig {
    pub playback_timeout: Duration,
}

impl Default for NativeAudioConfig {
    fn default() -> Self {
        Self {
            playback_timeout: PLAYBACK_TIMEOUT,
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

        let source = collect_source_samples(&audio)?;
        self.stop_flag.store(false, Ordering::SeqCst);
        self.active_generation = Some(context.generation);
        self.last_status.active_generation = self.active_generation;

        let timeout = self.config.playback_timeout;
        let stop_flag = Arc::clone(&self.stop_flag);
        let result = tokio::task::spawn_blocking(move || play_blocking(source, stop_flag, timeout))
            .await
            .map_err(|_| audio_fault("output-task-join"))?;

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
            TimestampMicros(context.started_at.0.saturating_add(playback.sample_count)),
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
    sample_rate_hz: u32,
    channels: u16,
}

#[derive(Debug, Clone, PartialEq)]
struct SourceAudio {
    samples: Vec<i16>,
    sample_rate_hz: u32,
    channels: u16,
}

fn collect_source_samples(audio: &TtsSynthesisResult) -> Result<SourceAudio, VoiceCoreError> {
    let mut chunks = audio.chunks().iter();
    let first = chunks
        .next()
        .ok_or_else(|| audio_fault("empty-playback-audio"))?;
    let sample_rate_hz = first.sample_rate_hz();
    let channels = first.channels();
    if sample_rate_hz == 0 || channels == 0 {
        return Err(audio_fault("invalid-playback-format"));
    }

    let mut samples = first.samples().to_vec();
    for chunk in chunks {
        if chunk.sample_rate_hz() != sample_rate_hz || chunk.channels() != channels {
            return Err(audio_fault("mixed-playback-format"));
        }
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
    let cursor = Arc::new(Mutex::new(0_usize));
    let (done_tx, done_rx) = mpsc::channel();
    let done_tx = Arc::new(Mutex::new(Some(done_tx)));

    let err_done = Arc::clone(&done_tx);
    let err_fn = move |_| {
        if let Ok(mut done) = err_done.lock() {
            if let Some(done) = done.take() {
                let _ = done.send(Err(audio_fault("output-stream-error")));
            }
        }
    };

    let stream = match sample_format {
        SampleFormat::F32 => {
            let rendered = Arc::new(rendered);
            let data_fn = output_callback_f32(rendered, cursor, Arc::clone(&done_tx), stop_flag);
            device
                .build_output_stream(config, data_fn, err_fn, None)
                .map_err(|_| audio_fault("output-stream-build"))?
        }
        SampleFormat::I16 => {
            let rendered = Arc::new(rendered);
            let data_fn = output_callback_i16(rendered, cursor, Arc::clone(&done_tx), stop_flag);
            device
                .build_output_stream(config, data_fn, err_fn, None)
                .map_err(|_| audio_fault("output-stream-build"))?
        }
        _ => return Err(audio_fault("unsupported-output-format")),
    };
    stream
        .play()
        .map_err(|_| audio_fault("output-stream-start"))?;

    match done_rx.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(PlaybackRun {
            sample_count,
            sample_rate_hz: config.sample_rate,
            channels: config.channels,
        }),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(audio_fault("output-timeout")),
    }
}

fn output_callback_f32(
    rendered: Arc<Vec<f32>>,
    cursor: Arc<Mutex<usize>>,
    done_tx: SharedPlaybackDone,
    stop_flag: Arc<AtomicBool>,
) -> impl FnMut(&mut [f32], &cpal::OutputCallbackInfo) + Send + 'static {
    move |data, _| {
        fill_output(data, &rendered, &cursor, &done_tx, &stop_flag, |sample| {
            sample
        })
    }
}

fn output_callback_i16(
    rendered: Arc<Vec<f32>>,
    cursor: Arc<Mutex<usize>>,
    done_tx: SharedPlaybackDone,
    stop_flag: Arc<AtomicBool>,
) -> impl FnMut(&mut [i16], &cpal::OutputCallbackInfo) + Send + 'static {
    move |data, _| fill_output(data, &rendered, &cursor, &done_tx, &stop_flag, f32_to_i16)
}

fn fill_output<T>(
    data: &mut [T],
    rendered: &[f32],
    cursor: &Mutex<usize>,
    done_tx: &Mutex<Option<PlaybackDoneSender>>,
    stop_flag: &AtomicBool,
    convert: impl Fn(f32) -> T,
) where
    T: Copy + Default,
{
    let mut offset = match cursor.lock() {
        Ok(offset) => offset,
        Err(_) => {
            finish(done_tx, Err(audio_fault("output-lock-poisoned")));
            data.fill(T::default());
            return;
        }
    };
    for sample in data.iter_mut() {
        if stop_flag.load(Ordering::SeqCst) || *offset >= rendered.len() {
            *sample = T::default();
        } else {
            *sample = convert(rendered[*offset]);
            *offset = offset.saturating_add(1);
        }
    }
    if stop_flag.load(Ordering::SeqCst) {
        finish(done_tx, Err(VoiceCoreError::Cancelled));
    } else if *offset >= rendered.len() {
        finish(done_tx, Ok(()));
    }
}

fn finish(done_tx: &Mutex<Option<PlaybackDoneSender>>, result: Result<(), VoiceCoreError>) {
    if let Ok(mut done) = done_tx.lock() {
        if let Some(done) = done.take() {
            let _ = done.send(result);
        }
    }
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
    let output_frames = ((input_frames as u64).saturating_mul(output_rate_hz as u64)
        / input_rate_hz as u64)
        .max(1) as usize;
    let mut output = Vec::with_capacity(output_frames.saturating_mul(output_channels));

    for frame in 0..output_frames {
        let src_frame = frame
            .saturating_mul(input_rate_hz as usize)
            .checked_div(output_rate_hz as usize)
            .unwrap_or(0)
            .min(input_frames.saturating_sub(1));
        for channel in 0..output_channels {
            let src_channel = channel.min(input_channels.saturating_sub(1));
            output.push(i16_to_f32(input[src_frame * input_channels + src_channel]));
        }
    }
    Ok(output)
}

fn i16_to_f32(sample: i16) -> f32 {
    sample as f32 / i16::MAX as f32
}

fn f32_to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * i16::MAX as f32).round() as i16
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
    fn render_downmixes_by_taking_available_source_channel() {
        let rendered = render_for_output(&[0, i16::MAX, i16::MIN, 0], 16_000, 2, 16_000, 1)
            .expect("stereo render should succeed");
        assert_eq!(rendered, vec![0.0, -32768.0 / 32767.0]);
    }

    #[test]
    fn render_resamples_by_source_frame_identity() {
        let rendered = render_for_output(&[0, i16::MAX], 16_000, 1, 32_000, 1)
            .expect("resample render should succeed");
        assert_eq!(rendered, vec![0.0, 0.0, 1.0, 1.0]);
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
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
        assert_eq!(f32_to_i16(0.0), 0);
    }
}
