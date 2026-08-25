//! Android JNI binding for the shared Rust-native PCM ingress.

use aurora_voice_native::{
    AndroidAssistantRouteMode, AndroidAudioOutput, AndroidPcmIngress, AndroidPcmPushResult,
    AndroidTtsReferenceProfile, AndroidVoiceSession, AndroidVoiceSessionCommandError,
    AndroidVoiceSessionConfig, CancellationToken, SpeechCatalogTask, SpeechModelCatalog,
    SpeechPackManager, SpeechPackManagerConfig, TtsVoiceCatalog,
};
use jni::objects::{JClass, JFloatArray, JShortArray, JString};
use jni::sys::{jboolean, jint, jlong, jlongArray, jshortArray, jstring};
use jni::JNIEnv;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::ptr;
use std::sync::{Arc, Mutex, OnceLock};
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

fn optional_gateway_from_jni(env: &mut JNIEnv<'_>, value: JString<'_>) -> Option<Option<Url>> {
    let value = string_from_jni(env, value)?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Some(None)
    } else {
        Url::parse(trimmed).ok().map(Some)
    }
}

fn float_vec_from_jni(env: &mut JNIEnv<'_>, value: JFloatArray<'_>) -> Option<Vec<f32>> {
    let length = env.get_array_length(&value).ok()?;
    if length <= 0 {
        return None;
    }
    let mut samples = vec![0.0_f32; length as usize];
    env.get_float_array_region(&value, 0, &mut samples).ok()?;
    if samples.iter().any(|sample| !sample.is_finite()) {
        return None;
    }
    Some(samples)
}

fn manager_from_root(root: String) -> Option<Arc<SpeechPackManager>> {
    static MANAGERS: OnceLock<Mutex<HashMap<PathBuf, Arc<SpeechPackManager>>>> = OnceLock::new();

    let root = PathBuf::from(root);
    let managers = MANAGERS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut managers = managers.lock().ok()?;
    if let Some(manager) = managers.get(&root) {
        return Some(Arc::clone(manager));
    }

    // Opening a manager performs stale-install recovery. Android polls catalog
    // state while a download is active, so reopening here would mistake the
    // live extraction directory for stale work and delete it mid-install.
    let config = SpeechPackManagerConfig::new(root.clone(), None).ok()?;
    let manager = Arc::new(SpeechPackManager::open(config).ok()?);
    managers.insert(root, Arc::clone(&manager));
    Some(manager)
}

fn speech_catalog_task(task: &str) -> Option<SpeechCatalogTask> {
    match task {
        "stt" | "asr" | "transcription" => Some(SpeechCatalogTask::SpeechToText),
        "vad" => Some(SpeechCatalogTask::VoiceActivityDetection),
        "kws" | "wakeword" | "wake-word" => Some(SpeechCatalogTask::KeywordSpotting),
        _ => None,
    }
}

fn android_catalog_task_name(task: SpeechCatalogTask) -> &'static str {
    match task {
        SpeechCatalogTask::SpeechToText => "stt",
        SpeechCatalogTask::VoiceActivityDetection => "vad",
        SpeechCatalogTask::KeywordSpotting => "kws",
    }
}

fn android_embedded_catalog_json() -> Option<String> {
    let mut entries = Vec::new();
    let speech_catalog = SpeechModelCatalog::embedded().ok()?;
    for entry in &speech_catalog.entries {
        let language = match entry.languages.as_slice() {
            [] => "und".to_owned(),
            [language] => language.clone(),
            _ => "multi".to_owned(),
        };
        entries.push(json!({
            "packId": &entry.model_id,
            "packName": &entry.display_name,
            "provider": "k2-fsa/sherpa-onnx",
            "language": language,
            "uri": &entry.archive.url,
            "sha256": &entry.archive.sha256,
            "sizeBytes": entry.archive.byte_size,
            "tasks": [android_catalog_task_name(entry.task)],
            "engineRuntimeRevision": speech_catalog.revision(),
            "supportedOperatingSystems": ["android"],
            "supportedAbis": ["all"],
            "license": &entry.terms.source,
            "attributionRequired": false,
            "attributionText": "",
            "modelFamily": &entry.model_family,
            "requiresReferenceAudio": false,
            "referenceAudioMode": "",
        }));
    }

    let tts_catalog = TtsVoiceCatalog::runtime().ok()?;
    for entry in &tts_catalog.entries {
        entries.push(json!({
            "packId": &entry.voice_id,
            "packName": &entry.display_name,
            "provider": "k2-fsa/sherpa-onnx",
            "language": &entry.language,
            "uri": &entry.archive.url,
            "sha256": &entry.archive.sha256,
            "sizeBytes": entry.archive.byte_size,
            "tasks": ["tts"],
            "engineRuntimeRevision": tts_catalog.revision(),
            "supportedOperatingSystems": ["android"],
            "supportedAbis": ["all"],
            "license": &entry.terms.source,
            "attributionRequired": false,
            "attributionText": "",
            "modelFamily": &entry.model_family,
            "requiresReferenceAudio": entry.requires_reference_profile(),
            "referenceAudioMode": entry.catalog_reference_audio_mode_label().unwrap_or(""),
        }));
    }
    serde_json::to_string(&entries).ok()
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
        let result = if task == "tts" || task == "text-to-speech" {
            manager
                .install_voice(&pack_id, &cancellation, |_| {})
                .await
                .map(|_| ())
        } else if speech_catalog_task(&task).is_some() {
            manager
                .install_model(&pack_id, &cancellation, |_| {})
                .await
                .map(|_| ())
        } else {
            return false;
        };
        match result {
            Ok(()) => true,
            Err(error) => {
                // SpeechPackError messages are deliberately sanitized and never
                // contain source URLs, local paths, headers, or downloaded bytes.
                eprintln!(
                    "aurora_android_voice_pack_install_failed reason={error} category={error:?}"
                );
                false
            }
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

fn installed_pack_ids_json(root: String) -> Option<String> {
    let manager = manager_from_root(root)?;
    serde_json::to_string(&manager.recorded_pack_ids().ok()?).ok()
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
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeEmbeddedCatalogJson(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
) -> jstring {
    let Some(catalog) = android_embedded_catalog_json() else {
        return ptr::null_mut();
    };
    env.new_string(catalog)
        .map(|value| value.into_raw())
        .unwrap_or_else(|_| ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeSpeechPackBridge_nativeInstalledPackIdsJson(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    root: JString<'_>,
) -> jstring {
    let Some(root) = string_from_jni(&mut env, root) else {
        return ptr::null_mut();
    };
    let Some(pack_ids) = installed_pack_ids_json(root) else {
        return ptr::null_mut();
    };
    env.new_string(pack_ids)
        .map(|value| value.into_raw())
        .unwrap_or_else(|_| ptr::null_mut())
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
    match state.push_latest(&pcm, sequence.max(0) as u64) {
        AndroidPcmPushResult::Accepted => AUDIO_OK,
        AndroidPcmPushResult::Backpressure => AUDIO_BACKPRESSURE,
        AndroidPcmPushResult::Closed => AUDIO_CLOSED,
        AndroidPcmPushResult::InvalidArgument => AUDIO_INVALID_ARGUMENT,
    }
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
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeAudioOutputBridge_nativeFailPlayback(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    error_code: JString<'_>,
) {
    let Some(output) = output_from_handle(handle) else {
        return;
    };
    let Some(error_code) = string_from_jni(&mut env, error_code) else {
        return;
    };
    output.fail_playback(error_code);
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
    assistant_route_mode: JString<'_>,
    preferred_stable_peer_id: JString<'_>,
) -> jlong {
    let Some(Some(gateway)) = optional_gateway_from_jni(&mut env, gateway) else {
        return 0;
    };
    let Some(bearer) = string_from_jni(&mut env, bearer) else {
        return 0;
    };
    let Some(assistant_route_mode) = string_from_jni(&mut env, assistant_route_mode) else {
        return 0;
    };
    let preferred_stable_peer_id = optional_string_from_jni(&mut env, preferred_stable_peer_id);
    let Ok(assistant_route_mode) = AndroidAssistantRouteMode::parse(&assistant_route_mode) else {
        return 0;
    };
    let auth = if bearer.is_empty() {
        aurora_voice_native::GatewayAuth::None
    } else {
        aurora_voice_native::GatewayAuth::Bearer(bearer)
    };
    let Ok(config) = AndroidVoiceSessionConfig::new(gateway, auth, remote_audio_consent != 0)
        .with_assistant_route(assistant_route_mode, preferred_stable_peer_id)
    else {
        return 0;
    };
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
    assistant_route_mode: JString<'_>,
    preferred_stable_peer_id: JString<'_>,
    pack_store_root: JString<'_>,
    stt_model_id: JString<'_>,
    tts_voice_id: JString<'_>,
    vad_model_id: JString<'_>,
    kws_model_id: JString<'_>,
    wake_phrase_id: JString<'_>,
    wake_phrase_text: JString<'_>,
    wake_phrase_revision: JString<'_>,
    tts_reference_sample_rate_hz: jint,
    tts_reference_samples: JFloatArray<'_>,
    tts_reference_text: JString<'_>,
    tts_reference_revision: JString<'_>,
) -> jlong {
    let Some(gateway) = optional_gateway_from_jni(&mut env, gateway) else {
        return 0;
    };
    let Some(bearer) = string_from_jni(&mut env, bearer) else {
        return 0;
    };
    let Some(assistant_route_mode) = string_from_jni(&mut env, assistant_route_mode) else {
        return 0;
    };
    let preferred_stable_peer_id = optional_string_from_jni(&mut env, preferred_stable_peer_id);
    let Some(pack_store_root) = string_from_jni(&mut env, pack_store_root) else {
        return 0;
    };
    let Some(stt_model_id) = optional_string_from_jni(&mut env, stt_model_id) else {
        return 0;
    };
    let Some(tts_voice_id) = optional_string_from_jni(&mut env, tts_voice_id) else {
        return 0;
    };
    let Ok(assistant_route_mode) = AndroidAssistantRouteMode::parse(&assistant_route_mode) else {
        return 0;
    };
    let auth = if bearer.is_empty() {
        aurora_voice_native::GatewayAuth::None
    } else {
        aurora_voice_native::GatewayAuth::Bearer(bearer)
    };
    let Ok(mut config) = AndroidVoiceSessionConfig::with_local_pack_selection_for_route(
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
    )
    .with_assistant_route(assistant_route_mode, preferred_stable_peer_id) else {
        return 0;
    };
    let reference_text = optional_string_from_jni(&mut env, tts_reference_text);
    let _reference_revision = optional_string_from_jni(&mut env, tts_reference_revision);
    if tts_reference_sample_rate_hz > 0 {
        let Some(reference_samples) = float_vec_from_jni(&mut env, tts_reference_samples) else {
            return 0;
        };
        let Ok(profile) = AndroidTtsReferenceProfile::new(
            tts_reference_sample_rate_hz,
            reference_samples,
            reference_text,
            _reference_revision,
        ) else {
            return 0;
        };
        config = config.with_tts_reference_profile(profile);
    }
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
    match session.ingress().push_latest(&pcm, sequence.max(0) as u64) {
        AndroidPcmPushResult::Accepted => AUDIO_OK,
        AndroidPcmPushResult::Backpressure => AUDIO_BACKPRESSURE,
        AndroidPcmPushResult::Closed => AUDIO_CLOSED,
        AndroidPcmPushResult::InvalidArgument => AUDIO_INVALID_ARGUMENT,
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeClearIngress(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jint {
    let Some(session) = session_from_handle(handle) else {
        return AUDIO_INVALID_ARGUMENT;
    };
    if session.clear_ingress() {
        AUDIO_OK
    } else {
        AUDIO_CLOSED
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
pub extern "system" fn Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeFailPlayback(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    error_code: JString<'_>,
) {
    let Some(session) = session_from_handle(handle) else {
        return;
    };
    let Some(error_code) = string_from_jni(&mut env, error_code) else {
        return;
    };
    session.output().fail_playback(error_code);
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
        android_voice_error_code(status.last_error.as_deref()),
    ];
    let Ok(array) = env.new_long_array(values.len() as jint) else {
        return ptr::null_mut();
    };
    if env.set_long_array_region(&array, 0, &values).is_err() {
        return ptr::null_mut();
    }
    array.into_raw()
}

fn android_voice_error_code(code: Option<&str>) -> jlong {
    match code {
        None => 0,
        Some("cancelled") => 1,
        Some("assistant_unavailable") => 2,
        Some("transcription_failed") => 3,
        Some("tts_failed") => 4,
        Some("playback_failed") => 5,
        Some("audio_overloaded") => 6,
        Some("voice_state_invalid") => 7,
        Some("wake_not_detected") => 8,
        Some("speech_not_detected") => 9,
        Some("speech_timeout") => 10,
        Some(_) => 11,
    }
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
