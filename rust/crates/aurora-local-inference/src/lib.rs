//! Bounded local chat inference through the pinned native engine host.
//!
//! The serialized worker owns llama.cpp contexts and delegates trusted Android
//! LiteRT models through the native platform bridge. The featureless build
//! reports no engines and rejects all execution requests.

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "native-llamacpp")]
use sha2::{Digest, Sha256};
#[cfg(feature = "native-llamacpp")]
use std::collections::{HashMap, HashSet};
#[cfg(feature = "native-llamacpp")]
use std::fs::File;
#[cfg(feature = "native-llamacpp")]
use std::io::{Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
#[cfg(feature = "native-llamacpp")]
use std::sync::{mpsc, Mutex, RwLock};
use thiserror::Error;

#[cfg(all(feature = "native-cactus", target_os = "ios", target_arch = "aarch64"))]
mod cactus;
#[cfg(all(
    feature = "native-needle2",
    target_os = "android",
    target_arch = "aarch64"
))]
mod needle;
#[cfg(all(feature = "native-cactus", target_os = "ios", target_arch = "aarch64"))]
pub use cactus::CactusBackend;
#[cfg(all(
    feature = "native-needle2",
    target_os = "android",
    target_arch = "aarch64"
))]
pub use needle::Needle2Backend;
#[cfg(all(
    feature = "native-needle2",
    target_os = "android",
    target_arch = "aarch64"
))]
static BUNDLED_NEEDLE2_MODEL: &[u8] = include_bytes!(env!("AURORA_NEEDLE2_BUNDLED_MODEL"));
#[cfg(feature = "native-llamacpp")]
use tokio::sync::oneshot;

const MAX_MODEL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
#[cfg(feature = "native-llamacpp")]
const MAX_REQUEST_BYTES: usize = 128 * 1024;
#[cfg(feature = "native-llamacpp")]
const MAX_MESSAGE_COUNT: usize = 64;
#[cfg(feature = "native-llamacpp")]
const MAX_TOOL_COUNT: usize = 32;
#[cfg(feature = "native-llamacpp")]
const MAX_TOOL_SCHEMA_BYTES: usize = 16 * 1024;
#[cfg(feature = "native-llamacpp")]
const MAX_CONTENT_BYTES: usize = 64 * 1024;
const MAX_CONTEXT_TOKENS: u32 = 8192;
const MAX_OUTPUT_TOKENS: u32 = 1024;
#[cfg(feature = "native-llamacpp")]
const MAX_PENDING_CANCELLATIONS: usize = 32;

/// Immutable model metadata supplied by the trusted native catalog.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedModelDescriptor {
    pub model_id: String,
    pub display_label: String,
    pub file_name: String,
    pub byte_size: u64,
    pub sha256: String,
    pub source_url: String,
    pub context_tokens: u32,
    pub max_output_tokens: u32,
    pub capabilities: ModelCapabilities,
}

/// Publicly advertised model capabilities; never contains a filesystem path.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCapabilities {
    pub chat: bool,
    pub tools: bool,
}

/// Trusted app-private storage root and catalog injected by native bootstrap.
#[derive(Clone, Debug)]
pub struct LocalInferenceConfig {
    pub app_private_root: PathBuf,
    pub models: Vec<TrustedModelDescriptor>,
}

/// Native platform bridge for trusted model formats outside the llama worker.
/// Implementations receive only descriptors and host-derived app-private paths.
pub trait NativeInferenceBackend: Send + Sync {
    fn load(
        &self,
        model_id: &str,
        model_path: &Path,
        cache_path: &Path,
    ) -> Result<(), LocalInferenceError>;
    fn complete(&self, request_id: &str, request_json: &str)
        -> Result<String, LocalInferenceError>;
    fn cancel(&self, request_id: &str) -> bool;
    fn reset(&self) -> Result<(), LocalInferenceError>;
    fn destroy(&self) -> Result<(), LocalInferenceError>;
}

/// Public catalog item returned to the settings surface.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub model_id: String,
    pub display_label: String,
    pub bytes: u64,
    pub capabilities: ModelCapabilities,
}

/// A native engine build available to the product host.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: String,
    pub surface: String,
    pub version: String,
    pub accelerators: Vec<String>,
    pub max_concurrent_models: u8,
}

/// Installed state describes bytes only. Session readiness is reported only
/// after the actual engine has loaded the model and created a context.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub model_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_on_disk: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "tool_call_id"
    )]
    pub tool_call_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "tool_calls"
    )]
    pub tool_calls: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunctionTool {
    pub r#type: String,
    pub function: FunctionDefinition,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FunctionDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_rag_top_k: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionRequest {
    pub model_id: String,
    pub session_id: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub tools: Vec<FunctionTool>,
    #[serde(default)]
    pub options: CompletionOptions,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CompletionResult {
    Message {
        content: String,
    },
    ToolCalls {
        content: String,
        tool_calls: Vec<ToolCall>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Error, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalInferenceError {
    #[error("Local answers are not available on this build.")]
    Unsupported,
    #[error("The local model is not available.")]
    ModelUnavailable,
    #[error("The local model could not be verified.")]
    ModelUnverified,
    #[error("A local inference session is already active.")]
    SessionBusy,
    #[error("The local inference session is unavailable.")]
    SessionUnavailable,
    #[error("The request is not available for local processing.")]
    InvalidRequest,
    #[error("The local request was cancelled.")]
    Cancelled,
    #[error("The local answer could not be completed.")]
    InferenceFailed,
    #[error("The local inference worker is unavailable.")]
    WorkerUnavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub model_id: String,
    pub session_id: String,
    pub context_bytes: Option<u64>,
    pub context_tokens: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub cancelled: bool,
}

#[derive(Clone)]
pub struct LocalInferenceState {
    inner: Arc<Inner>,
}

struct Inner {
    config: LocalInferenceConfig,
    #[cfg(feature = "native-llamacpp")]
    native_backend: Arc<RwLock<Option<Arc<dyn NativeInferenceBackend>>>>,
    #[cfg(feature = "native-llamacpp")]
    sender: mpsc::SyncSender<WorkerCommand>,
    #[cfg(feature = "native-llamacpp")]
    session: Mutex<Option<SessionState>>,
    #[cfg(feature = "native-llamacpp")]
    operations: Mutex<HashMap<(String, String), Arc<BridgeCancel>>>,
    #[cfg(feature = "native-llamacpp")]
    pending_cancellations: Mutex<HashSet<(String, String)>>,
}

#[cfg(feature = "native-llamacpp")]
#[derive(Clone)]
struct SessionState {
    session_id: String,
    model_id: String,
    profile_generation: u64,
}

#[cfg(feature = "native-llamacpp")]
enum WorkerCommand {
    Create {
        session_id: String,
        model_id: String,
        model_path: PathBuf,
        cache_path: PathBuf,
        use_native_backend: bool,
        context_tokens: u32,
        reply: oneshot::Sender<Result<(), LocalInferenceError>>,
    },
    Complete {
        session_id: String,
        request_id: String,
        request_json: String,
        cancellation: Arc<BridgeCancel>,
        reply: oneshot::Sender<Result<String, LocalInferenceError>>,
    },
    Reset {
        session_id: String,
        reply: oneshot::Sender<Result<(), LocalInferenceError>>,
    },
    Destroy {
        session_id: String,
        reply: oneshot::Sender<Result<(), LocalInferenceError>>,
    },
}

#[cfg(feature = "native-llamacpp")]
impl LocalInferenceState {
    /// Start the serialized inference worker using a trusted bootstrap catalog.
    pub fn new(config: LocalInferenceConfig) -> Result<Self, LocalInferenceError> {
        validate_config(&config)?;
        let native_backend = Arc::new(RwLock::new(None));
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker_backend = Arc::clone(&native_backend);
        std::thread::Builder::new()
            .name("aurora-local-inference".to_owned())
            .spawn(move || worker_loop(receiver, worker_backend))
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                native_backend,
                sender,
                session: Mutex::new(None),
                operations: Mutex::new(HashMap::new()),
                pending_cancellations: Mutex::new(HashSet::new()),
            }),
        })
    }

    /// Install the pinned Android ARM64 Needle model into app-private storage.
    #[cfg(all(
        feature = "native-needle2",
        target_os = "android",
        target_arch = "aarch64"
    ))]
    pub fn install_bundled_needle2_model(&self) -> Result<(), LocalInferenceError> {
        use std::fs::{self, OpenOptions};
        use std::io::Write;

        const MODEL_ID: &str = "actions-needle2";
        const FILE_NAME: &str = "needle2.cact";
        const MODEL_BYTES: u64 = 13_737_807;
        const MODEL_SHA256: &str =
            "b43aabfcaf1a6db6acf488076eab71d823c08697c7af4521fc1d174b60ede5ba";

        let model = find_model(&self.inner.config, MODEL_ID)?;
        if !is_needle_model(model)
            || model.file_name != FILE_NAME
            || model.byte_size != MODEL_BYTES
            || model.sha256 != MODEL_SHA256
        {
            return Err(LocalInferenceError::ModelUnverified);
        }
        let digest = format!("{:x}", Sha256::digest(BUNDLED_NEEDLE2_MODEL));
        if BUNDLED_NEEDLE2_MODEL.len() as u64 != MODEL_BYTES || digest != MODEL_SHA256 {
            return Err(LocalInferenceError::ModelUnverified);
        }

        let root = &self.inner.config.app_private_root;
        fs::create_dir_all(root).map_err(|_| LocalInferenceError::ModelUnavailable)?;
        let destination = model_path(&self.inner.config, model)?;
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_file() => {
                return verify_model_file(&destination, model)
            }
            Ok(_) => return Err(LocalInferenceError::ModelUnverified),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LocalInferenceError::ModelUnavailable),
        }

        let staging = root.join(format!(".needle2-{}.partial", std::process::id()));
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|_| LocalInferenceError::ModelUnavailable)?;
        let staged = (|| {
            output
                .write_all(BUNDLED_NEEDLE2_MODEL)
                .map_err(|_| LocalInferenceError::ModelUnavailable)?;
            output
                .sync_all()
                .map_err(|_| LocalInferenceError::ModelUnavailable)?;
            drop(output);
            verify_model_file(&staging, model)?;
            match fs::hard_link(&staging, &destination) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    verify_model_file(&destination, model)
                }
                Err(_) => Err(LocalInferenceError::ModelUnavailable),
            }
        })();
        let _ = fs::remove_file(&staging);
        staged
    }

    /// Install the platform bridge before any non-llama model is loaded.
    pub fn install_native_backend(
        &self,
        backend: Arc<dyn NativeInferenceBackend>,
    ) -> Result<(), LocalInferenceError> {
        let mut slot = self.native_backend_write()?;
        if slot.is_some() {
            return Ok(());
        }
        *slot = Some(backend);
        Ok(())
    }

    fn native_backend_write(
        &self,
    ) -> Result<
        std::sync::RwLockWriteGuard<'_, Option<Arc<dyn NativeInferenceBackend>>>,
        LocalInferenceError,
    > {
        self.inner
            .native_backend
            .write()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)
    }

    fn native_backend(
        &self,
    ) -> Result<Option<Arc<dyn NativeInferenceBackend>>, LocalInferenceError> {
        self.inner
            .native_backend
            .read()
            .map(|backend| backend.clone())
            .map_err(|_| LocalInferenceError::WorkerUnavailable)
    }

    /// Return the small, path-free model catalog for settings.
    pub fn catalog(&self) -> Vec<CatalogModel> {
        self.inner
            .config
            .models
            .iter()
            .map(|model| CatalogModel {
                model_id: model.model_id.clone(),
                display_label: model.display_label.clone(),
                bytes: model.byte_size,
                capabilities: model.capabilities.clone(),
            })
            .collect()
    }

    /// Advertise only engines compiled into this native target.
    pub fn engines(&self) -> Vec<EngineInfo> {
        let engines = vec![EngineInfo {
            engine: "llamacpp".to_owned(),
            surface: native_surface().to_owned(),
            version: "0.4.1".to_owned(),
            accelerators: vec!["cpu".to_owned()],
            max_concurrent_models: 1,
        }];
        #[cfg(all(feature = "native-cactus", target_os = "ios", target_arch = "aarch64"))]
        let engines = {
            let mut engines = engines;
            engines.push(EngineInfo {
                engine: "cactus".to_owned(),
                surface: "ios".to_owned(),
                version: "1.14.0".to_owned(),
                accelerators: vec!["cpu".to_owned()],
                max_concurrent_models: 1,
            });
            engines
        };
        #[cfg(all(
            feature = "native-needle2",
            target_os = "android",
            target_arch = "aarch64"
        ))]
        let engines = {
            let mut engines = engines;
            engines.push(EngineInfo {
                engine: "needle2".to_owned(),
                surface: "android".to_owned(),
                version: "2.0.1".to_owned(),
                accelerators: vec!["cpu".to_owned()],
                max_concurrent_models: 1,
            });
            engines
        };
        engines
    }

    /// Return one catalog entry to trusted native download code.
    pub fn model_descriptor(
        &self,
        model_id: &str,
    ) -> Result<TrustedModelDescriptor, LocalInferenceError> {
        Ok(find_model(&self.inner.config, model_id)?.clone())
    }

    /// Whether the trusted worker currently owns an active context for this model.
    pub fn session_loaded(&self, model_id: &str) -> bool {
        self.inner.session.lock().ok().is_some_and(|session| {
            session
                .as_ref()
                .is_some_and(|active| active.model_id == model_id)
        })
    }

    /// App-private root injected by native bootstrap, never accepted from IPC.
    pub fn app_private_root(&self) -> &Path {
        &self.inner.config.app_private_root
    }

    /// Verify the selected app-private file without claiming it is loaded.
    pub fn model_status(&self, model_id: &str) -> Result<ModelStatus, LocalInferenceError> {
        let model = find_model(&self.inner.config, model_id)?;
        let path = model_path(&self.inner.config, model)?;
        let loaded = self
            .inner
            .session
            .lock()
            .ok()
            .and_then(|session| session.as_ref().map(|session| session.model_id == model_id))
            .unwrap_or(false);
        let status = if loaded {
            "ready"
        } else if !path.exists() {
            "absent"
        } else if verify_model_file(&path, model).is_ok() {
            "ready"
        } else {
            "corrupt"
        };
        Ok(ModelStatus {
            model_id: model_id.to_owned(),
            state: status.to_owned(),
            bytes_on_disk: path.metadata().ok().map(|metadata| metadata.len()),
        })
    }

    /// Load the real model/context before returning an active session.
    pub async fn create_session(
        &self,
        session_id: String,
        model_id: String,
        profile_generation: u64,
    ) -> Result<SessionInfo, LocalInferenceError> {
        validate_identifier(&session_id)?;
        let model = find_model(&self.inner.config, &model_id)?.clone();
        let path = model_path(&self.inner.config, &model)?;
        let verify_path = path.clone();
        let verify_model = model.clone();
        tokio::task::spawn_blocking(move || verify_model_file(&verify_path, &verify_model))
            .await
            .map_err(|_| LocalInferenceError::WorkerUnavailable)??;
        {
            let mut current = self
                .inner
                .session
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            if current.is_some() {
                return Err(LocalInferenceError::SessionBusy);
            }
            *current = Some(SessionState {
                session_id: session_id.clone(),
                model_id: model_id.clone(),
                profile_generation,
            });
        }
        let (reply, result) = oneshot::channel();
        let use_native_backend = model.file_name.ends_with(".litertlm")
            || is_needle_model(&model)
            || is_cactus_model(&model);
        let cache_path = self
            .inner
            .config
            .app_private_root
            .join("cache")
            .join(&model_id);
        if use_native_backend && self.native_backend()?.is_none() {
            if let Ok(mut current) = self.inner.session.lock() {
                if current
                    .as_ref()
                    .is_some_and(|state| state.session_id == session_id)
                {
                    *current = None;
                }
            }
            return Err(LocalInferenceError::Unsupported);
        }
        if self
            .inner
            .sender
            .send(WorkerCommand::Create {
                session_id: session_id.clone(),
                model_id: model_id.clone(),
                model_path: path,
                cache_path,
                use_native_backend,
                context_tokens: model.context_tokens,
                reply,
            })
            .is_err()
        {
            if let Ok(mut current) = self.inner.session.lock() {
                if current
                    .as_ref()
                    .is_some_and(|state| state.session_id == session_id)
                {
                    *current = None;
                }
            }
            return Err(LocalInferenceError::WorkerUnavailable);
        }
        let loaded = result
            .await
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        if let Err(error) = loaded {
            if let Ok(mut current) = self.inner.session.lock() {
                if current
                    .as_ref()
                    .is_some_and(|state| state.session_id == session_id)
                {
                    *current = None;
                }
            }
            return Err(error);
        }
        let context_bytes = None;
        Ok(SessionInfo {
            model_id,
            session_id,
            context_bytes,
            context_tokens: model.context_tokens,
        })
    }

    /// Generate one bounded answer or constrained tool-call proposal.
    pub async fn complete(
        &self,
        session_id: &str,
        request_id: String,
        mut request: CompletionRequest,
        profile_generation: u64,
    ) -> Result<CompletionResult, LocalInferenceError> {
        validate_identifier(&request_id)?;
        let session = self.active_session(session_id)?;
        if request.session_id != session_id
            || request.model_id != session.model_id
            || session.profile_generation != profile_generation
        {
            return Err(LocalInferenceError::InvalidRequest);
        }
        let model = find_model(&self.inner.config, &session.model_id)?;
        validate_request(&request, model)?;
        if request.options.max_tokens.is_none() {
            request.options.max_tokens = Some(model.max_output_tokens);
        }
        let request_json =
            serde_json::to_string(&request).map_err(|_| LocalInferenceError::InvalidRequest)?;
        if request_json.len() > MAX_REQUEST_BYTES {
            return Err(LocalInferenceError::InvalidRequest);
        }
        let cancellation = Arc::new(BridgeCancel::new());
        let key = (session_id.to_owned(), request_id);
        {
            let mut pending = self
                .inner
                .pending_cancellations
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            let mut operations = self
                .inner
                .operations
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            if pending.remove(&key) {
                return Err(LocalInferenceError::Cancelled);
            }
            if !operations.is_empty() {
                return Err(LocalInferenceError::SessionBusy);
            }
            if cancellation.0.is_null() {
                return Err(LocalInferenceError::WorkerUnavailable);
            }
            operations.insert(key.clone(), Arc::clone(&cancellation));
        }
        let (reply, result) = oneshot::channel();
        if self
            .inner
            .sender
            .send(WorkerCommand::Complete {
                session_id: session_id.to_owned(),
                request_id: key.1.clone(),
                request_json,
                cancellation,
                reply,
            })
            .is_err()
        {
            self.remove_operation(&key);
            return Err(LocalInferenceError::WorkerUnavailable);
        }
        let response = result
            .await
            .map_err(|_| LocalInferenceError::WorkerUnavailable);
        self.remove_operation(&key);
        let response = response??;
        serde_json::from_str(&response).map_err(|_| LocalInferenceError::InferenceFailed)
    }

    /// Cancel only the exact currently admitted request.
    pub fn cancel(&self, session_id: &str, request_id: &str) -> CancelResult {
        if validate_identifier(session_id).is_err() || validate_identifier(request_id).is_err() {
            return CancelResult { cancelled: false };
        }
        let Ok(active) = self.active_session(session_id) else {
            return CancelResult { cancelled: false };
        };
        // Needle2 has no interrupt symbol. Refuse cancellation before entering
        // either the admitted-operation or pending-cancellation path.
        if find_model(&self.inner.config, &active.model_id).is_ok_and(is_needle_model) {
            return CancelResult { cancelled: false };
        }
        let key = (session_id.to_owned(), request_id.to_owned());
        let Ok(mut pending) = self.inner.pending_cancellations.lock() else {
            return CancelResult { cancelled: false };
        };
        let Ok(operations) = self.inner.operations.lock() else {
            return CancelResult { cancelled: false };
        };
        let cancellation = operations.get(&key).cloned();
        if let Some(cancellation) = cancellation {
            cancellation.request();
            if self
                .active_session(session_id)
                .ok()
                .and_then(|session| {
                    find_model(&self.inner.config, &session.model_id)
                        .ok()
                        .cloned()
                })
                .is_some_and(|model| {
                    model.file_name.ends_with(".litertlm") || is_cactus_model(&model)
                })
            {
                if let Ok(Some(backend)) = self.native_backend() {
                    return CancelResult {
                        cancelled: backend.cancel(request_id),
                    };
                }
            }
            CancelResult { cancelled: true }
        } else if pending.contains(&key) {
            CancelResult { cancelled: true }
        } else if pending.len() < MAX_PENDING_CANCELLATIONS {
            pending.insert(key);
            CancelResult { cancelled: true }
        } else {
            CancelResult { cancelled: false }
        }
    }

    /// Clear engine memory for the exact active session.
    pub async fn reset_session(&self, session_id: &str) -> Result<(), LocalInferenceError> {
        self.active_session(session_id)?;
        {
            let mut pending = self
                .inner
                .pending_cancellations
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            let operations = self
                .inner
                .operations
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            if !operations.is_empty() {
                return Err(LocalInferenceError::SessionBusy);
            }
            pending.retain(|(active_session, _)| active_session != session_id);
        }
        let (reply, result) = oneshot::channel();
        self.inner
            .sender
            .send(WorkerCommand::Reset {
                session_id: session_id.to_owned(),
                reply,
            })
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        result
            .await
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?
    }

    /// Destroy the exact session after pending work has returned.
    pub async fn destroy_session(&self, session_id: &str) -> Result<(), LocalInferenceError> {
        self.active_session(session_id)?;
        {
            let mut pending = self
                .inner
                .pending_cancellations
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            let operations = self
                .inner
                .operations
                .lock()
                .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
            if operations
                .keys()
                .any(|(active_session, _)| active_session == session_id)
            {
                return Err(LocalInferenceError::SessionBusy);
            }
            pending.retain(|(active_session, _)| active_session != session_id);
        }
        let (reply, result) = oneshot::channel();
        self.inner
            .sender
            .send(WorkerCommand::Destroy {
                session_id: session_id.to_owned(),
                reply,
            })
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?;
        result
            .await
            .map_err(|_| LocalInferenceError::WorkerUnavailable)??;
        if let Ok(mut current) = self.inner.session.lock() {
            if current
                .as_ref()
                .is_some_and(|state| state.session_id == session_id)
            {
                *current = None;
            }
        }
        Ok(())
    }

    fn active_session(&self, session_id: &str) -> Result<SessionState, LocalInferenceError> {
        self.inner
            .session
            .lock()
            .map_err(|_| LocalInferenceError::WorkerUnavailable)?
            .as_ref()
            .filter(|session| session.session_id == session_id)
            .cloned()
            .ok_or(LocalInferenceError::SessionUnavailable)
    }

    fn remove_operation(&self, key: &(String, String)) {
        if let Ok(mut operations) = self.inner.operations.lock() {
            operations.remove(key);
        }
    }
}

#[cfg(not(feature = "native-llamacpp"))]
impl LocalInferenceState {
    /// Construct an explicitly unsupported state when the pinned engine is not
    /// compiled into this target.
    pub fn new(config: LocalInferenceConfig) -> Result<Self, LocalInferenceError> {
        validate_config(&config)?;
        Ok(Self {
            inner: Arc::new(Inner { config }),
        })
    }

    pub fn catalog(&self) -> Vec<CatalogModel> {
        Vec::new()
    }

    pub fn engines(&self) -> Vec<EngineInfo> {
        Vec::new()
    }

    pub fn model_descriptor(
        &self,
        model_id: &str,
    ) -> Result<TrustedModelDescriptor, LocalInferenceError> {
        Ok(find_model(&self.inner.config, model_id)?.clone())
    }

    pub fn session_loaded(&self, _model_id: &str) -> bool {
        false
    }

    pub fn app_private_root(&self) -> &Path {
        &self.inner.config.app_private_root
    }

    pub fn model_status(&self, _model_id: &str) -> Result<ModelStatus, LocalInferenceError> {
        Err(LocalInferenceError::Unsupported)
    }

    pub async fn create_session(
        &self,
        _session_id: String,
        _model_id: String,
        _profile_generation: u64,
    ) -> Result<SessionInfo, LocalInferenceError> {
        Err(LocalInferenceError::Unsupported)
    }

    pub async fn complete(
        &self,
        _session_id: &str,
        _request_id: String,
        _request: CompletionRequest,
        _profile_generation: u64,
    ) -> Result<CompletionResult, LocalInferenceError> {
        Err(LocalInferenceError::Unsupported)
    }

    pub fn cancel(&self, _session_id: &str, _request_id: &str) -> CancelResult {
        CancelResult::default()
    }

    pub async fn reset_session(&self, _session_id: &str) -> Result<(), LocalInferenceError> {
        Err(LocalInferenceError::Unsupported)
    }

    pub async fn destroy_session(&self, _session_id: &str) -> Result<(), LocalInferenceError> {
        Err(LocalInferenceError::Unsupported)
    }
}

fn validate_config(config: &LocalInferenceConfig) -> Result<(), LocalInferenceError> {
    if config.models.len() > 16 {
        return Err(LocalInferenceError::ModelUnavailable);
    }
    let mut ids = std::collections::HashSet::new();
    for model in &config.models {
        validate_identifier(&model.model_id)?;
        if !ids.insert(model.model_id.as_str())
            || model.byte_size == 0
            || model.byte_size > MAX_MODEL_BYTES
            || model.context_tokens == 0
            || model.context_tokens > MAX_CONTEXT_TOKENS
            || model.max_output_tokens == 0
            || model.max_output_tokens > MAX_OUTPUT_TOKENS
            || model.sha256.len() != 64
            || !model
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !safe_file_name(&model.file_name)
            || !model.source_url.starts_with("https://")
        {
            return Err(LocalInferenceError::ModelUnavailable);
        }
    }
    Ok(())
}

fn find_model<'a>(
    config: &'a LocalInferenceConfig,
    model_id: &str,
) -> Result<&'a TrustedModelDescriptor, LocalInferenceError> {
    config
        .models
        .iter()
        .find(|model| model.model_id == model_id)
        .ok_or(LocalInferenceError::ModelUnavailable)
}

#[cfg(feature = "native-llamacpp")]
fn model_path(
    config: &LocalInferenceConfig,
    model: &TrustedModelDescriptor,
) -> Result<PathBuf, LocalInferenceError> {
    if !safe_file_name(&model.file_name) {
        return Err(LocalInferenceError::ModelUnavailable);
    }
    Ok(config.app_private_root.join(&model.file_name))
}

fn safe_file_name(file_name: &str) -> bool {
    let path = Path::new(file_name);
    !file_name.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && !file_name.bytes().any(|byte| matches!(byte, b'/' | b'\\'))
}

fn validate_identifier(value: &str) -> Result<(), LocalInferenceError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(LocalInferenceError::InvalidRequest);
    }
    Ok(())
}

#[cfg(feature = "native-llamacpp")]
fn is_cactus_model(model: &TrustedModelDescriptor) -> bool {
    cfg!(all(
        feature = "native-cactus",
        target_os = "ios",
        target_arch = "aarch64"
    )) && model.model_id == "chat-qwen3-06b-cactus"
        && model.file_name == "qwen3-0.6b-int4.zip"
}

#[cfg(feature = "native-llamacpp")]
fn is_needle_model(model: &TrustedModelDescriptor) -> bool {
    cfg!(all(
        feature = "native-needle2",
        target_os = "android",
        target_arch = "aarch64"
    )) && model.model_id == "actions-needle2"
        && model.file_name == "needle2.cact"
}

#[cfg(feature = "native-llamacpp")]
fn verify_model_file(
    path: &Path,
    model: &TrustedModelDescriptor,
) -> Result<(), LocalInferenceError> {
    let root = path.parent().ok_or(LocalInferenceError::ModelUnavailable)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let canonical_path = path
        .canonicalize()
        .map_err(|_| LocalInferenceError::ModelUnavailable)?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(LocalInferenceError::ModelUnavailable);
    }
    let metadata =
        std::fs::metadata(&canonical_path).map_err(|_| LocalInferenceError::ModelUnavailable)?;
    if !metadata.is_file() || metadata.len() != model.byte_size || metadata.len() > MAX_MODEL_BYTES
    {
        return Err(LocalInferenceError::ModelUnverified);
    }
    let mut file =
        File::open(&canonical_path).map_err(|_| LocalInferenceError::ModelUnavailable)?;
    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)
        .map_err(|_| LocalInferenceError::ModelUnverified)?;
    let valid_magic = if is_cactus_model(model) {
        &magic == b"PK\x03\x04"
    } else {
        model.file_name.ends_with(".litertlm") || is_needle_model(model) || &magic == b"GGUF"
    };
    if !valid_magic {
        return Err(LocalInferenceError::ModelUnverified);
    }
    file.rewind()
        .map_err(|_| LocalInferenceError::ModelUnverified)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| LocalInferenceError::ModelUnverified)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual != model.sha256 {
        return Err(LocalInferenceError::ModelUnverified);
    }
    Ok(())
}

#[cfg(feature = "native-llamacpp")]
fn validate_request(
    request: &CompletionRequest,
    model: &TrustedModelDescriptor,
) -> Result<(), LocalInferenceError> {
    if (!model.capabilities.tools && !request.tools.is_empty())
        || request.messages.is_empty()
        || request.messages.len() > MAX_MESSAGE_COUNT
        || request.tools.len() > MAX_TOOL_COUNT
        || request
            .options
            .max_tokens
            .is_some_and(|tokens| tokens == 0 || tokens > model.max_output_tokens)
        || request
            .options
            .temperature
            .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
        || request
            .options
            .tool_rag_top_k
            .is_some_and(|value| value > MAX_TOOL_COUNT as u32)
        || request
            .options
            .stop_sequences
            .as_ref()
            .is_some_and(|values| {
                values.len() > 8
                    || values
                        .iter()
                        .any(|value| value.is_empty() || value.len() > 128)
            })
        || request.options.force_tools == Some(true) && request.tools.is_empty()
    {
        return Err(LocalInferenceError::InvalidRequest);
    }
    let mut content_bytes = 0usize;
    for message in &request.messages {
        if !matches!(
            message.role.as_str(),
            "system" | "user" | "assistant" | "tool"
        ) {
            return Err(LocalInferenceError::InvalidRequest);
        }
        content_bytes = content_bytes
            .checked_add(message.content.len())
            .ok_or(LocalInferenceError::InvalidRequest)?;
        if message.name.as_ref().is_some_and(|value| value.len() > 128)
            || message
                .tool_call_id
                .as_ref()
                .is_some_and(|value| value.len() > 256)
            || message
                .tool_calls
                .as_ref()
                .is_some_and(|value| value.len() > MAX_TOOL_COUNT)
            || message
                .metadata
                .as_ref()
                .is_some_and(|value| value.to_string().len() > MAX_TOOL_SCHEMA_BYTES)
        {
            return Err(LocalInferenceError::InvalidRequest);
        }
    }
    if content_bytes > MAX_CONTENT_BYTES {
        return Err(LocalInferenceError::InvalidRequest);
    }
    let mut names = std::collections::HashSet::new();
    for tool in &request.tools {
        if tool.r#type != "function" {
            return Err(LocalInferenceError::InvalidRequest);
        }
        validate_identifier(&tool.function.name)?;
        if !names.insert(tool.function.name.as_str())
            || tool.function.description.len() > 2048
            || tool.function.parameters.to_string().len() > MAX_TOOL_SCHEMA_BYTES
            || !tool.function.parameters.is_object()
            || !validate_schema_depth(&tool.function.parameters, 0)
        {
            return Err(LocalInferenceError::InvalidRequest);
        }
    }
    Ok(())
}

#[cfg(feature = "native-llamacpp")]
fn native_surface() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "desktop"
    }
}

#[cfg(feature = "native-llamacpp")]
fn validate_schema_depth(value: &Value, depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    match value {
        Value::Object(fields) => {
            fields.len() <= 128
                && !fields.contains_key("$ref")
                && fields
                    .values()
                    .all(|child| validate_schema_depth(child, depth + 1))
        }
        Value::Array(items) => {
            items.len() <= 128
                && items
                    .iter()
                    .all(|item| validate_schema_depth(item, depth + 1))
        }
        _ => true,
    }
}

#[cfg(feature = "native-llamacpp")]
enum WorkerEngine {
    Llama(*mut BridgeEngine),
    Native,
}

#[cfg(feature = "native-llamacpp")]
fn worker_loop(
    receiver: mpsc::Receiver<WorkerCommand>,
    native_backend: Arc<RwLock<Option<Arc<dyn NativeInferenceBackend>>>>,
) {
    use std::ffi::{CStr, CString};
    use std::ptr;

    unsafe {
        aurora_llama_backend_init();
    }
    let mut active_session: Option<(String, String, WorkerEngine)> = None;
    while let Ok(command) = receiver.recv() {
        match command {
            WorkerCommand::Create {
                session_id,
                model_id,
                model_path,
                cache_path,
                use_native_backend,
                context_tokens,
                reply,
            } => {
                if active_session.is_some() {
                    let _ = reply.send(Err(LocalInferenceError::SessionBusy));
                    continue;
                }
                if use_native_backend {
                    let backend = native_backend
                        .read()
                        .ok()
                        .and_then(|backend| backend.clone());
                    let Some(backend) = backend else {
                        let _ = reply.send(Err(LocalInferenceError::Unsupported));
                        continue;
                    };
                    match backend.load(&model_id, &model_path, &cache_path) {
                        Ok(()) => {
                            active_session = Some((session_id, model_id, WorkerEngine::Native));
                            let _ = reply.send(Ok(()));
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                    }
                    continue;
                }
                let path = match model_path
                    .to_str()
                    .and_then(|value| CString::new(value).ok())
                {
                    Some(path) => path,
                    None => {
                        let _ = reply.send(Err(LocalInferenceError::ModelUnavailable));
                        continue;
                    }
                };
                let mut engine = ptr::null_mut();
                let mut error = ptr::null_mut();
                let result = unsafe {
                    aurora_llama_engine_create(
                        path.as_ptr(),
                        context_tokens,
                        0,
                        &mut engine,
                        &mut error,
                    )
                };
                if result != 0 || engine.is_null() {
                    eprintln!("aurora_local_inference_create_failed code={result}");
                    unsafe { free_bridge_string(error) };
                    let _ = reply.send(Err(LocalInferenceError::InferenceFailed));
                    continue;
                }
                active_session = Some((session_id, model_id, WorkerEngine::Llama(engine)));
                let _ = reply.send(Ok(()));
            }
            WorkerCommand::Complete {
                session_id,
                request_id,
                request_json,
                cancellation,
                reply,
            } => {
                let Some((active_id, _, engine)) = active_session.as_ref() else {
                    let _ = reply.send(Err(LocalInferenceError::SessionUnavailable));
                    continue;
                };
                if active_id != &session_id {
                    let _ = reply.send(Err(LocalInferenceError::SessionUnavailable));
                    continue;
                }
                if matches!(engine, WorkerEngine::Native) {
                    let backend = native_backend
                        .read()
                        .ok()
                        .and_then(|backend| backend.clone());
                    let result = backend
                        .ok_or(LocalInferenceError::Unsupported)
                        .and_then(|backend| backend.complete(&request_id, &request_json));
                    let _ = reply.send(if cancellation.is_requested() {
                        Err(LocalInferenceError::Cancelled)
                    } else {
                        result
                    });
                    continue;
                }
                let WorkerEngine::Llama(engine) = engine else {
                    unreachable!()
                };
                let request = match CString::new(request_json) {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = reply.send(Err(LocalInferenceError::InvalidRequest));
                        continue;
                    }
                };
                let mut response = ptr::null_mut();
                let mut error = ptr::null_mut();
                let status = unsafe {
                    aurora_llama_complete(
                        *engine,
                        request.as_ptr(),
                        cancellation.0,
                        &mut response,
                        &mut error,
                    )
                };
                let result = if status == 0 && !response.is_null() {
                    let response_string = unsafe { CStr::from_ptr(response) }
                        .to_string_lossy()
                        .into_owned();
                    unsafe { free_bridge_string(response) };
                    Ok(response_string)
                } else {
                    eprintln!("aurora_local_inference_complete_failed code={status}");
                    unsafe { free_bridge_string(response) };
                    unsafe { free_bridge_string(error) };
                    if cancellation.is_requested() {
                        Err(LocalInferenceError::Cancelled)
                    } else {
                        Err(LocalInferenceError::InferenceFailed)
                    }
                };
                let _ = reply.send(result);
            }
            WorkerCommand::Reset { session_id, reply } => {
                let result = match active_session.as_ref() {
                    Some((active_id, _, WorkerEngine::Llama(engine)))
                        if active_id == &session_id =>
                    {
                        let status = unsafe { aurora_llama_engine_reset(*engine) };
                        if status == 0 {
                            Ok(())
                        } else {
                            Err(LocalInferenceError::InferenceFailed)
                        }
                    }
                    Some((active_id, _, WorkerEngine::Native)) if active_id == &session_id => {
                        native_backend
                            .read()
                            .ok()
                            .and_then(|backend| backend.clone())
                            .ok_or(LocalInferenceError::Unsupported)
                            .and_then(|backend| backend.reset())
                    }
                    _ => Err(LocalInferenceError::SessionUnavailable),
                };
                let _ = reply.send(result);
            }
            WorkerCommand::Destroy { session_id, reply } => {
                let result = match active_session.as_ref() {
                    Some((active_id, _, WorkerEngine::Llama(engine)))
                        if active_id == &session_id =>
                    {
                        unsafe { aurora_llama_engine_destroy(*engine) };
                        Ok(())
                    }
                    Some((active_id, _, WorkerEngine::Native)) if active_id == &session_id => {
                        native_backend
                            .read()
                            .ok()
                            .and_then(|backend| backend.clone())
                            .ok_or(LocalInferenceError::Unsupported)
                            .and_then(|backend| backend.destroy())
                    }
                    _ => Err(LocalInferenceError::SessionUnavailable),
                };
                if result.is_ok() {
                    active_session = None;
                }
                let _ = reply.send(result);
            }
        }
    }
    if let Some((_, _, engine)) = active_session {
        match engine {
            WorkerEngine::Llama(engine) => unsafe { aurora_llama_engine_destroy(engine) },
            WorkerEngine::Native => {
                if let Some(backend) = native_backend
                    .read()
                    .ok()
                    .and_then(|backend| backend.clone())
                {
                    let _ = backend.destroy();
                }
            }
        }
    }
}

#[cfg(feature = "native-llamacpp")]
struct BridgeCancel(*mut BridgeCancellation);

#[cfg(feature = "native-llamacpp")]
unsafe impl Send for BridgeCancel {}
#[cfg(feature = "native-llamacpp")]
unsafe impl Sync for BridgeCancel {}

#[cfg(feature = "native-llamacpp")]
impl BridgeCancel {
    fn new() -> Self {
        Self(unsafe { aurora_llama_cancel_create() })
    }

    fn request(&self) {
        if !self.0.is_null() {
            unsafe { aurora_llama_cancel_request(self.0) };
        }
    }

    fn is_requested(&self) -> bool {
        !self.0.is_null() && unsafe { aurora_llama_cancel_is_requested(self.0) != 0 }
    }
}

#[cfg(feature = "native-llamacpp")]
impl Drop for BridgeCancel {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { aurora_llama_cancel_destroy(self.0) };
        }
    }
}

#[cfg(feature = "native-llamacpp")]
#[repr(C)]
struct BridgeEngine {
    _private: [u8; 0],
}

#[cfg(feature = "native-llamacpp")]
#[repr(C)]
struct BridgeCancellation {
    _private: [u8; 0],
}

#[cfg(feature = "native-llamacpp")]
unsafe extern "C" {
    fn aurora_llama_backend_init();
    fn aurora_llama_engine_create(
        model_path: *const std::ffi::c_char,
        context_tokens: u32,
        threads: u32,
        engine_out: *mut *mut BridgeEngine,
        error_out: *mut *mut std::ffi::c_char,
    ) -> i32;
    fn aurora_llama_engine_destroy(engine: *mut BridgeEngine);
    fn aurora_llama_engine_reset(engine: *mut BridgeEngine) -> i32;
    fn aurora_llama_cancel_create() -> *mut BridgeCancellation;
    fn aurora_llama_cancel_request(cancellation: *mut BridgeCancellation);
    fn aurora_llama_cancel_is_requested(cancellation: *const BridgeCancellation) -> i32;
    fn aurora_llama_cancel_destroy(cancellation: *mut BridgeCancellation);
    fn aurora_llama_complete(
        engine: *mut BridgeEngine,
        request_json: *const std::ffi::c_char,
        cancellation: *mut BridgeCancellation,
        response_json_out: *mut *mut std::ffi::c_char,
        error_out: *mut *mut std::ffi::c_char,
    ) -> i32;
    fn aurora_llama_free_string(value: *mut std::ffi::c_char);
}

#[cfg(feature = "native-llamacpp")]
unsafe fn free_bridge_string(value: *mut std::ffi::c_char) {
    if !value.is_null() {
        unsafe { aurora_llama_free_string(value) };
    }
}
