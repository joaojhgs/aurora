//! Narrow Rust-owned PCM boundary for the iOS foreground audio host.
//!
//! Swift owns AVAudioSession/AVAudioEngine lifecycle. Rust owns bounded
//! buffering, validation, sequence accounting, and shutdown semantics. This
//! crate intentionally does not claim a complete iOS assistant turn.

use std::collections::VecDeque;
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use aurora_voice_core::{
    AudioInput, AudioOutput, AudioPlaybackContext, AudioPlaybackReceipt, CaptureOwnerKind,
    Generation, PcmFrame, RouteRevision, TimestampMicros, TransitionReason, VoiceCaptureLease,
    VoiceCoreError,
};
use aurora_voice_engine::TtsSynthesisResult;
use tokio::time::{sleep, Duration};

const DEFAULT_CAPACITY_CHUNKS: usize = 8;
const DEFAULT_MAX_CHUNK_SAMPLES: usize = 48_000;
const MAX_CAPACITY_CHUNKS: usize = 64;
const MAX_CHUNK_SAMPLES: usize = 96_000;

pub const AURORA_IOS_AUDIO_OK: i32 = 0;
pub const AURORA_IOS_AUDIO_BACKPRESSURE: i32 = 1;
pub const AURORA_IOS_AUDIO_CLOSED: i32 = 2;
pub const AURORA_IOS_AUDIO_INVALID_ARGUMENT: i32 = -1;

#[repr(C)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AuroraIosAudioStats {
    pub accepted_chunks: u64,
    pub accepted_samples: u64,
    pub dropped_chunks: u64,
    pub discontinuities: u64,
    pub queued_chunks: u32,
    pub closed: u32,
}

#[derive(Debug)]
struct PcmChunk {
    samples: Vec<f32>,
    sequence: u64,
    sample_rate_hz: u32,
}

/// One bounded PCM chunk drained by the shared native voice runtime.
#[derive(Debug, Clone, PartialEq)]
pub struct AuroraIosAudioChunk {
    pub samples: Vec<f32>,
    pub sequence: u64,
    pub sample_rate_hz: u32,
}

#[derive(Debug)]
struct Inner {
    queue: VecDeque<PcmChunk>,
    stats: AuroraIosAudioStats,
    last_sequence: Option<u64>,
}

pub struct AuroraIosAudioState {
    capacity_chunks: usize,
    max_chunk_samples: usize,
    inner: Arc<Mutex<Inner>>,
}

impl fmt::Debug for AuroraIosAudioState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let stats = self.stats();
        formatter
            .debug_struct("AuroraIosAudioState")
            .field("capacity_chunks", &self.capacity_chunks)
            .field("max_chunk_samples", &self.max_chunk_samples)
            .field("accepted_chunks", &stats.accepted_chunks)
            .field("accepted_samples", &stats.accepted_samples)
            .field("dropped_chunks", &stats.dropped_chunks)
            .field("queued_chunks", &stats.queued_chunks)
            .field("closed", &stats.closed)
            .finish()
    }
}

impl Clone for AuroraIosAudioState {
    fn clone(&self) -> Self {
        Self {
            capacity_chunks: self.capacity_chunks,
            max_chunk_samples: self.max_chunk_samples,
            inner: Arc::clone(&self.inner),
        }
    }
}

impl AuroraIosAudioState {
    fn new(capacity_chunks: usize, max_chunk_samples: usize) -> Self {
        let capacity_chunks = if capacity_chunks == 0 {
            DEFAULT_CAPACITY_CHUNKS
        } else {
            capacity_chunks.min(MAX_CAPACITY_CHUNKS)
        };
        let max_chunk_samples = if max_chunk_samples == 0 {
            DEFAULT_MAX_CHUNK_SAMPLES
        } else {
            max_chunk_samples.min(MAX_CHUNK_SAMPLES)
        };
        Self {
            capacity_chunks,
            max_chunk_samples,
            inner: Arc::new(Mutex::new(Inner {
                queue: VecDeque::with_capacity(capacity_chunks),
                stats: AuroraIosAudioStats::default(),
                last_sequence: None,
            })),
        }
    }

    fn push_pcm(&self, samples: &[f32], sequence: u64, sample_rate_hz: u32) -> i32 {
        if samples.is_empty()
            || samples.len() > self.max_chunk_samples
            || sample_rate_hz == 0
            || samples.iter().any(|sample| !sample.is_finite())
        {
            return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
        }
        let mut inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        if inner.stats.closed != 0 {
            return AURORA_IOS_AUDIO_CLOSED;
        }
        if inner.queue.len() >= self.capacity_chunks {
            inner.stats.dropped_chunks += 1;
            return AURORA_IOS_AUDIO_BACKPRESSURE;
        }
        if let Some(last_sequence) = inner.last_sequence {
            if sequence != last_sequence.saturating_add(1) {
                inner.stats.discontinuities += 1;
            }
        }
        inner.last_sequence = Some(sequence);
        inner.stats.accepted_chunks += 1;
        inner.stats.accepted_samples += samples.len() as u64;
        inner.queue.push_back(PcmChunk {
            samples: samples.to_vec(),
            sequence,
            sample_rate_hz,
        });
        AURORA_IOS_AUDIO_OK
    }

    /// Drain one owned chunk for a native runtime adapter.
    pub fn drain_chunk(&self) -> Option<AuroraIosAudioChunk> {
        let mut inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        inner.queue.pop_front().map(|chunk| AuroraIosAudioChunk {
            samples: chunk.samples,
            sequence: chunk.sequence,
            sample_rate_hz: chunk.sample_rate_hz,
        })
    }

    fn drain_one(&self) -> usize {
        self.drain_chunk().map_or(0, |chunk| chunk.samples.len())
    }

    fn close(&self) {
        let mut inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        inner.stats.closed = 1;
        inner.queue.clear();
    }

    fn reset(&self) -> i32 {
        let mut inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        if inner.stats.closed != 0 {
            return AURORA_IOS_AUDIO_CLOSED;
        }
        inner.queue.clear();
        inner.last_sequence = None;
        AURORA_IOS_AUDIO_OK
    }

    fn stats(&self) -> AuroraIosAudioStats {
        let inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        let mut stats = inner.stats;
        stats.queued_chunks = inner.queue.len() as u32;
        stats
    }
}

const IOS_FRAME_POLL_INTERVAL: Duration = Duration::from_millis(5);
const IOS_RUNTIME_SAMPLE_RATE_HZ: u32 = 16_000;

/// Finish/interruption control shared by the iOS host and the Rust input port.
#[derive(Debug, Clone, Default)]
pub struct AuroraIosCaptureControl {
    finished: Arc<AtomicBool>,
    interrupted: Arc<AtomicBool>,
    active_generation: Arc<Mutex<Option<Generation>>>,
}

impl AuroraIosCaptureControl {
    pub fn finish(&self, generation: Generation) {
        if self.matches_active_generation(generation) {
            self.finished.store(true, Ordering::SeqCst);
        }
    }

    pub fn interrupt(&self, generation: Generation) {
        if self.matches_active_generation(generation) {
            self.interrupted.store(true, Ordering::SeqCst);
            self.finished.store(true, Ordering::SeqCst);
        }
    }

    fn matches_active_generation(&self, generation: Generation) -> bool {
        self.active_generation
            .lock()
            .ok()
            .and_then(|active| *active)
            == Some(generation)
    }

    fn set_generation(&self, generation: Option<Generation>) {
        if let Ok(mut active) = self.active_generation.lock() {
            *active = generation;
        }
        self.finished.store(false, Ordering::SeqCst);
        self.interrupted.store(false, Ordering::SeqCst);
    }
}

/// Shared-core audio input adapter for AVAudioEngine PCM.
#[derive(Debug, Clone)]
pub struct AuroraIosAudioInput {
    state: AuroraIosAudioState,
    control: AuroraIosCaptureControl,
    active_generation: Option<Generation>,
    route_revision: RouteRevision,
    started_at: TimestampMicros,
    next_sequence: u64,
    expected_ingress_sequence: Option<u64>,
}

impl AuroraIosAudioInput {
    pub fn new(state: AuroraIosAudioState) -> Self {
        Self {
            state,
            control: AuroraIosCaptureControl::default(),
            active_generation: None,
            route_revision: RouteRevision(0),
            started_at: TimestampMicros(0),
            next_sequence: 0,
            expected_ingress_sequence: None,
        }
    }

    pub fn control(&self) -> AuroraIosCaptureControl {
        self.control.clone()
    }
}

#[async_trait(?Send)]
impl AudioInput for AuroraIosAudioInput {
    async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
        if self.active_generation.is_some() {
            return Err(VoiceCoreError::OwnerAlreadyActive);
        }
        if lease.owner != CaptureOwnerKind::Native {
            return Err(VoiceCoreError::OwnerMismatch);
        }
        while self.state.drain_chunk().is_some() {}
        self.active_generation = Some(lease.generation);
        self.route_revision = lease.route_revision;
        self.started_at = lease.created_at;
        self.next_sequence = 0;
        self.expected_ingress_sequence = None;
        self.control.set_generation(self.active_generation);
        Ok(())
    }

    async fn stop(&mut self, _reason: TransitionReason) -> Result<(), VoiceCoreError> {
        self.control.set_generation(None);
        self.active_generation = None;
        self.expected_ingress_sequence = None;
        Ok(())
    }

    async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
        let Some(generation) = self.active_generation else {
            return Ok(None);
        };
        loop {
            if self.control.interrupted.load(Ordering::SeqCst) {
                return Err(VoiceCoreError::Cancelled);
            }
            if let Some(chunk) = self.state.drain_chunk() {
                let discontinuity = self
                    .expected_ingress_sequence
                    .is_some_and(|expected| expected != chunk.sequence);
                self.expected_ingress_sequence = Some(chunk.sequence.saturating_add(1));
                let samples = resample_to_runtime_rate(&chunk.samples, chunk.sample_rate_hz)?;
                let timestamp = TimestampMicros(self.started_at.0.saturating_add(
                    self.next_sequence.saturating_mul(1_000_000)
                        / u64::from(IOS_RUNTIME_SAMPLE_RATE_HZ),
                ));
                let frame = PcmFrame::new(
                    samples,
                    timestamp,
                    self.next_sequence,
                    discontinuity,
                    self.route_revision,
                    generation,
                )?;
                self.next_sequence = self.next_sequence.saturating_add(1);
                return Ok(Some(frame));
            }
            if self.control.finished.load(Ordering::SeqCst) || self.state.stats().closed != 0 {
                return Ok(None);
            }
            sleep(IOS_FRAME_POLL_INTERVAL).await;
        }
    }

    fn current_route_revision(&self) -> RouteRevision {
        self.route_revision
    }
}

fn resample_to_runtime_rate(
    samples: &[f32],
    source_rate_hz: u32,
) -> Result<Vec<f32>, VoiceCoreError> {
    if source_rate_hz == 0 || samples.is_empty() {
        return Err(VoiceCoreError::EmptyFrame);
    }
    if source_rate_hz == IOS_RUNTIME_SAMPLE_RATE_HZ {
        return Ok(samples.to_vec());
    }
    let output_len = ((samples.len() as u64)
        .saturating_mul(u64::from(IOS_RUNTIME_SAMPLE_RATE_HZ))
        .saturating_add(u64::from(source_rate_hz).saturating_sub(1))
        / u64::from(source_rate_hz)) as usize;
    if output_len == 0 {
        return Err(VoiceCoreError::EmptyFrame);
    }
    let last = samples.len().saturating_sub(1);
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source_position =
            (index as f64 * f64::from(source_rate_hz)) / f64::from(IOS_RUNTIME_SAMPLE_RATE_HZ);
        let left = (source_position.floor() as usize).min(last);
        let right = (left.saturating_add(1)).min(last);
        let fraction = (source_position - left as f64) as f32;
        output.push(samples[left] + (samples[right] - samples[left]) * fraction);
    }
    Ok(output)
}

const DEFAULT_OUTPUT_CAPACITY_CHUNKS: usize = 16;
const MAX_OUTPUT_CAPACITY_CHUNKS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuroraIosAudioPlaybackChunk {
    pub samples: Vec<i16>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub sequence: u64,
    pub final_chunk: bool,
}

#[derive(Debug, Default)]
struct OutputInner {
    queue: VecDeque<AuroraIosAudioPlaybackChunk>,
    active_generation: Option<Generation>,
    final_sequence: Option<u64>,
    last_drained: Option<(u64, bool)>,
    completed_generation: Option<Generation>,
    closed: bool,
}

/// Bounded TTS handoff for a future AVAudioEngine/AVAudioPlayer host.
#[derive(Debug, Clone)]
pub struct AuroraIosAudioOutput {
    capacity_chunks: usize,
    inner: Arc<Mutex<OutputInner>>,
}

impl AuroraIosAudioOutput {
    pub fn new(capacity_chunks: usize) -> Self {
        Self {
            capacity_chunks: if capacity_chunks == 0 {
                DEFAULT_OUTPUT_CAPACITY_CHUNKS
            } else {
                capacity_chunks.min(MAX_OUTPUT_CAPACITY_CHUNKS)
            },
            inner: Arc::new(Mutex::new(OutputInner::default())),
        }
    }

    pub fn drain_chunk(&self) -> Option<AuroraIosAudioPlaybackChunk> {
        let mut inner = self.inner.lock().ok()?;
        let chunk = inner.queue.pop_front();
        if let Some(chunk) = &chunk {
            inner.last_drained = Some((chunk.sequence, chunk.final_chunk));
        }
        chunk
    }

    pub fn acknowledge_drained(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            let Some((sequence, final_chunk)) = inner.last_drained.take() else {
                return;
            };
            if final_chunk && inner.final_sequence == Some(sequence) {
                inner.completed_generation = inner.active_generation;
                inner.active_generation = None;
                inner.final_sequence = None;
            }
        }
    }

    pub fn queued_chunks(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.queue.len())
    }

    pub fn close(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.queue.clear();
            inner.active_generation = None;
            inner.final_sequence = None;
            inner.last_drained = None;
            inner.completed_generation = None;
            inner.closed = true;
        }
    }
}

#[async_trait(?Send)]
impl AudioOutput for AuroraIosAudioOutput {
    async fn play(
        &mut self,
        context: AudioPlaybackContext,
        audio: TtsSynthesisResult,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<AudioPlaybackReceipt, VoiceCoreError> {
        let (final_sequence, sample_count) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| VoiceCoreError::LockPoisoned)?;
            if inner.closed {
                return Err(VoiceCoreError::BufferClosed);
            }
            if inner.active_generation.is_some() {
                return Err(VoiceCoreError::OwnerAlreadyActive);
            }
            if audio.chunks().len() > self.capacity_chunks {
                return Err(VoiceCoreError::Backpressure);
            }
            if cancellation() {
                return Err(VoiceCoreError::Cancelled);
            }
            inner.queue.clear();
            inner.active_generation = Some(context.generation);
            inner.completed_generation = None;
            inner.last_drained = None;
            inner.final_sequence = None;
            let mut sample_count = 0_u64;
            for chunk in audio.chunks() {
                if cancellation() || chunk.channels() != 1 || chunk.samples().is_empty() {
                    inner.queue.clear();
                    inner.active_generation = None;
                    return Err(if cancellation() {
                        VoiceCoreError::Cancelled
                    } else {
                        VoiceCoreError::Engine(aurora_voice_core::EngineError::InvalidRequest)
                    });
                }
                sample_count = sample_count.saturating_add(chunk.samples().len() as u64);
                inner.queue.push_back(AuroraIosAudioPlaybackChunk {
                    samples: chunk.samples().to_vec(),
                    sample_rate_hz: chunk.sample_rate_hz(),
                    channels: chunk.channels(),
                    sequence: chunk.sequence(),
                    final_chunk: chunk.final_chunk(),
                });
            }
            inner.final_sequence = inner.queue.back().map(|chunk| chunk.sequence);
            (inner.final_sequence, sample_count)
        };
        loop {
            if cancellation() {
                self.stop(context.generation, TransitionReason::Cancel)
                    .await?;
                return Err(VoiceCoreError::Cancelled);
            }
            let (completed, closed) = {
                let inner = self
                    .inner
                    .lock()
                    .map_err(|_| VoiceCoreError::LockPoisoned)?;
                (
                    inner.completed_generation == Some(context.generation),
                    inner.closed,
                )
            };
            if completed {
                return Ok(AudioPlaybackReceipt::new(
                    context,
                    audio.chunk_count(),
                    sample_count,
                    TimestampMicros(
                        context
                            .started_at
                            .0
                            .saturating_add(sample_count.saturating_mul(1_000_000) / 16_000),
                    ),
                ));
            }
            if closed || final_sequence.is_none() {
                return Err(VoiceCoreError::BufferClosed);
            }
            sleep(Duration::from_millis(5)).await;
        }
    }

    async fn stop(
        &mut self,
        generation: Generation,
        _reason: TransitionReason,
    ) -> Result<(), VoiceCoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCoreError::LockPoisoned)?;
        if inner.active_generation == Some(generation) {
            inner.queue.clear();
            inner.active_generation = None;
            inner.final_sequence = None;
            inner.last_drained = None;
            inner.completed_generation = None;
        }
        Ok(())
    }
}

#[no_mangle]
pub extern "C" fn aurora_ios_audio_state_new(
    capacity_chunks: usize,
    max_chunk_samples: usize,
) -> *mut AuroraIosAudioState {
    Box::into_raw(Box::new(AuroraIosAudioState::new(
        capacity_chunks,
        max_chunk_samples,
    )))
}

/// # Safety
/// `state` must be null or a pointer returned by `aurora_ios_audio_state_new`
/// that has not already been freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_free(state: *mut AuroraIosAudioState) {
    if !state.is_null() {
        // SAFETY: caller owns the allocation returned by `state_new`.
        unsafe { drop(Box::from_raw(state)) };
    }
}

/// # Safety
/// `state` and `samples` must be valid for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_push_pcm_f32(
    state: *mut AuroraIosAudioState,
    samples: *const f32,
    sample_count: usize,
    sequence: u64,
    sample_rate_hz: u32,
) -> i32 {
    if state.is_null() || samples.is_null() || sample_count == 0 || sample_rate_hz == 0 {
        return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
    }
    // SAFETY: validated non-null pointers and caller-provided element count.
    let state = unsafe { &*state };
    if sample_count > state.max_chunk_samples || sample_count > MAX_CHUNK_SAMPLES {
        return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
    }
    // SAFETY: the caller guarantees `samples` points to `sample_count` values.
    let samples = unsafe { std::slice::from_raw_parts(samples, sample_count) };
    state.push_pcm(samples, sequence, sample_rate_hz)
}

/// # Safety
/// `state` must be null or a valid state pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_drain_one(
    state: *mut AuroraIosAudioState,
) -> usize {
    if state.is_null() {
        return 0;
    }
    // SAFETY: non-null state pointer is valid for this call by contract.
    unsafe { &*state }.drain_one()
}

/// # Safety
/// `state` must be null or a valid state pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_reset(state: *mut AuroraIosAudioState) -> i32 {
    if state.is_null() {
        return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
    }
    // SAFETY: non-null state pointer is valid for this call by contract.
    unsafe { &*state }.reset()
}

/// # Safety
/// `state` must be null or a valid state pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_close(state: *mut AuroraIosAudioState) {
    if !state.is_null() {
        // SAFETY: non-null state pointer is valid for this call by contract.
        unsafe { &*state }.close();
    }
}

/// # Safety
/// `state` and `out_stats` must be valid pointers for this call.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_stats(
    state: *mut AuroraIosAudioState,
    out_stats: *mut AuroraIosAudioStats,
) -> i32 {
    if state.is_null() || out_stats.is_null() {
        return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
    }
    // SAFETY: both pointers are non-null and caller-owned output is writable.
    unsafe { *out_stats = (&*state).stats() };
    AURORA_IOS_AUDIO_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_queue_tracks_backpressure_and_discontinuity() {
        let state = AuroraIosAudioState::new(1, 4);
        assert_eq!(state.push_pcm(&[0.0, 1.0], 1, 16_000), AURORA_IOS_AUDIO_OK);
        assert_eq!(
            state.push_pcm(&[0.0], 2, 16_000),
            AURORA_IOS_AUDIO_BACKPRESSURE
        );
        assert_eq!(state.drain_one(), 2);
        assert_eq!(state.push_pcm(&[0.0], 4, 16_000), AURORA_IOS_AUDIO_OK);
        let stats = state.stats();
        assert_eq!(stats.dropped_chunks, 1);
        assert_eq!(stats.discontinuities, 1);
    }

    #[test]
    fn invalid_and_closed_inputs_fail_closed() {
        let state = AuroraIosAudioState::new(2, 2);
        assert_eq!(
            state.push_pcm(&[f32::NAN], 1, 16_000),
            AURORA_IOS_AUDIO_INVALID_ARGUMENT
        );
        state.close();
        assert_eq!(state.push_pcm(&[0.0], 1, 16_000), AURORA_IOS_AUDIO_CLOSED);
        assert_eq!(state.reset(), AURORA_IOS_AUDIO_CLOSED);
    }

    #[test]
    fn resampling_normalizes_non_16khz_capture() {
        let output = resample_to_runtime_rate(&[0.0, 1.0, 0.0], 8_000).expect("resample");
        assert_eq!(output.len(), 6);
        assert!((output[1] - 0.5).abs() < 0.001);
        assert!((output[2] - 1.0).abs() < 0.001);
    }

    #[tokio::test]
    async fn audio_input_drains_frames_with_generation_and_discontinuity() {
        let state = AuroraIosAudioState::new(4, 8);
        let mut input = AuroraIosAudioInput::new(state);
        let lease = VoiceCaptureLease {
            owner: CaptureOwnerKind::Native,
            surface: "ios".to_owned(),
            device_route: "default".to_owned(),
            start_reason: aurora_voice_core::CaptureStartReason::PushToTalk,
            generation: Generation(7),
            created_at: TimestampMicros(100),
            route_revision: RouteRevision(2),
            background_eligible: false,
            consent_revision: 1,
            heartbeat_at: TimestampMicros(100),
            stop_deadline: None,
        };
        input.start(lease).await.expect("start");
        assert_eq!(
            input.state.push_pcm(&[0.0, 0.5], 4, 16_000),
            AURORA_IOS_AUDIO_OK
        );
        let frame = input.next_frame().await.expect("frame").expect("frame");
        assert_eq!(frame.generation(), Generation(7));
        assert_eq!(frame.route_revision(), RouteRevision(2));
        assert_eq!(frame.sequence(), 0);
        assert!(!frame.discontinuity());
        assert_eq!(frame.samples(), &[0.0, 0.5]);
        input.control().finish(Generation(7));
        assert!(input.next_frame().await.expect("finish").is_none());
    }

    fn playback_audio() -> TtsSynthesisResult {
        let route =
            aurora_voice_core::RouteTtsBinding::new("gateway", "voice", 16_000, 1).expect("route");
        let request = aurora_voice_core::BoundTtsSynthesisRequest::new_route(
            aurora_voice_core::RouteTtsSynthesisRequest::new(route, None, 2).expect("request"),
            "hello",
            aurora_voice_core::TtsSynthesisConfig::new("default", "voice", 16_000, 64, None)
                .expect("config"),
        )
        .expect("bound request");
        let chunk =
            aurora_voice_engine::TtsAudioChunk::new(&request, 1, 16_000, 1, vec![1, -1], true)
                .expect("chunk");
        TtsSynthesisResult::new(&request, vec![chunk], false).expect("result")
    }

    #[tokio::test]
    async fn audio_output_waits_for_host_acknowledgement() {
        let mut output = AuroraIosAudioOutput::new(1);
        let host = output.clone();
        let context = AudioPlaybackContext {
            generation: Generation(3),
            route_revision: RouteRevision(1),
            started_at: TimestampMicros(100),
        };
        let mut play = Box::pin(output.play(context, playback_audio(), &|| false));
        tokio::select! {
            result = &mut play => panic!("play completed before host acknowledgement: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        assert_eq!(host.drain_chunk().expect("chunk").samples, vec![1, -1]);
        host.acknowledge_drained();
        assert_eq!(play.await.expect("play").sample_count, 2);
    }
}
