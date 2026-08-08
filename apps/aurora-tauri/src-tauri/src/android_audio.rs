//! Android JNI binding for the shared Rust-native PCM ingress.

use aurora_voice_native::{AndroidAudioOutput, AndroidPcmIngress, AndroidPcmPushResult};
use jni::objects::{JClass, JShortArray};
use jni::sys::{jint, jlong, jlongArray, jshortArray};
use jni::JNIEnv;
use std::ptr;

pub const AUDIO_OK: jint = 0;
pub const AUDIO_BACKPRESSURE: jint = 1;
pub const AUDIO_CLOSED: jint = 2;
pub const AUDIO_INVALID_ARGUMENT: jint = -1;

fn state_from_handle(handle: jlong) -> Option<&'static AndroidPcmIngress> {
    if handle == 0 {
        return None;
    }
    // The Kotlin owner joins the AudioRecord thread before nativeFree, so this
    // opaque handle cannot be used after its Rust allocation is released.
    Some(unsafe { &*(handle as *const AndroidPcmIngress) })
}

fn output_from_handle(handle: jlong) -> Option<&'static AndroidAudioOutput> {
    if handle == 0 {
        return None;
    }
    Some(unsafe { &*(handle as *const AndroidAudioOutput) })
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeCreate(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    capacity_chunks: jint,
    max_chunk_samples: jint,
) -> jlong {
    Box::into_raw(Box::new(AndroidPcmIngress::new(
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
    match state.push(&pcm, sequence.max(0) as u64) {
        AndroidPcmPushResult::Accepted => AUDIO_OK,
        AndroidPcmPushResult::Backpressure => AUDIO_BACKPRESSURE,
        AndroidPcmPushResult::Closed => AUDIO_CLOSED,
        AndroidPcmPushResult::InvalidArgument => AUDIO_INVALID_ARGUMENT,
    }
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
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioBridge_nativeDrainPcm(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jshortArray {
    let Some(state) = state_from_handle(handle) else {
        return ptr::null_mut();
    };
    let Some(chunk) = state.drain_chunk() else {
        return env
            .new_short_array(0)
            .map(|array| array.into_raw())
            .unwrap_or(ptr::null_mut());
    };
    let Ok(array) = env.new_short_array(chunk.samples.len() as jint) else {
        return ptr::null_mut();
    };
    if env
        .set_short_array_region(&array, 0, &chunk.samples)
        .is_err()
    {
        return ptr::null_mut();
    }
    array.into_raw()
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
        unsafe { drop(Box::from_raw(handle as *mut AndroidPcmIngress)) };
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

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeCreate(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    capacity_chunks: jint,
) -> jlong {
    Box::into_raw(Box::new(AndroidAudioOutput::new(
        capacity_chunks.max(0) as usize
    ))) as jlong
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeDrainPcm(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jshortArray {
    let Some(output) = output_from_handle(handle) else {
        return ptr::null_mut();
    };
    let samples = output
        .drain_chunk()
        .map(|chunk| chunk.samples)
        .unwrap_or_default();
    let Ok(array) = env.new_short_array(samples.len() as jint) else {
        return ptr::null_mut();
    };
    if env.set_short_array_region(&array, 0, &samples).is_err() {
        return ptr::null_mut();
    }
    array.into_raw()
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeClose(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if let Some(output) = output_from_handle(handle) {
        output.close();
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeFree(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if handle != 0 {
        unsafe { drop(Box::from_raw(handle as *mut AndroidAudioOutput)) };
    }
}
