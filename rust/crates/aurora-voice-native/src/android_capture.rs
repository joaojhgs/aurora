//! Android-native PCM ingress shared by the Kotlin capture adapter and Rust runtime.

use std::collections::VecDeque;
use std::sync::Mutex;

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
#[derive(Debug)]
pub struct AndroidPcmIngress {
    capacity_chunks: usize,
    max_chunk_samples: usize,
    inner: Mutex<Inner>,
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
            inner: Mutex::new(Inner {
                queue: VecDeque::with_capacity(capacity_chunks),
                stats: AndroidPcmIngressStats::default(),
                last_sequence: None,
            }),
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

    pub fn drain_one(&self) -> usize {
        let Ok(mut inner) = self.inner.lock() else {
            return 0;
        };
        let drained = inner
            .queue
            .pop_front()
            .map(|chunk| {
                let _sequence = chunk.sequence;
                chunk.samples.len()
            })
            .unwrap_or(0);
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
}
