use std::fmt;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use async_trait::async_trait;
use aurora_voice_core::{
    AudioInput, CaptureOwnerKind, Generation, PcmFrame, RouteRevision, TimestampMicros,
    TransitionReason, VoiceCaptureLease, VoiceCoreError,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use crossbeam_queue::ArrayQueue;
use sha2::{Digest, Sha256};
use tokio::sync::Notify;
use tokio::time::{sleep, Duration};

const TARGET_SAMPLE_RATE_HZ: u32 = 16_000;
const DEFAULT_QUEUE_BLOCKS: usize = 32;
const MAX_QUEUE_BLOCKS: usize = 256;
const DEFAULT_MAX_BLOCK_SAMPLES: usize = 4096;
const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(5);
const NO_ACTIVE_GENERATION: u64 = 0;

#[derive(Clone, PartialEq, Eq)]
pub struct NativeInputDeviceId(String);

impl NativeInputDeviceId {
    pub fn default_device() -> Self {
        Self("default".to_owned())
    }

    pub fn from_token(token: impl Into<String>) -> Result<Self, VoiceCoreError> {
        let token = token.into();
        if !valid_device_token(&token) {
            return Err(capture_fault("invalid-input-device"));
        }
        Ok(Self(token))
    }

    pub fn route_token(&self) -> &str {
        &self.0
    }

    fn is_default(&self) -> bool {
        self.0 == "default"
    }
}

impl Default for NativeInputDeviceId {
    fn default() -> Self {
        Self::default_device()
    }
}

impl fmt::Debug for NativeInputDeviceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeInputDeviceId([redacted])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeCaptureConfig {
    pub input_device: NativeInputDeviceId,
    pub queue_blocks: usize,
    pub max_block_samples: usize,
}

impl Default for NativeCaptureConfig {
    fn default() -> Self {
        Self {
            input_device: NativeInputDeviceId::default_device(),
            queue_blocks: DEFAULT_QUEUE_BLOCKS,
            max_block_samples: DEFAULT_MAX_BLOCK_SAMPLES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeCaptureStatus {
    pub input_available: bool,
    pub active_generation: Option<Generation>,
    pub route_revision: RouteRevision,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
    pub queued_blocks: usize,
    pub dropped_blocks: u64,
}

/// Opaque CPAL input-device token derived from CPAL 0.18 `Device` display text.
///
/// The token is stable for the same CPAL backend/device display value in one host
/// environment and intentionally does not expose the raw display text.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeInputDevice {
    pub id: NativeInputDeviceId,
    pub is_default: bool,
}

impl fmt::Debug for NativeInputDevice {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeInputDevice")
            .field("id", &self.id)
            .field("is_default", &self.is_default)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct NativeCaptureControl {
    shared: Arc<CaptureShared>,
}

impl NativeCaptureControl {
    pub fn finish(&self, generation: Generation) {
        if self.matches_active_generation(generation) {
            self.shared.finished.store(true, Ordering::SeqCst);
            self.shared.notify.notify_waiters();
        }
    }

    pub fn interrupt(&self, generation: Generation) {
        if self.matches_active_generation(generation) {
            self.shared.interrupted.store(true, Ordering::SeqCst);
            self.finish(generation);
        }
    }

    pub fn dropped_blocks(&self) -> u64 {
        self.shared.dropped_blocks.load(Ordering::SeqCst)
    }

    fn matches_active_generation(&self, generation: Generation) -> bool {
        generation.0 != NO_ACTIVE_GENERATION
            && self.shared.active_generation.load(Ordering::SeqCst) == generation.0
    }
}

pub struct CpalAudioInput {
    config: NativeCaptureConfig,
    shared: Arc<CaptureShared>,
    stream: Option<cpal::Stream>,
    active: Option<CaptureSession>,
    last_status: NativeCaptureStatus,
}

impl fmt::Debug for CpalAudioInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CpalAudioInput")
            .field("config", &self.config)
            .field("active", &self.active)
            .field("last_status", &self.last_status)
            .finish_non_exhaustive()
    }
}

impl CpalAudioInput {
    pub fn new(config: NativeCaptureConfig) -> Self {
        let shared = Arc::new(CaptureShared::new(
            config.queue_blocks,
            config.max_block_samples,
        ));
        Self {
            config,
            shared,
            stream: None,
            active: None,
            last_status: NativeCaptureStatus {
                input_available: false,
                active_generation: None,
                route_revision: RouteRevision(0),
                sample_rate_hz: None,
                channels: None,
                queued_blocks: 0,
                dropped_blocks: 0,
            },
        }
    }

    pub fn control(&self) -> NativeCaptureControl {
        NativeCaptureControl {
            shared: Arc::clone(&self.shared),
        }
    }

    pub fn status(&self) -> NativeCaptureStatus {
        NativeCaptureStatus {
            queued_blocks: self.shared.queue.len(),
            dropped_blocks: self.shared.dropped_blocks.load(Ordering::SeqCst),
            ..self.last_status
        }
    }

    pub fn available_input_devices() -> Result<Vec<NativeInputDevice>, VoiceCoreError> {
        enumerate_input_devices()
    }

    #[cfg(test)]
    fn with_test_config(config: NativeCaptureConfig) -> Self {
        Self::new(config)
    }

    #[cfg(test)]
    fn install_test_session(
        &mut self,
        lease: VoiceCaptureLease,
        sample_rate_hz: u32,
        channels: u16,
    ) {
        self.shared.reset_for_start(lease.generation);
        self.active = Some(CaptureSession::new(lease, sample_rate_hz, channels));
        self.last_status.active_generation = self.active.as_ref().map(|session| session.generation);
        self.last_status.route_revision = self
            .active
            .as_ref()
            .map_or(RouteRevision(0), |session| session.route_revision);
        self.last_status.sample_rate_hz = Some(sample_rate_hz);
        self.last_status.channels = Some(channels);
        self.last_status.input_available = true;
    }

    #[cfg(test)]
    fn push_test_block(&self, block: CapturedBlock) -> bool {
        self.shared.push_block(block)
    }

    async fn reset_for_stop(&mut self) -> Result<(), VoiceCoreError> {
        if let Some(stream) = self.stream.take() {
            tokio::task::spawn_blocking(move || drop(stream))
                .await
                .map_err(|_| capture_fault("input-stream-drop"))?;
        }
        self.active = None;
        self.shared.reset_inactive();
        self.last_status.active_generation = None;
        self.last_status.queued_blocks = 0;
        Ok(())
    }
}

impl Default for CpalAudioInput {
    fn default() -> Self {
        Self::new(NativeCaptureConfig::default())
    }
}

#[async_trait(?Send)]
impl AudioInput for CpalAudioInput {
    async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
        if self.active.is_some() {
            return Err(VoiceCoreError::OwnerAlreadyActive);
        }
        validate_lease(&lease, &self.config.input_device)?;
        let host = cpal::default_host();
        let device = resolve_input_device(&host, &self.config.input_device)?;
        let supported = device
            .default_input_config()
            .map_err(|_| capture_fault("input-config-unavailable"))?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        if config.channels == 0 || config.sample_rate == 0 {
            return Err(capture_fault("invalid-input-config"));
        }

        self.shared.reset_for_start(lease.generation);
        let generation = lease.generation;
        let channels = config.channels;
        let sample_rate_hz = config.sample_rate;

        let stream = match sample_format {
            SampleFormat::F32 => device
                .build_input_stream(
                    config,
                    input_callback_f32(
                        Arc::clone(&self.shared),
                        generation,
                        sample_rate_hz,
                        channels,
                    ),
                    stream_error_callback(Arc::clone(&self.shared), generation),
                    None,
                )
                .map_err(|_| capture_fault("input-stream-build"))?,
            SampleFormat::I16 => device
                .build_input_stream(
                    config,
                    input_callback_i16(
                        Arc::clone(&self.shared),
                        generation,
                        sample_rate_hz,
                        channels,
                    ),
                    stream_error_callback(Arc::clone(&self.shared), generation),
                    None,
                )
                .map_err(|_| capture_fault("input-stream-build"))?,
            SampleFormat::U16 => device
                .build_input_stream(
                    config,
                    input_callback_u16(
                        Arc::clone(&self.shared),
                        generation,
                        sample_rate_hz,
                        channels,
                    ),
                    stream_error_callback(Arc::clone(&self.shared), generation),
                    None,
                )
                .map_err(|_| capture_fault("input-stream-build"))?,
            _ => return Err(capture_fault("unsupported-input-format")),
        };
        stream
            .play()
            .map_err(|_| capture_fault("input-stream-start"))?;

        self.stream = Some(stream);
        self.active = Some(CaptureSession::new(lease, sample_rate_hz, channels));
        self.last_status = NativeCaptureStatus {
            input_available: true,
            active_generation: self.active.as_ref().map(|session| session.generation),
            route_revision: self.current_route_revision(),
            sample_rate_hz: Some(sample_rate_hz),
            channels: Some(channels),
            queued_blocks: 0,
            dropped_blocks: 0,
        };
        Ok(())
    }

    async fn stop(&mut self, _reason: TransitionReason) -> Result<(), VoiceCoreError> {
        self.shared.finished.store(true, Ordering::SeqCst);
        self.shared.notify.notify_waiters();
        self.reset_for_stop().await
    }

    async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
        loop {
            if self.shared.interrupted.load(Ordering::SeqCst) {
                self.reset_for_stop().await?;
                return Err(VoiceCoreError::Cancelled);
            }
            if self.shared.device_lost.load(Ordering::SeqCst) {
                self.reset_for_stop().await?;
                return Err(capture_fault("input-stream-error"));
            }
            if let Some(block) = self.shared.queue.pop() {
                let Some(session) = self.active.as_mut() else {
                    continue;
                };
                if block.generation != session.generation {
                    continue;
                }
                if let Some(frame) = session.block_to_frame(block)? {
                    self.last_status.queued_blocks = self.shared.queue.len();
                    self.last_status.dropped_blocks =
                        self.shared.dropped_blocks.load(Ordering::SeqCst);
                    return Ok(Some(frame));
                }
                continue;
            }
            if self.shared.finished.load(Ordering::SeqCst) {
                if let Some(session) = self.active.as_mut() {
                    if let Some(frame) = session.flush_to_frame()? {
                        return Ok(Some(frame));
                    }
                }
                self.reset_for_stop().await?;
                return Ok(None);
            }
            tokio::select! {
                () = self.shared.notify.notified() => {}
                () = sleep(FRAME_POLL_INTERVAL) => {}
            }
        }
    }

    fn current_route_revision(&self) -> RouteRevision {
        self.active
            .as_ref()
            .map_or(self.last_status.route_revision, |session| {
                session.route_revision
            })
    }
}

#[derive(Debug)]
struct CaptureSession {
    generation: Generation,
    route_revision: RouteRevision,
    started_at: TimestampMicros,
    channels: u16,
    next_sequence: u64,
    emitted_samples: u64,
    resampler: LinearResampler,
    pending_discontinuity: bool,
    seen_overflow_count: u64,
}

impl CaptureSession {
    fn new(lease: VoiceCaptureLease, input_rate_hz: u32, channels: u16) -> Self {
        Self {
            generation: lease.generation,
            route_revision: lease.route_revision,
            started_at: lease.created_at,
            channels,
            next_sequence: 0,
            emitted_samples: 0,
            resampler: LinearResampler::new(input_rate_hz),
            pending_discontinuity: false,
            seen_overflow_count: 0,
        }
    }

    fn block_to_frame(&mut self, block: CapturedBlock) -> Result<Option<PcmFrame>, VoiceCoreError> {
        if block.input_rate_hz != self.resampler.input_rate_hz || block.channels != self.channels {
            self.pending_discontinuity = true;
            self.resampler = LinearResampler::new(block.input_rate_hz);
        }
        if block.overflow_count > self.seen_overflow_count {
            self.pending_discontinuity = true;
            self.seen_overflow_count = block.overflow_count;
        }
        let mono = downmix_to_mono(&block.samples[..block.len], block.channels)?;
        let samples = self.resampler.convert(&mono)?;
        self.samples_to_frame(samples)
    }

    fn flush_to_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
        let samples = self.resampler.flush();
        if samples.is_empty() {
            return Ok(None);
        }
        self.samples_to_frame(samples)
    }

    fn samples_to_frame(&mut self, samples: Vec<f32>) -> Result<Option<PcmFrame>, VoiceCoreError> {
        if samples.is_empty() {
            return Ok(None);
        }
        let timestamp = TimestampMicros(
            self.started_at
                .0
                .saturating_add(self.emitted_samples.saturating_mul(1_000_000) / 16_000),
        );
        self.emitted_samples = self.emitted_samples.saturating_add(samples.len() as u64);
        let discontinuity = self.pending_discontinuity;
        self.pending_discontinuity = false;
        let frame = PcmFrame::new(
            samples,
            timestamp,
            self.next_sequence,
            discontinuity,
            self.route_revision,
            self.generation,
        )?;
        self.next_sequence = self.next_sequence.saturating_add(1);
        Ok(Some(frame))
    }
}

#[derive(Debug)]
struct LinearResampler {
    input_rate_hz: u32,
    source_position: f64,
    input_samples_seen: u64,
    output_samples_emitted: u64,
    buffer: Vec<f32>,
}

impl LinearResampler {
    fn new(input_rate_hz: u32) -> Self {
        Self {
            input_rate_hz,
            source_position: 0.0,
            input_samples_seen: 0,
            output_samples_emitted: 0,
            buffer: Vec::new(),
        }
    }

    fn convert(&mut self, mono: &[f32]) -> Result<Vec<f32>, VoiceCoreError> {
        if mono.is_empty() || self.input_rate_hz == 0 {
            return Err(capture_fault("invalid-input-frame"));
        }
        self.input_samples_seen = self.input_samples_seen.saturating_add(mono.len() as u64);
        if self.input_rate_hz == TARGET_SAMPLE_RATE_HZ {
            self.output_samples_emitted = self
                .output_samples_emitted
                .saturating_add(mono.len() as u64);
            return Ok(mono.to_vec());
        }

        self.buffer.extend_from_slice(mono);
        let target_output = self.target_output_samples();
        let requested_output = target_output.saturating_sub(self.output_samples_emitted) as usize;
        if requested_output == 0 {
            return Ok(Vec::new());
        }
        let step = self.input_rate_hz as f64 / TARGET_SAMPLE_RATE_HZ as f64;
        let mut output = Vec::with_capacity(requested_output);
        let effective_len = self.effective_len(false);
        while output.len() < requested_output && self.source_position + 1.0 < effective_len {
            let left = self.source_position.floor() as usize;
            let right = (left + 1).min(self.buffer.len().saturating_sub(1));
            let fraction = (self.source_position - left as f64) as f32;
            let sample = self.buffer[left] * (1.0 - fraction) + self.buffer[right] * fraction;
            output.push(sample.clamp(-1.0, 1.0));
            self.source_position += step;
        }
        self.output_samples_emitted = self
            .output_samples_emitted
            .saturating_add(output.len() as u64);

        let consumed = self.source_position.floor() as usize;
        if consumed > 0 {
            self.buffer.drain(0..consumed);
            self.source_position -= consumed as f64;
        }
        Ok(output)
    }

    fn flush(&mut self) -> Vec<f32> {
        let requested_output = self
            .target_output_samples()
            .saturating_sub(self.output_samples_emitted) as usize;
        if requested_output == 0 || self.buffer.is_empty() {
            self.buffer.clear();
            self.source_position = 0.0;
            return Vec::new();
        }
        let step = self.input_rate_hz as f64 / TARGET_SAMPLE_RATE_HZ as f64;
        let mut output = Vec::with_capacity(requested_output);
        let effective_len = self.effective_len(true);
        while output.len() < requested_output && self.source_position + 1.0 < effective_len {
            let left = self.source_position.floor() as usize;
            let right = (left + 1).min(self.buffer.len().saturating_sub(1));
            let fraction = (self.source_position - left as f64) as f32;
            let sample = self.buffer[left] * (1.0 - fraction) + self.buffer[right] * fraction;
            output.push(sample.clamp(-1.0, 1.0));
            self.source_position += step;
        }
        self.output_samples_emitted = self
            .output_samples_emitted
            .saturating_add(output.len() as u64);
        if self.output_samples_emitted >= self.target_output_samples() {
            self.buffer.clear();
            self.source_position = 0.0;
        }
        output
    }

    fn target_output_samples(&self) -> u64 {
        self.input_samples_seen
            .saturating_mul(TARGET_SAMPLE_RATE_HZ as u64)
            / self.input_rate_hz as u64
    }

    fn effective_len(&self, include_virtual_endpoint: bool) -> f64 {
        if self.buffer.is_empty() {
            0.0
        } else if include_virtual_endpoint {
            self.buffer.len() as f64 + 1.0
        } else {
            self.buffer.len() as f64
        }
    }
}

#[derive(Debug)]
struct CaptureShared {
    queue: ArrayQueue<CapturedBlock>,
    notify: Notify,
    active_generation: AtomicU64,
    finished: AtomicBool,
    interrupted: AtomicBool,
    device_lost: AtomicBool,
    dropped_blocks: AtomicU64,
    max_block_samples: usize,
}

impl CaptureShared {
    fn new(queue_blocks: usize, max_block_samples: usize) -> Self {
        Self {
            queue: ArrayQueue::new(queue_blocks.clamp(1, MAX_QUEUE_BLOCKS)),
            notify: Notify::new(),
            active_generation: AtomicU64::new(NO_ACTIVE_GENERATION),
            finished: AtomicBool::new(false),
            interrupted: AtomicBool::new(false),
            device_lost: AtomicBool::new(false),
            dropped_blocks: AtomicU64::new(0),
            max_block_samples: max_block_samples.clamp(1, DEFAULT_MAX_BLOCK_SAMPLES),
        }
    }

    fn reset_for_start(&self, generation: Generation) {
        self.reset(generation.0);
    }

    fn reset_inactive(&self) {
        self.reset(NO_ACTIVE_GENERATION);
    }

    fn reset(&self, generation: u64) {
        while self.queue.pop().is_some() {}
        self.active_generation.store(generation, Ordering::SeqCst);
        self.finished.store(false, Ordering::SeqCst);
        self.interrupted.store(false, Ordering::SeqCst);
        self.device_lost.store(false, Ordering::SeqCst);
        self.dropped_blocks.store(0, Ordering::SeqCst);
    }

    fn push_block(&self, block: CapturedBlock) -> bool {
        if self.queue.push(block).is_err() {
            self.dropped_blocks.fetch_add(1, Ordering::SeqCst);
            return false;
        }
        true
    }
}

#[derive(Clone)]
struct CapturedBlock {
    generation: Generation,
    input_rate_hz: u32,
    channels: u16,
    len: usize,
    samples: [f32; DEFAULT_MAX_BLOCK_SAMPLES],
    overflow_count: u64,
}

impl CapturedBlock {
    fn new(generation: Generation, input_rate_hz: u32, channels: u16) -> Self {
        Self {
            generation,
            input_rate_hz,
            channels,
            len: 0,
            samples: [0.0; DEFAULT_MAX_BLOCK_SAMPLES],
            overflow_count: 0,
        }
    }
}

impl fmt::Debug for CapturedBlock {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedBlock")
            .field("generation", &self.generation)
            .field("input_rate_hz", &self.input_rate_hz)
            .field("channels", &self.channels)
            .field("len", &self.len)
            .field("overflow_count", &self.overflow_count)
            .finish()
    }
}

fn validate_lease(
    lease: &VoiceCaptureLease,
    input_device: &NativeInputDeviceId,
) -> Result<(), VoiceCoreError> {
    if lease.owner != CaptureOwnerKind::Native
        || lease.generation.0 == NO_ACTIVE_GENERATION
        || !valid_route_token(&lease.device_route)
        || lease.device_route != input_device.route_token()
    {
        return Err(capture_fault("invalid-capture-lease"));
    }
    Ok(())
}

fn valid_route_token(route: &str) -> bool {
    route == "default" || valid_device_token(route)
}

fn valid_device_token(token: &str) -> bool {
    token.len() == 20
        && token.starts_with("dev-")
        && token
            .bytes()
            .skip(4)
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn enumerate_input_devices() -> Result<Vec<NativeInputDevice>, VoiceCoreError> {
    let host = cpal::default_host();
    let default_token = host
        .default_input_device()
        .map(|device| device_token(&device.to_string()));
    let mut devices = vec![NativeInputDevice {
        id: NativeInputDeviceId::default_device(),
        is_default: true,
    }];

    for device in host
        .input_devices()
        .map_err(|_| capture_fault("input-devices-unavailable"))?
    {
        let token = device_token(&device.to_string());
        if devices
            .iter()
            .any(|known| known.id.route_token() == token.as_str())
        {
            continue;
        }
        devices.push(NativeInputDevice {
            id: NativeInputDeviceId::from_token(token.clone())?,
            is_default: default_token.as_deref() == Some(token.as_str()),
        });
    }
    Ok(devices)
}

fn resolve_input_device(
    host: &cpal::Host,
    input_device: &NativeInputDeviceId,
) -> Result<cpal::Device, VoiceCoreError> {
    if input_device.is_default() {
        return host
            .default_input_device()
            .ok_or_else(|| capture_fault("input-unavailable"));
    }
    let devices = host
        .input_devices()
        .map_err(|_| capture_fault("input-devices-unavailable"))?;
    for device in devices {
        if device_token(&device.to_string()) == input_device.0 {
            return Ok(device);
        }
    }
    Err(capture_fault("input-device-unavailable"))
}

fn stream_error_callback(
    shared: Arc<CaptureShared>,
    generation: Generation,
) -> impl FnMut(cpal::Error) + Send + 'static {
    move |_| {
        if shared.active_generation.load(Ordering::SeqCst) == generation.0 {
            shared.device_lost.store(true, Ordering::SeqCst);
            shared.finished.store(true, Ordering::SeqCst);
            shared.notify.notify_waiters();
        }
    }
}

fn input_callback_f32(
    shared: Arc<CaptureShared>,
    generation: Generation,
    input_rate_hz: u32,
    channels: u16,
) -> impl FnMut(&[f32], &cpal::InputCallbackInfo) + Send + 'static {
    move |data, _| {
        capture_callback(
            data,
            &shared,
            generation,
            input_rate_hz,
            channels,
            |sample| sample.clamp(-1.0, 1.0),
        )
    }
}

fn input_callback_i16(
    shared: Arc<CaptureShared>,
    generation: Generation,
    input_rate_hz: u32,
    channels: u16,
) -> impl FnMut(&[i16], &cpal::InputCallbackInfo) + Send + 'static {
    move |data, _| {
        capture_callback(
            data,
            &shared,
            generation,
            input_rate_hz,
            channels,
            i16_to_f32,
        )
    }
}

fn input_callback_u16(
    shared: Arc<CaptureShared>,
    generation: Generation,
    input_rate_hz: u32,
    channels: u16,
) -> impl FnMut(&[u16], &cpal::InputCallbackInfo) + Send + 'static {
    move |data, _| {
        capture_callback(
            data,
            &shared,
            generation,
            input_rate_hz,
            channels,
            u16_to_f32,
        )
    }
}

fn capture_callback<T>(
    data: &[T],
    shared: &CaptureShared,
    generation: Generation,
    input_rate_hz: u32,
    channels: u16,
    convert: impl Fn(T) -> f32,
) where
    T: Copy,
{
    if shared.finished.load(Ordering::SeqCst) || channels == 0 || input_rate_hz == 0 {
        return;
    }
    let mut offset = 0;
    let channel_count = channels as usize;
    while offset < data.len() {
        let mut block = CapturedBlock::new(generation, input_rate_hz, channels);
        let remaining_frames = data.len().saturating_sub(offset) / channel_count;
        let block_frames = shared.max_block_samples.min(DEFAULT_MAX_BLOCK_SAMPLES) / channel_count;
        let available_frames = remaining_frames.min(block_frames);
        let available = available_frames.saturating_mul(channel_count);
        for sample in data[offset..offset + available].iter().copied() {
            block.samples[block.len] = convert(sample);
            block.len = block.len.saturating_add(1);
        }
        if available == 0 {
            shared.dropped_blocks.fetch_add(1, Ordering::SeqCst);
            return;
        }
        offset = offset.saturating_add(available);
        block.overflow_count = shared.dropped_blocks.load(Ordering::SeqCst);
        if !shared.push_block(block) {
            return;
        }
    }
}

fn downmix_to_mono(samples: &[f32], channels: u16) -> Result<Vec<f32>, VoiceCoreError> {
    if samples.is_empty() || channels == 0 || !samples.len().is_multiple_of(channels as usize) {
        return Err(capture_fault("invalid-input-frame"));
    }
    let channels = channels as usize;
    let mut mono = Vec::with_capacity(samples.len() / channels);
    for frame in samples.chunks_exact(channels) {
        let sum = frame.iter().copied().sum::<f32>();
        mono.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
    Ok(mono)
}

fn device_token(name: &str) -> String {
    let digest = Sha256::digest(name.as_bytes());
    format!(
        "dev-{:016x}",
        u64::from_be_bytes([
            digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
        ])
    )
}

fn i16_to_f32(sample: i16) -> f32 {
    if sample == i16::MIN {
        -1.0
    } else {
        sample as f32 / i16::MAX as f32
    }
}

fn u16_to_f32(sample: u16) -> f32 {
    (sample as f32 - 32768.0) / 32768.0
}

fn capture_fault(code: &'static str) -> VoiceCoreError {
    VoiceCoreError::TransportFault {
        code: code.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_core::{CaptureOwnerKind, CaptureStartReason};

    fn lease(generation: u64, route_revision: u64) -> VoiceCaptureLease {
        VoiceCaptureLease {
            owner: CaptureOwnerKind::Native,
            surface: "desktop".to_owned(),
            device_route: "default".to_owned(),
            start_reason: CaptureStartReason::PushToTalk,
            generation: Generation(generation),
            created_at: TimestampMicros(1_000),
            route_revision: RouteRevision(route_revision),
            background_eligible: false,
            consent_revision: 1,
            heartbeat_at: TimestampMicros(1_000),
            stop_deadline: None,
        }
    }

    fn block(
        generation: Generation,
        input_rate_hz: u32,
        channels: u16,
        samples: &[f32],
    ) -> CapturedBlock {
        let mut block = CapturedBlock::new(generation, input_rate_hz, channels);
        for sample in samples.iter().copied() {
            block.samples[block.len] = sample;
            block.len += 1;
        }
        block
    }

    #[test]
    fn input_conversions_are_bounded_and_centered() {
        assert_eq!(i16_to_f32(i16::MIN), -1.0);
        assert_eq!(i16_to_f32(0), 0.0);
        assert_eq!(i16_to_f32(i16::MAX), 1.0);
        assert_eq!(u16_to_f32(0), -1.0);
        assert_eq!(u16_to_f32(32768), 0.0);
        assert!(u16_to_f32(u16::MAX) <= 1.0);
    }

    #[test]
    fn downmix_averages_interleaved_channels() -> Result<(), VoiceCoreError> {
        let mono = downmix_to_mono(&[1.0, -1.0, 0.5, 1.0], 2)?;
        assert_eq!(mono, vec![0.0, 0.75]);
        assert!(matches!(
            downmix_to_mono(&[1.0, 0.0, 0.5], 2),
            Err(VoiceCoreError::TransportFault { code }) if code == "invalid-input-frame"
        ));
        Ok(())
    }

    #[test]
    fn resampler_converts_to_16khz_mono_with_carry() -> Result<(), VoiceCoreError> {
        let mut resampler = LinearResampler::new(48_000);
        let first = resampler.convert(&(0..48).map(|value| value as f32).collect::<Vec<_>>())?;
        assert_eq!(first.len(), 16);
        let second = resampler.convert(&(48..96).map(|value| value as f32).collect::<Vec<_>>())?;
        assert_eq!(second.len(), 16);

        let mut one_shot = LinearResampler::new(48_000);
        let expected = one_shot.convert(&(0..96).map(|value| value as f32).collect::<Vec<_>>())?;
        let actual = first.into_iter().chain(second).collect::<Vec<_>>();
        assert_eq!(actual, expected);
        Ok(())
    }

    #[test]
    fn resampler_upsamples_8khz_with_block_duration_and_bridge() -> Result<(), VoiceCoreError> {
        let mut split = LinearResampler::new(8_000);
        let first = split.convert(&[0.0, 1.0, 0.0, -1.0])?;
        let second = split.convert(&[0.5, -0.5, 0.25, -0.25])?;

        let mut one_shot = LinearResampler::new(8_000);
        let mut expected = one_shot.convert(&[0.0, 1.0, 0.0, -1.0, 0.5, -0.5, 0.25, -0.25])?;
        expected.extend(one_shot.flush());
        let mut actual = first.into_iter().chain(second).collect::<Vec<_>>();
        actual.extend(split.flush());
        assert_eq!(actual.len(), 16);
        assert_eq!(actual, expected);
        Ok(())
    }

    #[test]
    fn resampler_preserves_44100_fractional_remainder_across_uneven_splits(
    ) -> Result<(), VoiceCoreError> {
        let input = (0..1280)
            .map(|value| ((value % 97) as f32 / 96.0) * 2.0 - 1.0)
            .collect::<Vec<_>>();
        let mut split = LinearResampler::new(44_100);
        let mut actual = Vec::new();
        for chunk in input.chunks(128) {
            actual.extend(split.convert(chunk)?);
        }
        actual.extend(split.flush());

        let mut one_shot = LinearResampler::new(44_100);
        let mut expected = one_shot.convert(&input)?;
        expected.extend(one_shot.flush());

        assert_eq!(actual.len(), input.len() * 16_000 / 44_100);
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected.iter()) {
            assert!((actual - expected).abs() < 0.0001);
        }
        Ok(())
    }

    #[test]
    fn resampler_handles_44100_downsample_and_16khz_passthrough() -> Result<(), VoiceCoreError> {
        let mut downsample = LinearResampler::new(44_100);
        let output = downsample.convert(&vec![0.25; 441])?;
        assert_eq!(output.len(), 160);
        assert!(output.iter().all(|sample| (*sample - 0.25).abs() < 0.0001));

        let mut passthrough = LinearResampler::new(16_000);
        assert_eq!(passthrough.convert(&[0.5, -0.5])?, vec![0.5, -0.5]);
        Ok(())
    }

    #[test]
    fn callback_chunks_large_buffers_without_allocating_dynamic_blocks() {
        let shared = CaptureShared::new(4, 3);
        capture_callback(
            &[0_i16, i16::MAX, i16::MIN, 0, 1, 2, 3],
            &shared,
            Generation(7),
            16_000,
            1,
            i16_to_f32,
        );
        assert_eq!(shared.queue.len(), 3);
        assert_eq!(shared.dropped_blocks.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn callback_chunks_only_complete_interleaved_frames() {
        let shared = CaptureShared::new(8, 3);
        capture_callback(
            &[0_i16, 1, 2, 3, 4, 5, 6, 7],
            &shared,
            Generation(7),
            16_000,
            2,
            i16_to_f32,
        );
        assert_eq!(shared.queue.len(), 4);
        while let Some(block) = shared.queue.pop() {
            assert_eq!(block.len % block.channels as usize, 0);
            assert_eq!(block.len, 2);
        }

        let too_small = CaptureShared::new(8, 2);
        capture_callback(
            &[0_i16, 1, 2],
            &too_small,
            Generation(7),
            16_000,
            3,
            i16_to_f32,
        );
        assert_eq!(too_small.queue.len(), 0);
        assert_eq!(too_small.dropped_blocks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn callback_body_stays_queue_atomic_only() {
        let source = include_str!("desktop_capture.rs");
        let callback = source
            .split("fn capture_callback<T>")
            .nth(1)
            .and_then(|tail| tail.split("fn downmix_to_mono(").next())
            .expect("capture callback source is present");
        for forbidden in [
            "notify",
            "Mutex",
            ".lock(",
            "sleep(",
            "await",
            "spawn",
            "Vec::new",
            "Vec::with_capacity",
            "to_vec",
            "Box::new",
        ] {
            assert!(
                !callback.contains(forbidden),
                "capture callback must not contain {forbidden}"
            );
        }
        assert!(callback.contains("push_block"));
        assert!(callback.contains("fetch_add"));
    }

    #[test]
    fn queue_overflow_is_counted_and_redacted() {
        let shared = CaptureShared::new(1, 8);
        assert!(shared.push_block(block(Generation(1), 16_000, 1, &[0.0])));
        assert!(!shared.push_block(block(Generation(1), 16_000, 1, &[0.1])));
        assert_eq!(shared.dropped_blocks.load(Ordering::SeqCst), 1);
        assert!(!format!("{:?}", shared.queue.pop()).contains("0.1"));
    }

    #[test]
    fn queue_capacity_is_clamped() {
        let shared = CaptureShared::new(usize::MAX, 8);
        for _ in 0..MAX_QUEUE_BLOCKS {
            assert!(shared.push_block(block(Generation(1), 16_000, 1, &[0.0])));
        }
        assert!(!shared.push_block(block(Generation(1), 16_000, 1, &[0.0])));
    }

    #[tokio::test]
    async fn next_frame_preserves_generation_route_sequence_and_timestamp(
    ) -> Result<(), VoiceCoreError> {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(11, 3), 16_000, 2);
        input
            .push_test_block(block(Generation(11), 16_000, 2, &[1.0, -1.0, 0.5, 0.5]))
            .then_some(())
            .expect("test queue accepts block");
        let frame = input
            .next_frame()
            .await?
            .ok_or_else(|| capture_fault("missing-test-frame"))?;
        assert_eq!(frame.generation(), Generation(11));
        assert_eq!(frame.route_revision(), RouteRevision(3));
        assert_eq!(frame.sequence(), 0);
        assert_eq!(frame.timestamp(), TimestampMicros(1_000));
        assert_eq!(frame.samples(), &[0.0, 0.5]);
        Ok(())
    }

    #[tokio::test]
    async fn next_frame_skips_stale_generation_blocks() -> Result<(), VoiceCoreError> {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(2, 1), 16_000, 1);
        input
            .push_test_block(block(Generation(1), 16_000, 1, &[0.9]))
            .then_some(())
            .expect("stale block queued");
        input
            .push_test_block(block(Generation(2), 16_000, 1, &[0.2]))
            .then_some(())
            .expect("active block queued");
        let frame = input
            .next_frame()
            .await?
            .ok_or_else(|| capture_fault("missing-test-frame"))?;
        assert_eq!(frame.generation(), Generation(2));
        assert_eq!(frame.samples(), &[0.2]);
        Ok(())
    }

    #[tokio::test]
    async fn overflow_marks_next_frame_discontinuous() -> Result<(), VoiceCoreError> {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(4, 9), 16_000, 1);
        let mut overflowed = block(Generation(4), 16_000, 1, &[0.1]);
        overflowed.overflow_count = 1;
        input
            .push_test_block(overflowed)
            .then_some(())
            .expect("overflow block queued");
        let frame = input
            .next_frame()
            .await?
            .ok_or_else(|| capture_fault("missing-test-frame"))?;
        assert!(frame.discontinuity());
        assert_eq!(frame.route_revision(), RouteRevision(9));
        Ok(())
    }

    #[tokio::test]
    async fn finish_controller_unblocks_next_frame_with_none() -> Result<(), VoiceCoreError> {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(5, 1), 16_000, 1);
        let control = input.control();
        control.finish(Generation(5));
        assert!(input.next_frame().await?.is_none());
        assert_eq!(input.status().active_generation, None);
        Ok(())
    }

    #[tokio::test]
    async fn finish_flushes_pending_upsampled_frame_before_none() -> Result<(), VoiceCoreError> {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(5, 1), 8_000, 1);
        input
            .push_test_block(block(Generation(5), 8_000, 1, &[0.0, 1.0, 0.0, -1.0]))
            .then_some(())
            .expect("test queue accepts block");
        let first = input
            .next_frame()
            .await?
            .ok_or_else(|| capture_fault("missing-test-frame"))?;
        assert_eq!(first.sample_count(), 6);
        input.control().finish(Generation(5));
        let flushed = input
            .next_frame()
            .await?
            .ok_or_else(|| capture_fault("missing-flush-frame"))?;
        assert_eq!(flushed.sample_count(), 2);
        assert!(input.next_frame().await?.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn stale_control_does_not_finish_restarted_generation() -> Result<(), VoiceCoreError> {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(5, 1), 16_000, 1);
        let stale = input.control();
        input.install_test_session(lease(6, 1), 16_000, 1);
        stale.finish(Generation(5));
        stale.interrupt(Generation(5));
        assert!(!input.shared.finished.load(Ordering::SeqCst));
        assert!(!input.shared.interrupted.load(Ordering::SeqCst));
        input
            .push_test_block(block(Generation(6), 16_000, 1, &[0.4]))
            .then_some(())
            .expect("active block queued");
        let frame = input
            .next_frame()
            .await?
            .ok_or_else(|| capture_fault("missing-test-frame"))?;
        assert_eq!(frame.generation(), Generation(6));
        assert_eq!(frame.samples(), &[0.4]);
        Ok(())
    }

    #[tokio::test]
    async fn pre_start_control_can_finish_expected_runtime_generation() -> Result<(), VoiceCoreError>
    {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        let control = input.control();
        control.finish(Generation(8));
        assert!(!input.shared.finished.load(Ordering::SeqCst));
        input.install_test_session(lease(8, 0), 16_000, 1);
        control.finish(Generation(8));
        assert!(input.next_frame().await?.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn interrupt_controller_unblocks_next_frame_with_cancelled() {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(6, 1), 16_000, 1);
        let control = input.control();
        control.interrupt(Generation(6));
        assert!(matches!(
            input.next_frame().await,
            Err(VoiceCoreError::Cancelled)
        ));
    }

    #[tokio::test]
    async fn device_loss_fails_closed_with_stable_code() {
        let mut input = CpalAudioInput::with_test_config(NativeCaptureConfig::default());
        input.install_test_session(lease(7, 1), 16_000, 1);
        input.shared.device_lost.store(true, Ordering::SeqCst);
        input.shared.notify.notify_waiters();
        assert!(matches!(
            input.next_frame().await,
            Err(VoiceCoreError::TransportFault { code }) if code == "input-stream-error"
        ));
    }

    #[test]
    fn status_and_debug_do_not_expose_device_identity_or_pcm() {
        let id = NativeInputDeviceId::from_token("dev-abcdef0123456789").expect("token accepted");
        assert_eq!(format!("{id:?}"), "NativeInputDeviceId([redacted])");
        let status = NativeCaptureStatus {
            input_available: true,
            active_generation: Some(Generation(1)),
            route_revision: RouteRevision(2),
            sample_rate_hz: Some(16_000),
            channels: Some(1),
            queued_blocks: 0,
            dropped_blocks: 0,
        };
        let rendered = format!("{status:?}");
        assert!(!rendered.contains("dev-abcdef"));
        assert!(!rendered.contains("0.25"));
    }

    #[test]
    fn lease_validation_rejects_non_native_or_unbounded_routes() {
        let config = NativeInputDeviceId::default_device();
        let zero_route_revision = lease(1, 0);
        assert!(validate_lease(&zero_route_revision, &config).is_ok());

        let mut wrong_owner = lease(1, 1);
        wrong_owner.owner = CaptureOwnerKind::Python;
        assert!(matches!(
            validate_lease(&wrong_owner, &config),
            Err(VoiceCoreError::TransportFault { code }) if code == "invalid-capture-lease"
        ));

        let mut raw_route = lease(1, 1);
        raw_route.device_route = "raw route with spaces".to_owned();
        assert!(validate_lease(&raw_route, &config).is_err());

        let token = NativeInputDeviceId::from_token("dev-abcdef0123456789").expect("valid token");
        let mut mismatched_route = lease(1, 1);
        mismatched_route.device_route = "default".to_owned();
        assert!(validate_lease(&mismatched_route, &token).is_err());
        mismatched_route.device_route = token.route_token().to_owned();
        assert!(validate_lease(&mismatched_route, &token).is_ok());
    }

    #[test]
    fn device_tokens_are_stable_without_revealing_names() {
        let token = device_token("Raw Microphone Name");
        assert!(token.starts_with("dev-"));
        assert_eq!(token, device_token("Raw Microphone Name"));
        assert!(!token.contains("Microphone"));
        assert!(NativeInputDeviceId::from_token(token).is_ok());
        assert!(NativeInputDeviceId::from_token("default").is_err());
        assert!(NativeInputDeviceId::from_token("dev-ABCDEF0123456789").is_err());
        assert!(NativeInputDeviceId::from_token("dev-abcdef012345678").is_err());
    }
}
