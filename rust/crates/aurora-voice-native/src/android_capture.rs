//! Android-native PCM ingress shared by the Kotlin capture adapter and Rust runtime.

use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use aurora_voice_core::{
    AudioInput, Generation, PcmFrame, RouteRevision, TimestampMicros, TransitionReason,
    VoiceCaptureLease, VoiceCoreError,
};
use tokio::time::{sleep, Duration};

const DEFAULT_CAPACITY_CHUNKS: usize = 8;
const MAX_CAPACITY_CHUNKS: usize = 64;
const DEFAULT_MAX_CHUNK_SAMPLES: usize = 4096;
const MAX_CHUNK_SAMPLES: usize = 96_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndroidPcmPushResult {
    Accepted,
    Backpressure,
    Closed,
    InvalidArgument,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AndroidPcmIngressStats {
    pub accepted_chunks: u64,
    pub accepted_samples: u64,
    pub dropped_chunks: u64,
    pub discontinuities: u64,
    pub queued_chunks: u32,
    pub closed: bool,
}

#[derive(Debug)]
struct PcmChunk {
    samples: Vec<i16>,
    sequence: u64,
}

/// One bounded PCM chunk drained from the Android capture ingress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidPcmChunk {
    pub samples: Vec<i16>,
    pub sequence: u64,
}

#[derive(Debug)]
struct Inner {
    queue: VecDeque<PcmChunk>,
    stats: AndroidPcmIngressStats,
    last_sequence: Option<u64>,
}

/// Bounded, generation-agnostic PCM ingress for Android's native capture thread.
///
/// The queue owns only short PCM chunks and redacted counters. It deliberately has
/// no logging, transport, credential, or model responsibilities; those remain in
/// the shared voice runtime and typed native transport layers.
#[derive(Debug, Clone)]
pub struct AndroidPcmIngress {
    capacity_chunks: usize,
    max_chunk_samples: usize,
    inner: Arc<Mutex<Inner>>,
}

impl AndroidPcmIngress {
    pub fn new(capacity_chunks: usize, max_chunk_samples: usize) -> Self {
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
                stats: AndroidPcmIngressStats::default(),
                last_sequence: None,
            })),
        }
    }

    pub fn push(&self, samples: &[i16], sequence: u64) -> AndroidPcmPushResult {
        if samples.is_empty() || samples.len() > self.max_chunk_samples {
            return AndroidPcmPushResult::InvalidArgument;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return AndroidPcmPushResult::Closed;
        };
        if inner.stats.closed {
            return AndroidPcmPushResult::Closed;
        }
        if inner.queue.len() >= self.capacity_chunks {
            inner.stats.dropped_chunks = inner.stats.dropped_chunks.saturating_add(1);
            return AndroidPcmPushResult::Backpressure;
        }
        if let Some(last_sequence) = inner.last_sequence {
            if sequence != last_sequence.saturating_add(1) {
                inner.stats.discontinuities = inner.stats.discontinuities.saturating_add(1);
            }
        }
        inner.last_sequence = Some(sequence);
        inner.stats.accepted_chunks = inner.stats.accepted_chunks.saturating_add(1);
        inner.stats.accepted_samples = inner
            .stats
            .accepted_samples
            .saturating_add(samples.len() as u64);
        inner.queue.push_back(PcmChunk {
            samples: samples.to_vec(),
            sequence,
        });
        inner.stats.queued_chunks = inner.queue.len() as u32;
        AndroidPcmPushResult::Accepted
    }

    /// Accept the newest microphone chunk while keeping the ingress bounded.
    ///
    /// When the queue is full, the oldest pending chunk is discarded atomically
    /// under the ingress lock. The runtime can then observe the sequence gap and
    /// reset streaming inference without retaining stale microphone audio.
    pub fn push_latest(&self, samples: &[i16], sequence: u64) -> AndroidPcmPushResult {
        if samples.is_empty() || samples.len() > self.max_chunk_samples {
            return AndroidPcmPushResult::InvalidArgument;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return AndroidPcmPushResult::Closed;
        };
        if inner.stats.closed {
            return AndroidPcmPushResult::Closed;
        }
        if inner.queue.len() >= self.capacity_chunks {
            inner.queue.pop_front();
            inner.stats.dropped_chunks = inner.stats.dropped_chunks.saturating_add(1);
            inner.stats.discontinuities = inner.stats.discontinuities.saturating_add(1);
        }
        if let Some(last_sequence) = inner.last_sequence {
            if sequence != last_sequence.saturating_add(1) {
                inner.stats.discontinuities = inner.stats.discontinuities.saturating_add(1);
            }
        }
        inner.last_sequence = Some(sequence);
        inner.stats.accepted_chunks = inner.stats.accepted_chunks.saturating_add(1);
        inner.stats.accepted_samples = inner
            .stats
            .accepted_samples
            .saturating_add(samples.len() as u64);
        inner.queue.push_back(PcmChunk {
            samples: samples.to_vec(),
            sequence,
        });
        inner.stats.queued_chunks = inner.queue.len() as u32;
        AndroidPcmPushResult::Accepted
    }

    pub fn drain_one(&self) -> usize {
        self.drain_chunk().map_or(0, |chunk| chunk.samples.len())
    }

    /// Discard pending microphone audio before a new runtime generation starts.
    ///
    /// Lifetime counters remain intact for diagnostics, while sequence tracking is
    /// reset so the first chunk of the new generation is not reported as a gap.
    pub fn clear_pending(&self) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.stats.closed {
            return false;
        }
        inner.queue.clear();
        inner.last_sequence = None;
        inner.stats.queued_chunks = 0;
        true
    }

    /// Drain one owned PCM chunk for the native voice runtime.
    pub fn drain_chunk(&self) -> Option<AndroidPcmChunk> {
        let Ok(mut inner) = self.inner.lock() else {
            return None;
        };
        let drained = inner.queue.pop_front().map(|chunk| AndroidPcmChunk {
            samples: chunk.samples,
            sequence: chunk.sequence,
        });
        inner.stats.queued_chunks = inner.queue.len() as u32;
        drained
    }

    pub fn close(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.queue.clear();
            inner.stats.queued_chunks = 0;
            inner.stats.closed = true;
        }
    }

    pub fn stats(&self) -> AndroidPcmIngressStats {
        let Ok(mut inner) = self.inner.lock() else {
            return AndroidPcmIngressStats {
                closed: true,
                ..AndroidPcmIngressStats::default()
            };
        };
        inner.stats.queued_chunks = inner.queue.len() as u32;
        inner.stats
    }
}

const ANDROID_FRAME_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Audio-input adapter that turns bounded Android PCM ingress into runtime frames.
///
/// The Android service owns microphone capture and pushes PCM into the ingress. This
/// adapter is the only shared-runtime consumer; it tags every frame with the active
/// generation and route revision and stops on an explicit finish or interruption.
#[derive(Debug, Clone)]
pub struct AndroidAudioInput {
    ingress: AndroidPcmIngress,
    control: AndroidCaptureControl,
    active_generation: Option<Generation>,
    route_revision: RouteRevision,
    started_at: TimestampMicros,
    next_sequence: u64,
    expected_ingress_sequence: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct AndroidCaptureControl {
    finished: Arc<AtomicBool>,
    interrupted: Arc<AtomicBool>,
    active_generation: Arc<Mutex<Option<Generation>>>,
}

impl AndroidCaptureControl {
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

impl AndroidAudioInput {
    pub fn new(ingress: AndroidPcmIngress) -> Self {
        Self {
            ingress,
            control: AndroidCaptureControl::default(),
            active_generation: None,
            route_revision: RouteRevision(0),
            started_at: TimestampMicros(0),
            next_sequence: 0,
            expected_ingress_sequence: None,
        }
    }

    pub fn control(&self) -> AndroidCaptureControl {
        self.control.clone()
    }

    fn clear_pending_chunks(&self) {
        while self.ingress.drain_chunk().is_some() {}
    }
}

#[async_trait(?Send)]
impl AudioInput for AndroidAudioInput {
    async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
        if self.active_generation.is_some() {
            return Err(VoiceCoreError::OwnerAlreadyActive);
        }
        if lease.owner != aurora_voice_core::CaptureOwnerKind::Native {
            return Err(VoiceCoreError::OwnerMismatch);
        }
        self.clear_pending_chunks();
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
            if let Some(chunk) = self.ingress.drain_chunk() {
                let discontinuity = self
                    .expected_ingress_sequence
                    .is_some_and(|expected| expected != chunk.sequence);
                self.expected_ingress_sequence = Some(chunk.sequence.saturating_add(1));
                let samples = chunk
                    .samples
                    .into_iter()
                    .map(|sample| f32::from(sample) / 32_768.0)
                    .collect::<Vec<_>>();
                let timestamp = TimestampMicros(
                    self.started_at
                        .0
                        .saturating_add(self.next_sequence.saturating_mul(1_000_000) / 16_000),
                );
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
            if self.control.finished.load(Ordering::SeqCst) || self.ingress.stats().closed {
                return Ok(None);
            }
            sleep(ANDROID_FRAME_POLL_INTERVAL).await;
        }
    }

    fn current_route_revision(&self) -> RouteRevision {
        self.route_revision
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_queue_rejects_without_growth() {
        let ingress = AndroidPcmIngress::new(1, 4);
        assert_eq!(ingress.push(&[1, 2], 0), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.push(&[3, 4], 1), AndroidPcmPushResult::Backpressure);
        assert_eq!(ingress.stats().dropped_chunks, 1);
        assert_eq!(ingress.drain_one(), 2);
    }

    #[test]
    fn latest_biased_queue_drops_oldest_and_accepts_newest() {
        let ingress = AndroidPcmIngress::new(2, 4);
        assert_eq!(ingress.push_latest(&[1], 0), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.push_latest(&[2], 1), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.push_latest(&[3], 2), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.stats().dropped_chunks, 1);
        assert_eq!(ingress.stats().discontinuities, 1);
        assert_eq!(ingress.drain_chunk().map(|chunk| chunk.sequence), Some(1));
        assert_eq!(ingress.drain_chunk().map(|chunk| chunk.sequence), Some(2));
        assert!(ingress.drain_chunk().is_none());
    }

    #[test]
    fn sequence_gaps_are_redacted_as_discontinuities() {
        let ingress = AndroidPcmIngress::new(4, 4);
        assert_eq!(ingress.push(&[1], 0), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.push(&[2], 2), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.stats().discontinuities, 1);
    }

    #[test]
    fn close_rejects_future_pcm() {
        let ingress = AndroidPcmIngress::new(4, 4);
        ingress.close();
        assert_eq!(ingress.push(&[1], 0), AndroidPcmPushResult::Closed);
        assert!(ingress.stats().closed);
    }

    #[test]
    fn drain_chunk_preserves_sequence_and_samples() {
        let ingress = AndroidPcmIngress::new(2, 4);
        assert_eq!(ingress.push(&[1, -2, 3], 7), AndroidPcmPushResult::Accepted);
        assert_eq!(
            ingress.drain_chunk(),
            Some(AndroidPcmChunk {
                samples: vec![1, -2, 3],
                sequence: 7,
            })
        );
        assert!(ingress.drain_chunk().is_none());
    }

    #[test]
    fn clear_pending_discards_stale_audio_and_resets_sequence_tracking() {
        let ingress = AndroidPcmIngress::new(2, 4);
        assert_eq!(
            ingress.push_latest(&[1], 10),
            AndroidPcmPushResult::Accepted
        );
        assert_eq!(
            ingress.push_latest(&[2], 11),
            AndroidPcmPushResult::Accepted
        );

        assert!(ingress.clear_pending());
        let cleared = ingress.stats();
        assert_eq!(cleared.queued_chunks, 0);
        assert_eq!(cleared.accepted_chunks, 2);
        assert_eq!(cleared.discontinuities, 0);

        assert_eq!(
            ingress.push_latest(&[3], 42),
            AndroidPcmPushResult::Accepted
        );
        assert_eq!(ingress.stats().discontinuities, 0);
        assert_eq!(ingress.drain_chunk().map(|chunk| chunk.sequence), Some(42));
    }

    #[tokio::test]
    async fn android_audio_input_tags_frames_and_honors_finish() {
        let ingress = AndroidPcmIngress::new(2, 4);
        let mut input = AndroidAudioInput::new(ingress.clone());
        let lease = VoiceCaptureLease {
            owner: aurora_voice_core::CaptureOwnerKind::Native,
            surface: "android".to_owned(),
            device_route: "default".to_owned(),
            start_reason: aurora_voice_core::CaptureStartReason::PushToTalk,
            generation: Generation(9),
            created_at: TimestampMicros(100),
            route_revision: RouteRevision(3),
            background_eligible: false,
            consent_revision: 0,
            heartbeat_at: TimestampMicros(100),
            stop_deadline: None,
        };
        input.start(lease).await.expect("start input");
        ingress.push(&[16_384, -16_384], 4);
        let frame = input
            .next_frame()
            .await
            .expect("next frame")
            .expect("frame");
        assert_eq!(frame.generation(), Generation(9));
        assert_eq!(frame.route_revision(), RouteRevision(3));
        assert_eq!(frame.samples(), &[0.5, -0.5]);
        input.control().finish(Generation(9));
        assert!(input.next_frame().await.expect("finish frame").is_none());
    }

    #[tokio::test]
    async fn latest_biased_input_marks_one_discontinuity_then_recovers() {
        let ingress = AndroidPcmIngress::new(2, 4);
        let mut input = AndroidAudioInput::new(ingress.clone());
        let lease = VoiceCaptureLease {
            owner: aurora_voice_core::CaptureOwnerKind::Native,
            surface: "android".to_owned(),
            device_route: "default".to_owned(),
            start_reason: aurora_voice_core::CaptureStartReason::BackgroundSession,
            generation: Generation(10),
            created_at: TimestampMicros(200),
            route_revision: RouteRevision(4),
            background_eligible: true,
            consent_revision: 0,
            heartbeat_at: TimestampMicros(200),
            stop_deadline: None,
        };
        input.start(lease).await.expect("start input");

        assert_eq!(ingress.push_latest(&[1], 0), AndroidPcmPushResult::Accepted);
        assert!(!input
            .next_frame()
            .await
            .expect("first frame")
            .expect("first samples")
            .discontinuity());
        assert_eq!(ingress.push_latest(&[2], 1), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.push_latest(&[3], 2), AndroidPcmPushResult::Accepted);
        assert_eq!(ingress.push_latest(&[4], 3), AndroidPcmPushResult::Accepted);

        assert!(input
            .next_frame()
            .await
            .expect("discontinuous frame")
            .expect("discontinuous samples")
            .discontinuity());
        assert!(!input
            .next_frame()
            .await
            .expect("recovered frame")
            .expect("recovered samples")
            .discontinuity());
        assert_eq!(ingress.stats().dropped_chunks, 1);
        assert_eq!(ingress.stats().discontinuities, 1);
    }
}
