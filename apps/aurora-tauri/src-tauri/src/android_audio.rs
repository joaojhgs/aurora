//! Android JNI binding for the shared Rust-native PCM ingress.

use aurora_voice_core::CancellationToken;
use aurora_voice_engine::SpeechCatalogTask;
use aurora_voice_native::{
    AndroidAudioOutput, AndroidPcmIngress, AndroidPcmPushResult, AndroidVoiceSession,
    AndroidVoiceSessionCommandError, AndroidVoiceSessionConfig, SpeechPackManager,
    SpeechPackManagerConfig,
};
use jni::objects::{JClass, JShortArray, JString};
use jni::sys::{jboolean, jint, jlong, jlongArray, jshortArray};
use jni::JNIEnv;
use std::path::PathBuf;
use std::ptr;
use tokio::runtime::Builder as TokioRuntimeBuilder;
use url::Url;

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

fn session_from_handle(handle: jlong) -> Option<&'static AndroidVoiceSession> {
    if handle == 0 {
        return None;
    }
    Some(unsafe { &*(handle as *const AndroidVoiceSession) })
}

fn session_error_code(error: AndroidVoiceSessionCommandError) -> jint {
    match error {
        AndroidVoiceSessionCommandError::AlreadyActive => 1,
        AndroidVoiceSessionCommandError::NotActive => 2,
        AndroidVoiceSessionCommandError::Unavailable => 3,
        AndroidVoiceSessionCommandError::Closed => 4,
    }
}

fn string_from_jni(env: &mut JNIEnv<'_>, value: JString<'_>) -> Option<String> {
    env.get_string(&value).ok().map(|value| value.into())
}

fn optional_string_from_jni(env: &mut JNIEnv<'_>, value: JString<'_>) -> Option<String> {
    string_from_jni(env, value).and_then(|value| {
        let trimmed = value.trim().to_owned();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn manager_from_root(root: String) -> Option<SpeechPackManager> {
    SpeechPackManagerConfig::new(PathBuf::from(root), None)
        .ok()
        .and_then(|config| SpeechPackManager::open(config).ok())
}

fn speech_catalog_task(task: &str) -> Option<SpeechCatalogTask> {
    match task {
        "stt" | "asr" | "transcription" => Some(SpeechCatalogTask::SpeechToText),
        "vad" => Some(SpeechCatalogTask::VoiceActivityDetection),
        "kws" | "wakeword" | "wake-word" => Some(SpeechCatalogTask::KeywordSpotting),
        _ => None,
    }
}

fn install_pack_blocking(root: String, pack_id: String, task: String) -> bool {
    let Some(manager) = manager_from_root(root) else {
        return false;
    };
    let Ok(runtime) = TokioRuntimeBuilder::new_current_thread()
        .enable_all()
        .build()
    else {
        return false;
    };
    runtime.block_on(async move {
        let cancellation = CancellationToken::new();
        if task == "tts" || task == "text-to-speech" {
            manager
                .install_voice(&pack_id, &cancellation, |_| {})
                .await
                .is_ok()
        } else if speech_catalog_task(&task).is_some() {
            manager
                .install_model(&pack_id, &cancellation, |_| {})
                .await
                .is_ok()
        } else {
            false
        }
    })
}

fn resolve_pack_blocking(root: String, pack_id: String, task: String) -> bool {
    let Some(manager) = manager_from_root(root) else {
        return false;
    };
    if task == "tts" || task == "text-to-speech" {
        manager.resolve_voice_bindings(&pack_id).is_ok()
    } else {
        speech_catalog_task(&task).is_some() && manager.resolve_model_bindings(&pack_id).is_ok()
    }
}

fn remove_pack_blocking(root: String, pack_id: String, task: String) -> bool {
    let Some(manager) = manager_from_root(root) else {
        return false;
    };
    if task == "tts" || task == "text-to-speech" {
        manager.remove_voice(&pack_id).is_ok()
    } else {
        speech_catalog_task(&task).is_some() && manager.remove_model(&pack_id).is_ok()
    }
}

fn bool_to_jboolean(value: bool) -> jboolean {
    if value {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeInstall(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    root: JString<'_>,
    pack_id: JString<'_>,
    task: JString<'_>,
) -> jboolean {
    let Some(root) = string_from_jni(&mut env, root) else {
        return 0;
    };
    let Some(pack_id) = string_from_jni(&mut env, pack_id) else {
        return 0;
    };
    let Some(task) = string_from_jni(&mut env, task) else {
        return 0;
    };
    bool_to_jboolean(install_pack_blocking(root, pack_id, task))
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeResolve(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    root: JString<'_>,
    pack_id: JString<'_>,
    task: JString<'_>,
) -> jboolean {
    let Some(root) = string_from_jni(&mut env, root) else {
        return 0;
    };
    let Some(pack_id) = string_from_jni(&mut env, pack_id) else {
        return 0;
    };
    let Some(task) = string_from_jni(&mut env, task) else {
        return 0;
    };
    bool_to_jboolean(resolve_pack_blocking(root, pack_id, task))
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeRemove(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    root: JString<'_>,
    pack_id: JString<'_>,
    task: JString<'_>,
) -> jboolean {
    let Some(root) = string_from_jni(&mut env, root) else {
        return 0;
    };
    let Some(pack_id) = string_from_jni(&mut env, pack_id) else {
        return 0;
    };
    let Some(task) = string_from_jni(&mut env, task) else {
        return 0;
    };
    bool_to_jboolean(remove_pack_blocking(root, pack_id, task))
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
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeAcknowledgeDrained(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if let Some(output) = output_from_handle(handle) {
        output.acknowledge_drained();
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeStats(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jlongArray {
    let Some(output) = output_from_handle(handle) else {
        return ptr::null_mut();
    };
    let queued_chunks = output.queued_chunks() as jlong;
    let values = [queued_chunks];
    let Ok(array) = env.new_long_array(values.len() as jint) else {
        return ptr::null_mut();
    };
    if env.set_long_array_region(&array, 0, &values).is_err() {
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

/// Create the shared Rust voice executor. Credentials are accepted only from
/// the native Android owner; no WebView command is involved in this bridge.
#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeCreate(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    gateway: JString<'_>,
    bearer: JString<'_>,
    remote_audio_consent: jboolean,
) -> jlong {
    let Some(gateway) = string_from_jni(&mut env, gateway) else {
        return 0;
    };
    let Some(bearer) = string_from_jni(&mut env, bearer) else {
        return 0;
    };
    let Ok(gateway) = Url::parse(&gateway) else {
        return 0;
    };
    let auth = if bearer.is_empty() {
        aurora_voice_native::GatewayAuth::None
    } else {
        aurora_voice_native::GatewayAuth::Bearer(bearer)
    };
    let config = AndroidVoiceSessionConfig::new(gateway, auth, remote_audio_consent != 0);
    AndroidVoiceSession::new(config, 8, 4_096, 16)
        .map(|session| Box::into_raw(Box::new(session)) as jlong)
        .unwrap_or(0)
}

/// Create a local-pack-backed Android voice executor. Empty optional strings
/// disable background wake providers but STT and TTS ids are required.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeCreateWithPackSelection(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    gateway: JString<'_>,
    bearer: JString<'_>,
    remote_audio_consent: jboolean,
    pack_store_root: JString<'_>,
    stt_model_id: JString<'_>,
    tts_voice_id: JString<'_>,
    vad_model_id: JString<'_>,
    kws_model_id: JString<'_>,
    wake_phrase_id: JString<'_>,
    wake_phrase_text: JString<'_>,
    wake_phrase_revision: JString<'_>,
) -> jlong {
    let Some(gateway) = string_from_jni(&mut env, gateway) else {
        return 0;
    };
    let Some(bearer) = string_from_jni(&mut env, bearer) else {
        return 0;
    };
    let Some(pack_store_root) = string_from_jni(&mut env, pack_store_root) else {
        return 0;
    };
    let Some(stt_model_id) = optional_string_from_jni(&mut env, stt_model_id) else {
        return 0;
    };
    let Some(tts_voice_id) = optional_string_from_jni(&mut env, tts_voice_id) else {
        return 0;
    };
    let Ok(gateway) = Url::parse(&gateway) else {
        return 0;
    };
    let auth = if bearer.is_empty() {
        aurora_voice_native::GatewayAuth::None
    } else {
        aurora_voice_native::GatewayAuth::Bearer(bearer)
    };
    let config = AndroidVoiceSessionConfig::with_local_pack_selection(
        gateway,
        auth,
        remote_audio_consent != 0,
        pack_store_root,
        stt_model_id,
        tts_voice_id,
        optional_string_from_jni(&mut env, vad_model_id),
        optional_string_from_jni(&mut env, kws_model_id),
        optional_string_from_jni(&mut env, wake_phrase_id),
        optional_string_from_jni(&mut env, wake_phrase_text),
        optional_string_from_jni(&mut env, wake_phrase_revision),
    );
    AndroidVoiceSession::new(config, 8, 4_096, 16)
        .map(|session| Box::into_raw(Box::new(session)) as jlong)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeStart(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jlong {
    session_from_handle(handle)
        .and_then(|session| session.start().ok())
        .map_or(0, |generation| generation.0 as jlong)
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeStartBackground(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jlong {
    session_from_handle(handle)
        .and_then(|session| session.start_background().ok())
        .map_or(0, |generation| generation.0 as jlong)
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeFinish(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    generation: jlong,
) -> jint {
    let Some(session) = session_from_handle(handle) else {
        return AUDIO_INVALID_ARGUMENT;
    };
    session
        .finish(generation.max(0) as u64)
        .map_or_else(session_error_code, |_| AUDIO_OK)
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeCancel(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    generation: jlong,
) -> jint {
    let Some(session) = session_from_handle(handle) else {
        return AUDIO_INVALID_ARGUMENT;
    };
    session
        .cancel(generation.max(0) as u64)
        .map_or_else(session_error_code, |_| AUDIO_OK)
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativePushPcm(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    samples: JShortArray<'_>,
    sample_count: jint,
    sequence: jlong,
) -> jint {
    let Some(session) = session_from_handle(handle) else {
        return AUDIO_INVALID_ARGUMENT;
    };
    if sample_count <= 0 {
        return AUDIO_INVALID_ARGUMENT;
    }
    let Ok(array_len) = env.get_array_length(&samples) else {
        return AUDIO_INVALID_ARGUMENT;
    };
    if sample_count > array_len {
        return AUDIO_INVALID_ARGUMENT;
    }
    let mut pcm = vec![0_i16; sample_count as usize];
    if env.get_short_array_region(&samples, 0, &mut pcm).is_err() {
        return AUDIO_INVALID_ARGUMENT;
    }
    match session.ingress().push(&pcm, sequence.max(0) as u64) {
        AndroidPcmPushResult::Accepted => AUDIO_OK,
        AndroidPcmPushResult::Backpressure => AUDIO_BACKPRESSURE,
        AndroidPcmPushResult::Closed => AUDIO_CLOSED,
        AndroidPcmPushResult::InvalidArgument => AUDIO_INVALID_ARGUMENT,
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeDrainPcm(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jshortArray {
    let Some(session) = session_from_handle(handle) else {
        return ptr::null_mut();
    };
    let samples = session
        .output()
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
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeAcknowledgeDrained(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if let Some(session) = session_from_handle(handle) {
        session.output().acknowledge_drained();
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeStats(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jlongArray {
    let Some(session) = session_from_handle(handle) else {
        return ptr::null_mut();
    };
    let status = session.status();
    let capture = session.ingress().stats();
    let values = [
        capture.accepted_chunks as jlong,
        capture.accepted_samples as jlong,
        capture.dropped_chunks as jlong,
        capture.discontinuities as jlong,
        capture.queued_chunks as jlong,
        if status.active { 1 } else { 0 },
        status.phase as jlong,
        status
            .generation
            .map_or(0, |generation| generation.0 as jlong),
        status.completed_turns as jlong,
        status.failed_turns as jlong,
        session.output().queued_chunks() as jlong,
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
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeClose(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if let Some(session) = session_from_handle(handle) {
        session.close();
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeFree(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    if handle != 0 {
        unsafe { drop(Box::from_raw(handle as *mut AndroidVoiceSession)) };
    }
}
