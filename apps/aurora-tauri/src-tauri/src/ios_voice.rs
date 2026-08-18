//! C ABI for the Swift-owned iOS audio host and Rust voice session.
//!
//! The opaque session owns the Rust input/output queues. The audio state and
//! output pointers borrowed from it are valid only until the session is freed.

use aurora_voice_core::CancellationToken;
use aurora_voice_engine::{
    PackTask, SpeechCatalogTask, SpeechModelCatalog, TtsVoiceCatalog, VoiceTask,
};
use aurora_voice_ios_bridge::{AuroraIosAudioOutput, AuroraIosAudioState};
use aurora_voice_native::{
    GatewayAuth, IosTtsReferenceBinding, IosVoicePackBinding, IosVoicePackBindings,
    IosVoicePackFileBinding, IosVoiceSession, IosVoiceSessionCommandError, IosVoiceSessionConfig,
    IosVoiceSessionStatus, SpeechModelBindings, SpeechPackBindings, SpeechPackManager,
    SpeechPackManagerConfig, MAX_IOS_PACK_BINDINGS,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use tokio::runtime::Builder as TokioRuntimeBuilder;
use url::Url;

pub const AURORA_IOS_VOICE_OK: i32 = 0;
pub const AURORA_IOS_VOICE_INVALID_ARGUMENT: i32 = -1;
pub const AURORA_IOS_VOICE_UNAVAILABLE: i32 = 1;
pub const AURORA_IOS_VOICE_ALREADY_ACTIVE: i32 = 2;
pub const AURORA_IOS_VOICE_NOT_ACTIVE: i32 = 3;
pub const AURORA_IOS_VOICE_CLOSED: i32 = 4;
pub const AURORA_IOS_VOICE_PACK_OK: i32 = 0;
pub const AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT: i32 = -1;
pub const AURORA_IOS_VOICE_PACK_UNAVAILABLE: i32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuroraIosVoiceSessionStatus {
    pub active: u32,
    pub phase: i64,
    pub has_generation: u32,
    pub generation: u64,
    pub completed_turns: u64,
    pub failed_turns: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuroraIosVoiceTaskPackBinding {
    /// 1=kws, 2=wakeword, 3=vad, 4=stt, 5=tts.
    pub task: i32,
    /// Optional NUL-terminated UTF-8 slot id. Null means the default slot.
    pub slot_id: *const c_char,
    /// Required NUL-terminated UTF-8 exact pack id selected by Swift.
    pub pack_id: *const c_char,
    /// Required NUL-terminated UTF-8 active pack path selected by Swift.
    pub pack_path: *const c_char,
    /// Required NUL-terminated lowercase hex SHA-256 selected by Swift.
    pub expected_sha256: *const c_char,
    /// Required exact byte size selected by Swift.
    pub expected_size_bytes: u64,
    /// Required NUL-terminated runtime/catalog revision selected by Swift.
    pub runtime_revision: *const c_char,
    /// Required NUL-terminated JSON array of exact local files selected by Swift.
    pub files_json: *const c_char,
    /// Required NUL-terminated BCP-47 language selected by Swift.
    pub language: *const c_char,
    /// Required audio sample rate selected from the catalog.
    pub sample_rate_hz: u32,
    /// Required provider frame size selected from the catalog.
    pub frame_size: u32,
    /// Required catalog model family selected from the catalog.
    pub model_family: *const c_char,
    /// Optional private PocketTTS reference-audio file selected by the user.
    pub reference_audio_path: *const c_char,
    /// Optional lowercase SHA-256 for the private reference-audio file.
    pub reference_audio_sha256: *const c_char,
    /// Optional exact byte size for the private reference-audio file.
    pub reference_audio_size_bytes: u64,
    /// Optional reference-audio sample rate.
    pub reference_audio_sample_rate_hz: u32,
    /// Optional user-provided reference text paired with the audio.
    pub reference_text: *const c_char,
    /// Optional user-managed reference profile revision.
    pub reference_revision: *const c_char,
}

#[derive(Debug, Deserialize)]
struct AuroraIosVoiceTaskPackFileJson {
    file_id: String,
    path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraIosResolvedVoicePack {
    pack_id: String,
    task: String,
    archive_sha256: String,
    archive_path: String,
    root: Option<String>,
    files: BTreeMap<String, String>,
    languages: Vec<String>,
    language: Option<String>,
    sample_rate_hz: u32,
    frame_size: u32,
    model_family: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraIosEmbeddedCatalogEntry {
    pack_id: String,
    display_name: String,
    language: String,
    task: String,
    download_url: String,
    sha256: String,
    file_size: u64,
    file_name: String,
    runtime_revision: String,
    license: String,
    attribution: String,
    acknowledged: bool,
    version: Option<String>,
    compatible_platforms: Vec<String>,
    compatible_architectures: Vec<String>,
    model_family: String,
    requires_reference_audio: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_audio_mode: Option<String>,
    model_files: Vec<AuroraIosEmbeddedCatalogModelFile>,
    sample_rate_hz: u32,
    frame_size: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuroraIosEmbeddedCatalogModelFile {
    file_id: String,
    relative_path: String,
    sha256: Option<String>,
    file_size: Option<u64>,
}

/// # Safety
/// `value` must be null or point to a valid NUL-terminated UTF-8 string of at
/// most `max_bytes` bytes for the duration of the call.
unsafe fn bounded_string(value: *const c_char, max_bytes: usize) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let bytes = unsafe { CStr::from_ptr(value) }.to_bytes();
    if bytes.is_empty() || bytes.len() > max_bytes {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(ToOwned::to_owned)
}

fn ios_tts_reference_from_optional_fields(
    path: Option<String>,
    sha256: Option<String>,
    size_bytes: u64,
    sample_rate: u32,
    text: Option<String>,
    revision: Option<String>,
) -> Option<Option<IosTtsReferenceBinding>> {
    match (path, sha256, size_bytes, sample_rate, text, revision) {
        (Some(path), Some(sha256), size_bytes, sample_rate, text, Some(revision))
            if size_bytes > 0 && sample_rate > 0 =>
        {
            Some(Some(
                IosTtsReferenceBinding::new(
                    path,
                    sha256,
                    size_bytes,
                    sample_rate,
                    text.unwrap_or_default(),
                    revision,
                )
                .ok()?,
            ))
        }
        (None, None, 0, 0, text, None)
            if text.as_deref().map(str::trim).is_none_or(str::is_empty) =>
        {
            Some(None)
        }
        _ => None,
    }
}

fn command_error_code(error: IosVoiceSessionCommandError) -> i32 {
    match error {
        IosVoiceSessionCommandError::AlreadyActive => AURORA_IOS_VOICE_ALREADY_ACTIVE,
        IosVoiceSessionCommandError::NotActive => AURORA_IOS_VOICE_NOT_ACTIVE,
        IosVoiceSessionCommandError::Unavailable => AURORA_IOS_VOICE_UNAVAILABLE,
        IosVoiceSessionCommandError::Closed => AURORA_IOS_VOICE_CLOSED,
    }
}

fn status_payload(status: IosVoiceSessionStatus) -> AuroraIosVoiceSessionStatus {
    AuroraIosVoiceSessionStatus {
        active: u32::from(status.active),
        phase: status.phase as i64,
        has_generation: u32::from(status.generation.is_some()),
        generation: status.generation.map_or(0, |generation| generation.0),
        completed_turns: status.completed_turns,
        failed_turns: status.failed_turns,
    }
}

fn pack_task_from_abi(value: i32) -> Option<PackTask> {
    match value {
        1 => Some(PackTask::Kws),
        2 => Some(PackTask::Wakeword),
        3 => Some(PackTask::Vad),
        4 => Some(PackTask::Stt),
        5 => Some(PackTask::Tts),
        _ => None,
    }
}

fn speech_catalog_task_from_pack_task(task: PackTask) -> Option<SpeechCatalogTask> {
    match task {
        PackTask::Kws | PackTask::Wakeword => Some(SpeechCatalogTask::KeywordSpotting),
        PackTask::Vad => Some(SpeechCatalogTask::VoiceActivityDetection),
        PackTask::Stt => Some(SpeechCatalogTask::SpeechToText),
        PackTask::Tts => None,
        _ => None,
    }
}

fn voice_task_to_pack_id(task: VoiceTask) -> &'static str {
    match task {
        VoiceTask::KeywordSpotting => "kws",
        VoiceTask::VoiceActivityDetection => "vad",
        VoiceTask::SpeechToText => "stt",
        VoiceTask::TextToSpeech => "tts",
    }
}

fn speech_pack_manager_at(root: PathBuf) -> Option<SpeechPackManager> {
    SpeechPackManagerConfig::new(root, None)
        .ok()
        .and_then(|config| SpeechPackManager::open(config).ok())
}

fn archive_path(root: &Path, sha256: &str) -> PathBuf {
    root.join("cache").join(sha256).join("archive.tar.bz2")
}

fn resolved_voice_pack_payload(
    root: &Path,
    bindings: SpeechPackBindings,
) -> AuroraIosResolvedVoicePack {
    let catalog = TtsVoiceCatalog::runtime().ok();
    let entry = catalog.and_then(|catalog| catalog.voice(&bindings.voice_id));
    let files = bindings
        .files
        .into_iter()
        .map(|(file_id, path)| (file_id, path.display().to_string()))
        .collect();
    AuroraIosResolvedVoicePack {
        pack_id: bindings.voice_id,
        task: "tts".to_owned(),
        archive_path: archive_path(root, &bindings.archive_sha256)
            .display()
            .to_string(),
        archive_sha256: bindings.archive_sha256,
        root: Some(bindings.root.display().to_string()),
        files,
        languages: entry
            .map(|entry| vec![entry.language.clone()])
            .unwrap_or_default(),
        language: entry.map(|entry| entry.language.clone()),
        sample_rate_hz: bindings.task_binding.sample_rate_hz(),
        frame_size: bindings.task_binding.frame_size().max(1),
        model_family: bindings
            .task_binding
            .catalog_model_family()
            .unwrap_or("unknown")
            .to_owned(),
    }
}

fn resolved_model_pack_payload(
    root: &Path,
    bindings: SpeechModelBindings,
) -> AuroraIosResolvedVoicePack {
    AuroraIosResolvedVoicePack {
        pack_id: bindings.model_id,
        task: voice_task_to_pack_id(bindings.task_binding.task()).to_owned(),
        archive_path: archive_path(root, &bindings.archive_sha256)
            .display()
            .to_string(),
        archive_sha256: bindings.archive_sha256,
        root: bindings.root.map(|root| root.display().to_string()),
        files: bindings
            .bindings
            .into_iter()
            .map(|(file_id, path)| (file_id, path.display().to_string()))
            .collect(),
        language: bindings.languages.first().cloned(),
        languages: bindings.languages,
        sample_rate_hz: bindings.task_binding.sample_rate_hz(),
        frame_size: bindings.task_binding.frame_size().max(1),
        model_family: bindings
            .task_binding
            .catalog_model_family()
            .unwrap_or("unknown")
            .to_owned(),
    }
}

fn embedded_catalog_json() -> Option<String> {
    let mut entries = Vec::new();
    let speech_catalog = SpeechModelCatalog::embedded().ok()?;
    for entry in &speech_catalog.entries {
        entries.push(AuroraIosEmbeddedCatalogEntry {
            pack_id: entry.model_id.clone(),
            display_name: entry.display_name.clone(),
            language: entry
                .languages
                .first()
                .cloned()
                .unwrap_or_else(|| "und".to_owned()),
            task: voice_task_to_pack_id(match entry.task {
                SpeechCatalogTask::KeywordSpotting => VoiceTask::KeywordSpotting,
                SpeechCatalogTask::VoiceActivityDetection => VoiceTask::VoiceActivityDetection,
                SpeechCatalogTask::SpeechToText => VoiceTask::SpeechToText,
            })
            .to_owned(),
            download_url: entry.archive.url.clone(),
            sha256: entry.archive.sha256.clone(),
            file_size: entry.archive.byte_size,
            file_name: entry.archive.filename.clone(),
            runtime_revision: speech_catalog.revision().to_owned(),
            license: entry.terms.source.clone(),
            attribution: entry.terms.source.clone(),
            acknowledged: true,
            version: Some(speech_catalog.revision().to_owned()),
            compatible_platforms: vec!["ios".to_owned()],
            compatible_architectures: vec!["arm64".to_owned(), "x86_64".to_owned()],
            model_family: entry.model_family.clone(),
            requires_reference_audio: false,
            reference_audio_mode: None,
            model_files: Vec::new(),
            sample_rate_hz: 16_000,
            frame_size: 512,
        });
    }
    let tts_catalog = TtsVoiceCatalog::runtime().ok()?;
    for entry in &tts_catalog.entries {
        entries.push(AuroraIosEmbeddedCatalogEntry {
            pack_id: entry.voice_id.clone(),
            display_name: entry.display_name.clone(),
            language: entry.language.clone(),
            task: "tts".to_owned(),
            download_url: entry.archive.url.clone(),
            sha256: entry.archive.sha256.clone(),
            file_size: entry.archive.byte_size,
            file_name: entry.archive.filename.clone(),
            runtime_revision: tts_catalog.revision().to_owned(),
            license: entry.terms.source.clone(),
            attribution: entry.terms.source.clone(),
            acknowledged: true,
            version: Some(tts_catalog.revision().to_owned()),
            compatible_platforms: vec!["ios".to_owned()],
            compatible_architectures: vec!["arm64".to_owned(), "x86_64".to_owned()],
            model_family: entry.model_family.clone(),
            requires_reference_audio: entry.requires_reference_profile(),
            reference_audio_mode: entry
                .catalog_reference_audio_mode_label()
                .map(str::to_string),
            model_files: Vec::new(),
            sample_rate_hz: entry.sample_rate_hz.unwrap_or(16_000),
            frame_size: 512,
        });
    }
    serde_json::to_string(&entries).ok()
}

fn install_pack_blocking(root: String, pack_id: String, task: PackTask) -> bool {
    let Some(manager) = speech_pack_manager_at(PathBuf::from(root)) else {
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
        if task == PackTask::Tts {
            manager
                .install_voice(&pack_id, &cancellation, |_| {})
                .await
                .is_ok()
        } else if speech_catalog_task_from_pack_task(task).is_some() {
            manager
                .install_model(&pack_id, &cancellation, |_| {})
                .await
                .is_ok()
        } else {
            false
        }
    })
}

fn remove_pack_blocking(root: String, pack_id: String, task: PackTask) -> bool {
    let Some(manager) = speech_pack_manager_at(PathBuf::from(root)) else {
        return false;
    };
    if task == PackTask::Tts {
        manager.remove_voice(&pack_id).is_ok()
    } else {
        speech_catalog_task_from_pack_task(task).is_some() && manager.remove_model(&pack_id).is_ok()
    }
}

fn resolve_pack_json(root: String, pack_id: String, task: PackTask) -> Option<String> {
    let root_path = PathBuf::from(root);
    let manager = speech_pack_manager_at(root_path.clone())?;
    let payload = if task == PackTask::Tts {
        let bindings = manager.resolve_voice_bindings(&pack_id).ok()?;
        resolved_voice_pack_payload(&root_path, bindings)
    } else {
        speech_catalog_task_from_pack_task(task)?;
        let bindings = manager.resolve_model_bindings(&pack_id).ok()?;
        resolved_model_pack_payload(&root_path, bindings)
    };
    serde_json::to_string(&payload).ok()
}

fn catalog_contains_pack(pack_id: &str, task: PackTask) -> bool {
    if task == PackTask::Tts {
        TtsVoiceCatalog::runtime()
            .ok()
            .and_then(|catalog| catalog.voice(pack_id))
            .is_some()
    } else {
        SpeechModelCatalog::embedded()
            .ok()
            .and_then(|catalog| catalog.model(pack_id))
            .is_some()
    }
}

/// # Safety
/// `bindings` must be null when `bindings_len` is zero, otherwise it must
/// point to `bindings_len` initialized [`AuroraIosVoiceTaskPackBinding`] items.
/// Each string pointer follows [`bounded_string`]'s UTF-8/NUL contract and is
/// copied before this function returns.
unsafe fn parse_pack_bindings(
    bindings: *const AuroraIosVoiceTaskPackBinding,
    bindings_len: usize,
) -> Option<IosVoicePackBindings> {
    if bindings_len == 0 {
        return Some(IosVoicePackBindings::default());
    }
    if bindings_len > MAX_IOS_PACK_BINDINGS {
        return None;
    }
    if bindings.is_null() {
        return None;
    }
    let raw = unsafe { std::slice::from_raw_parts(bindings, bindings_len) };
    let mut parsed = Vec::with_capacity(raw.len());
    for binding in raw {
        let task = pack_task_from_abi(binding.task)?;
        let slot_id =
            unsafe { bounded_string(binding.slot_id, 64) }.unwrap_or_else(|| "default".to_owned());
        let pack_id = unsafe { bounded_string(binding.pack_id, 128) }?;
        let pack_path = unsafe { bounded_string(binding.pack_path, 4096) }?;
        let expected_sha256 = unsafe { bounded_string(binding.expected_sha256, 64) }?;
        let runtime_revision = unsafe { bounded_string(binding.runtime_revision, 128) }?;
        let language = unsafe { bounded_string(binding.language, 64) }?;
        let files_json = unsafe { bounded_string(binding.files_json, 65_536) }?;
        let model_family = unsafe { bounded_string(binding.model_family, 64) }?;
        let reference_audio_path = unsafe { bounded_string(binding.reference_audio_path, 4096) };
        let reference_audio_sha256 = unsafe { bounded_string(binding.reference_audio_sha256, 64) };
        let reference_text = unsafe { bounded_string(binding.reference_text, 1024) };
        let reference_revision = unsafe { bounded_string(binding.reference_revision, 128) };
        let tts_reference = ios_tts_reference_from_optional_fields(
            reference_audio_path,
            reference_audio_sha256,
            binding.reference_audio_size_bytes,
            binding.reference_audio_sample_rate_hz,
            reference_text,
            reference_revision,
        )?;
        let files: Vec<AuroraIosVoiceTaskPackFileJson> = serde_json::from_str(&files_json).ok()?;
        let files = files
            .into_iter()
            .map(|file| {
                IosVoicePackFileBinding::new(file.file_id, file.path, file.sha256, file.size_bytes)
            })
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        parsed.push(
            IosVoicePackBinding::new(
                task,
                slot_id,
                pack_id,
                pack_path,
                expected_sha256,
                binding.expected_size_bytes,
                runtime_revision,
                language,
                binding.sample_rate_hz,
                binding.frame_size,
                model_family,
                tts_reference,
                files,
            )
            .ok()?,
        );
    }
    IosVoicePackBindings::new(parsed).ok()
}

/// # Safety
/// `gateway` and `bearer` must be null or valid NUL-terminated UTF-8 strings
/// for the duration of the call. Each string is copied and bounded to 4096
/// bytes; neither pointer is retained after this function returns.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_new(
    gateway: *const c_char,
    bearer: *const c_char,
    remote_audio_consent: u32,
) -> *mut IosVoiceSession {
    let gateway =
        match unsafe { bounded_string(gateway, 4096) }.and_then(|value| Url::parse(&value).ok()) {
            Some(gateway) => gateway,
            None => return std::ptr::null_mut(),
        };
    let auth = match unsafe { bounded_string(bearer, 4096) } {
        Some(value) => GatewayAuth::Bearer(value),
        None => GatewayAuth::None,
    };
    let config = IosVoiceSessionConfig::new(gateway, auth, remote_audio_consent != 0);
    match IosVoiceSession::new_default(config) {
        Ok(session) => Box::into_raw(Box::new(session)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `root` and `pack_id` must be valid NUL-terminated UTF-8 strings for the
/// duration of the call. Strings are copied and bounded.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_pack_install(
    root: *const c_char,
    pack_id: *const c_char,
    task: i32,
) -> i32 {
    let Some(task) = pack_task_from_abi(task) else {
        return AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT;
    };
    let Some(root) = (unsafe { bounded_string(root, 4096) }) else {
        return AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT;
    };
    let Some(pack_id) = (unsafe { bounded_string(pack_id, 256) }) else {
        return AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT;
    };
    if !catalog_contains_pack(&pack_id, task) {
        return AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT;
    }
    if install_pack_blocking(root, pack_id, task) {
        AURORA_IOS_VOICE_PACK_OK
    } else {
        AURORA_IOS_VOICE_PACK_UNAVAILABLE
    }
}

/// # Safety
/// `root` and `pack_id` must be valid NUL-terminated UTF-8 strings for the
/// duration of the call. The returned string must be freed with
/// `aurora_ios_voice_pack_string_free`.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_pack_resolve_json(
    root: *const c_char,
    pack_id: *const c_char,
    task: i32,
) -> *mut c_char {
    let Some(task) = pack_task_from_abi(task) else {
        return std::ptr::null_mut();
    };
    let Some(root) = (unsafe { bounded_string(root, 4096) }) else {
        return std::ptr::null_mut();
    };
    let Some(pack_id) = (unsafe { bounded_string(pack_id, 256) }) else {
        return std::ptr::null_mut();
    };
    let Some(payload) = resolve_pack_json(root, pack_id, task) else {
        return std::ptr::null_mut();
    };
    CString::new(payload)
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// The returned string must be freed with `aurora_ios_voice_pack_string_free`.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_pack_embedded_catalog_json() -> *mut c_char {
    let Some(payload) = embedded_catalog_json() else {
        return std::ptr::null_mut();
    };
    CString::new(payload)
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// `root` and `pack_id` must be valid NUL-terminated UTF-8 strings for the
/// duration of the call. Strings are copied and bounded.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_pack_remove(
    root: *const c_char,
    pack_id: *const c_char,
    task: i32,
) -> i32 {
    let Some(task) = pack_task_from_abi(task) else {
        return AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT;
    };
    let Some(root) = (unsafe { bounded_string(root, 4096) }) else {
        return AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT;
    };
    let Some(pack_id) = (unsafe { bounded_string(pack_id, 256) }) else {
        return AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT;
    };
    if remove_pack_blocking(root, pack_id, task) {
        AURORA_IOS_VOICE_PACK_OK
    } else {
        AURORA_IOS_VOICE_PACK_UNAVAILABLE
    }
}

/// # Safety
/// `value` must be null or a pointer returned by
/// `aurora_ios_voice_pack_resolve_json` that has not already been freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_pack_string_free(value: *mut c_char) {
    if !value.is_null() {
        unsafe { drop(CString::from_raw(value)) };
    }
}

/// # Safety
/// `gateway`, `bearer`, and every string in `bindings` must be null or valid
/// NUL-terminated UTF-8 strings for the duration of this call. Strings are
/// copied and bounded; no pointer is retained after this function returns.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_new_with_pack_bindings(
    gateway: *const c_char,
    bearer: *const c_char,
    remote_audio_consent: u32,
    bindings: *const AuroraIosVoiceTaskPackBinding,
    bindings_len: usize,
) -> *mut IosVoiceSession {
    let gateway =
        match unsafe { bounded_string(gateway, 4096) }.and_then(|value| Url::parse(&value).ok()) {
            Some(gateway) => gateway,
            None => return std::ptr::null_mut(),
        };
    let auth = match unsafe { bounded_string(bearer, 4096) } {
        Some(value) => GatewayAuth::Bearer(value),
        None => GatewayAuth::None,
    };
    let Some(pack_bindings) = (unsafe { parse_pack_bindings(bindings, bindings_len) }) else {
        return std::ptr::null_mut();
    };
    let config = IosVoiceSessionConfig::with_pack_bindings(
        gateway,
        auth,
        remote_audio_consent != 0,
        pack_bindings,
    );
    match IosVoiceSession::new_default(config) {
        Ok(session) => Box::into_raw(Box::new(session)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `session` must be null or a pointer returned by
/// `aurora_ios_voice_session_new` that has not already been freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_free(session: *mut IosVoiceSession) {
    if !session.is_null() {
        // SAFETY: the caller owns the allocation returned by `session_new`.
        unsafe { drop(Box::from_raw(session)) };
    }
}

/// # Safety
/// `session` must be null or a valid session pointer. The returned pointer is
/// borrowed and becomes invalid when `session` is freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_audio_state(
    session: *mut IosVoiceSession,
) -> *mut AuroraIosAudioState {
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { session.as_ref() }.map_or(std::ptr::null_mut(), IosVoiceSession::audio_state_ptr)
}

/// # Safety
/// `session` must be null or a valid session pointer. The returned pointer is
/// borrowed and becomes invalid when `session` is freed.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_output(
    session: *mut IosVoiceSession,
) -> *mut AuroraIosAudioOutput {
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { session.as_ref() }.map_or(std::ptr::null_mut(), IosVoiceSession::output_ptr)
}

/// # Safety
/// `session` and `out_generation` must be null or valid pointers for the
/// duration of this call.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_start(
    session: *mut IosVoiceSession,
    out_generation: *mut u64,
) -> i32 {
    if session.is_null() || out_generation.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: validated non-null pointers are valid by the ABI contract.
    let result = unsafe { &*session }.start();
    match result {
        Ok(generation) => {
            // SAFETY: validated caller-owned output pointer.
            unsafe { *out_generation = generation.0 };
            AURORA_IOS_VOICE_OK
        }
        Err(error) => command_error_code(error),
    }
}

/// # Safety
/// `session` and `out_generation` follow the same contract as
/// [`aurora_ios_voice_session_start`]. Background capture remains subject to
/// the session's explicit remote-audio consent and platform policy.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_start_background(
    session: *mut IosVoiceSession,
    out_generation: *mut u64,
) -> i32 {
    if session.is_null() || out_generation.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: validated non-null pointers are valid by the ABI contract.
    let result = unsafe { &*session }.start_background();
    match result {
        Ok(generation) => {
            // SAFETY: validated caller-owned output pointer.
            unsafe { *out_generation = generation.0 };
            AURORA_IOS_VOICE_OK
        }
        Err(error) => command_error_code(error),
    }
}

/// # Safety
/// `session` must be null or a valid session pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_finish(
    session: *mut IosVoiceSession,
    generation: u64,
) -> i32 {
    if session.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { &*session }
        .finish(generation)
        .map_or_else(command_error_code, |_| AURORA_IOS_VOICE_OK)
}

/// # Safety
/// `session` must be null or a valid session pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_cancel(
    session: *mut IosVoiceSession,
    generation: u64,
) -> i32 {
    if session.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: the caller guarantees that a non-null pointer is valid.
    unsafe { &*session }
        .cancel(generation)
        .map_or_else(command_error_code, |_| AURORA_IOS_VOICE_OK)
}

/// # Safety
/// `session` and `out_status` must be null or valid pointers for the duration
/// of this call.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_status(
    session: *mut IosVoiceSession,
    out_status: *mut AuroraIosVoiceSessionStatus,
) -> i32 {
    if session.is_null() || out_status.is_null() {
        return AURORA_IOS_VOICE_INVALID_ARGUMENT;
    }
    // SAFETY: validated non-null pointers are valid by the ABI contract.
    let status = status_payload(unsafe { &*session }.status());
    // SAFETY: validated caller-owned output pointer.
    unsafe { *out_status = status };
    AURORA_IOS_VOICE_OK
}

/// # Safety
/// `session` must be null or a valid session pointer.
#[no_mangle]
pub unsafe extern "C" fn aurora_ios_voice_session_close(session: *mut IosVoiceSession) {
    if !session.is_null() {
        // SAFETY: the caller guarantees that a non-null pointer is valid.
        unsafe { &*session }.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr::NonNull;

    #[test]
    fn parse_pack_bindings_rejects_null_pointer_with_nonzero_len() {
        let parsed = unsafe { parse_pack_bindings(std::ptr::null(), 1) };
        assert!(parsed.is_none());
    }

    #[test]
    fn parse_pack_bindings_rejects_over_limit_len_before_reading_pointer() {
        let dangling = NonNull::<AuroraIosVoiceTaskPackBinding>::dangling().as_ptr();

        let parsed = unsafe { parse_pack_bindings(dangling, MAX_IOS_PACK_BINDINGS + 1) };

        assert!(parsed.is_none());
    }

    #[test]
    fn parse_pack_bindings_rejects_huge_len_before_reading_pointer() {
        let dangling = NonNull::<AuroraIosVoiceTaskPackBinding>::dangling().as_ptr();

        let parsed = unsafe { parse_pack_bindings(dangling, usize::MAX) };

        assert!(parsed.is_none());
    }

    #[test]
    fn runtime_catalog_lists_public_overlay_without_user_profile() {
        let payload = embedded_catalog_json().expect("runtime catalog");
        let entries: Vec<serde_json::Value> = serde_json::from_str(&payload).expect("catalog json");
        let english = entries
            .iter()
            .find(|entry| entry["packId"] == "standard:pockettts:aurora-pockettts-en-2026-04")
            .expect("public english");
        let french = entries
            .iter()
            .find(|entry| entry["packId"] == "standard:pockettts:aurora-pockettts-fr-24l")
            .expect("public french");
        let official = entries
            .iter()
            .find(|entry| {
                entry["packId"] == "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26"
            })
            .expect("clone-capable english");
        assert_eq!(english["requiresReferenceAudio"], false);
        assert_eq!(english["referenceAudioMode"], "internal");
        assert_eq!(french["requiresReferenceAudio"], false);
        assert_eq!(french["referenceAudioMode"], "internal");
        assert_eq!(official["requiresReferenceAudio"], true);
        assert_eq!(official["referenceAudioMode"], "profile");
        assert!(catalog_contains_pack(
            "standard:pockettts:aurora-pockettts-en-2026-04",
            PackTask::Tts
        ));
        assert!(catalog_contains_pack(
            "standard:pockettts:aurora-pockettts-fr-24l",
            PackTask::Tts
        ));
    }

    fn test_reference_sha256() -> String {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned()
    }

    #[test]
    fn ios_tts_reference_from_optional_fields_allows_empty_text() {
        let binding = ios_tts_reference_from_optional_fields(
            Some("/tmp/ref.wav".to_owned()),
            Some(test_reference_sha256()),
            12,
            16_000,
            None,
            Some("rev-1".to_owned()),
        )
        .expect("parsed")
        .expect("present");
        assert_eq!(binding.reference_text(), "");
        assert_eq!(binding.reference_text_for_sherpa(), None);

        let blank = ios_tts_reference_from_optional_fields(
            Some("/tmp/ref.wav".to_owned()),
            Some(test_reference_sha256()),
            12,
            16_000,
            Some("   ".to_owned()),
            Some("rev-1".to_owned()),
        )
        .expect("parsed")
        .expect("present");
        assert_eq!(blank.reference_text(), "");
        assert_eq!(blank.reference_text_for_sherpa(), None);
    }

    #[test]
    fn ios_tts_reference_from_optional_fields_preserves_legacy_text() {
        let binding = ios_tts_reference_from_optional_fields(
            Some("/tmp/ref.wav".to_owned()),
            Some(test_reference_sha256()),
            12,
            16_000,
            Some("Hello Aurora".to_owned()),
            Some("rev-1".to_owned()),
        )
        .expect("parsed")
        .expect("present");
        assert_eq!(binding.reference_text(), "Hello Aurora");
        assert_eq!(binding.reference_text_for_sherpa(), Some("Hello Aurora"));
    }

    #[test]
    fn ios_tts_reference_from_optional_fields_requires_audio_and_revision() {
        assert!(ios_tts_reference_from_optional_fields(
            None,
            None,
            0,
            0,
            Some("Hello Aurora".to_owned()),
            Some("rev-1".to_owned()),
        )
        .is_none());
        assert!(ios_tts_reference_from_optional_fields(
            Some("/tmp/ref.wav".to_owned()),
            Some(test_reference_sha256()),
            12,
            16_000,
            None,
            None,
        )
        .is_none());
        assert_eq!(
            ios_tts_reference_from_optional_fields(None, None, 0, 0, None, None),
            Some(None)
        );
    }
}
