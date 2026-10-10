//! Finite local speech methods for the authenticated desktop peer host.
//!
//! The commands intentionally accept no caller identity. Each admission is
//! tied to the current native profile/policy snapshot and holds its profile
//! transition lease until model work and cancellation have actually returned.

use super::native_node_config::NativeNodeConfigRuntime;
use aurora_voice_core::node_policy::{
    NodeConfigDocumentV2, NullableField, RoutingPreference, SpeechStageConfig,
};
use aurora_voice_engine::{
    BoundTaskRequest, BoundTtsSynthesisRequest, FiniteSttAudioBuilder, FiniteSttPort,
    SpeechCatalogTask, SpeechModelCatalog, TaskRequest, TtsSynthesisConfig, TtsSynthesisPort,
    TtsVoiceCatalog, VoiceTask, TTS_MAX_TEXT_BYTES,
};
use aurora_voice_native::{
    build_installed_stt_provider, build_installed_tts_provider, SpeechPackManager,
    SpeechPackManagerConfig,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;

const MAX_ACTIVE_OPERATIONS: usize = 2;
const MAX_STT_SAMPLES: usize = 16_000 * 60;
const MAX_STT_BYTES: usize = MAX_STT_SAMPLES * 2;
const MAX_TTS_SAMPLES: usize = 48_000 * 60;
const TTS_CHUNK_SAMPLES: usize = 4096;

#[derive(Default)]
pub(crate) struct NativeSpeechHostState {
    operations: Arc<Mutex<HashMap<String, Arc<NativeSpeechOperation>>>>,
}

struct NativeSpeechOperation {
    cancelled: AtomicBool,
    finished: AtomicBool,
    finished_notify: Notify,
}

struct OperationCompletionGuard {
    operations: Arc<Mutex<HashMap<String, Arc<NativeSpeechOperation>>>>,
    operation_id: String,
    operation: Arc<NativeSpeechOperation>,
}

impl Drop for OperationCompletionGuard {
    fn drop(&mut self) {
        finish_operation(&self.operations, &self.operation_id, &self.operation);
    }
}

impl NativeSpeechOperation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finished_notify: Notify::new(),
        }
    }

    fn finish(&self) {
        self.finished.store(true, Ordering::Release);
        self.finished_notify.notify_waiters();
        self.finished_notify.notify_one();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechStageSnapshot {
    enabled: bool,
    model_id: Option<String>,
    language: Option<String>,
    voice_id: Option<String>,
    implementation: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechHostSnapshot {
    revision: u64,
    stt: Option<NativeSpeechStageSnapshot>,
    tts: Option<NativeSpeechStageSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeSpeechTranscribeRequest {
    operation_id: String,
    model_id: String,
    language: Option<String>,
    sample_rate_hz: u32,
    audio_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechTranscribeResult {
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeSpeechSynthesizeRequest {
    operation_id: String,
    model_id: Option<String>,
    voice_id: Option<String>,
    language: Option<String>,
    text: String,
    speed: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechSynthesizeResult {
    sample_rate_hz: u32,
    duration_ms: u64,
    audio_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechCancelResult {
    cancelled: bool,
}

#[tauri::command]
pub(crate) async fn aurora_native_speech_host_snapshot(
    app: AppHandle,
    node_config: State<'_, NativeNodeConfigRuntime>,
) -> Result<NativeSpeechHostSnapshot, String> {
    let (_transition, _generation, document, profile_json) = node_config
        .transcription_admission_snapshot()
        .await
        .map_err(|_| "Local speech is unavailable".to_owned())?;
    let selection = profile_selection(&profile_json)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local speech is unavailable".to_owned())?;
    let root = app_data.join("speech-packs");
    tauri::async_runtime::spawn_blocking(move || {
        let manager =
            SpeechPackManager::open(SpeechPackManagerConfig::new(root, None).ok()?).ok()?;
        let (stt_choice, tts_choice) = resolve_stage_choices(&document, &selection, &manager);
        let stt = stt_choice.and_then(|choice| {
            let model_id = choice.model_id?;
            let mut provider = build_installed_stt_provider(&manager, &model_id).ok()?;
            let binding = provider.finite_stt_binding().ok()?;
            if !matches!(
                &binding,
                aurora_voice_engine::FiniteSttProviderBinding::LocalTask(_)
            ) {
                return None;
            }
            tauri::async_runtime::block_on(provider.warm_finite_stt(binding)).ok()?;
            Some(NativeSpeechStageSnapshot {
                enabled: true,
                model_id: Some(model_id),
                language: choice.language,
                voice_id: None,
                implementation: "native",
            })
        });
        let tts = tts_choice.and_then(|choice| {
            let voice_id = choice.voice_id?;
            let mut provider = build_installed_tts_provider(&manager, &voice_id).ok()?;
            let binding = provider.synthesis_binding().ok()?;
            if !matches!(
                &binding,
                aurora_voice_engine::TtsSynthesisProviderBinding::LocalTask(_)
            ) {
                return None;
            }
            tauri::async_runtime::block_on(provider.warm_synthesis(binding)).ok()?;
            Some(NativeSpeechStageSnapshot {
                enabled: true,
                model_id: choice.model_id,
                language: choice.language,
                voice_id: Some(voice_id),
                implementation: "native",
            })
        });
        Some(NativeSpeechHostSnapshot {
            revision: document.revision,
            stt,
            tts,
        })
    })
    .await
    .map_err(|_| "Local speech is unavailable".to_owned())?
    .ok_or_else(|| "Local speech is unavailable".to_owned())
}

#[tauri::command]
pub(crate) async fn aurora_peer_host_local_speech_transcribe(
    app: AppHandle,
    node_config: State<'_, NativeNodeConfigRuntime>,
    host: State<'_, NativeSpeechHostState>,
    request: NativeSpeechTranscribeRequest,
) -> Result<NativeSpeechTranscribeResult, String> {
    validate_operation_id(&request.operation_id)?;
    if request.sample_rate_hz != 16_000 || request.audio_base64.len() > 5_600_000 {
        return Err("Local transcription request is unavailable".to_owned());
    }
    let encoded = BASE64
        .decode(request.audio_base64.as_bytes())
        .map_err(|_| "Local transcription request is unavailable".to_owned())?;
    if encoded.is_empty() || encoded.len() > MAX_STT_BYTES || encoded.len() % 2 != 0 {
        return Err("Local transcription request is unavailable".to_owned());
    }
    let mut pcm = Vec::with_capacity(encoded.len() / 2);
    for bytes in encoded.chunks_exact(2) {
        pcm.push(i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0);
    }

    let operation = begin_operation(&host, &request.operation_id)?;
    let completion = OperationCompletionGuard {
        operations: Arc::clone(&host.operations),
        operation_id: request.operation_id.clone(),
        operation: Arc::clone(&operation),
    };
    let (_transition, generation, document, profile_json) = node_config
        .transcription_admission_snapshot()
        .await
        .map_err(|_| "Local transcription is unavailable".to_owned())?;
    if operation.cancelled.load(Ordering::Acquire) {
        return Err("Local transcription was cancelled".to_owned());
    }
    let selection = profile_selection(&profile_json)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local transcription is unavailable".to_owned())?
        .join("speech-packs");
    let requested_model_id = request.model_id;
    let requested_language = request.language;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _completion = completion;
        let result = (|| {
            let _transition = _transition;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local transcription was cancelled".to_owned());
            }
            let manager = SpeechPackManager::open(
                SpeechPackManagerConfig::new(root, None)
                    .map_err(|_| "Local transcription is unavailable".to_owned())?,
            )
            .map_err(|_| "Local transcription is unavailable".to_owned())?;
            let choice = resolve_stage_choices(&document, &selection, &manager)
                .0
                .ok_or_else(|| "Local transcription is unavailable".to_owned())?;
            let model_id = choice
                .model_id
                .as_deref()
                .ok_or_else(|| "Local transcription is unavailable".to_owned())?;
            if requested_model_id != model_id
                || requested_language.as_deref() != choice.language.as_deref()
            {
                return Err("Local transcription selection changed".to_owned());
            }
            let model_id = model_id.to_owned();
            let language = choice.language;
            let mut provider = build_installed_stt_provider(&manager, &model_id)
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            let binding = provider
                .finite_stt_binding()
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            let task_request = BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::SpeechToText,
                    language: language.clone(),
                    generation,
                },
                match binding {
                    aurora_voice_engine::FiniteSttProviderBinding::LocalTask(binding) => *binding,
                    aurora_voice_engine::FiniteSttProviderBinding::Route(_) => {
                        return Err("Selected local transcription is unavailable".to_owned())
                    }
                },
            )
            .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            let mut builder = FiniteSttAudioBuilder::new(task_request)
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            for frame in pcm.chunks(16_000 * 30) {
                if operation.cancelled.load(Ordering::Acquire) {
                    return Err("Local transcription was cancelled".to_owned());
                }
                builder
                    .push_frame(frame)
                    .map_err(|_| "Local transcription request is unavailable".to_owned())?;
            }
            let (bound, audio) = builder
                .finish()
                .map_err(|_| "Local transcription request is unavailable".to_owned())?;
            let provider_binding = provider
                .finite_stt_binding()
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            tauri::async_runtime::block_on(provider.warm_finite_stt(provider_binding))
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local transcription was cancelled".to_owned());
            }
            let output =
                tauri::async_runtime::block_on(provider.transcribe_finite(bound, audio, &|| {
                    operation.cancelled.load(Ordering::Acquire)
                }))
                .map_err(|_| "Local transcription could not be completed".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local transcription was cancelled".to_owned());
            }
            Ok(NativeSpeechTranscribeResult {
                text: output.transcript().to_owned(),
            })
        })();
        result
    })
    .await;
    joined.map_err(|_| "Local transcription could not be completed".to_owned())?
}

#[tauri::command]
pub(crate) async fn aurora_peer_host_local_speech_synthesize(
    app: AppHandle,
    node_config: State<'_, NativeNodeConfigRuntime>,
    host: State<'_, NativeSpeechHostState>,
    request: NativeSpeechSynthesizeRequest,
) -> Result<NativeSpeechSynthesizeResult, String> {
    validate_operation_id(&request.operation_id)?;
    if request.text.is_empty()
        || request.text.len() > TTS_MAX_TEXT_BYTES
        || request.speed.is_some_and(|speed| speed != 1.0)
    {
        return Err("Local synthesis request is unavailable".to_owned());
    }
    let operation = begin_operation(&host, &request.operation_id)?;
    let completion = OperationCompletionGuard {
        operations: Arc::clone(&host.operations),
        operation_id: request.operation_id.clone(),
        operation: Arc::clone(&operation),
    };
    let (_transition, generation, document, profile_json) = node_config
        .transcription_admission_snapshot()
        .await
        .map_err(|_| "Local synthesis is unavailable".to_owned())?;
    if operation.cancelled.load(Ordering::Acquire) {
        return Err("Local synthesis was cancelled".to_owned());
    }
    let selection = profile_selection(&profile_json)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local synthesis is unavailable".to_owned())?
        .join("speech-packs");
    let requested_model_id = request.model_id;
    let requested_voice_id = request.voice_id;
    let requested_language = request.language;
    let text = request.text;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _completion = completion;
        let result = (|| {
            let _transition = _transition;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local synthesis was cancelled".to_owned());
            }
            let manager = SpeechPackManager::open(
                SpeechPackManagerConfig::new(root, None)
                    .map_err(|_| "Local synthesis is unavailable".to_owned())?,
            )
            .map_err(|_| "Local synthesis is unavailable".to_owned())?;
            let choice = resolve_stage_choices(&document, &selection, &manager)
                .1
                .ok_or_else(|| "Local synthesis is unavailable".to_owned())?;
            if requested_model_id
                .as_deref()
                .is_some_and(|requested| Some(requested) != choice.model_id.as_deref())
                || requested_voice_id
                    .as_deref()
                    .is_some_and(|voice| Some(voice) != choice.voice_id.as_deref())
                || requested_language.as_deref() != choice.language.as_deref()
            {
                return Err("Local synthesis selection changed".to_owned());
            }
            let voice_id = choice
                .voice_id
                .ok_or_else(|| "Local synthesis is unavailable".to_owned())?;
            let language = choice.language;
            let mut provider = build_installed_tts_provider(&manager, &voice_id)
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let binding = provider
                .synthesis_binding()
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let config = TtsSynthesisConfig::new(
                voice_id.clone(),
                binding.voice_state_compatibility_group_id().to_owned(),
                binding.sample_rate_hz(),
                TTS_CHUNK_SAMPLES,
                None,
            )
            .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let task_binding = match binding {
                aurora_voice_engine::TtsSynthesisProviderBinding::LocalTask(binding) => *binding,
                aurora_voice_engine::TtsSynthesisProviderBinding::Route(_) => {
                    return Err("Selected local synthesis is unavailable".to_owned())
                }
            };
            let task_request = BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::TextToSpeech,
                    language: language.clone(),
                    generation,
                },
                task_binding,
            )
            .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let synthesis_request = BoundTtsSynthesisRequest::new(task_request, text, config)
                .map_err(|_| "Local synthesis request is unavailable".to_owned())?;
            let provider_binding = provider
                .synthesis_binding()
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            tauri::async_runtime::block_on(provider.warm_synthesis(provider_binding))
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local synthesis was cancelled".to_owned());
            }
            let audio = tauri::async_runtime::block_on(
                provider.synthesize_text(synthesis_request, &|| {
                    operation.cancelled.load(Ordering::Acquire)
                }),
            )
            .map_err(|_| "Local synthesis could not be completed".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) || audio.cancelled() {
                return Err("Local synthesis was cancelled".to_owned());
            }
            let first = audio
                .chunks()
                .first()
                .ok_or_else(|| "Local synthesis could not be completed".to_owned())?;
            let sample_rate_hz = first.sample_rate_hz();
            if sample_rate_hz == 0 || sample_rate_hz > 48_000 {
                return Err("Local synthesis could not be completed".to_owned());
            }
            let mut samples = Vec::new();
            for chunk in audio.chunks() {
                if chunk.sample_rate_hz() != sample_rate_hz
                    || samples.len().saturating_add(chunk.samples().len()) > MAX_TTS_SAMPLES
                {
                    return Err("Local synthesis output exceeds the supported limit".to_owned());
                }
                samples.extend_from_slice(chunk.samples());
            }
            let duration_ms = ((samples.len() as u128) * 1000 / u128::from(sample_rate_hz)) as u64;
            if duration_ms > 60_000 {
                return Err("Local synthesis output exceeds the supported limit".to_owned());
            }
            let mut bytes = Vec::with_capacity(samples.len() * 2);
            for sample in samples {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            Ok(NativeSpeechSynthesizeResult {
                sample_rate_hz,
                duration_ms,
                audio_base64: BASE64.encode(bytes),
            })
        })();
        result
    })
    .await;
    joined.map_err(|_| "Local synthesis could not be completed".to_owned())?
}

#[tauri::command]
pub(crate) async fn aurora_peer_host_local_speech_cancel(
    host: State<'_, NativeSpeechHostState>,
    operation_id: String,
) -> Result<NativeSpeechCancelResult, String> {
    let operation = host
        .operations
        .lock()
        .ok()
        .and_then(|operations| operations.get(&operation_id).cloned());
    let Some(operation) = operation else {
        return Ok(NativeSpeechCancelResult { cancelled: false });
    };
    operation.cancelled.store(true, Ordering::Release);
    loop {
        let notified = operation.finished_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if operation.finished.load(Ordering::Acquire) {
            break;
        }
        notified.await;
    }
    Ok(NativeSpeechCancelResult { cancelled: true })
}

#[derive(Clone)]
struct StageChoice {
    model_id: Option<String>,
    voice_id: Option<String>,
    language: Option<String>,
}

fn resolve_stage_choices(
    document: &NodeConfigDocumentV2,
    selection: &ProfileSelection,
    manager: &SpeechPackManager,
) -> (Option<StageChoice>, Option<StageChoice>) {
    let stt = (|| {
        let stage = &document.speech.stages.stt;
        if !document.speech.sharing.stt || !is_local_stage(stage) {
            return None;
        }
        let selected = selection.stt.as_ref()?;
        let catalog = SpeechModelCatalog::embedded().ok()?;
        if selected.pack_revision != catalog.revision() {
            return None;
        }
        let entry = catalog.model(&selected.pack_id)?;
        if entry.task != SpeechCatalogTask::SpeechToText
            || nullable_string(&stage.model_id).is_some_and(|model| model != selected.pack_id)
        {
            return None;
        }
        let bindings = manager.resolve_model_bindings(&selected.pack_id).ok()?;
        if bindings.model_id != selected.pack_id
            || bindings.task != SpeechCatalogTask::SpeechToText
            || stage_language(stage).is_some_and(|language| !bindings.languages.contains(&language))
            || stage_language(stage).is_none()
                && bindings.languages.len() != 1
                && bindings.language_scope != "multilingual"
        {
            return None;
        }
        Some(StageChoice {
            model_id: Some(selected.pack_id.clone()),
            voice_id: None,
            language: stage_language(stage)
                .or_else(|| (bindings.languages.len() == 1).then(|| bindings.languages[0].clone())),
        })
    })();
    let tts = (|| {
        let stage = &document.speech.stages.tts;
        if !document.speech.sharing.tts || !is_local_stage(stage) {
            return None;
        }
        let selected = selection.tts.as_ref()?;
        if selected.reference_profile_id.is_some() {
            return None;
        }
        let catalog = TtsVoiceCatalog::runtime().ok()?;
        if selected.pack_revision != catalog.revision()
            || selected.voice_revision.as_deref() != Some(catalog.revision())
        {
            return None;
        }
        let voice_id = selected.voice_id.as_deref()?;
        let voice = catalog.voice(voice_id)?;
        if voice.language != selected.pack_id
            || stage_language(stage).is_some_and(|language| language != voice.language)
        {
            return None;
        }
        let bindings = manager.resolve_voice_bindings(voice_id).ok()?;
        if bindings.voice_id != voice_id
            || bindings.task_binding.task() != VoiceTask::TextToSpeech
            || bindings.task_binding.catalog_model_family() != Some(voice.model_family.as_str())
        {
            return None;
        }
        // Report only identity read from the verified provider binding; never
        // infer a model selector from the chosen voice ID.
        let model_id = bindings
            .task_binding
            .catalog_model_family()
            .map(str::to_owned);
        if nullable_string(&stage.model_id)
            .is_some_and(|configured| Some(configured) != model_id.as_deref())
        {
            return None;
        }
        // The profile's selected pack language is the actual runtime binding
        // when the policy leaves language unset.
        let language = stage_language(stage).unwrap_or_else(|| selected.pack_id.clone());
        if !bindings
            .task_binding
            .languages()
            .iter()
            .any(|supported| supported.language == language)
        {
            return None;
        }
        Some(StageChoice {
            model_id,
            voice_id: Some(voice_id.to_owned()),
            language: Some(language),
        })
    })();
    (stt, tts)
}

fn is_local_stage(stage: &SpeechStageConfig) -> bool {
    matches!(
        stage.routing.prefer,
        RoutingPreference::Local | RoutingPreference::LocalOnly
    )
}

fn nullable_string(field: &NullableField<String>) -> Option<&str> {
    match field {
        NullableField::Value(value) => Some(value.as_str()),
        NullableField::Missing | NullableField::Null => None,
    }
}

fn stage_language(stage: &SpeechStageConfig) -> Option<String> {
    nullable_string(&stage.language).map(str::to_owned)
}

#[derive(Clone)]
struct ProfileSpeechAsset {
    pack_id: String,
    pack_revision: String,
    voice_id: Option<String>,
    voice_revision: Option<String>,
    reference_profile_id: Option<String>,
}

struct ProfileSelection {
    stt: Option<ProfileSpeechAsset>,
    tts: Option<ProfileSpeechAsset>,
}

fn profile_selection(document: &str) -> Result<ProfileSelection, String> {
    let value: Value = serde_json::from_str(document)
        .map_err(|_| "Selected local profile is unavailable".to_owned())?;
    let active_id = value
        .get("activeProfileId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Selected local profile is unavailable".to_owned())?;
    let profile = value
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(active_id))
        })
        .ok_or_else(|| "Selected local profile is unavailable".to_owned())?;
    let selection = profile
        .get("localNode")
        .and_then(|node| node.get("localSpeechSelection"))
        .ok_or_else(|| "Selected local speech packs are unavailable".to_owned())?;
    Ok(ProfileSelection {
        stt: profile_asset(selection.get("stt")),
        tts: profile_asset(selection.get("tts")),
    })
}

fn profile_asset(value: Option<&Value>) -> Option<ProfileSpeechAsset> {
    let value = value?;
    Some(ProfileSpeechAsset {
        pack_id: value.get("packId")?.as_str()?.to_owned(),
        pack_revision: value.get("packRevision")?.as_str()?.to_owned(),
        voice_id: value
            .get("voiceId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        voice_revision: value
            .get("voiceRevision")
            .and_then(Value::as_str)
            .map(str::to_owned),
        reference_profile_id: value
            .get("referenceProfileId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err("Local speech request is unavailable".to_owned());
    }
    Ok(())
}

fn begin_operation(
    host: &NativeSpeechHostState,
    operation_id: &str,
) -> Result<Arc<NativeSpeechOperation>, String> {
    let mut operations = host
        .operations
        .lock()
        .map_err(|_| "Local speech is unavailable".to_owned())?;
    if operations.contains_key(operation_id) || operations.len() >= MAX_ACTIVE_OPERATIONS {
        return Err("Local speech is busy".to_owned());
    }
    let operation = Arc::new(NativeSpeechOperation::new());
    operations.insert(operation_id.to_owned(), Arc::clone(&operation));
    Ok(operation)
}

fn finish_operation(
    operations: &Mutex<HashMap<String, Arc<NativeSpeechOperation>>>,
    operation_id: &str,
    operation: &Arc<NativeSpeechOperation>,
) {
    operation.finish();
    if let Ok(mut operations) = operations.lock() {
        if operations
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            operations.remove(operation_id);
        }
    }
}
