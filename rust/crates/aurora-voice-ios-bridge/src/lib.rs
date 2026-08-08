//! Narrow Rust-owned PCM boundary for the iOS foreground audio host.
//!
//! Swift owns AVAudioSession/AVAudioEngine lifecycle. Rust owns bounded
//! buffering, validation, sequence accounting, and shutdown semantics. This
//! crate intentionally does not claim a complete iOS assistant turn.

use std::collections::VecDeque;
use std::sync::Mutex;

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

#[derive(Debug)]
struct Inner {
    queue: VecDeque<PcmChunk>,
    stats: AuroraIosAudioStats,
    last_sequence: Option<u64>,
}

pub struct AuroraIosAudioState {
    capacity_chunks: usize,
    max_chunk_samples: usize,
    inner: Mutex<Inner>,
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
            inner: Mutex::new(Inner {
                queue: VecDeque::with_capacity(capacity_chunks),
                stats: AuroraIosAudioStats::default(),
                last_sequence: None,
            }),
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

    fn drain_one(&self) -> usize {
        let mut inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        inner
            .queue
            .pop_front()
            .map(|chunk| {
                let _ = (chunk.sequence, chunk.sample_rate_hz);
                chunk.samples.len()
            })
            .unwrap_or(0)
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
}
