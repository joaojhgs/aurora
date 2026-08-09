//! Android-native TTS playback handoff shared by the Rust runtime and Kotlin AudioTrack host.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use aurora_voice_core::{
    AudioOutput, AudioPlaybackContext, AudioPlaybackReceipt, Generation, TimestampMicros,
    TransitionReason, VoiceCoreError,
};
use aurora_voice_engine::TtsSynthesisResult;
use tokio::time::{sleep, Duration};

const DEFAULT_CAPACITY_CHUNKS: usize = 16;
const MAX_CAPACITY_CHUNKS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidPcmPlaybackChunk {
    pub samples: Vec<i16>,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub sequence: u64,
    pub final_chunk: bool,
}

#[derive(Debug, Default)]
struct Inner {
    queue: VecDeque<AndroidPcmPlaybackChunk>,
    active_generation: Option<Generation>,
    final_sequence: Option<u64>,
    last_drained: Option<(u64, bool)>,
    completed_generation: Option<Generation>,
    closed: bool,
}

/// Bounded TTS playback handoff. Kotlin drains chunks and owns AudioTrack.
#[derive(Debug, Clone)]
pub struct AndroidAudioOutput {
    capacity_chunks: usize,
    inner: Arc<Mutex<Inner>>,
}

impl AndroidAudioOutput {
    pub fn new(capacity_chunks: usize) -> Self {
        Self {
            capacity_chunks: if capacity_chunks == 0 {
                DEFAULT_CAPACITY_CHUNKS
            } else {
                capacity_chunks.min(MAX_CAPACITY_CHUNKS)
            },
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }

    pub fn drain_chunk(&self) -> Option<AndroidPcmPlaybackChunk> {
        let mut inner = self.inner.lock().ok()?;
        let chunk = inner.queue.pop_front();
        if let Some(chunk) = &chunk {
            inner.last_drained = Some((chunk.sequence, chunk.final_chunk));
        }
        chunk
    }

    /// Acknowledge that the most recently drained chunk reached AudioTrack.
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

impl Default for AndroidAudioOutput {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY_CHUNKS)
    }
}

#[async_trait(?Send)]
impl AudioOutput for AndroidAudioOutput {
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
                if cancellation() {
                    inner.queue.clear();
                    inner.active_generation = None;
                    return Err(VoiceCoreError::Cancelled);
                }
                if chunk.channels() != 1 || chunk.samples().is_empty() {
                    inner.queue.clear();
                    inner.active_generation = None;
                    return Err(VoiceCoreError::Engine(
                        aurora_voice_core::EngineError::InvalidRequest,
                    ));
                }
                sample_count = sample_count.saturating_add(chunk.samples().len() as u64);
                inner.queue.push_back(AndroidPcmPlaybackChunk {
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
                break;
            }
            if closed || final_sequence.is_none() {
                return Err(VoiceCoreError::BufferClosed);
            }
            sleep(Duration::from_millis(5)).await;
        }
        Ok(AudioPlaybackReceipt::new(
            context,
            audio.chunk_count(),
            sample_count,
            TimestampMicros(
                context
                    .started_at
                    .0
                    .saturating_add(sample_count.saturating_mul(1_000_000) / 16_000),
            ),
        ))
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

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_core::{
        BoundTtsSynthesisRequest, RouteRevision, RouteTtsBinding, RouteTtsSynthesisRequest,
        TtsSynthesisConfig,
    };
    use aurora_voice_engine::TtsAudioChunk;

    fn audio() -> TtsSynthesisResult {
        let route = RouteTtsBinding::new("gateway", "voice-group", 16_000, 1).expect("route");
        let request = BoundTtsSynthesisRequest::new_route(
            RouteTtsSynthesisRequest::new(route, None, 2).expect("request"),
            "hello",
            TtsSynthesisConfig::new("default", "voice-group", 16_000, 256, None).expect("config"),
        )
        .expect("bound request");
        let chunk = TtsAudioChunk::new(&request, 1, 16_000, 1, vec![1, -1], true).expect("chunk");
        TtsSynthesisResult::new(&request, vec![chunk], false).expect("result")
    }

    #[tokio::test]
    async fn playback_handoff_is_bounded_and_preserves_chunk_metadata() {
        let mut output = AndroidAudioOutput::new(1);
        let drain = output.clone();
        let context = AudioPlaybackContext {
            generation: Generation(2),
            route_revision: RouteRevision(1),
            started_at: TimestampMicros(100),
        };
        let mut play = Box::pin(output.play(context, audio(), &|| false));
        tokio::select! {
            result = &mut play => panic!("play completed before AudioTrack acknowledgement: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        assert_eq!(drain.drain_chunk().expect("chunk").samples, vec![1, -1]);
        drain.acknowledge_drained();
        let receipt = play.await.expect("play");
        assert_eq!(receipt.sample_count, 2);
    }

    #[tokio::test]
    async fn playback_cancellation_does_not_leave_audio_queued() {
        let mut output = AndroidAudioOutput::new(1);
        let context = AudioPlaybackContext {
            generation: Generation(2),
            route_revision: RouteRevision(1),
            started_at: TimestampMicros(100),
        };
        let error = output
            .play(context, audio(), &|| true)
            .await
            .expect_err("cancel");
        assert_eq!(error, VoiceCoreError::Cancelled);
        assert!(output.drain_chunk().is_none());
    }
}
