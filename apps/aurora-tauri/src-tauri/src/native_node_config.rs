//! Tauri boundary for the native profile-selected node-policy owner.

#[cfg(any(target_os = "android", target_os = "ios"))]
use super::thin_profile_document_from_payload;
#[cfg(any(target_os = "android", target_os = "ios"))]
use super::AuroraMobileNativePlugin;
#[cfg(desktop)]
use super::{run_secure_storage_blocking, thin_profile_storage_entry};
use super::{
    store_thin_profile_state, AuroraCommandError, SharedThinProfileState, ThinProfileState,
};
use async_trait::async_trait;
use aurora_voice_core::node_policy::SpeechStages;
use aurora_voice_native::native_publication_fence::{
    NativePublicationFence, NativePublicationRegistration,
};
use aurora_voice_native::node_config::NodeConfigOperationError;
use aurora_voice_native::node_config_coordinator::{
    NativeProfileAdapter, NativeProfileAdapterError, NativeProfilePublicationFailure,
    NodeConfigCoordinator, NodeConfigCoordinatorError,
};
use aurora_voice_native::node_config_drafts::{
    NativeNodeConfigCaller, NodeConfigDraftNonceError, NodeConfigDraftNonceIssuer,
    NodeConfigDraftRegistry,
};
use aurora_voice_native::node_config_file::NodeConfigFilePersistence;
use aurora_voice_native::runtime_profile::RuntimeProfileValidationOptions;
use serde::Serialize;
#[cfg(any(target_os = "android", target_os = "ios"))]
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

const CALLER_DOMAIN: &[u8] = b"aurora.tauri.node-config.caller.v1\0";
const MAX_DOCUMENT_WINDOWS: usize = 64;
const POLICY_CHANGED_EVENT: &str = "aurora-node-config-policy-changed";

#[derive(Clone)]
pub(crate) struct NativeNodeConfigRuntime {
    inner: Arc<NativeNodeConfigRuntimeInner>,
}

struct NativeNodeConfigRuntimeInner {
    app: AppHandle<tauri::Wry>,
    profile_state: SharedThinProfileState,
    coordinator: NodeConfigCoordinator<TauriProfileAdapter, NodeConfigFilePersistence>,
    drafts: Arc<NodeConfigDraftRegistry<OsNonceIssuer>>,
    fence: NativePublicationFence,
    documents: Mutex<HashMap<String, WindowDocumentState>>,
    next_document_epoch: AtomicU64,
    profile_generation: AtomicU64,
    profile_transition: Arc<tokio::sync::RwLock<()>>,
    lifecycle_nonce: [u8; 16],
}

struct DocumentScope {
    epoch: u64,
    token: String,
    caller: NativeNodeConfigCaller,
    registration: Arc<NativePublicationRegistration>,
}

struct WindowDocumentState {
    epoch: u64,
    finished: bool,
    retiring: Option<Arc<DocumentScope>>,
    active: Option<Arc<DocumentScope>>,
    activate_after_retirement: bool,
}

struct TauriProfileAdapter {
    app: AppHandle<tauri::Wry>,
    profile_state: SharedThinProfileState,
    drafts: Arc<NodeConfigDraftRegistry<OsNonceIssuer>>,
}

struct OsNonceIssuer;

impl NodeConfigDraftNonceIssuer for OsNonceIssuer {
    fn issue_nonce(&self) -> Result<[u8; 32], NodeConfigDraftNonceError> {
        let mut nonce = [0; 32];
        getrandom::getrandom(&mut nonce).map_err(|_| NodeConfigDraftNonceError)?;
        Ok(nonce)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyReadResponse {
    document_json: String,
    draft_handle: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolicyWriteResponse {
    document_json: String,
    saved_revision: u64,
}

impl NativeNodeConfigRuntime {
    pub(crate) fn new(
        app: AppHandle<tauri::Wry>,
        profile_state: SharedThinProfileState,
        storage_root: PathBuf,
        profile_validation_options: RuntimeProfileValidationOptions,
    ) -> Result<Self, AuroraCommandError> {
        std::fs::create_dir_all(&storage_root)
            .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;

        let drafts = Arc::new(
            NodeConfigDraftRegistry::new(OsNonceIssuer)
                .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?,
        );
        let mut lifecycle_nonce = [0; 16];
        getrandom::getrandom(&mut lifecycle_nonce)
            .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;

        let fence = NativePublicationFence::new();
        let app_for_runtime = app.clone();
        let profile_state_for_runtime = Arc::clone(&profile_state);
        let profile_adapter = TauriProfileAdapter {
            app,
            profile_state,
            drafts: Arc::clone(&drafts),
        };
        let coordinator = NodeConfigCoordinator::new_with_profile_validation_options(
            NodeConfigFilePersistence::new(storage_root),
            profile_adapter,
            profile_validation_options,
        );

        Ok(Self {
            inner: Arc::new(NativeNodeConfigRuntimeInner {
                app: app_for_runtime,
                profile_state: profile_state_for_runtime,
                coordinator,
                drafts,
                fence,
                documents: Mutex::new(HashMap::new()),
                next_document_epoch: AtomicU64::new(1),
                profile_generation: AtomicU64::new(1),
                profile_transition: Arc::new(tokio::sync::RwLock::new(())),
                lifecycle_nonce,
            }),
        })
    }

    pub(crate) fn begin_document_load(&self, window_label: &str) -> bool {
        let Some(epoch) = self.next_document_epoch() else {
            return false;
        };
        let token = issue_document_token()
            .ok()
            .map(|bytes| (bytes, encode_document_token(&bytes)));
        let previous = {
            let Ok(mut documents) = self.inner.documents.lock() else {
                return false;
            };
            if !documents.contains_key(window_label) && documents.len() >= MAX_DOCUMENT_WINDOWS {
                return false;
            }
            let previous = documents
                .get(window_label)
                .and_then(|state| state.active.clone().or_else(|| state.retiring.clone()));
            documents.insert(
                window_label.to_owned(),
                WindowDocumentState {
                    epoch,
                    finished: false,
                    retiring: previous.clone(),
                    active: None,
                    activate_after_retirement: token.is_some(),
                },
            );
            previous
        };
        if let Some(previous) = previous {
            let _ = self.inner.drafts.invalidate_caller(previous.caller);
            let Ok(waiter) = self.inner.fence.revoke(&previous.registration) else {
                return true;
            };
            let runtime = self.clone();
            let label = window_label.to_owned();
            tauri::async_runtime::spawn(async move {
                // A failed operation still has a terminal settled outcome; the
                // coordinator independently keeps policy access quarantined.
                let _ = waiter.wait().await;
                if let Some((token_bytes, token_text)) = token {
                    runtime.finish_document_transition(label, epoch, token_bytes, token_text);
                } else {
                    runtime.finish_document_destruction(label, epoch);
                }
            });
        } else if let Some((token_bytes, token_text)) = token {
            self.finish_document_transition(
                window_label.to_owned(),
                epoch,
                token_bytes,
                token_text,
            );
        } else if let Ok(mut documents) = self.inner.documents.lock() {
            documents.remove(window_label);
        }
        true
    }

    pub(crate) fn finish_document_load(&self, window_label: &str) {
        let (found, active) = {
            let Ok(mut documents) = self.inner.documents.lock() else {
                return;
            };
            match documents.get_mut(window_label) {
                Some(state) => {
                    state.finished = true;
                    (
                        true,
                        state
                            .active
                            .as_ref()
                            .map(|scope| (state.epoch, scope.token.clone())),
                    )
                }
                None => (false, None),
            }
        };
        if !found {
            if self.begin_document_load(window_label) {
                self.finish_document_load(window_label);
            }
            return;
        }
        if let Some((epoch, token)) = active {
            self.inject_document_token(window_label, epoch, &token);
        }
    }

    pub(crate) fn invalidate_window(&self, window_label: &str) {
        let Some(epoch) = self.next_document_epoch() else {
            return;
        };
        let previous = {
            let Ok(mut documents) = self.inner.documents.lock() else {
                return;
            };
            let previous = documents
                .get(window_label)
                .and_then(|state| state.active.clone().or_else(|| state.retiring.clone()));
            if let Some(previous) = previous.as_ref() {
                documents.insert(
                    window_label.to_owned(),
                    WindowDocumentState {
                        epoch,
                        finished: false,
                        retiring: Some(Arc::clone(previous)),
                        active: None,
                        activate_after_retirement: false,
                    },
                );
            } else {
                documents.remove(window_label);
            }
            previous
        };
        let Some(previous) = previous else {
            return;
        };
        let _ = self.inner.drafts.invalidate_caller(previous.caller);
        let Ok(waiter) = self.inner.fence.revoke(&previous.registration) else {
            return;
        };
        let runtime = self.clone();
        let label = window_label.to_owned();
        tauri::async_runtime::spawn(async move {
            let _ = waiter.wait().await;
            runtime.finish_document_destruction(label, epoch);
        });
    }

    fn next_document_epoch(&self) -> Option<u64> {
        self.inner
            .next_document_epoch
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_add(1)
            })
            .ok()
    }

    fn finish_document_transition(
        &self,
        window_label: String,
        epoch: u64,
        token_bytes: [u8; 32],
        token: String,
    ) {
        let pending = self.inner.documents.lock().ok().is_some_and(|documents| {
            documents.get(&window_label).is_some_and(|state| {
                state.epoch == epoch && state.activate_after_retirement && state.active.is_none()
            })
        });
        if !pending {
            return;
        }
        let Ok(registration) = self.inner.fence.register() else {
            return;
        };
        let scope = Arc::new(DocumentScope {
            epoch,
            token: token.clone(),
            caller: caller_for_window(&self.inner.lifecycle_nonce, &window_label, &token_bytes),
            registration: Arc::new(registration),
        });
        let should_inject = if let Ok(mut documents) = self.inner.documents.lock() {
            if let Some(state) = documents.get_mut(&window_label) {
                if state.epoch == epoch && state.activate_after_retirement && state.active.is_none()
                {
                    state.active = Some(scope);
                    state.retiring = None;
                    state.finished
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };
        if should_inject {
            self.inject_document_token(&window_label, epoch, &token);
        }
    }

    fn inject_document_token(&self, window_label: &str, epoch: u64, token: &str) {
        let current = self.inner.documents.lock().ok().is_some_and(|documents| {
            documents.get(window_label).is_some_and(|state| {
                state.epoch == epoch
                    && state.finished
                    && state
                        .active
                        .as_ref()
                        .is_some_and(|scope| scope.epoch == epoch && scope.token == token)
            })
        });
        if !current {
            return;
        }
        if let Some(window) = self.inner.app.get_webview_window(window_label) {
            let _ = window.eval(&format!(
                "window.__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__ = '{token}'; window.dispatchEvent(new Event('aurora-node-config-document-token-ready'));"
            ));
        }
    }

    fn finish_document_destruction(&self, window_label: String, epoch: u64) {
        if let Ok(mut documents) = self.inner.documents.lock() {
            if documents
                .get(&window_label)
                .is_some_and(|state| state.epoch == epoch && !state.activate_after_retirement)
            {
                documents.remove(&window_label);
            }
        }
    }

    fn document_scope(&self, window_label: &str) -> Result<Arc<DocumentScope>, AuroraCommandError> {
        self.inner
            .documents
            .lock()
            .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?
            .get(window_label)
            .and_then(|state| state.active.clone())
            .ok_or(AuroraCommandError::NodeConfigUnavailable)
    }

    fn is_current_document(&self, window_label: &str, epoch: u64) -> bool {
        self.inner.documents.lock().ok().is_some_and(|documents| {
            documents
                .get(window_label)
                .and_then(|state| state.active.as_ref())
                .is_some_and(|scope| scope.epoch == epoch)
        })
    }

    pub(crate) async fn refresh_profile(&self) -> Result<(), AuroraCommandError> {
        let _transition = Arc::clone(&self.inner.profile_transition)
            .write_owned()
            .await;
        self.bump_profile_generation()?;
        let refreshed = self
            .inner
            .coordinator
            .refresh_confirmed_profile()
            .await
            .map_err(map_coordinator_error);
        if refreshed.is_err() {
            let _ = self.inner.drafts.invalidate_all();
        }
        refreshed
    }

    /// Read recording preferences and the selected profile under one native
    /// profile-transition lease. Native capture must keep this guard until
    /// admission or a scoped archive write has finished.
    pub(crate) async fn transcription_admission_snapshot(
        &self,
    ) -> Result<
        (
            tokio::sync::OwnedRwLockReadGuard<()>,
            u64,
            aurora_voice_core::node_policy::NodeConfigDocumentV2,
            String,
        ),
        AuroraCommandError,
    > {
        let guard = Arc::clone(&self.inner.profile_transition)
            .try_read_owned()
            .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;
        let generation = self.inner.profile_generation.load(Ordering::Acquire);
        let receipt = self
            .inner
            .coordinator
            .read_policy()
            .await
            .map_err(map_coordinator_error)?;
        let profile_document = self
            .inner
            .profile_state
            .lock()
            .map_err(|_| AuroraCommandError::ProfileState)?
            .document
            .clone()
            .ok_or(AuroraCommandError::NodeConfigUnavailable)?;
        if !self.profile_generation_is_current(generation) {
            return Err(AuroraCommandError::NodeConfigUnavailable);
        }
        Ok((guard, generation, receipt.document, profile_document))
    }

    pub(crate) async fn voice_admission_snapshot(
        &self,
    ) -> Result<
        (
            tokio::sync::OwnedRwLockReadGuard<()>,
            u64,
            Option<SpeechStages>,
            Option<u64>,
            Option<String>,
        ),
        AuroraCommandError,
    > {
        let transition = Arc::clone(&self.inner.profile_transition);
        let guard = transition.read_owned().await;
        let generation = self.inner.profile_generation.load(Ordering::Acquire);
        let (stages, config_revision) = match self.inner.coordinator.read_policy().await {
            Ok(receipt) => (
                Some(receipt.document.speech.stages),
                Some(receipt.document.revision),
            ),
            Err(NodeConfigCoordinatorError::Policy(
                NodeConfigOperationError::NoSelectedProfile,
            )) => (None, None),
            Err(error) => return Err(map_coordinator_error(error)),
        };
        let profile_document = self
            .inner
            .profile_state
            .lock()
            .map_err(|_| AuroraCommandError::ProfileState)?
            .document
            .clone();
        if self.inner.profile_generation.load(Ordering::Acquire) != generation {
            return Err(AuroraCommandError::NodeConfigUnavailable);
        }
        Ok((guard, generation, stages, config_revision, profile_document))
    }

    pub(crate) fn profile_generation_is_current(&self, generation: u64) -> bool {
        self.inner.profile_generation.load(Ordering::Acquire) == generation
    }

    fn bump_profile_generation(&self) -> Result<u64, AuroraCommandError> {
        self.inner
            .profile_generation
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| AuroraCommandError::NodeConfigUnavailable)
    }

    pub(crate) async fn replace_profile(&self, document: String) -> Result<(), AuroraCommandError> {
        let _transition = Arc::clone(&self.inner.profile_transition)
            .write_owned()
            .await;
        self.bump_profile_generation()?;
        self.inner
            .coordinator
            .replace_profile(document)
            .await
            .map_err(map_coordinator_error)
    }
}

fn caller_for_window(
    lifecycle_nonce: &[u8; 16],
    window_label: &str,
    document_nonce: &[u8; 32],
) -> NativeNodeConfigCaller {
    let mut digest = Sha256::new();
    digest.update(CALLER_DOMAIN);
    digest.update(lifecycle_nonce);
    digest.update((window_label.len() as u64).to_be_bytes());
    digest.update(window_label.as_bytes());
    digest.update(document_nonce);
    let output = digest.finalize();
    let mut nonce = [0; 16];
    nonce.copy_from_slice(&output[..16]);
    NativeNodeConfigCaller::from_native_lifecycle_nonce(nonce)
}

fn issue_document_token() -> Result<[u8; 32], NodeConfigDraftNonceError> {
    let mut nonce = [0; 32];
    getrandom::getrandom(&mut nonce).map_err(|_| NodeConfigDraftNonceError)?;
    Ok(nonce)
}

fn encode_document_token(token: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in token {
        encoded.push(char::from(HEX[(byte >> 4) as usize]));
        encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    encoded
}

#[async_trait]
impl NativeProfileAdapter for TauriProfileAdapter {
    async fn read_confirmed_profile(&self) -> Result<Option<String>, NativeProfileAdapterError> {
        #[cfg(desktop)]
        {
            return tauri::async_runtime::spawn_blocking(super::read_desktop_thin_profile_document)
                .await
                .map_err(|_| NativeProfileAdapterError)?
                .map_err(|_| NativeProfileAdapterError);
        }
        #[cfg(target_os = "android")]
        {
            let native = self
                .app
                .try_state::<AuroraMobileNativePlugin<tauri::Wry>>()
                .ok_or_else(|| {
                    eprintln!("aurora_node_config_stage=android_profile_read_plugin_unavailable");
                    NativeProfileAdapterError
                })?;
            let response = super::run_android_plugin_command(native, "thinProfileGet", json!({}))
                .map_err(|_| {
                eprintln!("aurora_node_config_stage=android_profile_read_command_failed");
                NativeProfileAdapterError
            })?;
            return thin_profile_document_from_payload(&response).map_err(|_| {
                eprintln!("aurora_node_config_stage=android_profile_read_payload_invalid");
                NativeProfileAdapterError
            });
        }
        #[cfg(target_os = "ios")]
        {
            let native = self
                .app
                .try_state::<AuroraMobileNativePlugin<tauri::Wry>>()
                .ok_or(NativeProfileAdapterError)?;
            let response = super::run_ios_plugin_command(native, "thinProfileGet", json!({}))
                .map_err(|_| NativeProfileAdapterError)?;
            return thin_profile_document_from_payload(&response)
                .map_err(|_| NativeProfileAdapterError);
        }
        #[allow(unreachable_code)]
        Err(NativeProfileAdapterError)
    }

    async fn persist_profile(
        &self,
        candidate: &str,
    ) -> Result<(), NativeProfilePublicationFailure> {
        #[cfg(desktop)]
        {
            let candidate = candidate.to_owned();
            let persisted = run_secure_storage_blocking(move || {
                thin_profile_storage_entry()?
                    .set_password(&candidate)
                    .map_err(|_| AuroraCommandError::NodeConfigUnavailable)
            })
            .await
            .map_err(|_| NativeProfilePublicationFailure::Indeterminate);
            persisted?;
        }
        #[cfg(target_os = "android")]
        {
            let native = self
                .app
                .try_state::<AuroraMobileNativePlugin<tauri::Wry>>()
                .ok_or_else(|| {
                    eprintln!("aurora_node_config_stage=android_profile_write_plugin_unavailable");
                    NativeProfilePublicationFailure::Indeterminate
                })?;
            let response = super::run_android_plugin_command(
                native,
                "thinProfileSet",
                json!({ "value": candidate }),
            )
            .map_err(|_| {
                eprintln!("aurora_node_config_stage=android_profile_write_command_failed");
                NativeProfilePublicationFailure::Indeterminate
            })?;
            if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
                eprintln!("aurora_node_config_stage=android_profile_write_unconfirmed");
                return Err(NativeProfilePublicationFailure::Indeterminate);
            }
        }
        #[cfg(target_os = "ios")]
        {
            let native = self
                .app
                .try_state::<AuroraMobileNativePlugin<tauri::Wry>>()
                .ok_or(NativeProfilePublicationFailure::Indeterminate)?;
            let response = super::run_ios_plugin_command(
                native,
                "thinProfileSet",
                json!({ "value": candidate }),
            )
            .map_err(|_| NativeProfilePublicationFailure::Indeterminate)?;
            if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
                || response
                    .get("persisted")
                    .and_then(serde_json::Value::as_bool)
                    != Some(true)
            {
                return Err(NativeProfilePublicationFailure::Indeterminate);
            }
        }

        let confirmed = self.read_confirmed_profile().await.map_err(|_| {
            eprintln!("aurora_node_config_stage=profile_write_readback_failed");
            NativeProfilePublicationFailure::Indeterminate
        })?;
        if confirmed.as_deref() == Some(candidate) {
            Ok(())
        } else {
            #[cfg(target_os = "android")]
            eprintln!("aurora_node_config_stage=android_profile_write_readback_mismatch");
            Err(NativeProfilePublicationFailure::Indeterminate)
        }
    }

    async fn release_previous_sessions(&self) -> Result<(), NativeProfileAdapterError> {
        let drafts_release = self
            .drafts
            .invalidate_all()
            .map_err(|_| NativeProfileAdapterError);
        let voice_state = self
            .app
            .try_state::<super::NativeVoiceState>()
            .map(|state| state.inner().clone());
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let voice_release = match voice_state {
            Some(state) => state.cancel_and_drain_for_profile_change().await,
            None => Err(super::NativeVoiceStopError::Unavailable),
        };
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let voice_release = {
            let _ = voice_state;
            #[cfg(target_os = "android")]
            let command = "releaseVoiceSessionForProfileChange";
            #[cfg(target_os = "ios")]
            let command = "releaseVoiceSessionForProfileChange";

            let native = self
                .app
                .try_state::<super::AuroraMobileNativePlugin<tauri::Wry>>()
                .ok_or_else(|| {
                    #[cfg(target_os = "android")]
                    eprintln!(
                        "aurora_node_config_stage=android_voice_profile_release_plugin_unavailable"
                    );
                    NativeProfileAdapterError
                });
            native.and_then(|native| {
                let handle = native.handle.as_ref().ok_or_else(|| {
                    #[cfg(target_os = "android")]
                    eprintln!(
                        "aurora_node_config_stage=android_voice_profile_release_handle_unavailable"
                    );
                    NativeProfileAdapterError
                })?;
                let response = handle
                    .run_mobile_plugin::<serde_json::Value>(command, json!({}))
                    .map_err(|_| {
                        #[cfg(target_os = "android")]
                        eprintln!(
                            "aurora_node_config_stage=android_voice_profile_release_command_failed"
                        );
                        NativeProfileAdapterError
                    })?;
                if response
                    .get("released")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
                {
                    Ok(())
                } else {
                    #[cfg(target_os = "android")]
                    eprintln!("aurora_node_config_stage=android_voice_profile_release_unconfirmed");
                    Err(NativeProfileAdapterError)
                }
            })
        };
        if let Some(state) = self
            .app
            .try_state::<super::mesh_session::MeshSessionState>()
        {
            state.reset_for_profile_change(&self.app).await;
        }
        drafts_release.map_err(|_| {
            #[cfg(target_os = "android")]
            eprintln!("aurora_node_config_stage=android_profile_draft_invalidation_failed");
            NativeProfileAdapterError
        })?;
        voice_release.map_err(|_| {
            #[cfg(target_os = "android")]
            eprintln!("aurora_node_config_stage=android_voice_profile_release_failed");
            NativeProfileAdapterError
        })?;
        Ok(())
    }

    async fn install_confirmed_profile(
        &self,
        document: Option<&str>,
    ) -> Result<(), NativeProfileAdapterError> {
        let next_state = ThinProfileState::from_stored_document(document.map(str::to_owned))
            .map_err(|_| {
                #[cfg(target_os = "android")]
                eprintln!("aurora_node_config_stage=android_profile_install_validation_failed");
                NativeProfileAdapterError
            })?;
        store_thin_profile_state(&self.profile_state, next_state).map_err(|_| {
            #[cfg(target_os = "android")]
            eprintln!("aurora_node_config_stage=android_profile_state_install_failed");
            NativeProfileAdapterError
        })?;
        #[cfg(target_os = "android")]
        {
            let native = self
                .app
                .try_state::<super::AuroraMobileNativePlugin<tauri::Wry>>()
                .ok_or_else(|| {
                    eprintln!(
                        "aurora_node_config_stage=android_voice_profile_install_plugin_unavailable"
                    );
                    NativeProfileAdapterError
                })?;
            let handle = native.handle.as_ref().ok_or_else(|| {
                eprintln!(
                    "aurora_node_config_stage=android_voice_profile_install_handle_unavailable"
                );
                NativeProfileAdapterError
            })?;
            let response = handle
                .run_mobile_plugin::<serde_json::Value>("completeVoiceProfileChange", json!({}))
                .map_err(|_| {
                    eprintln!(
                        "aurora_node_config_stage=android_voice_profile_install_command_failed"
                    );
                    NativeProfileAdapterError
                })?;
            if response
                .get("completed")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            {
                eprintln!("aurora_node_config_stage=android_voice_profile_install_unconfirmed");
                return Err(NativeProfileAdapterError);
            }
        }
        #[cfg(target_os = "ios")]
        {
            let native = self
                .app
                .try_state::<super::AuroraMobileNativePlugin<tauri::Wry>>()
                .ok_or(NativeProfileAdapterError)?;
            let handle = native.handle.as_ref().ok_or(NativeProfileAdapterError)?;
            let response = handle
                .run_mobile_plugin::<serde_json::Value>("completeVoiceProfileChange", json!({}))
                .map_err(|_| NativeProfileAdapterError)?;
            if response
                .get("completed")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            {
                return Err(NativeProfileAdapterError);
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn aurora_node_config_policy_read(
    window: WebviewWindow,
    document_token: String,
    runtime: State<'_, NativeNodeConfigRuntime>,
) -> Result<PolicyReadResponse, AuroraCommandError> {
    let window_label = window.label().to_owned();
    let scope = runtime.document_scope(&window_label)?;
    if scope.token != document_token {
        return Err(AuroraCommandError::NodeConfigUnavailable);
    }
    let ticket = scope
        .registration
        .issue_ticket()
        .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;
    let receipt = runtime
        .inner
        .coordinator
        .read_policy_authorized(runtime.inner.fence.clone(), ticket)
        .await
        .map_err(map_coordinator_error)?;
    if !runtime.is_current_document(&window_label, scope.epoch) {
        return Err(AuroraCommandError::NodeConfigUnavailable);
    }
    let issued = runtime
        .inner
        .drafts
        .issue_read(scope.caller, receipt)
        .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;
    let document_json = serde_json::to_string(&issued.document)
        .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;
    Ok(PolicyReadResponse {
        document_json,
        draft_handle: issued.handle,
    })
}

#[tauri::command]
pub(crate) async fn aurora_node_config_policy_compare_and_swap(
    window: WebviewWindow,
    document_token: String,
    draft_handle: String,
    expected_revision: u64,
    draft_json: String,
    runtime: State<'_, NativeNodeConfigRuntime>,
) -> Result<PolicyWriteResponse, AuroraCommandError> {
    let window_label = window.label().to_owned();
    let scope = runtime.document_scope(&window_label)?;
    if scope.token != document_token {
        return Err(AuroraCommandError::NodeConfigUnavailable);
    }
    let context = runtime
        .inner
        .drafts
        .take_context(scope.caller, &draft_handle, expected_revision)
        .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;
    let ticket = scope
        .registration
        .issue_ticket()
        .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;
    let receipt = runtime
        .inner
        .coordinator
        .compare_and_swap_authorized(
            runtime.inner.fence.clone(),
            ticket,
            context,
            expected_revision,
            draft_json,
        )
        .await
        .map_err(map_coordinator_error)?;
    if !runtime.is_current_document(&window_label, scope.epoch) {
        return Err(AuroraCommandError::NodeConfigUnavailable);
    }
    let document_json = serde_json::to_string(&receipt.document)
        .map_err(|_| AuroraCommandError::NodeConfigUnavailable)?;
    // Publish only the saved revision; each host reloads its current authorized
    // policy rather than accepting settings or identities from the event.
    let _ = runtime.inner.app.emit(
        POLICY_CHANGED_EVENT,
        serde_json::json!({ "revision": receipt.document.revision }),
    );
    Ok(PolicyWriteResponse {
        document_json,
        saved_revision: receipt.document.revision,
    })
}

fn map_coordinator_error(error: NodeConfigCoordinatorError) -> AuroraCommandError {
    let code = match error {
        NodeConfigCoordinatorError::Unavailable => "coordinator_unavailable",
        NodeConfigCoordinatorError::ProfileReadFailed => "profile_read_failed",
        NodeConfigCoordinatorError::ProfileNotPublished => "profile_not_published",
        NodeConfigCoordinatorError::ProfilePublicationIndeterminate => {
            "profile_publication_indeterminate"
        }
        NodeConfigCoordinatorError::SessionReleaseFailed => "profile_session_release_failed",
        NodeConfigCoordinatorError::ProfileInstallFailed => "profile_install_failed",
        NodeConfigCoordinatorError::TaskFailed => "coordinator_task_failed",
        NodeConfigCoordinatorError::InvalidCanonicalProfile(_) => {
            "profile_canonical_validation_failed"
        }
        NodeConfigCoordinatorError::InvalidProfile(_) => "profile_selection_validation_failed",
        NodeConfigCoordinatorError::Policy(_) => "profile_policy_operation_failed",
    };
    eprintln!("aurora_node_config_coordinator_error={code}");
    AuroraCommandError::NodeConfigUnavailable
}

#[cfg(test)]
mod tests {
    use super::{
        caller_for_window, encode_document_token, issue_document_token, PolicyReadResponse,
        PolicyWriteResponse,
    };
    use aurora_voice_native::native_publication_fence::{
        NativePublicationFence, NativePublicationFenceError,
    };
    use aurora_voice_native::node_config_drafts::NativeNodeConfigCaller;
    use serde_json::json;

    #[test]
    fn command_receipts_match_the_sdk_wire_fields() {
        assert_eq!(
            serde_json::to_value(PolicyReadResponse {
                document_json: "{}".to_owned(),
                draft_handle: "a".repeat(64),
            })
            .expect("read response serializes"),
            json!({ "documentJson": "{}", "draftHandle": "a".repeat(64) })
        );
        assert_eq!(
            serde_json::to_value(PolicyWriteResponse {
                document_json: "{}".to_owned(),
                saved_revision: 2,
            })
            .expect("write response serializes"),
            json!({ "documentJson": "{}", "savedRevision": 2 })
        );
    }

    #[test]
    fn draft_callers_are_scoped_to_native_window_lifecycle() {
        let first_lifecycle = [1; 16];
        let next_lifecycle = [2; 16];
        let first_document = [3; 32];
        let next_document = [4; 32];
        let caller = caller_for_window(&first_lifecycle, "main", &first_document);
        assert_eq!(
            caller,
            caller_for_window(&first_lifecycle, "main", &first_document)
        );
        assert_ne!(
            caller,
            caller_for_window(&first_lifecycle, "main", &next_document)
        );
        assert_ne!(
            caller,
            caller_for_window(&first_lifecycle, "settings", &first_document)
        );
        assert_ne!(
            caller,
            caller_for_window(&next_lifecycle, "main", &first_document)
        );
        let _opaque_type: NativeNodeConfigCaller = caller;
    }

    #[test]
    fn document_token_is_random_and_encoded_without_reducing_entropy() {
        let first = issue_document_token().expect("native document token");
        let second = issue_document_token().expect("fresh native document token");
        assert_ne!(first, second);
        assert_eq!(encode_document_token(&first).len(), 64);
        assert!(encode_document_token(&first)
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[tokio::test]
    async fn reloaded_document_caller_cannot_reuse_retired_publication_ticket() {
        let fence = NativePublicationFence::new();
        let previous = fence.register().expect("previous document registration");
        let stale_ticket = previous.issue_ticket().expect("old document ticket");
        let old_caller = caller_for_window(&[1; 16], "main", &[2; 32]);
        let new_caller = caller_for_window(&[1; 16], "main", &[3; 32]);
        assert_ne!(old_caller, new_caller);

        fence
            .revoke(&previous)
            .expect("retire previous document")
            .wait()
            .await
            .expect("no prior publication remained reserved");
        assert_eq!(
            fence.reserve(stale_ticket).err(),
            Some(NativePublicationFenceError::TicketUnavailable)
        );

        let current = fence.register().expect("new document registration");
        fence
            .reserve(current.issue_ticket().expect("new document ticket"))
            .expect("new page has independent publication scope")
            .settle(true)
            .expect("settle current page operation");
    }
}
