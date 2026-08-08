//! Bounded Android AudioRecord ingress owned by the native Rust library.
//!
//! Kotlin owns Android lifecycle and AudioRecord. This module owns the bounded
//! PCM handoff and generation-safe counters; no audio payload is logged.

use jni::objects::{JClass, JShortArray};
use jni::sys::{jint, jlong, jlongArray};
use jni::JNIEnv;
use std::collections::VecDeque;
use std::ptr;
use std::sync::Mutex;

const DEFAULT_CAPACITY_CHUNKS: usize = 8;
const MAX_CAPACITY_CHUNKS: usize = 64;
const DEFAULT_MAX_CHUNK_SAMPLES: usize = 4096;
const MAX_CHUNK_SAMPLES: usize = 96_000;

pub const AUDIO_OK: jint = 0;
pub const AUDIO_BACKPRESSURE: jint = 1;
pub const AUDIO_CLOSED: jint = 2;
pub const AUDIO_INVALID_ARGUMENT: jint = -1;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct AudioStats {
    accepted_chunks: u64,
    accepted_samples: u64,
    dropped_chunks: u64,
    discontinuities: u64,
    queued_chunks: u32,
    closed: bool,
}

#[derive(Debug)]
struct PcmChunk {
    samples: Vec<i16>,
    sequence: u64,
}

#[derive(Debug)]
struct Inner {
    queue: VecDeque<PcmChunk>,
    stats: AudioStats,
    last_sequence: Option<u64>,
}

#[derive(Debug)]
struct AudioState {
    capacity_chunks: usize,
    max_chunk_samples: usize,
    inner: Mutex<Inner>,
}

impl AudioState {
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
                stats: AudioStats::default(),
                last_sequence: None,
            }),
        }
    }

    fn push(&self, samples: &[i16], sequence: u64) -> jint {
        if samples.is_empty() || samples.len() > self.max_chunk_samples {
            return AUDIO_INVALID_ARGUMENT;
        }
        let mut inner = self.inner.lock().expect("android audio mutex poisoned");
        if inner.stats.closed {
            return AUDIO_CLOSED;
        }
        if inner.queue.len() >= self.capacity_chunks {
            inner.stats.dropped_chunks = inner.stats.dropped_chunks.saturating_add(1);
            return AUDIO_BACKPRESSURE;
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
        AUDIO_OK
    }

    fn drain_one(&self) -> usize {
        let mut inner = self.inner.lock().expect("android audio mutex poisoned");
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

    fn close(&self) {
        let mut inner = self.inner.lock().expect("android audio mutex poisoned");
        inner.queue.clear();
        inner.stats.queued_chunks = 0;
        inner.stats.closed = true;
    }

    fn stats(&self) -> AudioStats {
        let mut inner = self.inner.lock().expect("android audio mutex poisoned");
        inner.stats.queued_chunks = inner.queue.len() as u32;
        inner.stats
    }
}

fn state_from_handle(handle: jlong) -> Option<&'static AudioState> {
    if handle == 0 {
        return None;
    }
    // The handle is only created by nativeCreate and is released exactly once
    // by nativeFree after the Kotlin owner has stopped all capture work.
    Some(unsafe { &*(handle as *const AudioState) })
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeCreate(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    capacity_chunks: jint,
    max_chunk_samples: jint,
) -> jlong {
    Box::into_raw(Box::new(AudioState::new(
        capacity_chunks.max(0) as usize,
        max_chunk_samples.max(0) as usize,
    ))) as jlong
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativePushPcm(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    samples: JShortArray<'_>,
    sample_count: jint,
    sequence: jlong,
) -> jint {
    let Some(state) = state_from_handle(handle) else {
        return AUDIO_INVALID_ARGUMENT;
    };
    if sample_count <= 0 {
        return AUDIO_INVALID_ARGUMENT;
    }
    let array_len = match env.get_array_length(&samples) {
        Ok(length) => length,
        Err(_) => return AUDIO_INVALID_ARGUMENT,
    };
    if sample_count > array_len {
        return AUDIO_INVALID_ARGUMENT;
    }
    let mut pcm = vec![0_i16; sample_count as usize];
    if env.get_short_array_region(&samples, 0, &mut pcm).is_err() {
        return AUDIO_INVALID_ARGUMENT;
    }
    state.push(&pcm, sequence.max(0) as u64)
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeDrainOne(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jint {
    state_from_handle(handle)
        .map(|state| state.drain_one() as jint)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeClose(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if let Some(state) = state_from_handle(handle) {
        state.close();
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeFree(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if handle != 0 {
        unsafe { drop(Box::from_raw(handle as *mut AudioState)) };
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeStats(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jlongArray {
    let Some(state) = state_from_handle(handle) else {
        return ptr::null_mut();
    };
    let stats = state.stats();
    let values = [
        stats.accepted_chunks as jlong,
        stats.accepted_samples as jlong,
        stats.dropped_chunks as jlong,
        stats.discontinuities as jlong,
        stats.queued_chunks as jlong,
        jlong::from(stats.closed),
    ];
    let Ok(array) = env.new_long_array(values.len() as jint) else {
        return ptr::null_mut();
    };
    if env.set_long_array_region(&array, 0, &values).is_err() {
        return ptr::null_mut();
    }
    array.into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_queue_rejects_without_growth() {
        let state = AudioState::new(1, 4);
        assert_eq!(state.push(&[1, 2], 0), AUDIO_OK);
        assert_eq!(state.push(&[3, 4], 1), AUDIO_BACKPRESSURE);
        assert_eq!(state.stats().dropped_chunks, 1);
        assert_eq!(state.drain_one(), 2);
    }

    #[test]
    fn sequence_gaps_are_redacted_as_discontinuities() {
        let state = AudioState::new(4, 4);
        assert_eq!(state.push(&[1], 0), AUDIO_OK);
        assert_eq!(state.push(&[2], 2), AUDIO_OK);
        assert_eq!(state.stats().discontinuities, 1);
    }

    #[test]
    fn close_rejects_future_pcm() {
        let state = AudioState::new(4, 4);
        state.close();
        assert_eq!(state.push(&[1], 0), AUDIO_CLOSED);
        assert_eq!(state.stats().closed, true);
    }
}
