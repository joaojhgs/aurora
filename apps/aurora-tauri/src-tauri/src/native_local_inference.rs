//! Tauri command boundary for the trusted, app-private llama.cpp catalog.
//!
//! IPC accepts catalog IDs and bounded request DTOs only. Model paths, download
//! origins, byte digests, and execution limits come from native bootstrap.

use super::native_node_config::NativeNodeConfigRuntime;
use aurora_local_inference::{
    CatalogModel, CompletionRequest, CompletionResult, EngineInfo, LocalInferenceConfig,
    LocalInferenceError, LocalInferenceState, ModelStatus, NativeInferenceBackend, SessionInfo,
};
use aurora_voice_core::CancellationToken;
use aurora_voice_native::{AssetIntegrity, DownloadPolicy, NativeDownloader};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::sync::Arc;
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{AppHandle, State};
use url::Url;

const MODEL_DOWNLOAD_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

pub(crate) struct NativeLocalInferenceState {
    engine: LocalInferenceState,
    node_config: NativeNodeConfigRuntime,
    download_lock: tokio::sync::Mutex<()>,
}

impl NativeLocalInferenceState {
    /// Construct the command state from the native-only verified catalog and
    /// the operating-system app-private directory.
    pub(crate) fn new(
        config: LocalInferenceConfig,
        node_config: NativeNodeConfigRuntime,
        app: AppHandle<tauri::Wry>,
    ) -> Result<Self, LocalInferenceError> {
        #[cfg(all(target_os = "ios", target_arch = "aarch64"))]
        let private_root = config.app_private_root.clone();
        let engine = LocalInferenceState::new(config)?;
        #[cfg(all(target_os = "android", target_arch = "aarch64"))]
        engine.install_bundled_needle2_model()?;
        #[cfg(target_os = "android")]
        engine.install_native_backend(Arc::new(AndroidNativeInferenceBackend::new(app)))?;
        #[cfg(all(target_os = "ios", target_arch = "aarch64"))]
        engine.install_native_backend(Arc::new(aurora_local_inference::CactusBackend::new(
            private_root,
        )))?;
        #[cfg(not(target_os = "android"))]
        let _ = app;
        Ok(Self {
            engine,
            node_config,
            download_lock: tokio::sync::Mutex::new(()),
        })
    }

    fn engine(&self) -> &LocalInferenceState {
        &self.engine
    }

    async fn model_status(&self, model_id: String) -> Result<ModelStatus, LocalInferenceError> {
        let engine = self.engine.clone();
        tokio::task::spawn_blocking(move || engine.model_status(&model_id))
            .await
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?
    }

    async fn profile_admission(
        &self,
    ) -> Result<(tokio::sync::OwnedRwLockReadGuard<()>, u64), LocalInferenceError> {
        let (guard, generation, _policy, profile_json) = self
            .node_config
            .transcription_admission_snapshot()
            .await
            .map_err(|_| LocalInferenceError::Unsupported)?;
        if !profile_allows_local_inference(&profile_json) {
            return Err(LocalInferenceError::Unsupported);
        }
        Ok((guard, generation))
    }
}

#[cfg(target_os = "android")]
struct AndroidLiteRtBackend {
    app: AppHandle<tauri::Wry>,
}

#[cfg(target_os = "android")]
impl AndroidLiteRtBackend {
    fn invoke(&self, command: &str, payload: Value) -> Result<Value, LocalInferenceError> {
        let native = self
            .app
            .try_state::<super::AuroraMobileNativePlugin<tauri::Wry>>()
            .ok_or(LocalInferenceError::Unsupported)?;
        super::run_android_plugin_command(native, command, payload)
            .map_err(|_| LocalInferenceError::WorkerUnavailable)
    }
}

#[cfg(target_os = "android")]
#[derive(Clone, Copy)]
enum AndroidInferenceRoute {
    LiteRt,
    #[cfg(all(target_arch = "aarch64"))]
    Needle2,
}

#[cfg(target_os = "android")]
struct AndroidNativeInferenceBackend {
    lite_rt: AndroidLiteRtBackend,
    #[cfg(all(target_arch = "aarch64"))]
    needle: aurora_local_inference::Needle2Backend,
    active: std::sync::Mutex<Option<AndroidInferenceRoute>>,
}

#[cfg(target_os = "android")]
impl AndroidNativeInferenceBackend {
    fn new(app: AppHandle<tauri::Wry>) -> Self {
        Self {
            lite_rt: AndroidLiteRtBackend { app },
            #[cfg(all(target_arch = "aarch64"))]
            needle: aurora_local_inference::Needle2Backend,
            active: std::sync::Mutex::new(None),
        }
    }

    fn active(&self) -> Result<AndroidInferenceRoute, LocalInferenceError> {
        self.active
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?
            .as_ref()
            .copied()
            .ok_or(LocalInferenceError::SessionUnavailable)
    }
}

#[cfg(target_os = "android")]
impl NativeInferenceBackend for AndroidNativeInferenceBackend {
    fn load(
        &self,
        model_id: &str,
        model_path: &Path,
        cache_path: &Path,
    ) -> Result<(), LocalInferenceError> {
        let route = if model_id == "actions-needle2" {
            if model_path.extension().and_then(|ext| ext.to_str()) != Some("cact") {
                return Err(LocalInferenceError::ModelUnavailable);
            }
            #[cfg(all(target_arch = "aarch64"))]
            {
                AndroidInferenceRoute::Needle2
            }
            #[cfg(not(all(target_arch = "aarch64")))]
            {
                return Err(LocalInferenceError::Unsupported);
            }
        } else if model_path.extension().and_then(|ext| ext.to_str()) == Some("litertlm") {
            AndroidInferenceRoute::LiteRt
        } else {
            return Err(LocalInferenceError::ModelUnavailable);
        };
        match route {
            AndroidInferenceRoute::LiteRt => self.lite_rt.load(model_id, model_path, cache_path)?,
            #[cfg(all(target_arch = "aarch64"))]
            AndroidInferenceRoute::Needle2 => self.needle.load(model_id, model_path, cache_path)?,
        }
        *self
            .active
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)? = Some(route);
        Ok(())
    }

    fn complete(
        &self,
        request_id: &str,
        request_json: &str,
    ) -> Result<String, LocalInferenceError> {
        match self.active()? {
            AndroidInferenceRoute::LiteRt => self.lite_rt.complete(request_id, request_json),
            #[cfg(all(target_arch = "aarch64"))]
            AndroidInferenceRoute::Needle2 => self.needle.complete(request_id, request_json),
        }
    }

    fn cancel(&self, request_id: &str) -> bool {
        match self.active() {
            Ok(AndroidInferenceRoute::LiteRt) => self.lite_rt.cancel(request_id),
            #[cfg(all(target_arch = "aarch64"))]
            Ok(AndroidInferenceRoute::Needle2) => self.needle.cancel(request_id),
            Err(_) => false,
        }
    }

    fn reset(&self) -> Result<(), LocalInferenceError> {
        match self.active()? {
            AndroidInferenceRoute::LiteRt => self.lite_rt.reset(),
            #[cfg(all(target_arch = "aarch64"))]
            AndroidInferenceRoute::Needle2 => self.needle.reset(),
        }
    }

    fn destroy(&self) -> Result<(), LocalInferenceError> {
        let route = self.active()?;
        let result = match route {
            AndroidInferenceRoute::LiteRt => self.lite_rt.destroy(),
            #[cfg(all(target_arch = "aarch64"))]
            AndroidInferenceRoute::Needle2 => self.needle.destroy(),
        };
        if result.is_ok() {
            *self
                .active
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)? = None;
        }
        result
    }
}

#[cfg(target_os = "android")]
impl NativeInferenceBackend for AndroidLiteRtBackend {
    fn load(
        &self,
        model_id: &str,
        model_path: &Path,
        cache_path: &Path,
    ) -> Result<(), LocalInferenceError> {
        std::fs::create_dir_all(cache_path).map_err(|_| LocalInferenceError::ModelUnavailable)?;
        self.invoke(
            "localInferenceLiteRtLoad",
            serde_json::json!({
                "modelId": model_id,
                "modelPath": model_path,
                "cachePath": cache_path,
            }),
        )
        .map(|_| ())
    }

    fn complete(
        &self,
        request_id: &str,
        request_json: &str,
    ) -> Result<String, LocalInferenceError> {
        let response = self.invoke(
            "localInferenceLiteRtComplete",
            serde_json::json!({
                "requestId": request_id,
                "requestJson": request_json,
            }),
        )?;
        serde_json::to_string(&response).map_err(|_| LocalInferenceError::InferenceFailed)
    }

    fn cancel(&self, request_id: &str) -> bool {
        self.invoke(
            "localInferenceLiteRtCancel",
            serde_json::json!({ "requestId": request_id }),
        )
        .ok()
        .and_then(|result| result.get("cancelled").and_then(Value::as_bool))
        .unwrap_or(false)
    }

    fn reset(&self) -> Result<(), LocalInferenceError> {
        self.invoke("localInferenceLiteRtReset", serde_json::json!({}))
            .map(|_| ())
    }

    fn destroy(&self) -> Result<(), LocalInferenceError> {
        self.invoke("localInferenceLiteRtDestroy", serde_json::json!({}))
            .map(|_| ())
    }
}

fn profile_allows_local_inference(profile_json: &str) -> bool {
    let Ok(document) = serde_json::from_str::<Value>(profile_json) else {
        return false;
    };
    if document.get("version").and_then(Value::as_u64) != Some(2) {
        return false;
    }
    let Some(active_id) = document.get("activeProfileId").and_then(Value::as_str) else {
        return false;
    };
    let Some(profiles) = document.get("profiles").and_then(Value::as_array) else {
        return false;
    };
    let mut matching = profiles
        .iter()
        .filter(|profile| profile.get("id").and_then(Value::as_str) == Some(active_id));
    let Some(profile) = matching.next() else {
        return false;
    };
    if matching.next().is_some()
        || profile.get("nodeMode").and_then(Value::as_str) != Some("mesh-node")
        || profile.get("runtimeTier").and_then(Value::as_str) != Some("lightweight-ts")
    {
        return false;
    }
    profile
        .get("localNode")
        .and_then(|node| node.get("enabledCapabilityPacks"))
        .and_then(Value::as_array)
        .is_some_and(|packs| {
            packs
                .iter()
                .any(|pack| pack.as_str() == Some("local-inference"))
        })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: &'static str,
    message: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandEnvelope<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<CommandError>,
}

impl<T: Serialize> CommandEnvelope<T> {
    fn success(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    fn failure(error: LocalInferenceError) -> Self {
        let (code, message) = match error {
            LocalInferenceError::Unsupported => (
                "unsupported_feature",
                "Offline answers are unavailable on this device.",
            ),
            LocalInferenceError::ModelUnavailable | LocalInferenceError::ModelUnverified => (
                "unavailable_service",
                "The selected offline model is unavailable.",
            ),
            LocalInferenceError::SessionBusy => (
                "unavailable_service",
                "Another offline answer is still running.",
            ),
            LocalInferenceError::SessionUnavailable => {
                ("validation", "The offline answer session is unavailable.")
            }
            LocalInferenceError::InvalidRequest => {
                ("validation", "This request cannot be answered offline.")
            }
            LocalInferenceError::Cancelled => {
                ("unavailable_service", "The offline answer was stopped.")
            }
            LocalInferenceError::InferenceFailed => {
                ("unknown", "The offline answer could not be completed.")
            }
            LocalInferenceError::WorkerUnavailable => (
                "unavailable_service",
                "Offline answers are temporarily unavailable.",
            ),
        };
        Self {
            ok: false,
            data: None,
            error: Some(CommandError { code, message }),
        }
    }
}

#[tauri::command]
pub(crate) fn aurora_local_inference_engines(
    state: State<'_, NativeLocalInferenceState>,
) -> CommandEnvelope<Vec<EngineInfo>> {
    CommandEnvelope::success(state.engine().engines())
}

#[tauri::command]
pub(crate) fn aurora_local_inference_catalog(
    state: State<'_, NativeLocalInferenceState>,
) -> CommandEnvelope<Vec<CatalogModel>> {
    CommandEnvelope::success(state.engine().catalog())
}

#[tauri::command]
pub(crate) async fn aurora_local_inference_model_status(
    state: State<'_, NativeLocalInferenceState>,
    model_id: String,
) -> Result<CommandEnvelope<ModelStatus>, String> {
    Ok(match state.model_status(model_id).await {
        Ok(status) => CommandEnvelope::success(status),
        Err(error) => CommandEnvelope::failure(error),
    })
}

#[tauri::command]
pub(crate) async fn aurora_local_inference_download_model(
    state: State<'_, NativeLocalInferenceState>,
    model_id: String,
) -> Result<CommandEnvelope<ModelStatus>, String> {
    let _download_guard = state.download_lock.lock().await;
    let descriptor = match state.engine().model_descriptor(&model_id) {
        Ok(descriptor) => descriptor,
        Err(error) => return Ok(CommandEnvelope::failure(error)),
    };
    let root = state.engine().app_private_root().to_path_buf();
    let destination = root.join(&descriptor.file_name);
    if let Ok(status) = state.model_status(model_id.clone()).await {
        if status.state == "ready" {
            return Ok(CommandEnvelope::success(status));
        }
    }
    let result = download_verified_model(&root, &destination, &descriptor).await;
    Ok(match result {
        Ok(()) => match state.model_status(model_id.clone()).await {
            Ok(status) if status.state == "ready" => CommandEnvelope::success(status),
            _ => CommandEnvelope::failure(LocalInferenceError::ModelUnverified),
        },
        Err(_) => CommandEnvelope::failure(LocalInferenceError::ModelUnavailable),
    })
}

#[tauri::command]
pub(crate) async fn aurora_local_inference_delete_model(
    state: State<'_, NativeLocalInferenceState>,
    model_id: String,
) -> Result<CommandEnvelope<ModelStatus>, String> {
    let _download_guard = state.download_lock.lock().await;
    let descriptor = match state.engine().model_descriptor(&model_id) {
        Ok(descriptor) => descriptor,
        Err(error) => return Ok(CommandEnvelope::failure(error)),
    };
    let is_cactus = model_id == "chat-qwen3-06b-cactus";
    if state.engine().session_loaded(&model_id) {
        return Ok(CommandEnvelope::failure(LocalInferenceError::SessionBusy));
    }
    match state.model_status(model_id.clone()).await {
        Ok(status) if status.state == "absent" && !is_cactus => {
            return Ok(CommandEnvelope::success(status));
        }
        Err(error) => return Ok(CommandEnvelope::failure(error)),
        _ => {}
    }
    let root = state.engine().app_private_root();
    let cleanup = (|| {
        if is_cactus {
            remove_cactus_model_cache(root)?;
        }
        let archive = root.join(&descriptor.file_name);
        match std::fs::symlink_metadata(&archive) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(LocalInferenceError::ModelUnavailable);
            }
            Ok(_) => {
                let path = confined_model_path(root, &descriptor.file_name)?;
                std::fs::remove_file(path).map_err(|_| LocalInferenceError::ModelUnavailable)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && is_cactus => {}
            Err(_) => return Err(LocalInferenceError::ModelUnavailable),
        }
        Ok(())
    })();
    match cleanup {
        Ok(()) => match state.model_status(model_id.clone()).await {
            Ok(status) => Ok(CommandEnvelope::success(status)),
            Err(error) => Ok(CommandEnvelope::failure(error)),
        },
        Err(error) => Ok(CommandEnvelope::failure(error)),
    }
}

#[tauri::command]
pub(crate) async fn aurora_local_inference_session_create(
    state: State<'_, NativeLocalInferenceState>,
    session_id: String,
    model_id: String,
) -> Result<CommandEnvelope<SessionInfo>, String> {
    let (_profile_lease, generation) = match state.profile_admission().await {
        Ok(admission) => admission,
        Err(error) => return Ok(CommandEnvelope::failure(error)),
    };
    Ok(
        match state
            .engine()
            .create_session(session_id, model_id, generation)
            .await
        {
            Ok(info) => CommandEnvelope::success(info),
            Err(error) => CommandEnvelope::failure(error),
        },
    )
}

#[tauri::command]
pub(crate) async fn aurora_local_inference_complete(
    state: State<'_, NativeLocalInferenceState>,
    session_id: String,
    request_id: String,
    request: CompletionRequest,
) -> Result<CommandEnvelope<CompletionResult>, String> {
    let (_profile_lease, generation) = match state.profile_admission().await {
        Ok(admission) => admission,
        Err(error) => return Ok(CommandEnvelope::failure(error)),
    };
    Ok(
        match state
            .engine()
            .complete(&session_id, request_id, request, generation)
            .await
        {
            Ok(result) => CommandEnvelope::success(result),
            Err(error) => CommandEnvelope::failure(error),
        },
    )
}

#[tauri::command]
pub(crate) fn aurora_local_inference_cancel(
    state: State<'_, NativeLocalInferenceState>,
    session_id: String,
    request_id: String,
) -> CommandEnvelope<()> {
    let _ = state.engine().cancel(&session_id, &request_id);
    CommandEnvelope::success(())
}

#[tauri::command]
pub(crate) async fn aurora_local_inference_session_reset(
    state: State<'_, NativeLocalInferenceState>,
    session_id: String,
) -> Result<CommandEnvelope<()>, String> {
    Ok(match state.engine().reset_session(&session_id).await {
        Ok(()) => CommandEnvelope::success(()),
        Err(error) => CommandEnvelope::failure(error),
    })
}

#[tauri::command]
pub(crate) async fn aurora_local_inference_session_destroy(
    state: State<'_, NativeLocalInferenceState>,
    session_id: String,
) -> Result<CommandEnvelope<()>, String> {
    Ok(match state.engine().destroy_session(&session_id).await {
        Ok(()) => CommandEnvelope::success(()),
        Err(error) => CommandEnvelope::failure(error),
    })
}

async fn download_verified_model(
    root: &Path,
    destination: &Path,
    descriptor: &aurora_local_inference::TrustedModelDescriptor,
) -> Result<(), LocalInferenceError> {
    if descriptor.byte_size > MODEL_DOWNLOAD_LIMIT {
        return Err(LocalInferenceError::ModelUnavailable);
    }
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let integrity = AssetIntegrity::new(descriptor.byte_size, descriptor.sha256.clone())
        .map_err(|_| LocalInferenceError::ModelUnverified)?;
    let policy = DownloadPolicy::https_only(MODEL_DOWNLOAD_LIMIT)
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let downloader =
        NativeDownloader::new(policy).map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let origin =
        Url::parse("https://huggingface.co/").map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let source = downloader
        .resolve_source(&origin, &descriptor.source_url)
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(LocalInferenceError::ModelUnavailable)?;
    let staging = root.join(format!(".{file_name}.partial"));
    let cancellation = CancellationToken::new();
    downloader
        .download_to_staging(&source, &staging, &integrity, &cancellation, |_| {})
        .await
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    verify_staged_file(&staging, descriptor).await?;
    promote_staged_file(&staging, destination).await
}

async fn verify_staged_file(
    staging: &Path,
    descriptor: &aurora_local_inference::TrustedModelDescriptor,
) -> Result<(), LocalInferenceError> {
    let metadata = tokio::fs::metadata(staging)
        .await
        .map_err(|_| LocalInferenceError::ModelUnverified)?;
    if !metadata.is_file() || metadata.len() != descriptor.byte_size {
        return Err(LocalInferenceError::ModelUnverified);
    }
    let mut file = tokio::fs::File::open(staging)
        .await
        .map_err(|_| LocalInferenceError::ModelUnverified)?;
    use tokio::io::AsyncReadExt;
    let mut magic = [0; 4];
    file.read_exact(&mut magic)
        .await
        .map_err(|_| LocalInferenceError::ModelUnverified)?;
    let valid_magic = if descriptor.model_id == "chat-qwen3-06b-cactus"
        && descriptor.file_name == "qwen3-0.6b-int4.zip"
    {
        &magic == b"PK\x03\x04"
    } else {
        (cfg!(all(target_os = "android", target_arch = "aarch64"))
            && descriptor.model_id == "actions-needle2"
            && descriptor.file_name == "needle2.cact")
            || descriptor.file_name.ends_with(".litertlm")
            || &magic == b"GGUF"
    };
    if !valid_magic {
        return Err(LocalInferenceError::ModelUnverified);
    }
    Ok(())
}

async fn promote_staged_file(
    staging: &Path,
    destination: &Path,
) -> Result<(), LocalInferenceError> {
    let backup = destination.with_extension("previous");
    if tokio::fs::try_exists(destination)
        .await
        .map_err(|_| LocalInferenceError::ModelUnavailable)?
    {
        tokio::fs::rename(destination, &backup)
            .await
            .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    }
    if let Err(error) = tokio::fs::rename(staging, destination).await {
        if tokio::fs::try_exists(&backup).await.unwrap_or(false) {
            let _ = tokio::fs::rename(&backup, destination).await;
        }
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
            LocalInferenceError::ModelUnavailable
        } else {
            LocalInferenceError::ModelUnavailable
        });
    }
    if tokio::fs::try_exists(&backup).await.unwrap_or(false) {
        let _ = tokio::fs::remove_file(backup).await;
    }
    Ok(())
}

fn remove_cactus_model_cache(root: &Path) -> Result<(), LocalInferenceError> {
    let canonical_root = root
        .canonicalize()
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let cache_root = canonical_root.join("cache");
    let model_cache = cache_root.join("chat-qwen3-06b-cactus");
    let extracted_model = model_cache.join("model");

    for directory in [&cache_root, &model_cache] {
        match std::fs::symlink_metadata(directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(LocalInferenceError::ModelUnavailable),
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(LocalInferenceError::ModelUnavailable)
            }
            Ok(_) => {
                let canonical = directory
                    .canonicalize()
                    .map_err(|_| LocalInferenceError::ModelUnavailable)?;
                if canonical != *directory || !canonical.starts_with(&canonical_root) {
                    return Err(LocalInferenceError::ModelUnavailable);
                }
            }
        }
    }

    match std::fs::symlink_metadata(&extracted_model) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(LocalInferenceError::ModelUnavailable),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(LocalInferenceError::ModelUnavailable)
        }
        Ok(_) => {
            let canonical = extracted_model
                .canonicalize()
                .map_err(|_| LocalInferenceError::ModelUnavailable)?;
            if canonical != extracted_model || !canonical.starts_with(&canonical_root) {
                return Err(LocalInferenceError::ModelUnavailable);
            }
            std::fs::remove_dir_all(canonical).map_err(|_| LocalInferenceError::ModelUnavailable)
        }
    }
}

fn confined_model_path(root: &Path, file_name: &str) -> Result<PathBuf, LocalInferenceError> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name == "."
        || file_name == ".."
    {
        return Err(LocalInferenceError::ModelUnavailable);
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let path = canonical_root.join(file_name);
    if path.exists() {
        let canonical = path
            .canonicalize()
            .map_err(|_| LocalInferenceError::ModelUnavailable)?;
        if !canonical.starts_with(&canonical_root) {
            return Err(LocalInferenceError::ModelUnavailable);
        }
        Ok(canonical)
    } else {
        Ok(path)
    }
}
