//! Platform-independent speech-engine ports.

#![forbid(unsafe_code)]

pub mod catalog;
pub mod model_pack;
pub mod speech_catalog;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;
use thiserror::Error;

pub use catalog::*;
pub use model_pack::*;
pub use speech_catalog::*;

pub const VAD_SAMPLE_RATE_HZ: u32 = 16_000;
pub const MONO_CHANNELS: u16 = 1;
pub const VAD_WINDOW_SIZE_SAMPLES: usize = 512;
pub const VAD_DEFAULT_THRESHOLD: f32 = 0.25;
pub const VAD_DEFAULT_MIN_SILENCE_DURATION_MS: u32 = 250;
pub const VAD_DEFAULT_MIN_SPEECH_DURATION_MS: u32 = 250;
pub const VAD_DEFAULT_MAX_SPEECH_DURATION_MS: u32 = 10_000;
pub const VAD_DEFAULT_BUFFER_DURATION_MS: u32 = 30_000;
pub const VAD_MAX_DURATION_MS: u32 = 120_000;
/// Maximum canonical 16 kHz mono frame length accepted by generic streaming ports.
pub const MAX_STREAMING_FRAME_SAMPLES: usize = VAD_SAMPLE_RATE_HZ as usize * 30;
pub const MAX_KWS_PHRASES: usize = 64;
pub const MAX_KWS_COOLDOWN_FRAMES: u32 = 16_000;
pub const MAX_KWS_RESULTS: u8 = 16;
pub const MAX_FINITE_STT_FRAMES: usize = 60_000;
pub const MAX_FINITE_STT_SAMPLES: usize = VAD_SAMPLE_RATE_HZ as usize * 120;
pub const MAX_FINITE_STT_TRANSCRIPT_BYTES: usize = 16_384;
pub const TTS_MAX_TEXT_BYTES: usize = 4096;
pub const TTS_MIN_SAMPLE_RATE_HZ: u32 = 8_000;
pub const TTS_MAX_SAMPLE_RATE_HZ: u32 = 48_000;
pub const TTS_MIN_CHUNK_SAMPLES: usize = 64;
pub const TTS_MAX_CHUNK_SAMPLES: usize = 48_000;

/// Engine task families the shared runtime can request without choosing a
/// concrete inference backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceTask {
    KeywordSpotting,
    VoiceActivityDetection,
    SpeechToText,
    TextToSpeech,
}

/// High-level task readiness, independent of platform storage details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskReadiness {
    Cold,
    Warming,
    Ready,
    Unavailable,
}

/// Capability metadata that is safe to expose in product state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskCapability {
    languages: Vec<String>,
    streaming: bool,
    local_only: bool,
    binding: TaskPackBinding,
}

impl TaskCapability {
    pub fn new(binding: TaskPackBinding) -> Self {
        let languages = binding
            .languages
            .iter()
            .map(|language| language.language.clone())
            .collect();
        Self {
            languages,
            streaming: false,
            local_only: true,
            binding,
        }
    }

    pub fn streaming(mut self, streaming: bool) -> Self {
        self.streaming = streaming;
        self
    }

    pub fn task(&self) -> VoiceTask {
        self.binding.task
    }

    pub fn languages(&self) -> &[String] {
        &self.languages
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.binding.sample_rate_hz
    }

    pub fn streaming_enabled(&self) -> bool {
        self.streaming
    }

    pub fn local_only(&self) -> bool {
        self.local_only
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.binding
    }
}

/// Current resource use report for one engine provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceReport {
    pub loaded_tasks: Vec<VoiceTask>,
    pub memory_bytes: u64,
    pub active_streams: u32,
    pub readiness: TaskReadiness,
}

impl Default for ResourceReport {
    fn default() -> Self {
        Self {
            loaded_tasks: Vec::new(),
            memory_bytes: 0,
            active_streams: 0,
            readiness: TaskReadiness::Cold,
        }
    }
}

/// A cancellable provider request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequest {
    pub task: VoiceTask,
    pub language: Option<String>,
    pub generation: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TaskBindingSource {
    ModelPackManifest {
        manifest_sha256: String,
    },
    SpeechCatalog {
        catalog_id: String,
        catalog_revision: String,
        archive_sha256: String,
        model_family: String,
        language_scope: String,
    },
}

impl fmt::Debug for TaskBindingSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ModelPackManifest { manifest_sha256 } => formatter
                .debug_struct("TaskBindingSource::ModelPackManifest")
                .field("manifest_sha256_bytes", &manifest_sha256.len())
                .finish(),
            Self::SpeechCatalog {
                catalog_id,
                catalog_revision,
                archive_sha256,
                model_family,
                language_scope,
            } => formatter
                .debug_struct("TaskBindingSource::SpeechCatalog")
                .field("catalog_id_bytes", &catalog_id.len())
                .field("catalog_revision_bytes", &catalog_revision.len())
                .field("archive_sha256_bytes", &archive_sha256.len())
                .field("model_family", model_family)
                .field("language_scope", language_scope)
                .finish(),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct TaskPackBinding {
    source: TaskBindingSource,
    task: VoiceTask,
    manifest_sha256: String,
    pack_id: String,
    pack_version: String,
    variant_id: String,
    selected_file_ids: Vec<String>,
    compatibility_group_id: String,
    voice_state_compatibility_group_id: String,
    target: RuntimeTarget,
    os: TargetOs,
    arch: TargetArch,
    engine: EngineKind,
    required_browser_features: Vec<BrowserFeature>,
    min_device_memory_mb: Option<u64>,
    runtime_gates: RuntimeGates,
    resource_budget: ResourceBudget,
    variant_abi: AbiRequirements,
    interoperable: bool,
    sample_rate_hz: u32,
    channels: u16,
    frame_size: u32,
    languages: Vec<LanguageSupport>,
}

impl TaskPackBinding {
    pub fn from_selection(
        task: VoiceTask,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<Self, EngineError> {
        if !selection.belongs_to(manifest) || !manifest_supports_task(manifest.manifest(), task) {
            return Err(EngineError::InvalidRequest);
        }
        let variant = manifest
            .manifest()
            .variants
            .iter()
            .find(|candidate| candidate.variant_id == selection.variant_id())
            .ok_or(EngineError::InvalidRequest)?;
        let has_selected_task_file = selection.file_ids().iter().any(|file_id| {
            manifest.manifest().files.iter().any(|file| {
                file.file_id == *file_id
                    && voice_task_matches_pack_task(task, file.task)
                    && !file
                        .revocation
                        .as_ref()
                        .is_some_and(|revocation| revocation.revoked)
            })
        });
        if variant.compatibility.channels != MONO_CHANNELS
            || variant.compatibility.sample_rate_hz == 0
            || manifest.manifest().languages.is_empty()
            || !has_selected_task_file
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            source: TaskBindingSource::ModelPackManifest {
                manifest_sha256: manifest.manifest_sha256().to_owned(),
            },
            task,
            manifest_sha256: manifest.manifest_sha256().to_owned(),
            pack_id: manifest.manifest().pack_id.clone(),
            pack_version: manifest.manifest().pack_version.clone(),
            variant_id: variant.variant_id.clone(),
            selected_file_ids: selection.file_ids().iter().cloned().collect(),
            compatibility_group_id: variant.compatibility.group_id.clone(),
            voice_state_compatibility_group_id: variant.compatibility.voice_state_group_id.clone(),
            target: variant.target,
            os: variant.os,
            arch: variant.arch,
            engine: variant.engine,
            required_browser_features: variant.required_browser_features.clone(),
            min_device_memory_mb: variant.min_device_memory_mb,
            runtime_gates: variant.runtime_gates.clone(),
            resource_budget: variant.resource_budget.clone(),
            variant_abi: variant.abi.clone(),
            interoperable: variant.compatibility.interoperable,
            sample_rate_hz: variant.compatibility.sample_rate_hz,
            channels: variant.compatibility.channels,
            frame_size: variant.compatibility.frame_size,
            languages: manifest.manifest().languages.clone(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_ios_cached_sherpa(
        task: VoiceTask,
        pack_id: impl Into<String>,
        pack_version: impl Into<String>,
        archive_sha256: impl Into<String>,
        runtime_revision: impl Into<String>,
        selected_file_ids: Vec<String>,
        language: impl Into<String>,
        sample_rate_hz: u32,
        frame_size: u32,
        max_installed_bytes: u64,
    ) -> Result<Self, EngineError> {
        let pack_id = pack_id.into();
        let pack_version = pack_version.into();
        let archive_sha256 = archive_sha256.into();
        let runtime_revision = runtime_revision.into();
        let language = language.into();
        if !valid_logical_id(&pack_id)
            || !valid_logical_id(&pack_version)
            || archive_sha256.len() != 64
            || !archive_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !valid_logical_id(&runtime_revision)
            || selected_file_ids.is_empty()
            || selected_file_ids
                .iter()
                .any(|file_id| !valid_logical_id(file_id))
            || !valid_logical_id(&language)
            || sample_rate_hz == 0
            || frame_size == 0
            || max_installed_bytes == 0
        {
            return Err(EngineError::InvalidRequest);
        }
        let mut hasher = Sha256::new();
        hash_part(&mut hasher, b"aurora.ios.cached.sherpa.binding.v1");
        hash_part(&mut hasher, pack_id.as_bytes());
        hash_part(&mut hasher, pack_version.as_bytes());
        hash_part(&mut hasher, archive_sha256.as_bytes());
        hash_part(&mut hasher, runtime_revision.as_bytes());
        for file_id in &selected_file_ids {
            hash_part(&mut hasher, file_id.as_bytes());
        }
        let digest = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join("");
        Ok(Self {
            source: TaskBindingSource::SpeechCatalog {
                catalog_id: "aurora-ios-cache".to_owned(),
                catalog_revision: pack_version.clone(),
                archive_sha256: archive_sha256.clone(),
                model_family: runtime_revision.clone(),
                language_scope: "specific".to_owned(),
            },
            task,
            manifest_sha256: digest,
            pack_id,
            pack_version,
            variant_id: archive_sha256,
            selected_file_ids,
            compatibility_group_id: runtime_revision.clone(),
            voice_state_compatibility_group_id: runtime_revision.clone(),
            target: RuntimeTarget::Ios,
            os: TargetOs::Ios,
            arch: TargetArch::Aarch64,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Low,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: max_installed_bytes,
                max_installed_bytes,
                max_memory_bytes: max_installed_bytes,
            },
            variant_abi: AbiRequirements {
                min_aurora_version: "ios-native".to_owned(),
                min_runtime_version: runtime_revision.clone(),
                min_engine_version: runtime_revision,
                engine_source_revision: "ios-cached".to_owned(),
                build_flags: vec!["ios-sherpa".to_owned()],
            },
            interoperable: true,
            sample_rate_hz,
            channels: MONO_CHANNELS,
            frame_size,
            languages: vec![LanguageSupport {
                language,
                locale: None,
                fixed_language: true,
                auto_detect: false,
            }],
        })
    }

    pub fn from_speech_catalog_entry(
        catalog: &SpeechModelCatalog,
        entry: &SpeechCatalogEntry,
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
    ) -> Result<Self, EngineError> {
        let canonical_catalog =
            SpeechModelCatalog::embedded().map_err(|_| EngineError::InvalidRequest)?;
        let canonical_entry = canonical_catalog
            .model(&entry.model_id)
            .ok_or(EngineError::InvalidRequest)?;
        if catalog != canonical_catalog
            || entry != canonical_entry
            || entry.engine != "sherpa_onnx"
            || !speech_catalog_task_matches_id(entry.task, &entry.model_id)
            || entry.bindings.is_empty()
            || entry.archive.sha256.len() != 64
        {
            return Err(EngineError::InvalidRequest);
        }
        let entry = canonical_entry;
        let task = voice_task_from_speech_catalog_task(entry.task);
        let selected_file_ids = entry.bindings.keys().cloned().collect::<Vec<_>>();
        let frame_size = match task {
            VoiceTask::VoiceActivityDetection => VAD_WINDOW_SIZE_SAMPLES as u32,
            VoiceTask::KeywordSpotting | VoiceTask::SpeechToText => 0,
            VoiceTask::TextToSpeech => return Err(EngineError::InvalidRequest),
        };
        let languages = speech_catalog_languages(entry)?;
        Ok(Self {
            source: TaskBindingSource::SpeechCatalog {
                catalog_id: catalog.catalog_id().to_owned(),
                catalog_revision: catalog.revision().to_owned(),
                archive_sha256: entry.archive.sha256.clone(),
                model_family: entry.model_family.clone(),
                language_scope: entry.language_scope.clone(),
            },
            task,
            manifest_sha256: String::new(),
            pack_id: entry.model_id.clone(),
            pack_version: catalog.revision().to_owned(),
            variant_id: entry.archive.sha256.clone(),
            selected_file_ids,
            compatibility_group_id: format!(
                "speech-catalog:{}:{:?}",
                entry.model_family, entry.task
            ),
            voice_state_compatibility_group_id: String::new(),
            target,
            os,
            arch,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Balanced,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: entry.archive.byte_size,
                max_installed_bytes: entry.archive.byte_size,
                max_memory_bytes: entry.archive.byte_size,
            },
            variant_abi: AbiRequirements {
                min_aurora_version: "0.0.0".to_owned(),
                min_runtime_version: "1.88.0".to_owned(),
                min_engine_version: "sherpa-onnx-v1.13.4".to_owned(),
                engine_source_revision: catalog.revision().to_owned(),
                build_flags: Vec::new(),
            },
            interoperable: true,
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            frame_size,
            languages,
        })
    }

    pub fn from_tts_catalog_entry(
        catalog: &TtsVoiceCatalog,
        entry: &TtsCatalogEntry,
        target: RuntimeTarget,
        os: TargetOs,
        arch: TargetArch,
        sample_rate_hz: u32,
    ) -> Result<Self, EngineError> {
        let canonical_catalog =
            TtsVoiceCatalog::embedded().map_err(|_| EngineError::InvalidRequest)?;
        let canonical_entry = canonical_catalog
            .voice(&entry.voice_id)
            .ok_or(EngineError::InvalidRequest)?;
        if catalog != canonical_catalog
            || entry != canonical_entry
            || entry.engine != "sherpa_onnx"
            || entry.model_family != "vits_piper"
            || !entry.voice_id.starts_with("standard:piper:")
            || entry.archive.sha256.len() != 64
            || !(TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&sample_rate_hz)
        {
            return Err(EngineError::InvalidRequest);
        }
        let entry = canonical_entry;
        Ok(Self {
            source: TaskBindingSource::SpeechCatalog {
                catalog_id: catalog.catalog_id().to_owned(),
                catalog_revision: catalog.revision().to_owned(),
                archive_sha256: entry.archive.sha256.clone(),
                model_family: entry.model_family.clone(),
                language_scope: "specific".to_owned(),
            },
            task: VoiceTask::TextToSpeech,
            manifest_sha256: String::new(),
            pack_id: entry.voice_id.clone(),
            pack_version: catalog.revision().to_owned(),
            variant_id: entry.archive.sha256.clone(),
            selected_file_ids: vec![
                "config".to_owned(),
                "espeak-ng-data".to_owned(),
                "model".to_owned(),
                "model-card".to_owned(),
                "tokens".to_owned(),
            ],
            compatibility_group_id: format!("tts-catalog:{}", entry.model_family),
            voice_state_compatibility_group_id: format!("tts-catalog:{}", entry.voice_id),
            target,
            os,
            arch,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Balanced,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: entry.archive.byte_size,
                max_installed_bytes: entry.archive.byte_size,
                max_memory_bytes: entry.archive.byte_size,
            },
            variant_abi: AbiRequirements {
                min_aurora_version: "0.0.0".to_owned(),
                min_runtime_version: "1.88.0".to_owned(),
                min_engine_version: "sherpa-onnx-v1.13.4".to_owned(),
                engine_source_revision: catalog.revision().to_owned(),
                build_flags: Vec::new(),
            },
            interoperable: true,
            sample_rate_hz,
            channels: MONO_CHANNELS,
            frame_size: 0,
            languages: vec![LanguageSupport {
                language: entry.language.clone(),
                locale: None,
                fixed_language: true,
                auto_detect: false,
            }],
        })
    }

    pub fn source(&self) -> &TaskBindingSource {
        &self.source
    }

    pub fn task(&self) -> VoiceTask {
        self.task
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    pub fn pack_id(&self) -> &str {
        &self.pack_id
    }

    pub fn pack_version(&self) -> &str {
        &self.pack_version
    }

    pub fn variant_id(&self) -> &str {
        &self.variant_id
    }

    pub fn selected_file_ids(&self) -> &[String] {
        &self.selected_file_ids
    }

    pub fn compatibility_group_id(&self) -> &str {
        &self.compatibility_group_id
    }

    pub fn voice_state_compatibility_group_id(&self) -> &str {
        &self.voice_state_compatibility_group_id
    }

    pub fn target(&self) -> RuntimeTarget {
        self.target
    }

    pub fn os(&self) -> TargetOs {
        self.os
    }

    pub fn arch(&self) -> TargetArch {
        self.arch
    }

    pub fn engine(&self) -> EngineKind {
        self.engine
    }

    pub fn required_browser_features(&self) -> &[BrowserFeature] {
        &self.required_browser_features
    }

    pub fn min_device_memory_mb(&self) -> Option<u64> {
        self.min_device_memory_mb
    }

    pub fn runtime_gates(&self) -> &RuntimeGates {
        &self.runtime_gates
    }

    pub fn resource_budget(&self) -> &ResourceBudget {
        &self.resource_budget
    }

    pub fn variant_abi(&self) -> &AbiRequirements {
        &self.variant_abi
    }

    pub fn interoperable(&self) -> bool {
        self.interoperable
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn frame_size(&self) -> u32 {
        self.frame_size
    }

    pub fn languages(&self) -> &[LanguageSupport] {
        &self.languages
    }

    pub fn validate_language(&self, language: Option<&str>) -> Result<(), EngineError> {
        validate_binding_language(self, language)
    }
}

impl fmt::Debug for TaskPackBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TaskPackBinding")
            .field("source", &self.source)
            .field("task", &self.task)
            .field("manifest_sha256_bytes", &self.manifest_sha256.len())
            .field("pack_id_bytes", &self.pack_id.len())
            .field("pack_version_bytes", &self.pack_version.len())
            .field("variant_id_bytes", &self.variant_id.len())
            .field("selected_file_count", &self.selected_file_ids.len())
            .field(
                "compatibility_group_id_bytes",
                &self.compatibility_group_id.len(),
            )
            .field(
                "voice_state_compatibility_group_id_bytes",
                &self.voice_state_compatibility_group_id.len(),
            )
            .field("target", &self.target)
            .field("os", &self.os)
            .field("arch", &self.arch)
            .field("engine", &self.engine)
            .field(
                "required_browser_feature_count",
                &self.required_browser_features.len(),
            )
            .field("min_device_memory_mb", &self.min_device_memory_mb)
            .field("interoperable", &self.interoperable)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("frame_size", &self.frame_size)
            .field("language_count", &self.languages.len())
            .finish()
    }
}

fn voice_task_from_speech_catalog_task(task: SpeechCatalogTask) -> VoiceTask {
    match task {
        SpeechCatalogTask::SpeechToText => VoiceTask::SpeechToText,
        SpeechCatalogTask::VoiceActivityDetection => VoiceTask::VoiceActivityDetection,
        SpeechCatalogTask::KeywordSpotting => VoiceTask::KeywordSpotting,
    }
}

fn speech_catalog_task_matches_id(task: SpeechCatalogTask, model_id: &str) -> bool {
    match task {
        SpeechCatalogTask::SpeechToText => model_id.starts_with("stt:"),
        SpeechCatalogTask::VoiceActivityDetection => model_id.starts_with("vad:"),
        SpeechCatalogTask::KeywordSpotting => model_id.starts_with("kws:"),
    }
}

fn speech_catalog_languages(
    entry: &SpeechCatalogEntry,
) -> Result<Vec<LanguageSupport>, EngineError> {
    if entry.language_scope == "language_independent" {
        if entry.languages.is_empty() {
            return Ok(Vec::new());
        }
        return Err(EngineError::InvalidRequest);
    }
    let auto_detect = entry.language_scope == "multilingual";
    let languages = entry
        .languages
        .iter()
        .map(|language| LanguageSupport {
            language: language.clone(),
            locale: None,
            fixed_language: !auto_detect,
            auto_detect,
        })
        .collect::<Vec<_>>();
    if languages.is_empty() {
        Err(EngineError::InvalidRequest)
    } else {
        Ok(languages)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct BoundTaskRequest {
    request: TaskRequest,
    binding: TaskPackBinding,
}

impl BoundTaskRequest {
    pub fn new(request: TaskRequest, binding: TaskPackBinding) -> Result<Self, EngineError> {
        if request.task != binding.task {
            return Err(EngineError::InvalidRequest);
        }
        binding.validate_language(request.language.as_deref())?;
        Ok(Self { request, binding })
    }

    pub fn request(&self) -> &TaskRequest {
        &self.request
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.binding
    }
}

impl fmt::Debug for BoundTaskRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundTaskRequest")
            .field("task", &self.request.task)
            .field(
                "language_present",
                &self.request.language.as_ref().is_some(),
            )
            .field("generation", &self.request.generation)
            .field("binding", &self.binding)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct BoundFiniteSttRequest {
    binding: FiniteSttBinding,
    frames: usize,
    identity: FiniteSttRequestIdentity,
}

impl BoundFiniteSttRequest {
    pub fn new(request: BoundTaskRequest, frames: usize) -> Result<Self, EngineError> {
        if request.request().task != VoiceTask::SpeechToText
            || frames == 0
            || frames > MAX_FINITE_STT_FRAMES
        {
            return Err(EngineError::InvalidRequest);
        }
        let binding = FiniteSttBinding::LocalTask(Box::new(request));
        let identity = FiniteSttRequestIdentity::for_request(&binding, frames);
        Ok(Self {
            binding,
            frames,
            identity,
        })
    }

    pub fn new_route(request: RouteFiniteSttRequest, frames: usize) -> Result<Self, EngineError> {
        if frames == 0 || frames > MAX_FINITE_STT_FRAMES {
            return Err(EngineError::InvalidRequest);
        }
        let binding = FiniteSttBinding::Route(request);
        let identity = FiniteSttRequestIdentity::for_request(&binding, frames);
        Ok(Self {
            binding,
            frames,
            identity,
        })
    }

    pub fn binding(&self) -> &FiniteSttBinding {
        &self.binding
    }

    pub fn request(&self) -> Option<&BoundTaskRequest> {
        self.local_request()
    }

    pub fn local_request(&self) -> Option<&BoundTaskRequest> {
        match &self.binding {
            FiniteSttBinding::LocalTask(request) => Some(request.as_ref()),
            FiniteSttBinding::Route(_) => None,
        }
    }

    pub fn route_request(&self) -> Option<&RouteFiniteSttRequest> {
        match &self.binding {
            FiniteSttBinding::LocalTask(_) => None,
            FiniteSttBinding::Route(request) => Some(request),
        }
    }

    pub fn generation(&self) -> u64 {
        self.binding.generation()
    }

    pub fn max_audio_samples(&self) -> usize {
        self.binding.max_audio_samples()
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn identity(&self) -> &FiniteSttRequestIdentity {
        &self.identity
    }
}

impl fmt::Debug for BoundFiniteSttRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundFiniteSttRequest")
            .field("binding", &self.binding)
            .field("frames", &self.frames)
            .field("identity", &self.identity)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum FiniteSttBinding {
    LocalTask(Box<BoundTaskRequest>),
    Route(RouteFiniteSttRequest),
}

impl FiniteSttBinding {
    pub fn generation(&self) -> u64 {
        match self {
            Self::LocalTask(request) => request.request().generation,
            Self::Route(request) => request.generation(),
        }
    }

    pub fn language(&self) -> Option<&str> {
        match self {
            Self::LocalTask(request) => request.request().language.as_deref(),
            Self::Route(request) => request.language(),
        }
    }

    pub fn max_audio_samples(&self) -> usize {
        match self {
            Self::LocalTask(_) => MAX_FINITE_STT_SAMPLES,
            Self::Route(request) => request.route().max_audio_samples(),
        }
    }
}

impl fmt::Debug for FiniteSttBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LocalTask(request) => formatter
                .debug_struct("FiniteSttBinding::LocalTask")
                .field("task", &request.request().task)
                .field("generation", &request.request().generation)
                .field("language_present", &request.request().language.is_some())
                .field("binding", request.binding())
                .finish(),
            Self::Route(request) => formatter
                .debug_struct("FiniteSttBinding::Route")
                .field("generation", &request.generation())
                .field("language_present", &request.language().is_some())
                .field("route", request.route())
                .finish(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RouteFiniteSttBinding {
    route_id: String,
    route_scope: FiniteSttRouteScope,
    sample_rate_hz: u32,
    channels: u16,
    max_audio_samples: usize,
    route_revision: u64,
}

impl RouteFiniteSttBinding {
    pub fn new(
        route_id: impl Into<String>,
        route_scope: FiniteSttRouteScope,
        sample_rate_hz: u32,
        max_audio_samples: usize,
        route_revision: u64,
    ) -> Result<Self, EngineError> {
        let binding = Self {
            route_id: route_id.into(),
            route_scope,
            sample_rate_hz,
            channels: MONO_CHANNELS,
            max_audio_samples,
            route_revision,
        };
        binding.validate()?;
        Ok(binding)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if !valid_logical_id(&self.route_id)
            || self.sample_rate_hz != VAD_SAMPLE_RATE_HZ
            || self.channels != MONO_CHANNELS
            || self.max_audio_samples == 0
            || self.max_audio_samples > MAX_FINITE_STT_SAMPLES
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn route_id(&self) -> &str {
        &self.route_id
    }

    pub fn route_scope(&self) -> FiniteSttRouteScope {
        self.route_scope
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn max_audio_samples(&self) -> usize {
        self.max_audio_samples
    }

    pub fn route_revision(&self) -> u64 {
        self.route_revision
    }
}

impl fmt::Debug for RouteFiniteSttBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouteFiniteSttBinding")
            .field("route_id_bytes", &self.route_id.len())
            .field("route_scope", &self.route_scope)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("max_audio_samples", &self.max_audio_samples)
            .field("route_revision", &self.route_revision)
            .finish()
    }
}

impl Serialize for RouteFiniteSttBinding {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("RouteFiniteSttBinding", 6)?;
        state.serialize_field("route_id_bytes", &self.route_id.len())?;
        state.serialize_field("route_scope", &self.route_scope)?;
        state.serialize_field("sample_rate_hz", &self.sample_rate_hz)?;
        state.serialize_field("channels", &self.channels)?;
        state.serialize_field("max_audio_samples", &self.max_audio_samples)?;
        state.serialize_field("route_revision", &self.route_revision)?;
        state.end()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FiniteSttRouteScope {
    LoopbackSidecar,
    RemoteGateway,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RouteFiniteSttRequest {
    route: RouteFiniteSttBinding,
    language: Option<String>,
    generation: u64,
}

impl RouteFiniteSttRequest {
    pub fn new(
        route: RouteFiniteSttBinding,
        language: Option<String>,
        generation: u64,
    ) -> Result<Self, EngineError> {
        route.validate()?;
        if language
            .as_deref()
            .is_some_and(|language| !valid_logical_id(language))
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            route,
            language,
            generation,
        })
    }

    pub fn route(&self) -> &RouteFiniteSttBinding {
        &self.route
    }

    pub fn language(&self) -> Option<&str> {
        self.language.as_deref()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl fmt::Debug for RouteFiniteSttRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouteFiniteSttRequest")
            .field("route", &self.route)
            .field("language_present", &self.language.is_some())
            .field("generation", &self.generation)
            .finish()
    }
}

impl Serialize for RouteFiniteSttRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("RouteFiniteSttRequest", 3)?;
        state.serialize_field("route", &self.route)?;
        state.serialize_field("language_present", &self.language.is_some())?;
        state.serialize_field("generation", &self.generation)?;
        state.end()
    }
}

/// Opaque bounded identity for one finite STT request.
#[derive(Clone, PartialEq, Eq)]
pub struct FiniteSttRequestIdentity([u8; 32]);

impl FiniteSttRequestIdentity {
    fn for_request(binding: &FiniteSttBinding, frames: usize) -> Self {
        let mut hasher = Sha256::new();
        hash_part(&mut hasher, b"aurora.finite-stt.request.v1");
        hash_finite_stt_binding(&mut hasher, binding);
        hash_part(&mut hasher, &(frames as u64).to_le_bytes());
        Self(hasher.finalize().into())
    }
}

impl fmt::Debug for FiniteSttRequestIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FiniteSttRequestIdentity(<redacted>)")
    }
}

#[derive(Clone, PartialEq)]
pub struct FiniteSttAudioBuilder {
    binding: FiniteSttBinding,
    samples: Vec<f32>,
    frames: usize,
    total_samples: usize,
    max_audio_samples: usize,
    failed: bool,
}

impl FiniteSttAudioBuilder {
    pub fn new(request: BoundTaskRequest) -> Result<Self, EngineError> {
        if request.request().task != VoiceTask::SpeechToText {
            return Err(EngineError::InvalidRequest);
        }
        Self::from_binding(FiniteSttBinding::LocalTask(Box::new(request)))
    }

    pub fn new_route(request: RouteFiniteSttRequest) -> Result<Self, EngineError> {
        Self::from_binding(FiniteSttBinding::Route(request))
    }

    fn from_binding(binding: FiniteSttBinding) -> Result<Self, EngineError> {
        let max_audio_samples = binding.max_audio_samples();
        if max_audio_samples == 0 || max_audio_samples > MAX_FINITE_STT_SAMPLES {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            binding,
            samples: Vec::new(),
            frames: 0,
            total_samples: 0,
            max_audio_samples,
            failed: false,
        })
    }

    pub fn push_frame(&mut self, samples: &[f32]) -> Result<(), EngineError> {
        if self.failed {
            return Err(EngineError::InvalidRequest);
        }
        let next_frames = self
            .frames
            .checked_add(1)
            .ok_or(EngineError::ResourceLimit)?;
        let next_total_samples = self
            .total_samples
            .checked_add(samples.len())
            .ok_or(EngineError::ResourceLimit)?;
        if samples.is_empty()
            || samples.len() > MAX_STREAMING_FRAME_SAMPLES
            || next_frames > MAX_FINITE_STT_FRAMES
            || next_total_samples > self.max_audio_samples
            || !normalized_mono_samples(samples)
        {
            self.clear();
            self.failed = true;
            return Err(EngineError::InvalidRequest);
        }
        self.samples
            .try_reserve(samples.len())
            .map_err(|_| EngineError::ResourceLimit)?;
        self.samples.extend_from_slice(samples);
        self.frames = next_frames;
        self.total_samples = next_total_samples;
        Ok(())
    }

    pub fn clear(&mut self) {
        self.samples.clear();
        self.frames = 0;
        self.total_samples = 0;
    }

    pub fn finish(self) -> Result<(BoundFiniteSttRequest, FiniteSttAudio), EngineError> {
        if self.failed || self.frames == 0 || self.samples.is_empty() {
            return Err(EngineError::InvalidRequest);
        }
        let request = match self.binding {
            FiniteSttBinding::LocalTask(request) => {
                BoundFiniteSttRequest::new(*request, self.frames)
            }
            FiniteSttBinding::Route(request) => {
                BoundFiniteSttRequest::new_route(request, self.frames)
            }
        }?;
        let audio = FiniteSttAudio {
            request_identity: request.identity().clone(),
            generation: request.generation(),
            frames: self.frames,
            samples: self.samples,
        };
        if !audio.matches_request(&request) {
            return Err(EngineError::InvalidRequest);
        }
        Ok((request, audio))
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn sample_count(&self) -> usize {
        self.total_samples
    }

    pub fn request(&self) -> Option<&BoundTaskRequest> {
        self.local_request()
    }

    pub fn local_request(&self) -> Option<&BoundTaskRequest> {
        match &self.binding {
            FiniteSttBinding::LocalTask(request) => Some(request.as_ref()),
            FiniteSttBinding::Route(_) => None,
        }
    }

    pub fn route_request(&self) -> Option<&RouteFiniteSttRequest> {
        match &self.binding {
            FiniteSttBinding::LocalTask(_) => None,
            FiniteSttBinding::Route(request) => Some(request),
        }
    }
}

impl fmt::Debug for FiniteSttAudioBuilder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FiniteSttAudioBuilder")
            .field("binding", &self.binding)
            .field("frames", &self.frames)
            .field("sample_count", &self.total_samples)
            .field("max_audio_samples", &self.max_audio_samples)
            .field("failed", &self.failed)
            .finish()
    }
}

/// Bounded canonical 16 kHz mono PCM for finite STT. Debug output redacts samples.
#[derive(Clone, PartialEq)]
pub struct FiniteSttAudio {
    request_identity: FiniteSttRequestIdentity,
    generation: u64,
    frames: usize,
    samples: Vec<f32>,
}

impl FiniteSttAudio {
    pub fn from_frames(
        request: BoundTaskRequest,
        frames: impl IntoIterator<Item = impl AsRef<[f32]>>,
    ) -> Result<(BoundFiniteSttRequest, Self), EngineError> {
        let mut builder = FiniteSttAudioBuilder::new(request)?;
        for frame in frames {
            builder.push_frame(frame.as_ref())?;
        }
        builder.finish()
    }

    fn matches_request(&self, request: &BoundFiniteSttRequest) -> bool {
        self.request_identity == *request.identity()
            && self.generation == request.generation()
            && self.frames == request.frames()
            && !self.samples.is_empty()
            && self.samples.len() <= request.max_audio_samples()
    }

    pub fn request_identity(&self) -> &FiniteSttRequestIdentity {
        &self.request_identity
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn sample_rate_hz(&self) -> u32 {
        VAD_SAMPLE_RATE_HZ
    }

    pub fn channels(&self) -> u16 {
        MONO_CHANNELS
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }
}

impl fmt::Debug for FiniteSttAudio {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FiniteSttAudio")
            .field("request_identity", &self.request_identity)
            .field("generation", &self.generation)
            .field("frames", &self.frames)
            .field("sample_rate_hz", &VAD_SAMPLE_RATE_HZ)
            .field("channels", &MONO_CHANNELS)
            .field("sample_count", &self.samples.len())
            .finish()
    }
}

/// Bounded finite STT result. Providers return this typed result instead of
/// an unvalidated string so turn orchestration can trust transcript shape.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct FiniteSttResult {
    transcript: String,
    frames: usize,
    generation: u64,
}

impl FiniteSttResult {
    pub fn new(
        request: &BoundFiniteSttRequest,
        audio: &FiniteSttAudio,
        transcript: impl Into<String>,
    ) -> Result<Self, EngineError> {
        let transcript = transcript.into();
        if request.frames() == 0
            || request.frames() > MAX_FINITE_STT_FRAMES
            || !audio.matches_request(request)
            || !valid_transcript_text(&transcript)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            transcript,
            frames: request.frames(),
            generation: request.generation(),
        })
    }

    pub fn transcript(&self) -> &str {
        &self.transcript
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl fmt::Debug for FiniteSttResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FiniteSttResult")
            .field("transcript_bytes", &self.transcript.len())
            .field("frames", &self.frames)
            .field("generation", &self.generation)
            .finish()
    }
}

/// Bounded provider fault identifiers safe for UI/log surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineFaultCode {
    Provider,
    HostUnavailable,
    Native,
    Wasm,
    Timeout,
    Internal,
}

impl EngineFaultCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Provider => "provider",
            Self::HostUnavailable => "host_unavailable",
            Self::Native => "native",
            Self::Wasm => "wasm",
            Self::Timeout => "timeout",
            Self::Internal => "internal",
        }
    }
}

impl fmt::Display for EngineFaultCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Provider errors must stay product-safe and exclude credentials or raw audio.
#[derive(Debug, Clone, Error, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineError {
    #[error("task unavailable")]
    TaskUnavailable,
    #[error("cancelled")]
    Cancelled,
    #[error("resource limit")]
    ResourceLimit,
    #[error("invalid request")]
    InvalidRequest,
    #[error("provider fault: {code}")]
    ProviderFault { code: EngineFaultCode },
}

/// Shared cancellation check for streaming providers.
pub fn check_engine_cancellation(cancellation: &dyn Fn() -> bool) -> Result<(), EngineError> {
    if cancellation() {
        Err(EngineError::Cancelled)
    } else {
        Ok(())
    }
}

/// A backend-neutral stream/session handle owned by the engine provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StreamSessionId(pub u64);

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct BoundStreamSession {
    session_id: StreamSessionId,
    task: VoiceTask,
    generation: u64,
    binding: TaskPackBinding,
}

impl BoundStreamSession {
    pub fn new(
        session_id: StreamSessionId,
        request: &BoundTaskRequest,
    ) -> Result<Self, EngineError> {
        if session_id.0 == 0 {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            session_id,
            task: request.request().task,
            generation: request.request().generation,
            binding: request.binding().clone(),
        })
    }

    pub fn session_id(&self) -> StreamSessionId {
        self.session_id
    }

    pub fn task(&self) -> VoiceTask {
        self.task
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.binding
    }

    pub fn matches_request(&self, request: &BoundTaskRequest) -> bool {
        self.task == request.request().task
            && self.generation == request.request().generation
            && self.binding == *request.binding()
    }
}

impl fmt::Debug for BoundStreamSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundStreamSession")
            .field("session_id", &self.session_id)
            .field("task", &self.task)
            .field("generation", &self.generation)
            .field("binding", &self.binding)
            .finish()
    }
}

/// Reason a streaming task must discard recurrent/cache state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamResetReason {
    Manual,
    Discontinuity,
    RouteChanged,
    NewGeneration,
}

/// Validated sherpa-onnx Silero VAD shape for Aurora's canonical processing ABI.
#[derive(Debug, Clone, PartialEq)]
pub struct VadConfig {
    sample_rate_hz: u32,
    channels: u16,
    window_size_samples: usize,
    threshold: f32,
    min_silence_duration_ms: u32,
    min_speech_duration_ms: u32,
    max_speech_duration_ms: u32,
    buffer_duration_ms: u32,
}

impl VadConfig {
    pub fn new(
        window_size_samples: usize,
        threshold: f32,
        min_silence_duration_ms: u32,
        min_speech_duration_ms: u32,
        max_speech_duration_ms: u32,
        buffer_duration_ms: u32,
    ) -> Result<Self, EngineError> {
        let config = Self {
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            window_size_samples,
            threshold,
            min_silence_duration_ms,
            min_speech_duration_ms,
            max_speech_duration_ms,
            buffer_duration_ms,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if self.sample_rate_hz != VAD_SAMPLE_RATE_HZ
            || self.channels != MONO_CHANNELS
            || self.window_size_samples != VAD_WINDOW_SIZE_SAMPLES
            || !valid_sherpa_threshold(self.threshold)
            || self.min_silence_duration_ms == 0
            || self.min_speech_duration_ms == 0
            || self.max_speech_duration_ms == 0
            || self.buffer_duration_ms == 0
            || self.min_silence_duration_ms > VAD_MAX_DURATION_MS
            || self.min_speech_duration_ms > VAD_MAX_DURATION_MS
            || self.max_speech_duration_ms > VAD_MAX_DURATION_MS
            || self.buffer_duration_ms > VAD_MAX_DURATION_MS
            || self.max_speech_duration_ms < self.min_speech_duration_ms
            || self.buffer_duration_ms < self.max_speech_duration_ms
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_frame_samples(&self, samples: &[f32]) -> Result<(), EngineError> {
        self.validate()?;
        if samples.len() != self.window_size_samples || !normalized_mono_samples(samples) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_end_tail_samples(&self, samples: &[f32]) -> Result<(), EngineError> {
        self.validate()?;
        if samples.is_empty()
            || samples.len() > self.window_size_samples
            || !normalized_mono_samples(samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn min_silence_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.min_silence_duration_ms, self.sample_rate_hz)
    }

    pub fn min_speech_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.min_speech_duration_ms, self.sample_rate_hz)
    }

    pub fn max_speech_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.max_speech_duration_ms, self.sample_rate_hz)
    }

    pub fn buffer_samples(&self) -> Result<u64, EngineError> {
        duration_ms_to_samples(self.buffer_duration_ms, self.sample_rate_hz)
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::VoiceActivityDetection
            || binding.sample_rate_hz() != self.sample_rate_hz
            || binding.channels() != self.channels
            || binding.frame_size() != self.window_size_samples as u32
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn window_size_samples(&self) -> usize {
        self.window_size_samples
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn min_silence_duration_ms(&self) -> u32 {
        self.min_silence_duration_ms
    }

    pub fn min_speech_duration_ms(&self) -> u32 {
        self.min_speech_duration_ms
    }

    pub fn max_speech_duration_ms(&self) -> u32 {
        self.max_speech_duration_ms
    }

    pub fn buffer_duration_ms(&self) -> u32 {
        self.buffer_duration_ms
    }
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            window_size_samples: VAD_WINDOW_SIZE_SAMPLES,
            threshold: VAD_DEFAULT_THRESHOLD,
            min_silence_duration_ms: VAD_DEFAULT_MIN_SILENCE_DURATION_MS,
            min_speech_duration_ms: VAD_DEFAULT_MIN_SPEECH_DURATION_MS,
            max_speech_duration_ms: VAD_DEFAULT_MAX_SPEECH_DURATION_MS,
            buffer_duration_ms: VAD_DEFAULT_BUFFER_DURATION_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoundVadRequest {
    request: BoundTaskRequest,
    config: VadConfig,
}

impl BoundVadRequest {
    pub fn new(request: BoundTaskRequest, config: VadConfig) -> Result<Self, EngineError> {
        config.validate_binding(request.binding())?;
        Ok(Self { request, config })
    }

    pub fn request(&self) -> &BoundTaskRequest {
        &self.request
    }

    pub fn config(&self) -> &VadConfig {
        &self.config
    }
}

/// Borrowed canonical 16 kHz mono frame for streaming inference.
#[derive(Clone, Copy)]
pub struct StreamingAudioFrame<'a> {
    sequence: u64,
    sample_rate_hz: u32,
    channels: u16,
    samples: &'a [f32],
    discontinuity: bool,
    end_tail: bool,
}

impl<'a> StreamingAudioFrame<'a> {
    pub fn new(
        sequence: u64,
        sample_rate_hz: u32,
        channels: u16,
        samples: &'a [f32],
        discontinuity: bool,
    ) -> Result<Self, EngineError> {
        if sample_rate_hz != VAD_SAMPLE_RATE_HZ
            || channels != MONO_CHANNELS
            || samples.len() > MAX_STREAMING_FRAME_SAMPLES
            || !normalized_mono_samples(samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            sequence,
            sample_rate_hz,
            channels,
            samples,
            discontinuity,
            end_tail: false,
        })
    }

    pub fn end_tail(
        sequence: u64,
        sample_rate_hz: u32,
        channels: u16,
        samples: &'a [f32],
        discontinuity: bool,
    ) -> Result<Self, EngineError> {
        if sample_rate_hz != VAD_SAMPLE_RATE_HZ
            || channels != MONO_CHANNELS
            || samples.len() > MAX_STREAMING_FRAME_SAMPLES
            || !normalized_mono_samples(samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            sequence,
            sample_rate_hz,
            channels,
            samples,
            discontinuity,
            end_tail: true,
        })
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn samples(&self) -> &[f32] {
        self.samples
    }

    pub fn discontinuity(&self) -> bool {
        self.discontinuity
    }

    pub fn is_end_tail(&self) -> bool {
        self.end_tail
    }
}

impl fmt::Debug for StreamingAudioFrame<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StreamingAudioFrame")
            .field("sequence", &self.sequence)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("sample_count", &self.samples.len())
            .field("discontinuity", &self.discontinuity)
            .field("end_tail", &self.end_tail)
            .finish()
    }
}

/// One VAD speech interval with owned PCM for downstream STT handoff.
#[derive(Clone, PartialEq)]
pub struct SpeechSegment {
    start_frame: u64,
    end_frame: u64,
    start_sample: u64,
    end_sample_exclusive: u64,
    samples: Vec<f32>,
    flushed: bool,
}

impl SpeechSegment {
    pub fn new(
        start_frame: u64,
        end_frame: u64,
        start_sample: u64,
        samples: Vec<f32>,
        flushed: bool,
    ) -> Result<Self, EngineError> {
        if end_frame < start_frame || !normalized_mono_samples(&samples) {
            return Err(EngineError::InvalidRequest);
        }
        let sample_len = u64::try_from(samples.len()).map_err(|_| EngineError::ResourceLimit)?;
        let end_sample_exclusive = start_sample
            .checked_add(sample_len)
            .ok_or(EngineError::ResourceLimit)?;
        Ok(Self {
            start_frame,
            end_frame,
            start_sample,
            end_sample_exclusive,
            samples,
            flushed,
        })
    }

    pub fn start_frame(&self) -> u64 {
        self.start_frame
    }

    pub fn end_frame(&self) -> u64 {
        self.end_frame
    }

    pub fn start_sample(&self) -> u64 {
        self.start_sample
    }

    pub fn end_sample_exclusive(&self) -> u64 {
        self.end_sample_exclusive
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub fn flushed(&self) -> bool {
        self.flushed
    }
}

impl fmt::Debug for SpeechSegment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechSegment")
            .field("start_frame", &self.start_frame)
            .field("end_frame", &self.end_frame)
            .field("start_sample", &self.start_sample)
            .field("end_sample_exclusive", &self.end_sample_exclusive)
            .field("sample_count", &self.samples.len())
            .field("flushed", &self.flushed)
            .finish()
    }
}

/// Result of accepting one streaming audio frame.
#[derive(Clone, PartialEq)]
pub struct VadAcceptResult {
    detected: bool,
    segments: Vec<SpeechSegment>,
    reset: Option<StreamResetReason>,
}

impl VadAcceptResult {
    pub fn new(
        detected: bool,
        segments: Vec<SpeechSegment>,
        reset: Option<StreamResetReason>,
    ) -> Self {
        Self {
            detected,
            segments,
            reset,
        }
    }

    pub fn detected(&self) -> bool {
        self.detected
    }

    pub fn segments(&self) -> &[SpeechSegment] {
        &self.segments
    }

    pub fn reset(&self) -> Option<StreamResetReason> {
        self.reset
    }
}

impl fmt::Debug for VadAcceptResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VadAcceptResult")
            .field("detected", &self.detected)
            .field("segment_count", &self.segments.len())
            .field("reset", &self.reset)
            .finish()
    }
}

/// Backend-neutral keyword spotting configuration.
#[derive(Clone, PartialEq)]
pub struct KwsConfig {
    phrase_ids: Vec<String>,
    phrase_set_revision: String,
    threshold: f32,
    cooldown_frames: u32,
    max_results: u8,
}

impl KwsConfig {
    pub fn new(
        phrase_ids: impl IntoIterator<Item = impl Into<String>>,
        phrase_set_revision: impl Into<String>,
        threshold: f32,
        cooldown_frames: u32,
        max_results: u8,
    ) -> Result<Self, EngineError> {
        let config = Self {
            phrase_ids: phrase_ids.into_iter().map(Into::into).collect(),
            phrase_set_revision: phrase_set_revision.into(),
            threshold,
            cooldown_frames,
            max_results,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if self.phrase_ids.is_empty()
            || self.phrase_ids.len() > MAX_KWS_PHRASES
            || self
                .phrase_ids
                .iter()
                .any(|phrase_id| !valid_logical_id(phrase_id))
            || self.phrase_ids.iter().collect::<BTreeSet<_>>().len() != self.phrase_ids.len()
            || !valid_logical_id(&self.phrase_set_revision)
            || !valid_sherpa_threshold(self.threshold)
            || self.cooldown_frames > MAX_KWS_COOLDOWN_FRAMES
            || self.max_results == 0
            || self.max_results > MAX_KWS_RESULTS
            || usize::from(self.max_results) > self.phrase_ids.len()
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::KeywordSpotting {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn phrase_ids(&self) -> &[String] {
        &self.phrase_ids
    }

    pub fn phrase_set_revision(&self) -> &str {
        &self.phrase_set_revision
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn cooldown_frames(&self) -> u32 {
        self.cooldown_frames
    }

    pub fn max_results(&self) -> u8 {
        self.max_results
    }
}

impl fmt::Debug for KwsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KwsConfig")
            .field("phrase_count", &self.phrase_ids.len())
            .field("phrase_set_revision_bytes", &self.phrase_set_revision.len())
            .field("threshold", &self.threshold)
            .field("cooldown_frames", &self.cooldown_frames)
            .field("max_results", &self.max_results)
            .finish()
    }
}

#[derive(Clone, PartialEq)]
pub struct BoundKwsRequest {
    request: BoundTaskRequest,
    config: KwsConfig,
}

impl BoundKwsRequest {
    pub fn new(request: BoundTaskRequest, config: KwsConfig) -> Result<Self, EngineError> {
        config.validate_binding(request.binding())?;
        Ok(Self { request, config })
    }

    pub fn request(&self) -> &BoundTaskRequest {
        &self.request
    }

    pub fn config(&self) -> &KwsConfig {
        &self.config
    }
}

impl fmt::Debug for BoundKwsRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundKwsRequest")
            .field("task", &self.request.request().task)
            .field("generation", &self.request.request().generation)
            .field(
                "language_present",
                &self.request.request().language.as_ref().is_some(),
            )
            .field("config", &self.config)
            .finish()
    }
}

/// One keyword match using manifest/application keyword identifiers only.
#[derive(Clone, PartialEq, Serialize)]
pub struct KeywordMatch {
    keyword_id: String,
    score: f32,
    frame_index: u64,
}

impl KeywordMatch {
    pub fn new(
        keyword_id: impl Into<String>,
        score: f32,
        frame_index: u64,
    ) -> Result<Self, EngineError> {
        let keyword_id = keyword_id.into();
        if !valid_logical_id(&keyword_id) || !valid_probability(score) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            keyword_id,
            score,
            frame_index,
        })
    }

    pub fn keyword_id(&self) -> &str {
        &self.keyword_id
    }

    pub fn score(&self) -> f32 {
        self.score
    }

    pub fn frame_index(&self) -> u64 {
        self.frame_index
    }
}

impl fmt::Debug for KeywordMatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeywordMatch")
            .field("keyword_id_bytes", &self.keyword_id.len())
            .field("score", &self.score)
            .field("frame_index", &self.frame_index)
            .finish()
    }
}

#[derive(Clone, PartialEq, Serialize)]
pub struct KwsFrameResult {
    matches: Vec<KeywordMatch>,
    reset: Option<StreamResetReason>,
}

impl KwsFrameResult {
    pub fn new(
        config: &KwsConfig,
        cooldown: &mut KwsCooldownState,
        matches: Vec<KeywordMatch>,
        reset: Option<StreamResetReason>,
    ) -> Result<Self, EngineError> {
        config.validate()?;
        if matches.len() > usize::from(config.max_results()) {
            return Err(EngineError::InvalidRequest);
        }
        let mut keyword_ids = BTreeSet::new();
        for keyword_match in &matches {
            if !config
                .phrase_ids()
                .iter()
                .any(|phrase_id| phrase_id == keyword_match.keyword_id())
                || !keyword_ids.insert(keyword_match.keyword_id())
                || !valid_probability(keyword_match.score())
            {
                return Err(EngineError::InvalidRequest);
            }
        }
        cooldown.accept_frame(config, &matches, reset)?;
        Ok(Self { matches, reset })
    }

    pub fn matches(&self) -> &[KeywordMatch] {
        &self.matches
    }

    pub fn reset(&self) -> Option<StreamResetReason> {
        self.reset
    }
}

impl fmt::Debug for KwsFrameResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KwsFrameResult")
            .field("match_count", &self.matches.len())
            .field("reset", &self.reset)
            .finish()
    }
}

/// Stateful KWS cooldown gate shared by streaming adapters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KwsCooldownState {
    last_emitted_frame: Option<u64>,
}

impl KwsCooldownState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.last_emitted_frame = None;
    }

    pub fn last_emitted_frame(&self) -> Option<u64> {
        self.last_emitted_frame
    }

    fn accept_frame(
        &mut self,
        config: &KwsConfig,
        matches: &[KeywordMatch],
        reset: Option<StreamResetReason>,
    ) -> Result<(), EngineError> {
        if reset.is_some() {
            self.reset();
        }
        if matches.is_empty() {
            return Ok(());
        }
        let earliest_match_frame = matches
            .iter()
            .map(KeywordMatch::frame_index)
            .min()
            .ok_or(EngineError::InvalidRequest)?;
        if let Some(last_emitted_frame) = self.last_emitted_frame {
            let next_allowed_frame =
                last_emitted_frame.saturating_add(u64::from(config.cooldown_frames()));
            if earliest_match_frame <= next_allowed_frame {
                return Err(EngineError::InvalidRequest);
            }
        }
        self.last_emitted_frame = matches.iter().map(KeywordMatch::frame_index).max();
        Ok(())
    }
}

/// Backend-neutral streaming STT configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingSttConfig {
    language: Option<String>,
    emit_partials: bool,
    timestamps: bool,
}

impl StreamingSttConfig {
    pub fn new(
        language: Option<impl Into<String>>,
        emit_partials: bool,
        timestamps: bool,
    ) -> Result<Self, EngineError> {
        let config = Self {
            language: language.map(Into::into),
            emit_partials,
            timestamps,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if self.language.as_ref().is_some_and(|language| {
            language.is_empty()
                || language.len() > 35
                || !language
                    .bytes()
                    .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'-'))
        }) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::SpeechToText {
            return Err(EngineError::InvalidRequest);
        }
        binding.validate_language(self.language())?;
        Ok(())
    }

    pub fn language(&self) -> Option<&str> {
        self.language.as_deref()
    }

    pub fn emit_partials(&self) -> bool {
        self.emit_partials
    }

    pub fn timestamps(&self) -> bool {
        self.timestamps
    }
}

impl Default for StreamingSttConfig {
    fn default() -> Self {
        Self {
            language: None,
            emit_partials: true,
            timestamps: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundStreamingSttRequest {
    request: BoundTaskRequest,
    config: StreamingSttConfig,
}

impl BoundStreamingSttRequest {
    pub fn new(request: BoundTaskRequest, config: StreamingSttConfig) -> Result<Self, EngineError> {
        config.validate_binding(request.binding())?;
        Ok(Self { request, config })
    }

    pub fn request(&self) -> &BoundTaskRequest {
        &self.request
    }

    pub fn config(&self) -> &StreamingSttConfig {
        &self.config
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct TranscriptSegment {
    text: String,
    start_ms: Option<u64>,
    end_ms: Option<u64>,
    is_final: bool,
}

impl TranscriptSegment {
    pub fn new(
        text: impl Into<String>,
        start_ms: Option<u64>,
        end_ms: Option<u64>,
        is_final: bool,
    ) -> Result<Self, EngineError> {
        let text = text.into();
        if text.is_empty() || end_ms.zip(start_ms).is_some_and(|(end, start)| end < start) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            text,
            start_ms,
            end_ms,
            is_final,
        })
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn start_ms(&self) -> Option<u64> {
        self.start_ms
    }

    pub fn end_ms(&self) -> Option<u64> {
        self.end_ms
    }

    pub fn is_final(&self) -> bool {
        self.is_final
    }
}

impl fmt::Debug for TranscriptSegment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TranscriptSegment")
            .field("text_bytes", &self.text.len())
            .field("start_ms", &self.start_ms)
            .field("end_ms", &self.end_ms)
            .field("is_final", &self.is_final)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct StreamingSttResult {
    segments: Vec<TranscriptSegment>,
    reset: Option<StreamResetReason>,
    completed: bool,
}

impl StreamingSttResult {
    pub fn new(
        segments: Vec<TranscriptSegment>,
        reset: Option<StreamResetReason>,
        completed: bool,
    ) -> Self {
        Self {
            segments,
            reset,
            completed,
        }
    }

    pub fn segments(&self) -> &[TranscriptSegment] {
        &self.segments
    }

    pub fn reset(&self) -> Option<StreamResetReason> {
        self.reset
    }

    pub fn completed(&self) -> bool {
        self.completed
    }
}

impl fmt::Debug for StreamingSttResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let final_segment_count = self
            .segments
            .iter()
            .filter(|segment| segment.is_final())
            .count();
        formatter
            .debug_struct("StreamingSttResult")
            .field("segment_count", &self.segments.len())
            .field("final_segment_count", &final_segment_count)
            .field("reset", &self.reset)
            .field("completed", &self.completed)
            .finish()
    }
}

/// TTS synthesis request without provider paths or raw handles.
#[derive(Clone, PartialEq, Eq)]
pub struct TtsSynthesisConfig {
    logical_voice_id: String,
    voice_state_compatibility_group_id: String,
    sample_rate_hz: u32,
    channels: u16,
    chunk_samples: usize,
    seed: Option<u64>,
}

impl TtsSynthesisConfig {
    pub fn new(
        logical_voice_id: impl Into<String>,
        voice_state_compatibility_group_id: impl Into<String>,
        sample_rate_hz: u32,
        chunk_samples: usize,
        seed: Option<u64>,
    ) -> Result<Self, EngineError> {
        let config = Self {
            logical_voice_id: logical_voice_id.into(),
            voice_state_compatibility_group_id: voice_state_compatibility_group_id.into(),
            sample_rate_hz,
            channels: MONO_CHANNELS,
            chunk_samples,
            seed,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if !valid_logical_id(&self.logical_voice_id)
            || !valid_logical_id(&self.voice_state_compatibility_group_id)
            || !(TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&self.sample_rate_hz)
            || self.channels != MONO_CHANNELS
            || !(TTS_MIN_CHUNK_SAMPLES..=TTS_MAX_CHUNK_SAMPLES).contains(&self.chunk_samples)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        self.validate()?;
        if binding.task() != VoiceTask::TextToSpeech
            || binding.sample_rate_hz() != self.sample_rate_hz
            || binding.channels() != self.channels
            || binding.voice_state_compatibility_group_id()
                != self.voice_state_compatibility_group_id
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn validate_route(&self, route: &RouteTtsBinding) -> Result<(), EngineError> {
        self.validate()?;
        route.validate()?;
        if route.sample_rate_hz() != self.sample_rate_hz
            || route.channels() != self.channels
            || route.voice_state_compatibility_group_id() != self.voice_state_compatibility_group_id
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn logical_voice_id(&self) -> &str {
        &self.logical_voice_id
    }

    pub fn voice_state_compatibility_group_id(&self) -> &str {
        &self.voice_state_compatibility_group_id
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn chunk_samples(&self) -> usize {
        self.chunk_samples
    }

    pub fn seed(&self) -> Option<u64> {
        self.seed
    }
}

impl fmt::Debug for TtsSynthesisConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TtsSynthesisConfig")
            .field("logical_voice_id_bytes", &self.logical_voice_id.len())
            .field(
                "voice_state_compatibility_group_id_bytes",
                &self.voice_state_compatibility_group_id.len(),
            )
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("chunk_samples", &self.chunk_samples)
            .field("seed_present", &self.seed.is_some())
            .finish()
    }
}

impl Default for TtsSynthesisConfig {
    fn default() -> Self {
        Self {
            logical_voice_id: "default".to_owned(),
            voice_state_compatibility_group_id: "default".to_owned(),
            sample_rate_hz: VAD_SAMPLE_RATE_HZ,
            channels: MONO_CHANNELS,
            chunk_samples: 1024,
            seed: None,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct BoundTtsSynthesisRequest {
    binding: TtsSynthesisBinding,
    text: String,
    config: TtsSynthesisConfig,
    identity: TtsRequestIdentity,
}

impl BoundTtsSynthesisRequest {
    pub fn new(
        request: BoundTaskRequest,
        text: impl Into<String>,
        config: TtsSynthesisConfig,
    ) -> Result<Self, EngineError> {
        config.validate_binding(request.binding())?;
        let text = text.into();
        if !valid_tts_text(&text) {
            return Err(EngineError::InvalidRequest);
        }
        let binding = TtsSynthesisBinding::LocalTask(Box::new(request));
        let identity = TtsRequestIdentity::for_request(&binding, &text, &config);
        Ok(Self {
            binding,
            text,
            config,
            identity,
        })
    }

    pub fn new_route(
        request: RouteTtsSynthesisRequest,
        text: impl Into<String>,
        config: TtsSynthesisConfig,
    ) -> Result<Self, EngineError> {
        config.validate_route(request.route())?;
        let text = text.into();
        if !valid_tts_text(&text) {
            return Err(EngineError::InvalidRequest);
        }
        let binding = TtsSynthesisBinding::Route(request);
        let identity = TtsRequestIdentity::for_request(&binding, &text, &config);
        Ok(Self {
            binding,
            text,
            config,
            identity,
        })
    }

    pub fn binding(&self) -> &TtsSynthesisBinding {
        &self.binding
    }

    pub fn request(&self) -> Option<&BoundTaskRequest> {
        match &self.binding {
            TtsSynthesisBinding::LocalTask(request) => Some(request.as_ref()),
            TtsSynthesisBinding::Route(_) => None,
        }
    }

    pub fn local_request(&self) -> Option<&BoundTaskRequest> {
        self.request()
    }

    pub fn route_request(&self) -> Option<&RouteTtsSynthesisRequest> {
        match &self.binding {
            TtsSynthesisBinding::LocalTask(_) => None,
            TtsSynthesisBinding::Route(request) => Some(request),
        }
    }

    pub fn generation(&self) -> u64 {
        self.binding.generation()
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn config(&self) -> &TtsSynthesisConfig {
        &self.config
    }

    pub fn identity(&self) -> &TtsRequestIdentity {
        &self.identity
    }
}

impl fmt::Debug for BoundTtsSynthesisRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundTtsSynthesisRequest")
            .field("binding", &self.binding)
            .field("generation", &self.binding.generation())
            .field("language_present", &self.binding.language().is_some())
            .field("text_bytes", &self.text.len())
            .field("sample_rate_hz", &self.config.sample_rate_hz())
            .field("channels", &self.config.channels())
            .field("chunk_samples", &self.config.chunk_samples())
            .field("seed_present", &self.config.seed().is_some())
            .field("identity", &self.identity)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum TtsSynthesisBinding {
    LocalTask(Box<BoundTaskRequest>),
    Route(RouteTtsSynthesisRequest),
}

impl TtsSynthesisBinding {
    pub fn generation(&self) -> u64 {
        match self {
            Self::LocalTask(request) => request.request().generation,
            Self::Route(request) => request.generation(),
        }
    }

    pub fn language(&self) -> Option<&str> {
        match self {
            Self::LocalTask(request) => request.request().language.as_deref(),
            Self::Route(request) => request.language(),
        }
    }
}

impl fmt::Debug for TtsSynthesisBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LocalTask(request) => formatter
                .debug_struct("TtsSynthesisBinding::LocalTask")
                .field("task", &request.request().task)
                .field("generation", &request.request().generation)
                .field("language_present", &request.request().language.is_some())
                .field("binding", request.binding())
                .finish(),
            Self::Route(request) => formatter
                .debug_struct("TtsSynthesisBinding::Route")
                .field("generation", &request.generation())
                .field("language_present", &request.language().is_some())
                .field("route", request.route())
                .finish(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RouteTtsBinding {
    route_id: String,
    voice_state_compatibility_group_id: String,
    sample_rate_hz: u32,
    channels: u16,
    route_revision: u64,
}

impl RouteTtsBinding {
    pub fn new(
        route_id: impl Into<String>,
        voice_state_compatibility_group_id: impl Into<String>,
        sample_rate_hz: u32,
        route_revision: u64,
    ) -> Result<Self, EngineError> {
        let binding = Self {
            route_id: route_id.into(),
            voice_state_compatibility_group_id: voice_state_compatibility_group_id.into(),
            sample_rate_hz,
            channels: MONO_CHANNELS,
            route_revision,
        };
        binding.validate()?;
        Ok(binding)
    }

    pub fn validate(&self) -> Result<(), EngineError> {
        if !valid_logical_id(&self.route_id)
            || !valid_logical_id(&self.voice_state_compatibility_group_id)
            || !(TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&self.sample_rate_hz)
            || self.channels != MONO_CHANNELS
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    pub fn route_id(&self) -> &str {
        &self.route_id
    }

    pub fn voice_state_compatibility_group_id(&self) -> &str {
        &self.voice_state_compatibility_group_id
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn route_revision(&self) -> u64 {
        self.route_revision
    }
}

impl fmt::Debug for RouteTtsBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouteTtsBinding")
            .field("route_id_bytes", &self.route_id.len())
            .field(
                "voice_state_compatibility_group_id_bytes",
                &self.voice_state_compatibility_group_id.len(),
            )
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("route_revision", &self.route_revision)
            .finish()
    }
}

impl Serialize for RouteTtsBinding {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("RouteTtsBinding", 5)?;
        state.serialize_field("route_id_bytes", &self.route_id.len())?;
        state.serialize_field(
            "voice_state_compatibility_group_id_bytes",
            &self.voice_state_compatibility_group_id.len(),
        )?;
        state.serialize_field("sample_rate_hz", &self.sample_rate_hz)?;
        state.serialize_field("channels", &self.channels)?;
        state.serialize_field("route_revision", &self.route_revision)?;
        state.end()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RouteTtsSynthesisRequest {
    route: RouteTtsBinding,
    language: Option<String>,
    generation: u64,
}

impl RouteTtsSynthesisRequest {
    pub fn new(
        route: RouteTtsBinding,
        language: Option<String>,
        generation: u64,
    ) -> Result<Self, EngineError> {
        route.validate()?;
        if language
            .as_deref()
            .is_some_and(|language| !valid_logical_id(language))
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            route,
            language,
            generation,
        })
    }

    pub fn route(&self) -> &RouteTtsBinding {
        &self.route
    }

    pub fn language(&self) -> Option<&str> {
        self.language.as_deref()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl fmt::Debug for RouteTtsSynthesisRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RouteTtsSynthesisRequest")
            .field("route", &self.route)
            .field("language_present", &self.language.is_some())
            .field("generation", &self.generation)
            .finish()
    }
}

impl Serialize for RouteTtsSynthesisRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("RouteTtsSynthesisRequest", 3)?;
        state.serialize_field("route", &self.route)?;
        state.serialize_field("language_present", &self.language.is_some())?;
        state.serialize_field("generation", &self.generation)?;
        state.end()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum TtsSynthesisProviderBinding {
    LocalTask(Box<TaskPackBinding>),
    Route(RouteTtsBinding),
}

impl TtsSynthesisProviderBinding {
    pub fn voice_state_compatibility_group_id(&self) -> &str {
        match self {
            Self::LocalTask(binding) => binding.voice_state_compatibility_group_id(),
            Self::Route(binding) => binding.voice_state_compatibility_group_id(),
        }
    }

    pub fn sample_rate_hz(&self) -> u32 {
        match self {
            Self::LocalTask(binding) => binding.sample_rate_hz(),
            Self::Route(binding) => binding.sample_rate_hz(),
        }
    }

    pub fn channels(&self) -> u16 {
        match self {
            Self::LocalTask(binding) => binding.channels(),
            Self::Route(binding) => binding.channels(),
        }
    }
}

impl fmt::Debug for TtsSynthesisProviderBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LocalTask(binding) => formatter
                .debug_struct("TtsSynthesisProviderBinding::LocalTask")
                .field("binding", binding)
                .finish(),
            Self::Route(binding) => formatter
                .debug_struct("TtsSynthesisProviderBinding::Route")
                .field("route", binding)
                .finish(),
        }
    }
}

/// Opaque bounded identity for one bound TTS request.
#[derive(Clone, PartialEq, Eq)]
pub struct TtsRequestIdentity([u8; 32]);

impl TtsRequestIdentity {
    fn for_request(binding: &TtsSynthesisBinding, text: &str, config: &TtsSynthesisConfig) -> Self {
        let mut hasher = Sha256::new();
        hash_part(&mut hasher, b"aurora.tts.request.v2");
        hash_tts_binding(&mut hasher, binding);
        hash_part(&mut hasher, config.logical_voice_id().as_bytes());
        hash_part(
            &mut hasher,
            config.voice_state_compatibility_group_id().as_bytes(),
        );
        hash_part(&mut hasher, &config.sample_rate_hz().to_le_bytes());
        hash_part(&mut hasher, &config.channels().to_le_bytes());
        hash_part(&mut hasher, &(config.chunk_samples() as u64).to_le_bytes());
        match config.seed() {
            Some(seed) => {
                hash_part(&mut hasher, b"seed:some");
                hash_part(&mut hasher, &seed.to_le_bytes());
            }
            None => hash_part(&mut hasher, b"seed:none"),
        }
        hash_part(&mut hasher, &(text.len() as u64).to_le_bytes());
        hash_part(&mut hasher, text.as_bytes());
        Self(hasher.finalize().into())
    }
}

impl fmt::Debug for TtsRequestIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TtsRequestIdentity(<redacted>)")
    }
}

/// One synthesized audio chunk. Debug output redacts sample values.
#[derive(Clone, PartialEq, Eq)]
pub struct TtsAudioChunk {
    request_identity: TtsRequestIdentity,
    chunk_samples_policy: usize,
    sequence: u64,
    sample_rate_hz: u32,
    channels: u16,
    samples: Vec<i16>,
    final_chunk: bool,
}

impl TtsAudioChunk {
    pub fn new(
        request: &BoundTtsSynthesisRequest,
        sequence: u64,
        sample_rate_hz: u32,
        channels: u16,
        samples: Vec<i16>,
        final_chunk: bool,
    ) -> Result<Self, EngineError> {
        let config = request.config();
        config.validate()?;
        if sample_rate_hz != config.sample_rate_hz()
            || !(TTS_MIN_SAMPLE_RATE_HZ..=TTS_MAX_SAMPLE_RATE_HZ).contains(&sample_rate_hz)
            || channels != config.channels()
            || samples.is_empty()
            || samples.len() > config.chunk_samples()
            || samples.len() > TTS_MAX_CHUNK_SAMPLES
            || (!final_chunk && samples.len() != config.chunk_samples())
            || (final_chunk && samples.len() > config.chunk_samples())
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            request_identity: request.identity().clone(),
            chunk_samples_policy: config.chunk_samples(),
            sequence,
            sample_rate_hz,
            channels,
            samples,
            final_chunk,
        })
    }

    fn matches_request(&self, request: &BoundTtsSynthesisRequest) -> bool {
        self.request_identity == *request.identity()
            && self.chunk_samples_policy == request.config().chunk_samples()
            && self.sample_rate_hz == request.config().sample_rate_hz()
            && self.channels == request.config().channels()
            && !self.samples.is_empty()
            && self.samples.len() <= request.config().chunk_samples()
    }

    pub fn request_identity(&self) -> &TtsRequestIdentity {
        &self.request_identity
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn samples(&self) -> &[i16] {
        &self.samples
    }

    pub fn final_chunk(&self) -> bool {
        self.final_chunk
    }
}

impl fmt::Debug for TtsAudioChunk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TtsAudioChunk")
            .field("sequence", &self.sequence)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("sample_count", &self.samples.len())
            .field("final_chunk", &self.final_chunk)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct TtsSynthesisResult {
    chunks: Vec<TtsAudioChunk>,
    cancelled: bool,
}

impl TtsSynthesisResult {
    pub fn new(
        request: &BoundTtsSynthesisRequest,
        chunks: Vec<TtsAudioChunk>,
        cancelled: bool,
    ) -> Result<Self, EngineError> {
        if chunks.is_empty() {
            if cancelled {
                return Ok(Self { chunks, cancelled });
            }
            return Err(EngineError::InvalidRequest);
        }
        let mut final_chunks = 0_usize;
        for (index, chunk) in chunks.iter().enumerate() {
            if !chunk.matches_request(request)
                || chunk.sequence() != (index as u64).saturating_add(1)
            {
                return Err(EngineError::InvalidRequest);
            }
            if chunk.final_chunk() {
                final_chunks = final_chunks.saturating_add(1);
                if index != chunks.len() - 1 {
                    return Err(EngineError::InvalidRequest);
                }
            }
        }
        if (!cancelled && final_chunks != 1) || (cancelled && final_chunks > 0) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self { chunks, cancelled })
    }

    pub fn chunks(&self) -> &[TtsAudioChunk] {
        &self.chunks
    }

    pub fn chunk_count(&self) -> u64 {
        self.chunks.len() as u64
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled
    }
}

impl fmt::Debug for TtsSynthesisResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TtsSynthesisResult")
            .field("chunk_count", &self.chunks.len())
            .field("cancelled", &self.cancelled)
            .finish()
    }
}

/// VAD-only streaming provider boundary.
#[async_trait(?Send)]
pub trait VadStreamProvider: TaskProvider {
    async fn start_vad_session(
        &mut self,
        request: BoundVadRequest,
    ) -> Result<BoundStreamSession, EngineError>;

    async fn push_vad_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<VadAcceptResult, EngineError>;

    async fn flush_vad_session(
        &mut self,
        session: &BoundStreamSession,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<SpeechSegment>, EngineError>;

    async fn reset_vad_session(
        &mut self,
        session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError>;
}

/// Keyword-spotting-only streaming provider boundary.
#[async_trait(?Send)]
pub trait KwsStreamProvider: TaskProvider {
    async fn start_kws_session(
        &mut self,
        request: BoundKwsRequest,
    ) -> Result<BoundStreamSession, EngineError>;

    async fn push_kws_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<KwsFrameResult, EngineError>;

    async fn reset_kws_session(
        &mut self,
        session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError>;
}

/// Streaming STT provider boundary.
#[async_trait(?Send)]
pub trait StreamingSttProvider: TaskProvider {
    async fn start_stt_session(
        &mut self,
        request: BoundStreamingSttRequest,
    ) -> Result<BoundStreamSession, EngineError>;

    async fn push_stt_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<StreamingSttResult, EngineError>;

    async fn finish_stt_session(
        &mut self,
        session: &BoundStreamSession,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<StreamingSttResult, EngineError>;

    async fn reset_stt_session(
        &mut self,
        session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError>;
}

/// TTS synthesis boundary that exposes the provider's real binding shape.
#[async_trait(?Send)]
pub trait TtsSynthesisPort {
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError>;

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError>;

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError>;

    async fn cancel_synthesis_generation(&mut self, generation: u64) -> Result<(), EngineError>;
}

fn duration_ms_to_samples(duration_ms: u32, sample_rate_hz: u32) -> Result<u64, EngineError> {
    u64::from(duration_ms)
        .checked_mul(u64::from(sample_rate_hz))
        .and_then(|value| value.checked_add(999))
        .map(|value| value / 1_000)
        .ok_or(EngineError::ResourceLimit)
}

fn valid_probability(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}

fn valid_sherpa_threshold(value: f32) -> bool {
    value.is_finite() && (0.01..1.0).contains(&value)
}

fn valid_logical_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b':'))
}

fn normalized_mono_samples(samples: &[f32]) -> bool {
    !samples.is_empty()
        && samples
            .iter()
            .all(|sample| sample.is_finite() && (-1.0..=1.0).contains(sample))
}

fn valid_tts_text(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= TTS_MAX_TEXT_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn valid_transcript_text(value: &str) -> bool {
    value.len() <= MAX_FINITE_STT_TRANSCRIPT_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn hash_part(hasher: &mut Sha256, part: &[u8]) {
    hasher.update((part.len() as u64).to_le_bytes());
    hasher.update(part);
}

fn hash_bound_task_request(hasher: &mut Sha256, request: &BoundTaskRequest) {
    hash_part(hasher, format!("{:?}", request.request().task).as_bytes());
    hash_part(
        hasher,
        request
            .request()
            .language
            .as_deref()
            .unwrap_or("")
            .as_bytes(),
    );
    hash_part(hasher, &request.request().generation.to_le_bytes());
    let binding = request.binding();
    hash_part(hasher, binding.manifest_sha256().as_bytes());
    hash_part(hasher, binding.pack_id().as_bytes());
    hash_part(hasher, binding.pack_version().as_bytes());
    hash_part(hasher, binding.variant_id().as_bytes());
    for file_id in binding.selected_file_ids() {
        hash_part(hasher, file_id.as_bytes());
    }
    hash_part(hasher, binding.compatibility_group_id().as_bytes());
    hash_part(
        hasher,
        binding.voice_state_compatibility_group_id().as_bytes(),
    );
    hash_part(hasher, format!("{:?}", binding.target()).as_bytes());
    hash_part(hasher, format!("{:?}", binding.os()).as_bytes());
    hash_part(hasher, format!("{:?}", binding.arch()).as_bytes());
    hash_part(hasher, format!("{:?}", binding.engine()).as_bytes());
    hash_part(hasher, &binding.sample_rate_hz().to_le_bytes());
    hash_part(hasher, &binding.channels().to_le_bytes());
    hash_part(hasher, &binding.frame_size().to_le_bytes());
}

fn hash_finite_stt_binding(hasher: &mut Sha256, binding: &FiniteSttBinding) {
    match binding {
        FiniteSttBinding::LocalTask(request) => {
            hash_part(hasher, b"local_task");
            hash_bound_task_request(hasher, request);
        }
        FiniteSttBinding::Route(request) => {
            hash_part(hasher, b"route");
            hash_part(hasher, request.route().route_id().as_bytes());
            hash_part(
                hasher,
                format!("{:?}", request.route().route_scope()).as_bytes(),
            );
            hash_part(hasher, &request.route().sample_rate_hz().to_le_bytes());
            hash_part(hasher, &request.route().channels().to_le_bytes());
            hash_part(
                hasher,
                &(request.route().max_audio_samples() as u64).to_le_bytes(),
            );
            hash_part(hasher, &request.route().route_revision().to_le_bytes());
            hash_part(hasher, request.language().unwrap_or("").as_bytes());
            hash_part(hasher, &request.generation().to_le_bytes());
        }
    }
}

fn hash_tts_binding(hasher: &mut Sha256, binding: &TtsSynthesisBinding) {
    match binding {
        TtsSynthesisBinding::LocalTask(request) => {
            hash_part(hasher, b"local_task");
            hash_bound_task_request(hasher, request);
        }
        TtsSynthesisBinding::Route(request) => {
            hash_part(hasher, b"route");
            hash_part(hasher, request.route().route_id().as_bytes());
            hash_part(
                hasher,
                request
                    .route()
                    .voice_state_compatibility_group_id()
                    .as_bytes(),
            );
            hash_part(hasher, &request.route().sample_rate_hz().to_le_bytes());
            hash_part(hasher, &request.route().channels().to_le_bytes());
            hash_part(hasher, &request.route().route_revision().to_le_bytes());
            hash_part(hasher, request.language().unwrap_or("").as_bytes());
            hash_part(hasher, &request.generation().to_le_bytes());
        }
    }
}

fn manifest_supports_task(manifest: &ModelPackManifest, task: VoiceTask) -> bool {
    manifest
        .tasks
        .iter()
        .copied()
        .any(|pack_task| voice_task_matches_pack_task(task, pack_task))
}

fn voice_task_matches_pack_task(task: VoiceTask, pack_task: PackTask) -> bool {
    match task {
        VoiceTask::KeywordSpotting => matches!(pack_task, PackTask::Kws | PackTask::Wakeword),
        VoiceTask::VoiceActivityDetection => pack_task == PackTask::Vad,
        VoiceTask::SpeechToText => pack_task == PackTask::Stt,
        VoiceTask::TextToSpeech => pack_task == PackTask::Tts,
    }
}

fn validate_binding_language(
    binding: &TaskPackBinding,
    language: Option<&str>,
) -> Result<(), EngineError> {
    match language {
        Some(requested) => {
            if binding.languages.iter().any(|supported| {
                supported.language == requested
                    || supported
                        .locale
                        .as_deref()
                        .is_some_and(|locale| locale == requested)
            }) {
                Ok(())
            } else {
                Err(EngineError::InvalidRequest)
            }
        }
        None if binding.task == VoiceTask::VoiceActivityDetection => Ok(()),
        None if binding
            .languages
            .iter()
            .any(|supported| supported.auto_detect) =>
        {
            Ok(())
        }
        None if binding.languages.len() == 1 => Ok(()),
        None => Err(EngineError::InvalidRequest),
    }
}

/// Engine-independent task provider.
#[async_trait(?Send)]
pub trait TaskProvider {
    fn capabilities(&self) -> Vec<TaskCapability>;

    fn resource_report(&self) -> ResourceReport;

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError>;

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError>;

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError>;
}

/// Finite STT boundary that exposes the provider's real binding shape.
#[async_trait(?Send)]
pub trait FiniteSttPort {
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError>;

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError>;

    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError>;

    async fn cancel_finite_stt_generation(&mut self, generation: u64) -> Result<(), EngineError>;
}

#[derive(Clone, PartialEq, Eq)]
pub enum FiniteSttProviderBinding {
    LocalTask(Box<TaskPackBinding>),
    Route(RouteFiniteSttBinding),
}

impl FiniteSttProviderBinding {
    pub fn sample_rate_hz(&self) -> u32 {
        match self {
            Self::LocalTask(binding) => binding.sample_rate_hz(),
            Self::Route(binding) => binding.sample_rate_hz(),
        }
    }

    pub fn channels(&self) -> u16 {
        match self {
            Self::LocalTask(binding) => binding.channels(),
            Self::Route(binding) => binding.channels(),
        }
    }

    pub fn max_audio_samples(&self) -> usize {
        match self {
            Self::LocalTask(_) => MAX_FINITE_STT_SAMPLES,
            Self::Route(binding) => binding.max_audio_samples(),
        }
    }
}

impl fmt::Debug for FiniteSttProviderBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LocalTask(binding) => formatter
                .debug_struct("FiniteSttProviderBinding::LocalTask")
                .field("binding", binding)
                .finish(),
            Self::Route(binding) => formatter
                .debug_struct("FiniteSttProviderBinding::Route")
                .field("route", binding)
                .finish(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::BTreeSet;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct AcceptingVerifier;

    impl SignatureVerifier for AcceptingVerifier {
        fn verify(
            &self,
            _canonical_json: &str,
            signature: &ManifestSignature,
        ) -> Result<bool, ModelPackError> {
            Ok(signature.value == "signed")
        }
    }

    fn test_license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn test_provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
        }
    }

    fn test_processing() -> ProcessingMetadata {
        ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: HASH.to_owned(),
            preprocessing_abi: "pre-v1".to_owned(),
            postprocessing_abi: "post-v1".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: MONO_CHANNELS,
                frame_size: 512,
                window_size: 1024,
                cache_state: vec!["hidden".to_owned()],
            },
        }
    }

    fn test_file(file_id: &str, task: PackTask) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task,
            byte_size: 100,
            sha256: HASH.to_owned(),
            url: format!("/models/{file_id}"),
            compression: CompressionKind::None,
            installed_size: 100,
            install_order: 0,
            dependencies: Vec::new(),
            license: test_license(),
            provenance: test_provenance(),
            processing: test_processing(),
            raven: None,
            revocation: None,
        }
    }

    fn test_variant(file_id: &str) -> ModelPackVariant {
        ModelPackVariant {
            variant_id: "linux".to_owned(),
            target: RuntimeTarget::Desktop,
            os: TargetOs::Linux,
            arch: TargetArch::X86_64,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Low,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
            },
            compatibility: Compatibility {
                group_id: "group-a".to_owned(),
                voice_state_group_id: "voice-state-a".to_owned(),
                preprocessing_abi: "pre-v1".to_owned(),
                postprocessing_abi: "post-v1".to_owned(),
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: MONO_CHANNELS,
                frame_size: 512,
                interoperable: true,
            },
            file_ids: vec![file_id.to_owned()],
            abi: AbiRequirements {
                min_aurora_version: "1.0.0".to_owned(),
                min_runtime_version: "1.0.0".to_owned(),
                min_engine_version: "1.0.0".to_owned(),
                engine_source_revision: "rev1".to_owned(),
                build_flags: vec!["cpu".to_owned()],
            },
            revocation: None,
        }
    }

    fn test_manifest(pack_task: PackTask) -> ModelPackManifest {
        ModelPackManifest {
            schema_version: 1,
            pack_id: "pack".to_owned(),
            pack_version: "1.0.0".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![pack_task],
            license: test_license(),
            languages: vec![LanguageSupport {
                language: "en".to_owned(),
                locale: Some("en-US".to_owned()),
                fixed_language: true,
                auto_detect: false,
            }],
            capabilities: CapabilityFlags {
                streaming: true,
                cancellation: true,
            },
            provenance: test_provenance(),
            files: vec![test_file("model", pack_task)],
            variants: vec![test_variant("model")],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key1".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        }
    }

    fn selected(pack_task: PackTask) -> (VerifiedManifest, SelectedVariant) {
        let verified = verify_manifest(
            test_manifest(pack_task),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        )
        .expect("verified manifest");
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
                device_memory_mb: None,
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
                cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Low,
                require_interoperable: true,
            },
        )
        .expect("selected variant");
        (verified, selection)
    }

    fn tts_binding(voice_state_group_id: &str) -> TaskPackBinding {
        let mut manifest = test_manifest(PackTask::Tts);
        manifest.variants[0].compatibility.voice_state_group_id = voice_state_group_id.to_owned();
        let verified = verify_manifest(manifest, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("verified tts manifest");
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
                device_memory_mb: None,
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
                cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Low,
                require_interoperable: true,
            },
        )
        .expect("selected tts variant");
        TaskPackBinding::from_selection(VoiceTask::TextToSpeech, &verified, &selection)
            .expect("tts binding")
    }

    fn bound_tts_request_with(
        binding: TaskPackBinding,
        generation: u64,
        text: &str,
        logical_voice_id: &str,
        seed: Option<u64>,
        chunk_samples: usize,
    ) -> BoundTtsSynthesisRequest {
        let config = TtsSynthesisConfig::new(
            logical_voice_id,
            binding.voice_state_compatibility_group_id().to_owned(),
            binding.sample_rate_hz(),
            chunk_samples,
            seed,
        )
        .expect("valid tts config");
        BoundTtsSynthesisRequest::new(
            BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::TextToSpeech,
                    language: Some("en".to_owned()),
                    generation,
                },
                binding,
            )
            .expect("bound tts task"),
            text,
            config,
        )
        .expect("bound tts request")
    }

    fn bound_tts_request(generation: u64, chunk_samples: usize) -> BoundTtsSynthesisRequest {
        bound_tts_request_with(
            tts_binding("voice-state-a"),
            generation,
            "hello",
            "voice.default",
            None,
            chunk_samples,
        )
    }

    fn route_tts_request_with(
        generation: u64,
        text: &str,
        route_id: &str,
        route_revision: u64,
    ) -> BoundTtsSynthesisRequest {
        let route = RouteTtsBinding::new(
            route_id,
            "voice-state-a",
            VAD_SAMPLE_RATE_HZ,
            route_revision,
        )
        .expect("valid route binding");
        let config = TtsSynthesisConfig::new(
            "voice.default",
            route.voice_state_compatibility_group_id().to_owned(),
            route.sample_rate_hz(),
            1024,
            None,
        )
        .expect("valid tts config");
        BoundTtsSynthesisRequest::new_route(
            RouteTtsSynthesisRequest::new(route, Some("en".to_owned()), generation)
                .expect("valid route request"),
            text,
            config,
        )
        .expect("bound route tts request")
    }

    fn bound_finite_stt_request(generation: u64, frames: usize) -> BoundFiniteSttRequest {
        let (manifest, selection) = selected(PackTask::Stt);
        let binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
                .expect("stt binding");
        BoundFiniteSttRequest::new(
            BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::SpeechToText,
                    language: Some("en".to_owned()),
                    generation,
                },
                binding,
            )
            .expect("bound stt task"),
            frames,
        )
        .expect("finite stt request")
    }

    fn route_finite_stt_request(
        generation: u64,
        frames: usize,
        route_id: &str,
        route_revision: u64,
        max_audio_samples: usize,
    ) -> BoundFiniteSttRequest {
        let route = RouteFiniteSttBinding::new(
            route_id,
            FiniteSttRouteScope::LoopbackSidecar,
            VAD_SAMPLE_RATE_HZ,
            max_audio_samples,
            route_revision,
        )
        .expect("valid route binding");
        BoundFiniteSttRequest::new_route(
            RouteFiniteSttRequest::new(route, Some("en".to_owned()), generation)
                .expect("valid route request"),
            frames,
        )
        .expect("route finite stt request")
    }

    struct SurfaceVadProvider;

    #[async_trait(?Send)]
    impl TaskProvider for SurfaceVadProvider {
        fn capabilities(&self) -> Vec<TaskCapability> {
            Vec::new()
        }

        fn resource_report(&self) -> ResourceReport {
            ResourceReport::default()
        }

        async fn warm_task(&mut self, _request: BoundTaskRequest) -> Result<(), EngineError> {
            Ok(())
        }

        async fn unload_task(&mut self, _binding: TaskPackBinding) -> Result<(), EngineError> {
            Ok(())
        }

        async fn cancel_generation(&mut self, _generation: u64) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[async_trait(?Send)]
    impl VadStreamProvider for SurfaceVadProvider {
        async fn start_vad_session(
            &mut self,
            request: BoundVadRequest,
        ) -> Result<BoundStreamSession, EngineError> {
            BoundStreamSession::new(StreamSessionId(1), request.request())
        }

        async fn push_vad_frame(
            &mut self,
            _session: &BoundStreamSession,
            _frame: StreamingAudioFrame<'_>,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<VadAcceptResult, EngineError> {
            Ok(VadAcceptResult::new(false, Vec::new(), None))
        }

        async fn flush_vad_session(
            &mut self,
            _session: &BoundStreamSession,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<Vec<SpeechSegment>, EngineError> {
            Ok(Vec::new())
        }

        async fn reset_vad_session(
            &mut self,
            _session: &BoundStreamSession,
            _reason: StreamResetReason,
        ) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[test]
    fn task_pack_binding_requires_matching_verified_selection_task_and_language() {
        let (manifest, selection) = selected(PackTask::Stt);
        let binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
                .expect("binding");
        assert_eq!(binding.pack_id(), "pack");
        assert_eq!(binding.variant_id(), "linux");
        assert_eq!(binding.compatibility_group_id(), "group-a");
        assert_eq!(binding.target(), RuntimeTarget::Desktop);
        assert_eq!(binding.os(), TargetOs::Linux);
        assert_eq!(binding.arch(), TargetArch::X86_64);
        assert_eq!(binding.engine(), EngineKind::SherpaOnnx);
        assert_eq!(binding.runtime_gates().min_device_class, DeviceClass::Low);
        assert_eq!(binding.resource_budget().max_memory_bytes, 1024);
        assert_eq!(binding.variant_abi().engine_source_revision, "rev1");
        assert_eq!(
            binding.voice_state_compatibility_group_id(),
            "voice-state-a"
        );
        assert_eq!(binding.selected_file_ids(), &["model".to_owned()]);
        assert!(binding.interoperable());
        assert_eq!(binding.sample_rate_hz(), VAD_SAMPLE_RATE_HZ);
        assert_eq!(binding.channels(), MONO_CHANNELS);
        assert_eq!(binding.frame_size(), 512);
        assert_eq!(binding.languages()[0].language, "en");

        assert_eq!(
            TaskPackBinding::from_selection(VoiceTask::TextToSpeech, &manifest, &selection),
            Err(EngineError::InvalidRequest)
        );

        let request = TaskRequest {
            task: VoiceTask::SpeechToText,
            language: Some("en-US".to_owned()),
            generation: 7,
        };
        assert!(BoundTaskRequest::new(request, binding.clone()).is_ok());
        let wrong_language = TaskRequest {
            task: VoiceTask::SpeechToText,
            language: Some("fr".to_owned()),
            generation: 7,
        };
        assert_eq!(
            BoundTaskRequest::new(wrong_language, binding),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn capabilities_are_inherently_bound_to_verified_selection() {
        let (manifest, selection) = selected(PackTask::Stt);
        let binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
                .expect("binding");
        let capability = TaskCapability::new(binding.clone()).streaming(true);
        assert_eq!(capability.task(), VoiceTask::SpeechToText);
        assert_eq!(capability.sample_rate_hz(), VAD_SAMPLE_RATE_HZ);
        assert_eq!(capability.languages(), &["en".to_owned()]);
        assert_eq!(capability.binding(), &binding);
        assert!(capability.streaming_enabled());
    }

    #[test]
    fn binding_requires_selected_non_revoked_file_for_requested_task() {
        let mut raw = test_manifest(PackTask::Stt);
        raw.files[0].task = PackTask::Tokenizer;
        raw.tasks.push(PackTask::Tokenizer);
        let verified =
            verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier)).expect("valid");
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
                device_memory_mb: None,
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
                cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                device_class: DeviceClass::Low,
                require_interoperable: true,
            },
        )
        .expect("selected");
        assert_eq!(
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &verified, &selection),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn binding_language_none_requires_unambiguous_or_auto_detect_language() {
        let (manifest, selection) = selected(PackTask::Stt);
        let mut binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &manifest, &selection)
                .expect("binding");
        assert!(binding.validate_language(None).is_ok());

        binding.languages.push(LanguageSupport {
            language: "fr".to_owned(),
            locale: None,
            fixed_language: true,
            auto_detect: false,
        });
        assert_eq!(
            binding.validate_language(None),
            Err(EngineError::InvalidRequest)
        );
        assert!(binding.validate_language(Some("fr")).is_ok());
        assert_eq!(
            binding.validate_language(Some("de")),
            Err(EngineError::InvalidRequest)
        );
        binding.languages[1].auto_detect = true;
        assert!(binding.validate_language(None).is_ok());

        let (manifest, selection) = selected(PackTask::Vad);
        let vad_binding = TaskPackBinding::from_selection(
            VoiceTask::VoiceActivityDetection,
            &manifest,
            &selection,
        )
        .expect("vad binding");
        assert!(vad_binding.validate_language(None).is_ok());
    }

    #[test]
    fn flush_and_reset_surfaces_are_distinct_for_vad_streams() {
        fn assert_vad_surface<T: VadStreamProvider>() {}
        assert_vad_surface::<SurfaceVadProvider>();
    }

    #[test]
    fn bound_stream_session_carries_immutable_request_identity() {
        let (manifest, selection) = selected(PackTask::Vad);
        let binding = TaskPackBinding::from_selection(
            VoiceTask::VoiceActivityDetection,
            &manifest,
            &selection,
        )
        .expect("binding");
        let request = BoundTaskRequest::new(
            TaskRequest {
                task: VoiceTask::VoiceActivityDetection,
                language: None,
                generation: 42,
            },
            binding.clone(),
        )
        .expect("bound request");
        let vad = BoundVadRequest::new(request.clone(), VadConfig::default()).expect("bound vad");
        let session = BoundStreamSession::new(StreamSessionId(7), vad.request()).expect("session");

        assert_eq!(session.session_id(), StreamSessionId(7));
        assert_eq!(session.task(), VoiceTask::VoiceActivityDetection);
        assert_eq!(session.generation(), 42);
        assert_eq!(session.binding(), &binding);
        assert!(session.matches_request(&request));
        assert_eq!(
            BoundStreamSession::new(StreamSessionId(0), &request),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn vad_config_enforces_sherpa_shape_and_canonical_audio() {
        let config = VadConfig::default();
        assert_eq!(config.min_silence_samples(), Ok(4_000));
        assert_eq!(config.min_speech_samples(), Ok(4_000));
        assert_eq!(config.max_speech_samples(), Ok(160_000));
        assert_eq!(config.buffer_samples(), Ok(480_000));
        assert_eq!(config.sample_rate_hz(), VAD_SAMPLE_RATE_HZ);
        assert_eq!(config.channels(), MONO_CHANNELS);
        assert_eq!(config.window_size_samples(), VAD_WINDOW_SIZE_SAMPLES);
        assert_eq!(config.threshold(), VAD_DEFAULT_THRESHOLD);

        assert_eq!(
            VadConfig::new(0, 0.5, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, f32::NAN, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.009, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert!(VadConfig::new(512, 0.01, 500, 250, 30_000, 60_000).is_ok());
        assert_eq!(
            VadConfig::new(512, 1.0, 500, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 500, 250, 200, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 0, 250, 30_000, 60_000),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            VadConfig::new(512, 0.5, 500, 250, 30_000, 20_000),
            Err(EngineError::InvalidRequest)
        );
        assert!(VadConfig::new(512, 0.5, 500, 250, 30_000, 30_000).is_ok());
        assert_eq!(
            VadConfig::new(
                512,
                0.5,
                500,
                250,
                VAD_MAX_DURATION_MS + 1,
                VAD_MAX_DURATION_MS + 1
            ),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn vad_samples_validate_exact_windows_and_end_tails() {
        let config = VadConfig::default();
        let exact = vec![0.0; VAD_WINDOW_SIZE_SAMPLES];
        assert!(config.validate_frame_samples(&exact).is_ok());
        assert_eq!(
            config.validate_frame_samples(&[-1.0, 0.0]),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&vec![1.1; VAD_WINDOW_SIZE_SAMPLES]),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&vec![f32::INFINITY; VAD_WINDOW_SIZE_SAMPLES]),
            Err(EngineError::InvalidRequest)
        );
        assert!(
            StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &exact, false).is_ok()
        );
        assert_eq!(
            StreamingAudioFrame::new(1, 8_000, MONO_CHANNELS, &[0.0, 0.0], false).map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, 2, &[0.0, 0.0], false).map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
        let too_long = vec![0.0; MAX_STREAMING_FRAME_SAMPLES + 1];
        assert_eq!(
            StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &too_long, false)
                .map(|_| ()),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            config.validate_frame_samples(&[0.0, 0.0]),
            Err(EngineError::InvalidRequest)
        );
        let tail =
            StreamingAudioFrame::end_tail(2, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &[0.0, 0.0], false)
                .expect("valid tail");
        assert!(tail.is_end_tail());
        assert!(config.validate_end_tail_samples(&[0.0, 0.0]).is_ok());
        assert_eq!(
            config.validate_end_tail_samples(&vec![0.0; VAD_WINDOW_SIZE_SAMPLES + 1]),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn speech_segments_and_frame_results_reject_invalid_ranges() {
        let segment = SpeechSegment::new(1, 2, 160, vec![0.1, -0.1], false).expect("valid segment");
        assert_eq!(segment.end_sample_exclusive(), 162);
        assert_eq!(
            SpeechSegment::new(2, 1, 160, vec![0.1], false),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            SpeechSegment::new(1, 2, 160, vec![1.1], false),
            Err(EngineError::InvalidRequest)
        );
        let result = VadAcceptResult::new(true, vec![segment], None);
        assert!(result.detected());
        assert_eq!(result.segments().len(), 1);
    }

    #[test]
    fn reset_discontinuity_and_cancellation_contracts_are_explicit() {
        let frame = StreamingAudioFrame::new(
            7,
            VAD_SAMPLE_RATE_HZ,
            MONO_CHANNELS,
            &[0.0, 0.1, -0.1],
            true,
        )
        .expect("valid frame");
        assert!(frame.discontinuity());
        let result =
            VadAcceptResult::new(false, Vec::new(), Some(StreamResetReason::Discontinuity));
        assert_eq!(result.reset(), Some(StreamResetReason::Discontinuity));

        assert_eq!(
            check_engine_cancellation(&|| true),
            Err(EngineError::Cancelled)
        );
        assert_eq!(check_engine_cancellation(&|| false), Ok(()));
    }

    #[test]
    fn backend_neutral_configs_validate_without_provider_identifiers() {
        let (kws_manifest, kws_selection) = selected(PackTask::Kws);
        let kws_binding = TaskPackBinding::from_selection(
            VoiceTask::KeywordSpotting,
            &kws_manifest,
            &kws_selection,
        )
        .expect("kws binding");
        let kws_config =
            KwsConfig::new(["wake.main"], "phrases:v1", 0.5, 0, 1).expect("valid config");
        assert!(kws_config.validate_binding(&kws_binding).is_ok());
        assert!(BoundKwsRequest::new(
            BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::KeywordSpotting,
                    language: Some("en".to_owned()),
                    generation: 9,
                },
                kws_binding.clone(),
            )
            .expect("bound task"),
            kws_config.clone(),
        )
        .is_ok());
        assert_eq!(
            KwsConfig::new(["wake.main"], "phrases:v1", 0.5, 0, 0),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            KwsConfig::new(["/tmp/model"], "phrases:v1", 0.5, 0, 4),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            KwsConfig::new(["wake.main", "wake.main"], "phrases:v1", 0.5, 0, 4),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            KwsConfig::new(
                ["wake.main"],
                "phrases:v1",
                0.5,
                MAX_KWS_COOLDOWN_FRAMES + 1,
                1
            ),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            KwsConfig::new(["wake.main"], "phrases:v1", 0.5, 0, MAX_KWS_RESULTS + 1),
            Err(EngineError::InvalidRequest)
        );
        let too_many_phrases = (0..=MAX_KWS_PHRASES).map(|index| format!("wake.{index}"));
        assert_eq!(
            KwsConfig::new(too_many_phrases, "phrases:v1", 0.5, 0, 4),
            Err(EngineError::InvalidRequest)
        );

        let (stt_manifest, stt_selection) = selected(PackTask::Stt);
        let stt_binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &stt_manifest, &stt_selection)
                .expect("stt binding");
        assert!(StreamingSttConfig::new(Some("en-US"), true, true)
            .expect("valid stt")
            .validate_binding(&stt_binding)
            .is_ok());
        assert!(BoundStreamingSttRequest::new(
            BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::SpeechToText,
                    language: Some("en-US".to_owned()),
                    generation: 10,
                },
                stt_binding.clone(),
            )
            .expect("bound task"),
            StreamingSttConfig::new(Some("en-US"), true, true).expect("valid stt"),
        )
        .is_ok());
        assert_eq!(
            StreamingSttConfig::new(Some("/tmp/model"), true, true),
            Err(EngineError::InvalidRequest)
        );

        let (tts_manifest, tts_selection) = selected(PackTask::Tts);
        let tts_binding =
            TaskPackBinding::from_selection(VoiceTask::TextToSpeech, &tts_manifest, &tts_selection)
                .expect("tts binding");
        let tts_config = TtsSynthesisConfig::new(
            "voice.default",
            "voice-state-a",
            VAD_SAMPLE_RATE_HZ,
            1024,
            None,
        )
        .expect("valid tts");
        assert!(tts_config.validate_binding(&tts_binding).is_ok());
        assert!(BoundTtsSynthesisRequest::new(
            BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::TextToSpeech,
                    language: Some("en".to_owned()),
                    generation: 11,
                },
                tts_binding.clone(),
            )
            .expect("bound task"),
            "hello",
            tts_config.clone(),
        )
        .is_ok());
        assert!(TtsSynthesisConfig::default().validate().is_ok());
        assert_eq!(
            TtsSynthesisConfig::new("/tmp/voice", "state:v1", VAD_SAMPLE_RATE_HZ, 1024, None),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            TtsSynthesisConfig::new("voice.default", "voice-state-a", 7_999, 1024, None),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            TtsSynthesisConfig::new(
                "voice.default",
                "voice-state-a",
                VAD_SAMPLE_RATE_HZ,
                TTS_MAX_CHUNK_SAMPLES + 1,
                None,
            ),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            BoundTtsSynthesisRequest::new(
                BoundTaskRequest::new(
                    TaskRequest {
                        task: VoiceTask::TextToSpeech,
                        language: Some("en".to_owned()),
                        generation: 12,
                    },
                    tts_binding,
                )
                .expect("bound task"),
                " ",
                tts_config,
            ),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn finite_stt_result_is_typed_and_bounded_to_request() {
        let finite_request = bound_finite_stt_request(21, 2);
        let (_built_request, audio) = FiniteSttAudio::from_frames(
            finite_request
                .local_request()
                .expect("local request")
                .clone(),
            vec![vec![0.0, 0.1], vec![-0.1]],
        )
        .expect("finite audio");
        let result = FiniteSttResult::new(&finite_request, &audio, "hello").expect("finite result");
        assert_eq!(result.transcript(), "hello");
        assert_eq!(result.frames(), 2);
        assert_eq!(result.generation(), 21);
        assert_eq!(
            FiniteSttResult::new(
                &finite_request,
                &audio,
                "x".repeat(MAX_FINITE_STT_TRANSCRIPT_BYTES + 1)
            ),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            FiniteSttResult::new(&finite_request, &audio, "bad\u{0000}text"),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn finite_stt_audio_is_bounded_and_tied_to_exact_request() {
        let request = bound_finite_stt_request(22, 2);
        let local_request = request.local_request().expect("local request").clone();
        assert_eq!(
            FiniteSttAudio::from_frames(local_request.clone(), Vec::<Vec<f32>>::new()),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            FiniteSttAudio::from_frames(local_request.clone(), vec![vec![1.1], vec![0.0]]),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            FiniteSttAudio::from_frames(
                local_request.clone(),
                vec![vec![0.0; MAX_STREAMING_FRAME_SAMPLES + 1], vec![0.0]]
            ),
            Err(EngineError::InvalidRequest)
        );
        let oversized_frame_samples = MAX_FINITE_STT_SAMPLES / 5 + 1;
        assert_eq!(
            FiniteSttAudio::from_frames(
                local_request.clone(),
                vec![
                    vec![0.0; oversized_frame_samples],
                    vec![0.0; oversized_frame_samples],
                    vec![0.0; oversized_frame_samples],
                    vec![0.0; oversized_frame_samples],
                    vec![0.0; oversized_frame_samples],
                ]
            ),
            Err(EngineError::InvalidRequest)
        );
        let (built_request, audio) =
            FiniteSttAudio::from_frames(local_request.clone(), vec![vec![0.25], vec![-0.25]])
                .expect("valid audio");
        assert_eq!(built_request, request);
        assert_eq!(audio.frames(), 2);
        assert_eq!(audio.samples(), &[0.25, -0.25]);
        assert_eq!(audio.generation(), 22);
        assert_eq!(audio.sample_rate_hz(), VAD_SAMPLE_RATE_HZ);
        assert_eq!(audio.channels(), MONO_CHANNELS);

        let other_request = bound_finite_stt_request(23, 2);
        assert_eq!(
            FiniteSttResult::new(&other_request, &audio, "hello"),
            Err(EngineError::InvalidRequest)
        );

        let debug = format!("{audio:?}");
        assert!(debug.contains("sample_count: 2"));
        assert!(!debug.contains("0.25"));
        assert!(!debug.contains("-0.25"));

        let mut builder = FiniteSttAudioBuilder::new(local_request).expect("builder");
        builder.push_frame(&[0.123, -0.456]).expect("push");
        let builder_debug = format!("{builder:?}");
        assert!(builder_debug.contains("sample_count: 2"));
        assert!(!builder_debug.contains("0.123"));
        assert!(!builder_debug.contains("-0.456"));
    }

    #[test]
    fn route_finite_stt_requests_keep_identity_strict_bounds_and_redaction() {
        let secret_route = "route.SECRET_STT_ROUTE_DO_NOT_LEAK_4d3c2b";
        let base = route_finite_stt_request(61, 2, secret_route, 9, 4);
        let local = bound_finite_stt_request(61, 2);
        assert_ne!(base.identity(), local.identity());
        assert!(base.request().is_none());
        assert!(base.local_request().is_none());
        assert_eq!(
            base.route_request().expect("route request").generation(),
            61
        );
        let mut builder =
            FiniteSttAudioBuilder::new_route(base.route_request().expect("route request").clone())
                .expect("route builder");
        builder.push_frame(&[0.1, -0.1]).expect("first frame");
        builder.push_frame(&[0.2, -0.2]).expect("second frame");
        let (built_request, audio) = builder.finish().expect("route audio");
        assert_eq!(built_request, base);
        assert_eq!(audio.samples(), &[0.1, -0.1, 0.2, -0.2]);
        FiniteSttResult::new(&base, &audio, "route transcript").expect("route result");

        let different_generation = route_finite_stt_request(62, 2, secret_route, 9, 4);
        assert_eq!(
            FiniteSttResult::new(&different_generation, &audio, "route transcript"),
            Err(EngineError::InvalidRequest)
        );
        let different_revision = route_finite_stt_request(61, 2, secret_route, 10, 4);
        assert_eq!(
            FiniteSttResult::new(&different_revision, &audio, "route transcript"),
            Err(EngineError::InvalidRequest)
        );

        let mut too_large =
            FiniteSttAudioBuilder::new_route(base.route_request().expect("route request").clone())
                .expect("route builder");
        assert_eq!(
            too_large.push_frame(&[0.0; 5]),
            Err(EngineError::InvalidRequest)
        );

        let debug = format!("{base:?} {audio:?}");
        assert!(debug.contains("FiniteSttBinding::Route"));
        assert!(!debug.contains(secret_route));
        assert!(!debug.contains("SECRET_STT_ROUTE"));
        assert!(!debug.contains("route transcript"));
        assert!(!debug.contains("0.1"));
        let encoded_binding =
            serde_json::to_string(base.route_request().expect("route request").route())
                .expect("redacted route binding serializes");
        assert!(encoded_binding.contains("route_id_bytes"));
        assert!(encoded_binding.contains("loopback_sidecar"));
        assert!(!encoded_binding.contains(secret_route));
        assert!(!encoded_binding.contains("SECRET_STT_ROUTE"));
        let encoded_request = serde_json::to_string(base.route_request().expect("route request"))
            .expect("redacted route request serializes");
        assert!(encoded_request.contains("\"generation\":61"));
        assert!(encoded_request.contains("language_present"));
        assert!(!encoded_request.contains(secret_route));
        assert!(!encoded_request.contains("SECRET_STT_ROUTE"));
        assert!(!encoded_request.contains("\"en\""));
    }

    #[test]
    fn stt_debug_output_redacts_transcript_text() {
        let secret = "SECRET_STT_TRANSCRIPT_DO_NOT_LEAK_6c5b4a";
        let (stt_manifest, stt_selection) = selected(PackTask::Stt);
        let stt_binding =
            TaskPackBinding::from_selection(VoiceTask::SpeechToText, &stt_manifest, &stt_selection)
                .expect("stt binding");
        let task_request = BoundTaskRequest::new(
            TaskRequest {
                task: VoiceTask::SpeechToText,
                language: Some("en".to_owned()),
                generation: 31,
            },
            stt_binding,
        )
        .expect("bound stt task");
        let finite_request = BoundFiniteSttRequest::new(task_request, 3).expect("finite request");
        let (_built_request, audio) = FiniteSttAudio::from_frames(
            finite_request
                .local_request()
                .expect("local request")
                .clone(),
            vec![vec![0.0], vec![0.1], vec![-0.1]],
        )
        .expect("finite audio");
        let finite = FiniteSttResult::new(&finite_request, &audio, secret).expect("finite result");
        let finite_debug = format!("{finite:?}");
        assert!(finite_debug.contains("transcript_bytes"));
        assert!(!finite_debug.contains(secret));
        assert!(!finite_debug.contains("SECRET_STT_TRANSCRIPT"));

        let partial =
            TranscriptSegment::new(secret, Some(10), Some(20), false).expect("partial segment");
        let final_segment =
            TranscriptSegment::new("final text", Some(20), Some(40), true).expect("final segment");
        let segment_debug = format!("{partial:?}");
        assert!(segment_debug.contains("text_bytes"));
        assert!(!segment_debug.contains(secret));
        let streaming = StreamingSttResult::new(
            vec![partial, final_segment],
            Some(StreamResetReason::Manual),
            true,
        );
        let streaming_debug = format!("{streaming:?}");
        assert!(streaming_debug.contains("segment_count: 2"));
        assert!(streaming_debug.contains("final_segment_count: 1"));
        assert!(!streaming_debug.contains(secret));
        assert!(!streaming_debug.contains("final text"));
    }

    #[test]
    fn kws_results_are_limited_to_configured_phrase_set() {
        let config =
            KwsConfig::new(["wake.a", "wake.b"], "phrases:v1", 0.5, 0, 2).expect("valid config");
        let first = KeywordMatch::new("wake.a", 0.9, 10).expect("match");
        let second = KeywordMatch::new("wake.b", 0.8, 11).expect("match");
        let mut cooldown = KwsCooldownState::new();
        assert!(
            KwsFrameResult::new(&config, &mut cooldown, vec![first.clone(), second], None).is_ok()
        );
        let mut cooldown = KwsCooldownState::new();
        assert_eq!(
            KwsFrameResult::new(&config, &mut cooldown, vec![first.clone(), first], None),
            Err(EngineError::InvalidRequest)
        );
        let unknown = KeywordMatch::new("wake.c", 0.7, 12).expect("match");
        let mut cooldown = KwsCooldownState::new();
        assert_eq!(
            KwsFrameResult::new(&config, &mut cooldown, vec![unknown], None),
            Err(EngineError::InvalidRequest)
        );
        let capped =
            KwsConfig::new(["wake.a", "wake.b"], "phrases:v1", 0.5, 0, 1).expect("valid config");
        let first = KeywordMatch::new("wake.a", 0.9, 10).expect("match");
        let second = KeywordMatch::new("wake.b", 0.8, 11).expect("match");
        let mut cooldown = KwsCooldownState::new();
        assert_eq!(
            KwsFrameResult::new(&capped, &mut cooldown, vec![first, second], None),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn kws_cooldown_is_enforced_across_frames_until_reset() {
        let config = KwsConfig::new(["wake.a"], "phrases:v1", 0.5, 2, 1).expect("valid config");
        let mut cooldown = KwsCooldownState::new();
        let first = KeywordMatch::new("wake.a", 0.9, 10).expect("match");
        KwsFrameResult::new(&config, &mut cooldown, vec![first], None).expect("first match");
        let suppressed = KeywordMatch::new("wake.a", 0.9, 12).expect("match");
        assert_eq!(
            KwsFrameResult::new(&config, &mut cooldown, vec![suppressed], None),
            Err(EngineError::InvalidRequest)
        );
        let allowed = KeywordMatch::new("wake.a", 0.9, 13).expect("match");
        KwsFrameResult::new(&config, &mut cooldown, vec![allowed], None).expect("after cooldown");
        let reset_allowed = KeywordMatch::new("wake.a", 0.9, 14).expect("match");
        KwsFrameResult::new(
            &config,
            &mut cooldown,
            vec![reset_allowed],
            Some(StreamResetReason::Manual),
        )
        .expect("reset clears cooldown");
    }

    #[test]
    fn kws_debug_output_redacts_keyword_identifiers() {
        let keyword_secret = "wake.SECRET_KEYWORD_DO_NOT_LEAK_5d4c3b";
        let revision_secret = "phrases.SECRET_REVISION_DO_NOT_LEAK_5d4c3b";
        let config =
            KwsConfig::new([keyword_secret], revision_secret, 0.5, 0, 1).expect("valid config");
        let config_debug = format!("{config:?}");
        assert!(config_debug.contains("phrase_count: 1"));
        assert!(config_debug.contains("phrase_set_revision_bytes"));
        assert!(!config_debug.contains(keyword_secret));
        assert!(!config_debug.contains(revision_secret));

        let keyword_match = KeywordMatch::new(keyword_secret, 0.9, 17).expect("match");
        let match_debug = format!("{keyword_match:?}");
        assert!(match_debug.contains("keyword_id_bytes"));
        assert!(!match_debug.contains(keyword_secret));

        let mut cooldown = KwsCooldownState::new();
        let result =
            KwsFrameResult::new(&config, &mut cooldown, vec![keyword_match], None).expect("result");
        let result_debug = format!("{result:?}");
        assert!(result_debug.contains("match_count: 1"));
        assert!(!result_debug.contains(keyword_secret));
        assert!(!result_debug.contains(revision_secret));
    }

    #[test]
    fn tts_chunks_are_bounded_by_active_config() {
        let request = bound_tts_request(11, 1024);
        let full = TtsAudioChunk::new(&request, 1, 16_000, MONO_CHANNELS, vec![0; 1024], false)
            .expect("full chunk");
        let tail = TtsAudioChunk::new(&request, 2, 16_000, MONO_CHANNELS, vec![0; 12], true)
            .expect("short final tail");
        assert_eq!(tail.samples().len(), 12);
        assert_eq!(
            TtsAudioChunk::new(&request, 3, 16_000, MONO_CHANNELS, vec![0; 12], false),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            TtsAudioChunk::new(&request, 4, 48_001, MONO_CHANNELS, vec![0; 1024], false),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            TtsAudioChunk::new(&request, 5, 16_000, MONO_CHANNELS, vec![0; 1025], true),
            Err(EngineError::InvalidRequest)
        );
        let result =
            TtsSynthesisResult::new(&request, vec![full, tail], false).expect("tts result");
        assert_eq!(result.chunk_count(), 2);
        assert_eq!(
            TtsSynthesisResult::new(&request, Vec::new(), false),
            Err(EngineError::InvalidRequest)
        );
        assert!(TtsSynthesisResult::new(&request, Vec::new(), true).is_ok());
    }

    #[test]
    fn tts_results_reject_missing_duplicate_or_nonterminal_final_chunks() {
        let request = bound_tts_request(12, 1024);
        let first = TtsAudioChunk::new(&request, 1, 16_000, MONO_CHANNELS, vec![0; 1024], false)
            .expect("first chunk");
        let middle_final =
            TtsAudioChunk::new(&request, 2, 16_000, MONO_CHANNELS, vec![0; 12], true)
                .expect("middle final");
        let after_final = TtsAudioChunk::new(&request, 3, 16_000, MONO_CHANNELS, vec![0; 12], true)
            .expect("second final tail");
        assert_eq!(
            TtsSynthesisResult::new(
                &request,
                vec![first.clone(), middle_final.clone(), after_final],
                false,
            ),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            TtsSynthesisResult::new(&request, vec![first.clone()], false),
            Err(EngineError::InvalidRequest)
        );
        let mismatched_request = bound_tts_request(13, 1024);
        assert_eq!(
            TtsSynthesisResult::new(&mismatched_request, vec![first, middle_final], false),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn tts_request_identity_rejects_semantic_request_collisions() {
        let base_binding = tts_binding("voice-state-a");
        let base = bound_tts_request_with(
            base_binding.clone(),
            30,
            "hello",
            "voice.default",
            None,
            1024,
        );
        let exact =
            TtsAudioChunk::new(&base, 1, 16_000, MONO_CHANNELS, vec![0; 12], true).expect("chunk");
        TtsSynthesisResult::new(&base, vec![exact.clone()], false).expect("exact request accepts");

        let different_text = bound_tts_request_with(
            base_binding.clone(),
            30,
            "hello again",
            "voice.default",
            None,
            1024,
        );
        assert_eq!(
            TtsSynthesisResult::new(&different_text, vec![exact.clone()], false),
            Err(EngineError::InvalidRequest)
        );

        let different_voice =
            bound_tts_request_with(base_binding.clone(), 30, "hello", "voice.other", None, 1024);
        assert_eq!(
            TtsSynthesisResult::new(&different_voice, vec![exact.clone()], false),
            Err(EngineError::InvalidRequest)
        );

        let different_seed = bound_tts_request_with(
            base_binding.clone(),
            30,
            "hello",
            "voice.default",
            Some(99),
            1024,
        );
        assert_eq!(
            TtsSynthesisResult::new(&different_seed, vec![exact.clone()], false),
            Err(EngineError::InvalidRequest)
        );

        let different_chunk_config = bound_tts_request_with(
            base_binding.clone(),
            30,
            "hello",
            "voice.default",
            None,
            512,
        );
        assert_eq!(
            TtsSynthesisResult::new(&different_chunk_config, vec![exact.clone()], false),
            Err(EngineError::InvalidRequest)
        );

        let different_compatibility = bound_tts_request_with(
            tts_binding("voice-state-b"),
            30,
            "hello",
            "voice.default",
            None,
            1024,
        );
        assert_eq!(
            TtsSynthesisResult::new(&different_compatibility, vec![exact], false),
            Err(EngineError::InvalidRequest)
        );

        let mismatched_config_chunk = TtsAudioChunk::new(
            &different_chunk_config,
            1,
            16_000,
            MONO_CHANNELS,
            vec![0; 12],
            true,
        )
        .expect("different config chunk");
        assert_eq!(
            TtsSynthesisResult::new(&base, vec![mismatched_config_chunk], false),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn tts_bound_request_debug_redacts_text_and_internal_identity_material() {
        let secret = "SECRET_TTS_TEXT_DO_NOT_LEAK_9f8e7d6c";
        let request = bound_tts_request_with(
            tts_binding("voice-state-secret"),
            41,
            secret,
            "voice.secret",
            Some(7),
            1024,
        );
        let debug = format!("{request:?}");
        assert!(debug.contains("BoundTtsSynthesisRequest"));
        assert!(debug.contains("text_bytes"));
        assert!(debug.contains("identity: TtsRequestIdentity(<redacted>)"));
        assert!(!debug.contains(secret));
        assert!(!debug.contains("voice.secret"));
        assert!(!debug.contains("voice-state-secret"));
        assert!(!debug.contains("SECRET_TTS_TEXT"));
    }

    #[test]
    fn route_tts_requests_keep_identity_strict_and_serialization_redacted() {
        let secret_route = "route.SECRET_TTS_ROUTE_DO_NOT_LEAK_7c6b5a";
        let base = route_tts_request_with(51, "hello", secret_route, 3);
        assert!(base.request().is_none());
        assert!(base.local_request().is_none());
        assert_eq!(
            base.route_request().expect("route request").generation(),
            51
        );
        let chunk =
            TtsAudioChunk::new(&base, 1, 16_000, MONO_CHANNELS, vec![7; 12], true).expect("chunk");
        TtsSynthesisResult::new(&base, vec![chunk.clone()], false).expect("exact route accepts");

        let different_generation = route_tts_request_with(52, "hello", secret_route, 3);
        assert_eq!(
            TtsSynthesisResult::new(&different_generation, vec![chunk.clone()], false),
            Err(EngineError::InvalidRequest)
        );

        let different_revision = route_tts_request_with(51, "hello", secret_route, 4);
        assert_eq!(
            TtsSynthesisResult::new(&different_revision, vec![chunk], false),
            Err(EngineError::InvalidRequest)
        );

        let debug = format!("{base:?}");
        assert!(debug.contains("TtsSynthesisBinding::Route"));
        assert!(!debug.contains(secret_route));
        assert!(!debug.contains("SECRET_TTS_ROUTE"));
        assert!(!debug.contains("hello"));
        let encoded = serde_json::to_string(base.route_request().expect("route request"))
            .expect("redacted route request serializes");
        assert!(encoded.contains("route_id_bytes"));
        assert!(encoded.contains("\"generation\":51"));
        assert!(!encoded.contains(secret_route));
        assert!(!encoded.contains("SECRET_TTS_ROUTE"));
        assert!(!encoded.contains("\"en\""));
    }

    #[test]
    fn tts_config_debug_redacts_voice_and_group_identifiers() {
        let voice_secret = "voice.SECRET_CONFIG_VOICE_DO_NOT_LEAK_4b3a2f";
        let group_secret = "voice-state.SECRET_CONFIG_GROUP_DO_NOT_LEAK_4b3a2f";
        let config = TtsSynthesisConfig::new(
            voice_secret,
            group_secret,
            VAD_SAMPLE_RATE_HZ,
            1024,
            Some(11),
        )
        .expect("valid config");
        let debug = format!("{config:?}");
        assert!(debug.contains("logical_voice_id_bytes"));
        assert!(debug.contains("voice_state_compatibility_group_id_bytes"));
        assert!(debug.contains("seed_present: true"));
        assert!(!debug.contains(voice_secret));
        assert!(!debug.contains(group_secret));
        assert!(!debug.contains("SECRET_CONFIG_VOICE"));
        assert!(!debug.contains("SECRET_CONFIG_GROUP"));
    }

    #[test]
    fn debug_output_redacts_audio_sample_values() {
        let frame = StreamingAudioFrame::new(
            1,
            VAD_SAMPLE_RATE_HZ,
            MONO_CHANNELS,
            &[0.123, -0.456],
            false,
        )
        .expect("valid frame");
        let frame_debug = format!("{frame:?}");
        assert!(frame_debug.contains("sample_count: 2"));
        assert!(!frame_debug.contains("0.123"));
        assert!(!frame_debug.contains("-0.456"));

        let segment =
            SpeechSegment::new(1, 1, 0, vec![0.123, -0.456], true).expect("valid segment");
        let segment_debug = format!("{segment:?}");
        assert!(segment_debug.contains("sample_count: 2"));
        assert!(!segment_debug.contains("0.123"));
        assert!(!segment_debug.contains("-0.456"));

        let result = VadAcceptResult::new(true, vec![segment], Some(StreamResetReason::Manual));
        let result_debug = format!("{result:?}");
        assert!(result_debug.contains("segment_count: 1"));
        assert!(!result_debug.contains("0.123"));
        assert!(!result_debug.contains("-0.456"));

        let tts_request = bound_tts_request(14, 1024);
        let chunk = TtsAudioChunk::new(
            &tts_request,
            1,
            16_000,
            MONO_CHANNELS,
            vec![123, -456],
            true,
        )
        .expect("valid chunk");
        let chunk_debug = format!("{chunk:?}");
        assert!(chunk_debug.contains("sample_count: 2"));
        assert!(!chunk_debug.contains("123"));
        assert!(!chunk_debug.contains("-456"));
        let identity_debug = format!("{:?}", chunk.request_identity());
        assert!(identity_debug.contains("<redacted>"));
        assert!(!identity_debug.contains("hello"));
    }

    #[test]
    fn speech_catalog_binding_carries_exact_selected_files_and_metadata() {
        let catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let entry = catalog
            .model("kws:zipformer:gigaspeech")
            .expect("kws model");
        let binding = TaskPackBinding::from_speech_catalog_entry(
            catalog,
            entry,
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
        )
        .expect("catalog binding");

        assert_eq!(binding.task(), VoiceTask::KeywordSpotting);
        assert_eq!(binding.pack_id(), "kws:zipformer:gigaspeech");
        assert_eq!(binding.pack_version(), catalog.revision());
        assert_eq!(binding.variant_id(), entry.archive.sha256);
        assert_eq!(
            binding.selected_file_ids(),
            &[
                "decoder".to_owned(),
                "encoder".to_owned(),
                "joiner".to_owned(),
                "tokenizer".to_owned(),
                "tokens".to_owned()
            ]
        );
        assert!(matches!(
            binding.source(),
            TaskBindingSource::SpeechCatalog { catalog_id, catalog_revision, archive_sha256, .. }
                if catalog_id == catalog.catalog_id()
                    && catalog_revision == catalog.revision()
                    && archive_sha256 == &entry.archive.sha256
        ));
        let debug = format!("{binding:?}");
        assert!(debug.contains("TaskBindingSource::SpeechCatalog"));
        assert!(debug.contains("catalog_id_bytes"));
        assert!(!debug.contains(catalog.catalog_id()));
        assert!(!debug.contains(&entry.archive.sha256));
    }

    #[test]
    fn speech_catalog_binding_rejects_wrong_or_ambiguous_ids() {
        let catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let mut entry = catalog
            .model("vad:silero:current")
            .expect("vad model")
            .clone();
        entry.model_id = "kws:zipformer:gigaspeech".to_owned();
        assert_eq!(
            TaskPackBinding::from_speech_catalog_entry(
                catalog,
                &entry,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
            ),
            Err(EngineError::InvalidRequest)
        );

        let entry = catalog.model("vad:silero:current").expect("vad model");
        let binding = TaskPackBinding::from_speech_catalog_entry(
            catalog,
            entry,
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
        )
        .expect("vad binding");
        assert_eq!(binding.selected_file_ids(), &["model".to_owned()]);
        assert_eq!(binding.languages(), &[]);
        assert!(BoundTaskRequest::new(
            TaskRequest {
                task: VoiceTask::VoiceActivityDetection,
                language: Some("en".to_owned()),
                generation: 1,
            },
            binding,
        )
        .is_err());
    }

    #[test]
    fn speech_catalog_binding_rejects_same_id_mutated_entry_provenance() {
        let catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let entry = catalog
            .model("kws:zipformer:gigaspeech")
            .expect("kws model");

        let mut mutated_hash = entry.clone();
        mutated_hash.archive.sha256 = "0".repeat(64);
        assert_eq!(
            TaskPackBinding::from_speech_catalog_entry(
                catalog,
                &mutated_hash,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
            ),
            Err(EngineError::InvalidRequest)
        );

        let mut mutated_bindings = entry.clone();
        mutated_bindings
            .bindings
            .insert("tokens".to_owned(), "tampered/tokens.txt".to_owned());
        assert_eq!(
            TaskPackBinding::from_speech_catalog_entry(
                catalog,
                &mutated_bindings,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
            ),
            Err(EngineError::InvalidRequest)
        );

        let mut mutated_language_scope = entry.clone();
        mutated_language_scope.language_scope = "multilingual".to_owned();
        assert_eq!(
            TaskPackBinding::from_speech_catalog_entry(
                catalog,
                &mutated_language_scope,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
            ),
            Err(EngineError::InvalidRequest)
        );

        let mut mutated_model_family = entry.clone();
        mutated_model_family.model_family = "zipformer_shadow".to_owned();
        assert_eq!(
            TaskPackBinding::from_speech_catalog_entry(
                catalog,
                &mutated_model_family,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
            ),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn tts_catalog_binding_requires_installed_sample_rate_metadata() {
        let catalog = TtsVoiceCatalog::embedded().expect("tts catalog");
        let entry = catalog
            .voice("standard:piper:en_us-ljspeech-medium")
            .expect("voice");
        assert_eq!(
            TaskPackBinding::from_tts_catalog_entry(
                catalog,
                entry,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                0,
            ),
            Err(EngineError::InvalidRequest)
        );
        let binding = TaskPackBinding::from_tts_catalog_entry(
            catalog,
            entry,
            RuntimeTarget::Desktop,
            TargetOs::Linux,
            TargetArch::X86_64,
            22_050,
        )
        .expect("tts binding");
        assert_eq!(binding.task(), VoiceTask::TextToSpeech);
        assert_eq!(binding.sample_rate_hz(), 22_050);
        assert_eq!(
            binding.selected_file_ids(),
            &[
                "config".to_owned(),
                "espeak-ng-data".to_owned(),
                "model".to_owned(),
                "model-card".to_owned(),
                "tokens".to_owned()
            ]
        );
        assert_eq!(binding.languages()[0].language, "en-us");
    }

    #[test]
    fn tts_catalog_binding_rejects_same_id_mutated_entry_provenance() {
        let catalog = TtsVoiceCatalog::embedded().expect("tts catalog");
        let entry = catalog
            .voice("standard:piper:en_us-ljspeech-medium")
            .expect("voice");

        let mut mutated_hash = entry.clone();
        mutated_hash.archive.sha256 = "0".repeat(64);
        assert_eq!(
            TaskPackBinding::from_tts_catalog_entry(
                catalog,
                &mutated_hash,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                22_050,
            ),
            Err(EngineError::InvalidRequest)
        );

        let mut mutated_bindings = entry.clone();
        mutated_bindings.bindings.tokens = "tampered/tokens.txt".to_owned();
        assert_eq!(
            TaskPackBinding::from_tts_catalog_entry(
                catalog,
                &mutated_bindings,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                22_050,
            ),
            Err(EngineError::InvalidRequest)
        );

        let mut mutated_language = entry.clone();
        mutated_language.language = "en".to_owned();
        assert_eq!(
            TaskPackBinding::from_tts_catalog_entry(
                catalog,
                &mutated_language,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                22_050,
            ),
            Err(EngineError::InvalidRequest)
        );

        let mut mutated_model_family = entry.clone();
        mutated_model_family.model_family = "vits_piper_shadow".to_owned();
        assert_eq!(
            TaskPackBinding::from_tts_catalog_entry(
                catalog,
                &mutated_model_family,
                RuntimeTarget::Desktop,
                TargetOs::Linux,
                TargetArch::X86_64,
                22_050,
            ),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn serializes_product_safe_stream_values() {
        let result = StreamingSttResult::new(
            vec![TranscriptSegment::new("hello", Some(0), Some(100), true).expect("segment")],
            Some(StreamResetReason::Manual),
            true,
        );
        let encoded = serde_json::to_string(&result).expect("serializes");
        assert!(encoded.contains("\"completed\":true"));
        assert!(!encoded.contains("provider"));

        let kws_config =
            KwsConfig::new(["wake-main"], "phrases:v1", 0.5, 0, 1).expect("valid kws config");
        let kws = KwsFrameResult::new(
            &kws_config,
            &mut KwsCooldownState::new(),
            vec![KeywordMatch::new("wake-main", 0.9, 10).expect("match")],
            None,
        )
        .expect("kws result");
        let encoded = serde_json::to_string(&kws).expect("serializes");
        assert!(encoded.contains("wake-main"));
        assert!(!encoded.contains("provider"));
    }
}
