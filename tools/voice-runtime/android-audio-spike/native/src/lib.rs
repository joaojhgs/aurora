use std::collections::VecDeque;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const DEFAULT_MAX_CHUNK_SAMPLES: usize = 48_000;
const DEFAULT_CAPACITY_CHUNKS: usize = 8;
const MAX_CAPACITY_CHUNKS: usize = 64;
const MAX_CHUNK_SAMPLES: usize = 96_000;

pub const AURORA_AUDIO_OK: i32 = 0;
pub const AURORA_AUDIO_BACKPRESSURE: i32 = 1;
pub const AURORA_AUDIO_CLOSED: i32 = 2;
pub const AURORA_AUDIO_INVALID_ARGUMENT: i32 = -1;

#[repr(C)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AuroraAudioStats {
    pub accepted_chunks: u64,
    pub accepted_samples: u64,
    pub dropped_chunks: u64,
    pub discontinuities: u64,
    pub queued_chunks: u32,
    pub closed: u32,
}

#[derive(Debug)]
struct PcmChunk {
    samples: Vec<i16>,
    sequence: u64,
}

#[derive(Debug)]
struct Inner {
    queue: VecDeque<PcmChunk>,
    accepted_chunks: u64,
    accepted_samples: u64,
    dropped_chunks: u64,
    discontinuities: u64,
    last_sequence: Option<u64>,
    closed: bool,
}

pub struct AuroraAudioState {
    capacity_chunks: usize,
    max_chunk_samples: usize,
    inner: Mutex<Inner>,
    callback_count: AtomicU64,
}

impl AuroraAudioState {
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
                accepted_chunks: 0,
                accepted_samples: 0,
                dropped_chunks: 0,
                discontinuities: 0,
                last_sequence: None,
                closed: false,
            }),
            callback_count: AtomicU64::new(0),
        }
    }

    fn push_pcm(&self, samples: &[i16], sequence: u64) -> i32 {
        self.callback_count.fetch_add(1, Ordering::Relaxed);

        if samples.is_empty() || samples.len() > self.max_chunk_samples {
            return AURORA_AUDIO_INVALID_ARGUMENT;
        }

        let mut inner = self.inner.lock().expect("audio state mutex poisoned");
        if inner.closed {
            return AURORA_AUDIO_CLOSED;
        }

        if inner.queue.len() >= self.capacity_chunks {
            inner.dropped_chunks += 1;
            return AURORA_AUDIO_BACKPRESSURE;
        }

        if let Some(last_sequence) = inner.last_sequence {
            if sequence != last_sequence.saturating_add(1) {
                inner.discontinuities += 1;
            }
        }
        inner.last_sequence = Some(sequence);
        inner.accepted_chunks += 1;
        inner.accepted_samples += samples.len() as u64;
        inner.queue.push_back(PcmChunk {
            samples: samples.to_vec(),
            sequence,
        });
        AURORA_AUDIO_OK
    }

    fn drain_one(&self) -> usize {
        let mut inner = self.inner.lock().expect("audio state mutex poisoned");
        inner
            .queue
            .pop_front()
            .map(|chunk| {
                let _sequence = chunk.sequence;
                chunk.samples.len()
            })
            .unwrap_or(0)
    }

    fn close(&self) {
        let mut inner = self.inner.lock().expect("audio state mutex poisoned");
        inner.closed = true;
        inner.queue.clear();
    }

    fn reset_stats(&self) {
        let mut inner = self.inner.lock().expect("audio state mutex poisoned");
        if inner.closed {
            return;
        }
        inner.queue.clear();
        inner.accepted_chunks = 0;
        inner.accepted_samples = 0;
        inner.dropped_chunks = 0;
        inner.discontinuities = 0;
        inner.last_sequence = None;
    }

    fn stats(&self) -> AuroraAudioStats {
        let inner = self.inner.lock().expect("audio state mutex poisoned");
        AuroraAudioStats {
            accepted_chunks: inner.accepted_chunks,
            accepted_samples: inner.accepted_samples,
            dropped_chunks: inner.dropped_chunks,
            discontinuities: inner.discontinuities,
            queued_chunks: inner.queue.len() as u32,
            closed: u32::from(inner.closed),
        }
    }
}

#[no_mangle]
pub extern "C" fn aurora_audio_state_new(
    capacity_chunks: usize,
    max_chunk_samples: usize,
) -> *mut AuroraAudioState {
    Box::into_raw(Box::new(AuroraAudioState::new(
        capacity_chunks,
        max_chunk_samples,
    )))
}

/// Frees an audio state allocated by `aurora_audio_state_new`.
///
/// # Safety
///
/// `state` must be either null or a pointer returned by `aurora_audio_state_new`
/// that has not already been freed. After this call the pointer must not be used.
#[no_mangle]
pub unsafe extern "C" fn aurora_audio_state_free(state: *mut AuroraAudioState) {
    if !state.is_null() {
        drop(Box::from_raw(state));
    }
}

/// Pushes one bounded signed 16-bit PCM chunk into the Rust-owned queue.
///
/// # Safety
///
/// `state` must be a valid pointer returned by `aurora_audio_state_new`.
/// `samples` must point to `sample_count` initialized `i16` values and remain
/// valid for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn aurora_audio_state_push_pcm_i16(
    state: *mut AuroraAudioState,
    samples: *const i16,
    sample_count: usize,
    sequence: u64,
) -> i32 {
    if state.is_null() || samples.is_null() {
        return AURORA_AUDIO_INVALID_ARGUMENT;
    }
    let samples = std::slice::from_raw_parts(samples, sample_count);
    (*state).push_pcm(samples, sequence)
}

/// Drains at most one queued PCM chunk and returns the drained sample count.
///
/// # Safety
///
/// `state` must be null or a valid pointer returned by `aurora_audio_state_new`.
#[no_mangle]
pub unsafe extern "C" fn aurora_audio_state_drain_one(state: *mut AuroraAudioState) -> usize {
    if state.is_null() {
        return 0;
    }
    (*state).drain_one()
}

/// Closes the state, clears queued PCM, and rejects future ingestion.
///
/// # Safety
///
/// `state` must be null or a valid pointer returned by `aurora_audio_state_new`.
#[no_mangle]
pub unsafe extern "C" fn aurora_audio_state_close(state: *mut AuroraAudioState) {
    if !state.is_null() {
        (*state).close();
    }
}

/// Clears queued PCM and counters while leaving the state open.
///
/// # Safety
///
/// `state` must be null or a valid pointer returned by `aurora_audio_state_new`.
#[no_mangle]
pub unsafe extern "C" fn aurora_audio_state_reset_stats(state: *mut AuroraAudioState) {
    if !state.is_null() {
        (*state).reset_stats();
    }
}

/// Writes a snapshot of the current counters to `out_stats`.
///
/// # Safety
///
/// `state` must be a valid pointer returned by `aurora_audio_state_new`.
/// `out_stats` must point to writable memory for one `AuroraAudioStats`.
#[no_mangle]
pub unsafe extern "C" fn aurora_audio_state_stats(
    state: *mut AuroraAudioState,
    out_stats: *mut AuroraAudioStats,
) -> i32 {
    if state.is_null() || out_stats.is_null() {
        return AURORA_AUDIO_INVALID_ARGUMENT;
    }
    ptr::write(out_stats, (*state).stats());
    AURORA_AUDIO_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bounded_pcm_chunks() {
        let state = AuroraAudioState::new(2, 4);

        assert_eq!(state.push_pcm(&[1, 2, 3, 4], 0), AURORA_AUDIO_OK);
        assert_eq!(state.push_pcm(&[5, 6], 1), AURORA_AUDIO_OK);

        let stats = state.stats();
        assert_eq!(stats.accepted_chunks, 2);
        assert_eq!(stats.accepted_samples, 6);
        assert_eq!(stats.queued_chunks, 2);
        assert_eq!(stats.dropped_chunks, 0);
    }

    #[test]
    fn returns_backpressure_without_unbounded_growth() {
        let state = AuroraAudioState::new(1, 8);

        assert_eq!(state.push_pcm(&[1, 2], 0), AURORA_AUDIO_OK);
        assert_eq!(state.push_pcm(&[3, 4], 1), AURORA_AUDIO_BACKPRESSURE);

        let stats = state.stats();
        assert_eq!(stats.queued_chunks, 1);
        assert_eq!(stats.dropped_chunks, 1);
        assert_eq!(stats.accepted_chunks, 1);
    }

    #[test]
    fn records_sequence_discontinuity() {
        let state = AuroraAudioState::new(4, 8);

        assert_eq!(state.push_pcm(&[1], 4), AURORA_AUDIO_OK);
        assert_eq!(state.push_pcm(&[2], 6), AURORA_AUDIO_OK);

        assert_eq!(state.stats().discontinuities, 1);
    }

    #[test]
    fn rejects_invalid_chunks() {
        let state = AuroraAudioState::new(4, 2);

        assert_eq!(state.push_pcm(&[], 0), AURORA_AUDIO_INVALID_ARGUMENT);
        assert_eq!(state.push_pcm(&[1, 2, 3], 0), AURORA_AUDIO_INVALID_ARGUMENT);
        assert_eq!(state.stats().accepted_chunks, 0);
    }

    #[test]
    fn close_cancels_future_ingestion_and_clears_queue() {
        let state = AuroraAudioState::new(4, 8);
        assert_eq!(state.push_pcm(&[1, 2], 0), AURORA_AUDIO_OK);

        state.close();

        assert_eq!(state.push_pcm(&[3, 4], 1), AURORA_AUDIO_CLOSED);
        let stats = state.stats();
        assert_eq!(stats.closed, 1);
        assert_eq!(stats.queued_chunks, 0);
    }

    #[test]
    fn reset_stats_separates_synthetic_from_capture_window() {
        let state = AuroraAudioState::new(4, 8);
        assert_eq!(state.push_pcm(&[1, 2], 0), AURORA_AUDIO_OK);
        assert_eq!(state.push_pcm(&[3, 4], 1), AURORA_AUDIO_OK);
        assert_eq!(state.stats().accepted_chunks, 2);

        state.reset_stats();

        let stats = state.stats();
        assert_eq!(stats.accepted_chunks, 0);
        assert_eq!(stats.accepted_samples, 0);
        assert_eq!(stats.queued_chunks, 0);
        assert_eq!(stats.closed, 0);
        assert_eq!(state.push_pcm(&[5, 6], 0), AURORA_AUDIO_OK);
    }

    #[test]
    fn c_abi_roundtrip_is_null_safe() {
        unsafe {
            assert_eq!(
                aurora_audio_state_push_pcm_i16(ptr::null_mut(), ptr::null(), 0, 0),
                AURORA_AUDIO_INVALID_ARGUMENT
            );

            let state = aurora_audio_state_new(2, 4);
            let samples = [7_i16, 8, 9];
            assert_eq!(
                aurora_audio_state_push_pcm_i16(state, samples.as_ptr(), samples.len(), 0),
                AURORA_AUDIO_OK
            );

            let mut stats = AuroraAudioStats::default();
            assert_eq!(aurora_audio_state_stats(state, &mut stats), AURORA_AUDIO_OK);
            assert_eq!(stats.accepted_samples, 3);
            assert_eq!(aurora_audio_state_drain_one(state), 3);
            aurora_audio_state_reset_stats(state);
            assert_eq!(aurora_audio_state_stats(state, &mut stats), AURORA_AUDIO_OK);
            assert_eq!(stats.accepted_chunks, 0);

            aurora_audio_state_close(state);
            assert_eq!(
                aurora_audio_state_push_pcm_i16(state, samples.as_ptr(), samples.len(), 1),
                AURORA_AUDIO_CLOSED
            );
            aurora_audio_state_free(state);
        }
    }
}
