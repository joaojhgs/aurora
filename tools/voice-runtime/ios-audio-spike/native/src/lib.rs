use std::collections::VecDeque;
use std::ptr;
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
    accepted_chunks: u64,
    accepted_samples: u64,
    dropped_chunks: u64,
    discontinuities: u64,
    last_sequence: Option<u64>,
    closed: bool,
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
                accepted_chunks: 0,
                accepted_samples: 0,
                dropped_chunks: 0,
                discontinuities: 0,
                last_sequence: None,
                closed: false,
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
        if inner.closed {
            return AURORA_IOS_AUDIO_CLOSED;
        }
        if inner.queue.len() >= self.capacity_chunks {
            inner.dropped_chunks += 1;
            return AURORA_IOS_AUDIO_BACKPRESSURE;
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
                let _sequence = chunk.sequence;
                let _sample_rate_hz = chunk.sample_rate_hz;
                chunk.samples.len()
            })
            .unwrap_or(0)
    }

    fn close(&self) {
        let mut inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        inner.closed = true;
        inner.queue.clear();
    }

    fn reset(&self) -> i32 {
        let mut inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        if inner.closed {
            return AURORA_IOS_AUDIO_CLOSED;
        }
        inner.queue.clear();
        inner.last_sequence = None;
        AURORA_IOS_AUDIO_OK
    }

    fn stats(&self) -> AuroraIosAudioStats {
        let inner = self.inner.lock().expect("iOS audio state mutex poisoned");
        AuroraIosAudioStats {
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
pub extern "C" fn aurora_ios_audio_state_new(
    capacity_chunks: usize,
    max_chunk_samples: usize,
) -> *mut AuroraIosAudioState {
    Box::into_raw(Box::new(AuroraIosAudioState::new(
        capacity_chunks,
        max_chunk_samples,
    )))
}

/// Frees a state allocated by `aurora_ios_audio_state_new`.
///
/// # Safety
///
/// `state` must be null or a pointer returned by `aurora_ios_audio_state_new`
/// that has not already been freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_free(state: *mut AuroraIosAudioState) {
    if !state.is_null() {
        drop(Box::from_raw(state));
    }
}

/// Pushes one bounded Float32 PCM chunk from an iOS audio callback.
///
/// # Safety
///
/// `state` must be a valid pointer returned by `aurora_ios_audio_state_new`.
/// `samples` must point to `sample_count` initialized `f32` values and remain
/// valid for the duration of the call.
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
    if sample_count > (*state).max_chunk_samples || sample_count > MAX_CHUNK_SAMPLES {
        return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
    }
    let samples = std::slice::from_raw_parts(samples, sample_count);
    (*state).push_pcm(samples, sequence, sample_rate_hz)
}

/// Drains at most one queued chunk and returns its sample count.
///
/// # Safety
///
/// `state` must be null or a valid pointer returned by `aurora_ios_audio_state_new`.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_drain_one(
    state: *mut AuroraIosAudioState,
) -> usize {
    if state.is_null() {
        return 0;
    }
    (*state).drain_one()
}

/// Closes the state, clears queued PCM, and rejects future ingestion.
///
/// # Safety
///
/// `state` must be null or a valid pointer returned by `aurora_ios_audio_state_new`.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_close(state: *mut AuroraIosAudioState) {
    if !state.is_null() {
        (*state).close();
    }
}

/// Clears queued PCM and sequence state so a stopped capture can restart.
///
/// # Safety
///
/// `state` must be null or a valid pointer returned by `aurora_ios_audio_state_new`.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_reset(state: *mut AuroraIosAudioState) -> i32 {
    if state.is_null() {
        return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
    }
    (*state).reset()
}

/// Writes a snapshot of current counters.
///
/// # Safety
///
/// `state` must be a valid pointer returned by `aurora_ios_audio_state_new`.
/// `out_stats` must point to writable memory for one `AuroraIosAudioStats`.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_audio_state_stats(
    state: *mut AuroraIosAudioState,
    out_stats: *mut AuroraIosAudioStats,
) -> i32 {
    if state.is_null() || out_stats.is_null() {
        return AURORA_IOS_AUDIO_INVALID_ARGUMENT;
    }
    ptr::write(out_stats, (*state).stats());
    AURORA_IOS_AUDIO_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bounded_float_pcm() {
        let state = AuroraIosAudioState::new(2, 4);

        assert_eq!(
            state.push_pcm(&[0.0, 0.25, -0.25], 0, 48_000),
            AURORA_IOS_AUDIO_OK
        );
        assert_eq!(state.push_pcm(&[0.5], 1, 48_000), AURORA_IOS_AUDIO_OK);

        let stats = state.stats();
        assert_eq!(stats.accepted_chunks, 2);
        assert_eq!(stats.accepted_samples, 4);
        assert_eq!(stats.queued_chunks, 2);
    }

    #[test]
    fn backpressure_does_not_grow_unbounded() {
        let state = AuroraIosAudioState::new(1, 8);

        assert_eq!(state.push_pcm(&[0.0], 0, 16_000), AURORA_IOS_AUDIO_OK);
        assert_eq!(
            state.push_pcm(&[0.1], 1, 16_000),
            AURORA_IOS_AUDIO_BACKPRESSURE
        );

        let stats = state.stats();
        assert_eq!(stats.queued_chunks, 1);
        assert_eq!(stats.dropped_chunks, 1);
        assert_eq!(stats.accepted_chunks, 1);
    }

    #[test]
    fn close_cancels_future_ingestion_and_clears_queue() {
        let state = AuroraIosAudioState::new(2, 8);
        assert_eq!(state.push_pcm(&[0.0, 0.1], 0, 16_000), AURORA_IOS_AUDIO_OK);

        state.close();

        assert_eq!(state.push_pcm(&[0.2], 1, 16_000), AURORA_IOS_AUDIO_CLOSED);
        let stats = state.stats();
        assert_eq!(stats.closed, 1);
        assert_eq!(stats.queued_chunks, 0);
    }

    #[test]
    fn reset_allows_restart_without_sequence_discontinuity() {
        let state = AuroraIosAudioState::new(2, 8);
        assert_eq!(state.push_pcm(&[0.0], 7, 16_000), AURORA_IOS_AUDIO_OK);

        assert_eq!(state.reset(), AURORA_IOS_AUDIO_OK);
        assert_eq!(state.push_pcm(&[0.1], 0, 16_000), AURORA_IOS_AUDIO_OK);

        let stats = state.stats();
        assert_eq!(stats.discontinuities, 0);
        assert_eq!(stats.accepted_chunks, 2);
        assert_eq!(stats.queued_chunks, 1);
    }

    #[test]
    fn rejects_invalid_samples() {
        let state = AuroraIosAudioState::new(2, 2);

        assert_eq!(
            state.push_pcm(&[], 0, 16_000),
            AURORA_IOS_AUDIO_INVALID_ARGUMENT
        );
        assert_eq!(
            state.push_pcm(&[0.0, 0.1, 0.2], 0, 16_000),
            AURORA_IOS_AUDIO_INVALID_ARGUMENT
        );
        assert_eq!(
            state.push_pcm(&[f32::NAN], 0, 16_000),
            AURORA_IOS_AUDIO_INVALID_ARGUMENT
        );
        assert_eq!(
            state.push_pcm(&[0.0], 0, 0),
            AURORA_IOS_AUDIO_INVALID_ARGUMENT
        );
    }

    #[test]
    fn c_abi_is_null_safe_and_reports_stats() {
        unsafe {
            assert_eq!(
                aurora_ios_audio_state_push_pcm_f32(ptr::null_mut(), ptr::null(), 1, 0, 16_000),
                AURORA_IOS_AUDIO_INVALID_ARGUMENT
            );
            assert_eq!(aurora_ios_audio_state_drain_one(ptr::null_mut()), 0);
            aurora_ios_audio_state_close(ptr::null_mut());
            aurora_ios_audio_state_free(ptr::null_mut());

            let state = aurora_ios_audio_state_new(2, 8);
            let samples = [0.0_f32, 0.1, 0.2];
            assert_eq!(
                aurora_ios_audio_state_push_pcm_f32(
                    state,
                    samples.as_ptr(),
                    samples.len(),
                    0,
                    16_000,
                ),
                AURORA_IOS_AUDIO_OK
            );
            let oversized_state = aurora_ios_audio_state_new(2, 2);
            assert_eq!(
                aurora_ios_audio_state_push_pcm_f32(
                    oversized_state,
                    samples.as_ptr(),
                    samples.len(),
                    0,
                    16_000,
                ),
                AURORA_IOS_AUDIO_INVALID_ARGUMENT
            );
            aurora_ios_audio_state_free(oversized_state);
            let mut stats = AuroraIosAudioStats::default();
            assert_eq!(
                aurora_ios_audio_state_stats(state, &mut stats),
                AURORA_IOS_AUDIO_OK
            );
            assert_eq!(stats.accepted_samples, 3);
            assert_eq!(aurora_ios_audio_state_drain_one(state), 3);
            aurora_ios_audio_state_close(state);
            aurora_ios_audio_state_free(state);
        }
    }
}
