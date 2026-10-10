use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(desktop)]
use crate::native_event_hub::{global_native_event_hub, voice_turn_event};

#[cfg(desktop)]
use {
    async_trait::async_trait,
    aurora_voice_core::node_policy::{
        NullableField, Omitted, RoutingFallback, RoutingPreference, SpeechNetworkKind,
        SpeechStageConfig, SpeechStages,
    },
    aurora_voice_core::{
        AudioInput, CancellationToken, CaptureStartReason, Generation, PcmFrame, RedactedSnapshot,
        RouteRevision, RuntimeEvent, RuntimeEventSink, SpeechLifecycleEventV1, TimestampMicros,
        TransitionReason, VoiceCaptureLease, VoiceCleanupReport, VoiceCoreError, VoiceRuntime,
        VoiceState, WakeKwsProvider, WakeOrchestrationConfig, WakeVadProvider,
    },
    aurora_voice_engine::{
        BoundFiniteSttRequest, BoundKwsRequest, BoundStreamSession, BoundTaskRequest,
        BoundTtsSynthesisRequest, BoundVadRequest, EngineError, FiniteSttAudio, FiniteSttPort,
        FiniteSttProviderBinding, FiniteSttResult, FiniteSttRouteScope, KwsConfig, KwsFrameResult,
        KwsStreamProvider, ResourceReport, RouteFiniteSttBinding, RouteTtsBinding,
        SpeechCatalogTask, SpeechModelCatalog, SpeechSegment, StreamResetReason,
        StreamingAudioFrame, TaskCapability, TaskPackBinding, TaskProvider, TtsSynthesisPort,
        TtsSynthesisProviderBinding, TtsSynthesisResult, TtsVoiceCatalog, VadAcceptResult,
        VadConfig, VadStreamProvider, MAX_FINITE_STT_SAMPLES, VAD_SAMPLE_RATE_HZ,
    },
    aurora_voice_native::{
        build_installed_kws_provider_from_phrases, build_installed_stt_provider,
        build_installed_tts_provider, build_installed_tts_provider_with_reference,
        build_installed_vad_provider, emit_native_speech_lifecycle,
        native_speech_lifecycle_observer_enabled, CpalAudioInput, CpalAudioOutput, GatewayAuth,
        MicrophoneAudioPolicy, NativeAudioConfig, NativeCaptureConfig, NativeCaptureControl,
        NativeGatewayCaptureGrant, NativeGatewayCaptureHandoff, NativeGatewayCaptureHandoffConfig,
        NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig, NativeGatewayTransport,
        NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer, NativeMeshFiniteStt,
        NativeMeshFiniteSttConfig, NativeMeshTtsConfig, NativeMeshTtsSynthesizer,
        SpeechPackManager, SpeechPackManagerConfig, TransportLimits, NATIVE_WAKE_KWS_THRESHOLD,
    },
    aurora_voice_sherpa::{
        NativeKwsBackend, NativeTtsReferenceAudio, NativeVadBackend, SherpaKwsPhraseInput,
        SherpaKwsProvider, SherpaVadProvider,
    },
    serde_json::Value,
    sha2::{Digest, Sha256},
    std::cell::Cell,
    std::cell::RefCell,
    std::fs,
    std::io::Write,
    std::path::{Path, PathBuf},
    std::rc::Rc,
    std::thread,
    std::time::Duration,
    tokio::runtime::Builder as TokioRuntimeBuilder,
    tokio::sync::{mpsc, oneshot},
    tokio::task::LocalSet,
    tokio::time::{sleep_until, timeout, Instant as TokioInstant},
    url::Url,
};

const STATUS_EVENT: &str = "aurora://native-voice-status";
const UNAVAILABLE_REASON: &str = "unavailable";
const E2E_UNAVAILABLE_REASON: &str = "desktop_native_voice_e2e_unavailable";
#[cfg(not(desktop))]
const UNSUPPORTED_REASON: &str = "unsupported_platform";
const ACTIVE_REASON: &str = "already_active";
const STALE_CONTROL_REASON: &str = "stale_generation";
const REMOTE_CONSENT_REASON: &str = "remote_audio_consent_required";
const PROFILE_REASON: &str = "profile_unavailable";
const CREDENTIAL_REASON: &str = "credential_unavailable";
#[cfg(desktop)]
const OWNER_ID: &str = "tauri-native-voice";
#[cfg(desktop)]
const SURFACE: &str = "desktop";
#[cfg(desktop)]
const DEVICE_ROUTE: &str = "default";
#[cfg(desktop)]
const ROUTE_REVISION: u64 = 1;
#[cfg(desktop)]
const TTS_MAX_AUDIO_SAMPLES: usize = 16_000 * 30;
#[cfg(desktop)]
const TTS_REFERENCE_PROFILE_VERSION: u8 = 1;
#[cfg(desktop)]
const TTS_REFERENCE_PROFILE_MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(desktop)]
const TTS_REFERENCE_PROFILE_MAX_TEXT_BYTES: usize = 4096;
#[cfg(desktop)]
const HANDOFF_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(desktop)]
const HANDOFF_OPERATION_TIMEOUT: Duration = Duration::from_secs(4);
#[cfg(desktop)]
const HANDOFF_RECOVERY_TIMEOUT: Duration = Duration::from_secs(9);
#[cfg(desktop)]
const SHUTDOWN_CLEANUP_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(desktop)]
const HOST_STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(75);
#[cfg(all(desktop, test))]
const DEFAULT_WAKE_PHRASE_ID: &str = "wake.aurora";
#[cfg(all(desktop, test))]
const DEFAULT_WAKE_PHRASE_TEXT: &str = "HEY AURORA";
#[cfg(all(desktop, test))]
const DEFAULT_WAKE_PHRASE_REVISION: &str = "phrases:aurora-default:v1";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeVoicePhase {
    Unavailable,
    Idle,
    Starting,
    Listening,
    Processing,
    Speaking,
    Stopping,
    Faulted,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeVoiceTrigger {
    FocusedPushToTalk,
    TrayPushToTalk,
    WakeWord,
    BackgroundWake,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeVoiceStopReason {
    UserRequest,
    WindowHidden,
    PermissionRevoked,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeVoiceConnection {
    ThisDevice,
    ConnectedDevice,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeVoiceStatus {
    available: bool,
    phase: NativeVoicePhase,
    generation: Option<u64>,
    background_eligible: bool,
    connection: NativeVoiceConnection,
    reason_code: Option<String>,
    redacted: bool,
}

impl NativeVoiceStatus {
    fn unavailable(reason_code: &'static str) -> Self {
        Self {
            available: false,
            phase: NativeVoicePhase::Unavailable,
            generation: None,
            background_eligible: false,
            connection: NativeVoiceConnection::Unavailable,
            reason_code: Some(reason_code.to_owned()),
            redacted: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeVoiceStartRequest {
    trigger: NativeVoiceTrigger,
    remote_audio_consent: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeVoiceControlRequest {
    generation: u64,
    reason: NativeVoiceStopReason,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeVoiceEvent {
    sequence: u64,
    status: NativeVoiceStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceCommandError {
    code: &'static str,
    reason_code: &'static str,
    redacted: bool,
}

impl NativeVoiceCommandError {
    fn unavailable(reason_code: &'static str) -> Self {
        Self {
            code: "unavailable",
            reason_code,
            redacted: true,
        }
    }

    fn invalid(reason_code: &'static str) -> Self {
        Self {
            code: "invalid_state",
            reason_code,
            redacted: true,
        }
    }
}

#[derive(Clone, Default)]
pub struct NativeVoiceState {
    #[cfg(desktop)]
    inner: Arc<Mutex<NativeVoiceLifecycle>>,
    #[cfg(not(desktop))]
    inner: Arc<Mutex<Option<()>>>,
}

impl NativeVoiceState {
    pub fn initialize(
        &self,
        app: AppHandle,
        #[cfg_attr(not(desktop), allow(unused_variables))] sidecar: super::SharedSidecarState,
    ) {
        #[cfg(desktop)]
        {
            if let Ok(mut guard) = self.inner.lock() {
                if matches!(*guard, NativeVoiceLifecycle::Uninitialized) {
                    *guard = NativeVoiceLifecycle::Running(NativeVoiceHandle::spawn(app, sidecar));
                }
            }
        }
    }

    /// Stop the owned desktop actor and await its local task and thread joins.
    ///
    /// On targets without the desktop actor there is no native voice thread to
    /// stop, so this returns success without claiming platform capture status.
    pub async fn stop(&self) -> Result<(), NativeVoiceStopError> {
        #[cfg(desktop)]
        {
            self.stop_with_timeout(HOST_STOP_WAIT_TIMEOUT).await
        }
        #[cfg(not(desktop))]
        {
            Ok(())
        }
    }

    /// Cancel and drain the current voice turn without shutting down the actor.
    ///
    /// Profile replacement uses this to release the old session while keeping
    /// the native voice service available for the newly installed profile.
    pub async fn cancel_and_drain_for_profile_change(&self) -> Result<(), NativeVoiceStopError> {
        #[cfg(desktop)]
        {
            let (reply, response) = oneshot::channel();
            {
                let guard = self
                    .inner
                    .lock()
                    .map_err(|_| NativeVoiceStopError::Unavailable)?;
                let NativeVoiceLifecycle::Running(handle) = &*guard else {
                    return match &*guard {
                        NativeVoiceLifecycle::Uninitialized => Ok(()),
                        NativeVoiceLifecycle::Stopping(_) | NativeVoiceLifecycle::Stopped(_) => {
                            Err(NativeVoiceStopError::Unavailable)
                        }
                        NativeVoiceLifecycle::Running(_) => unreachable!(),
                    };
                };
                handle
                    .tx
                    .send(ActorCommand::CancelAndDrainForProfileChange { reply })
                    .map_err(|_| NativeVoiceStopError::Unavailable)?;
            }
            timeout(HOST_STOP_WAIT_TIMEOUT, response)
                .await
                .map_err(|_| NativeVoiceStopError::TimedOut)?
                .map_err(|_| NativeVoiceStopError::Unavailable)?
        }
        #[cfg(not(desktop))]
        {
            Ok(())
        }
    }

    #[cfg(desktop)]
    async fn stop_with_timeout(&self, wait_timeout: Duration) -> Result<(), NativeVoiceStopError> {
        #[cfg(desktop)]
        {
            let operation = {
                let mut guard = self
                    .inner
                    .lock()
                    .map_err(|_| NativeVoiceStopError::Unavailable)?;
                match &*guard {
                    NativeVoiceLifecycle::Stopping(operation) => Arc::clone(operation),
                    NativeVoiceLifecycle::Stopped(operation) => {
                        return operation
                            .result()
                            .unwrap_or(Err(NativeVoiceStopError::Unavailable))
                    }
                    NativeVoiceLifecycle::Uninitialized => {
                        return Err(NativeVoiceStopError::Unavailable)
                    }
                    NativeVoiceLifecycle::Running(_) => {
                        let NativeVoiceLifecycle::Running(handle) =
                            std::mem::replace(&mut *guard, NativeVoiceLifecycle::Uninitialized)
                        else {
                            unreachable!("lifecycle checked while locked")
                        };
                        let operation = handle.begin_shutdown();
                        *guard = NativeVoiceLifecycle::Stopping(Arc::clone(&operation));
                        operation
                    }
                }
            };
            let result = wait_for_shutdown(&operation, wait_timeout).await;
            if result != Err(NativeVoiceStopError::TimedOut) {
                if let Ok(mut guard) = self.inner.lock() {
                    if matches!(&*guard, NativeVoiceLifecycle::Stopping(current) if Arc::ptr_eq(current, &operation))
                    {
                        *guard = NativeVoiceLifecycle::Stopped(Arc::clone(&operation));
                    }
                }
            }
            if operation.result() == Some(Err(NativeVoiceStopError::TimedOut)) {
                Err(NativeVoiceStopError::TimedOut)
            } else {
                result
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeVoiceStopError {
    Unavailable,
    ShutdownFailed,
    TimedOut,
    JoinFailed,
}

#[cfg(desktop)]
enum NativeVoiceLifecycle {
    Uninitialized,
    Running(NativeVoiceHandle),
    Stopping(Arc<ShutdownOperation>),
    Stopped(Arc<ShutdownOperation>),
}

#[cfg(desktop)]
impl Default for NativeVoiceLifecycle {
    fn default() -> Self {
        Self::Uninitialized
    }
}

#[cfg(desktop)]
struct ShutdownOperation {
    progress: tokio::sync::Mutex<ShutdownProgress>,
    // One terminal result wins. A queued timeout must remain visible even
    // after the retained shutdown job later joins successfully.
    outcome: std::sync::atomic::AtomicU8,
}

#[cfg(desktop)]
struct ShutdownProgress {
    job: tokio::task::JoinHandle<Result<(), NativeVoiceStopError>>,
}

#[cfg(desktop)]
const SHUTDOWN_OUTCOME_RUNNING: u8 = 0;
#[cfg(desktop)]
const SHUTDOWN_OUTCOME_OK: u8 = 1;
#[cfg(desktop)]
const SHUTDOWN_OUTCOME_FAILED: u8 = 2;
#[cfg(desktop)]
const SHUTDOWN_OUTCOME_JOIN_FAILED: u8 = 3;
#[cfg(desktop)]
const SHUTDOWN_OUTCOME_TIMED_OUT: u8 = 4;

#[cfg(desktop)]
impl ShutdownOperation {
    fn result(&self) -> Option<Result<(), NativeVoiceStopError>> {
        match self.outcome.load(std::sync::atomic::Ordering::SeqCst) {
            SHUTDOWN_OUTCOME_RUNNING => None,
            SHUTDOWN_OUTCOME_OK => Some(Ok(())),
            SHUTDOWN_OUTCOME_FAILED => Some(Err(NativeVoiceStopError::ShutdownFailed)),
            SHUTDOWN_OUTCOME_JOIN_FAILED => Some(Err(NativeVoiceStopError::JoinFailed)),
            SHUTDOWN_OUTCOME_TIMED_OUT => Some(Err(NativeVoiceStopError::TimedOut)),
            _ => Some(Err(NativeVoiceStopError::JoinFailed)),
        }
    }

    fn complete(
        &self,
        result: Result<(), NativeVoiceStopError>,
    ) -> Result<(), NativeVoiceStopError> {
        let value = match result {
            Ok(()) => SHUTDOWN_OUTCOME_OK,
            Err(NativeVoiceStopError::TimedOut) => SHUTDOWN_OUTCOME_TIMED_OUT,
            Err(NativeVoiceStopError::JoinFailed) => SHUTDOWN_OUTCOME_JOIN_FAILED,
            Err(NativeVoiceStopError::Unavailable | NativeVoiceStopError::ShutdownFailed) => {
                SHUTDOWN_OUTCOME_FAILED
            }
        };
        let _ = self.outcome.compare_exchange(
            SHUTDOWN_OUTCOME_RUNNING,
            value,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.result()
            .unwrap_or(Err(NativeVoiceStopError::JoinFailed))
    }

    fn time_out(&self) -> Result<(), NativeVoiceStopError> {
        let _ = self.outcome.compare_exchange(
            SHUTDOWN_OUTCOME_RUNNING,
            SHUTDOWN_OUTCOME_TIMED_OUT,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.result().unwrap_or(Err(NativeVoiceStopError::TimedOut))
    }
}

#[cfg(desktop)]
async fn wait_for_shutdown(
    operation: &Arc<ShutdownOperation>,
    wait_timeout: Duration,
) -> Result<(), NativeVoiceStopError> {
    if let Some(result) = operation.result() {
        return result;
    }
    let joined = timeout(wait_timeout, async {
        let mut progress = operation.progress.lock().await;
        if let Some(result) = operation.result() {
            return result;
        }
        let result = match (&mut progress.job).await {
            Ok(result) => result,
            Err(_) => Err(NativeVoiceStopError::JoinFailed),
        };
        operation.complete(result)
    })
    .await;
    match joined {
        Ok(result) => result,
        Err(_) => operation.time_out(),
    }
}

#[tauri::command]
pub async fn aurora_native_voice_status(
    state: State<'_, NativeVoiceState>,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    request_status(&state).await
}

#[tauri::command]
pub async fn aurora_native_voice_start(
    state: State<'_, NativeVoiceState>,
    request: NativeVoiceStartRequest,
    policy_runtime: State<'_, super::native_node_config::NativeNodeConfigRuntime>,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    #[cfg(desktop)]
    {
        let (_admission_guard, generation, speech_stages, config_revision, profile_document) =
            policy_runtime
                .inner()
                .voice_admission_snapshot()
                .await
                .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?;
        let profile_document =
            profile_document.ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?;
        send_actor(&state, |reply| ActorCommand::Start {
            request,
            profile_generation: Some(generation),
            speech_stages,
            config_revision,
            confirmed_profile_document: Some(profile_document),
            reply,
        })
        .await
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, request, policy_runtime);
        Ok(NativeVoiceStatus::unavailable(UNSUPPORTED_REASON))
    }
}

#[tauri::command]
pub async fn aurora_native_voice_finish(
    state: State<'_, NativeVoiceState>,
    request: NativeVoiceControlRequest,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    #[cfg(desktop)]
    {
        send_actor(&state, |reply| ActorCommand::Finish { request, reply }).await
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, request);
        Ok(NativeVoiceStatus::unavailable(UNSUPPORTED_REASON))
    }
}

#[tauri::command]
pub async fn aurora_native_voice_cancel(
    state: State<'_, NativeVoiceState>,
    request: NativeVoiceControlRequest,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    #[cfg(desktop)]
    {
        send_actor(&state, |reply| ActorCommand::Cancel { request, reply }).await
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, request);
        Ok(NativeVoiceStatus::unavailable(UNSUPPORTED_REASON))
    }
}

#[tauri::command]
pub async fn aurora_native_voice_tray_toggle_e2e(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    if !cfg!(all(debug_assertions, feature = "desktop-native-voice-e2e"))
        || std::env::var("AURORA_DESKTOP_NATIVE_VOICE_E2E").as_deref() != Ok("1")
    {
        return Err(NativeVoiceCommandError::unavailable(E2E_UNAVAILABLE_REASON));
    }
    #[cfg(desktop)]
    {
        tray_toggle_status(&app, &state).await
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state);
        Ok(NativeVoiceStatus::unavailable(UNSUPPORTED_REASON))
    }
}

pub async fn request_status(
    state: &NativeVoiceState,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    #[cfg(desktop)]
    {
        send_actor(state, |reply| ActorCommand::Status { reply }).await
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
        Ok(NativeVoiceStatus::unavailable(UNSUPPORTED_REASON))
    }
}

#[cfg(desktop)]
async fn tray_toggle_status(
    app: &AppHandle,
    state: &NativeVoiceState,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    let status = request_status(state).await?;
    if matches!(status.phase, NativeVoicePhase::Listening) {
        if let Some(generation) = status.generation {
            return send_actor(state, |reply| ActorCommand::Finish {
                request: NativeVoiceControlRequest {
                    generation,
                    reason: NativeVoiceStopReason::UserRequest,
                },
                reply,
            })
            .await;
        }
    } else if matches!(status.phase, NativeVoicePhase::Idle) {
        let policy_runtime = app
            .try_state::<super::native_node_config::NativeNodeConfigRuntime>()
            .map(|runtime| runtime.inner().clone())
            .ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?;
        let (_admission_guard, generation, speech_stages, config_revision, profile_document) =
            policy_runtime
                .voice_admission_snapshot()
                .await
                .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?;
        let profile_document =
            profile_document.ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?;
        return send_actor(state, |reply| ActorCommand::Start {
            request: NativeVoiceStartRequest {
                trigger: NativeVoiceTrigger::TrayPushToTalk,
                remote_audio_consent: false,
            },
            profile_generation: Some(generation),
            speech_stages,
            config_revision,
            confirmed_profile_document: Some(profile_document),
            reply,
        })
        .await;
    }
    Ok(status)
}

#[cfg(desktop)]
pub fn tray_toggle(app: &AppHandle) {
    let Some(state) = app.try_state::<NativeVoiceState>() else {
        return;
    };
    let state = state.inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tray_toggle_status(&app, &state).await;
    });
}

#[cfg(desktop)]
async fn send_actor(
    state: &NativeVoiceState,
    build: impl FnOnce(
        oneshot::Sender<Result<NativeVoiceStatus, NativeVoiceCommandError>>,
    ) -> ActorCommand,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    let (reply, rx) = oneshot::channel();
    {
        let guard = state
            .inner
            .lock()
            .map_err(|_| NativeVoiceCommandError::unavailable(UNAVAILABLE_REASON))?;
        let NativeVoiceLifecycle::Running(handle) = &*guard else {
            return Err(NativeVoiceCommandError::unavailable(UNAVAILABLE_REASON));
        };
        // Sending while holding the admission lock establishes FIFO ordering
        // with the one Shutdown command that closes this lifecycle.
        handle
            .tx
            .send(build(reply))
            .map_err(|_| NativeVoiceCommandError::unavailable(UNAVAILABLE_REASON))?;
    }
    rx.await
        .map_err(|_| NativeVoiceCommandError::unavailable(UNAVAILABLE_REASON))?
}

#[cfg(desktop)]
struct NativeVoiceHandle {
    tx: mpsc::UnboundedSender<ActorCommand>,
    thread: Option<thread::JoinHandle<()>>,
}

#[cfg(desktop)]
impl NativeVoiceHandle {
    fn spawn(app: AppHandle, sidecar: super::SharedSidecarState) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let thread_tx = tx.clone();
        let builder = thread::Builder::new().name("aurora-native-voice".to_owned());
        let thread = builder
            .spawn(move || {
                let runtime = TokioRuntimeBuilder::new_current_thread()
                    .enable_time()
                    .enable_io()
                    .build()
                    .expect("native voice runtime");
                let local = LocalSet::new();
                local.block_on(&runtime, run_actor(app, sidecar, thread_tx, rx));
            })
            .expect("native voice thread");
        Self {
            tx,
            thread: Some(thread),
        }
    }

    #[cfg(test)]
    fn with_test_actor(
        run: impl FnOnce(mpsc::UnboundedReceiver<ActorCommand>) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let thread = thread::Builder::new()
            .name("aurora-native-voice-test".to_owned())
            .spawn(move || run(rx))
            .expect("test actor thread");
        Self {
            tx,
            thread: Some(thread),
        }
    }

    fn begin_shutdown(mut self) -> Arc<ShutdownOperation> {
        let (reply, rx) = std::sync::mpsc::channel();
        let sent = self.tx.send(ActorCommand::Shutdown { reply }).is_ok();
        let thread = self.thread.take();
        let job = tokio::spawn(async move {
            let blocking = tokio::task::spawn_blocking(move || {
                let actor_result = if sent {
                    rx.recv()
                        .unwrap_or(Err(NativeVoiceStopError::ShutdownFailed))
                } else {
                    Err(NativeVoiceStopError::ShutdownFailed)
                };
                let thread_result = match thread {
                    Some(thread) => thread
                        .join()
                        .map(|_| ())
                        .map_err(|_| NativeVoiceStopError::JoinFailed),
                    None => Err(NativeVoiceStopError::JoinFailed),
                };
                actor_result.and(thread_result)
            });
            blocking
                .await
                .unwrap_or(Err(NativeVoiceStopError::JoinFailed))
        });
        Arc::new(ShutdownOperation {
            progress: tokio::sync::Mutex::new(ShutdownProgress { job }),
            outcome: std::sync::atomic::AtomicU8::new(SHUTDOWN_OUTCOME_RUNNING),
        })
    }
}

#[cfg(desktop)]
enum ActorCommand {
    Status {
        reply: oneshot::Sender<Result<NativeVoiceStatus, NativeVoiceCommandError>>,
    },
    Start {
        request: NativeVoiceStartRequest,
        profile_generation: Option<u64>,
        speech_stages: Option<SpeechStages>,
        config_revision: Option<u64>,
        confirmed_profile_document: Option<String>,
        reply: oneshot::Sender<Result<NativeVoiceStatus, NativeVoiceCommandError>>,
    },
    Finish {
        request: NativeVoiceControlRequest,
        reply: oneshot::Sender<Result<NativeVoiceStatus, NativeVoiceCommandError>>,
    },
    Cancel {
        request: NativeVoiceControlRequest,
        reply: oneshot::Sender<Result<NativeVoiceStatus, NativeVoiceCommandError>>,
    },
    RuntimePhase {
        ui_generation: u64,
        phase: NativeVoicePhase,
        reason_code: Option<&'static str>,
    },
    TurnFinished {
        ui_generation: u64,
    },
    Shutdown {
        reply: std::sync::mpsc::Sender<Result<(), NativeVoiceStopError>>,
    },
    CancelAndDrainForProfileChange {
        reply: oneshot::Sender<Result<(), NativeVoiceStopError>>,
    },
}

#[cfg(desktop)]
async fn run_actor(
    app: AppHandle,
    sidecar: super::SharedSidecarState,
    tx: mpsc::UnboundedSender<ActorCommand>,
    rx: mpsc::UnboundedReceiver<ActorCommand>,
) {
    run_actor_loop(NativeVoiceActor::new(app, sidecar, tx), rx).await;
}

#[cfg(desktop)]
async fn run_actor_loop(
    mut actor: NativeVoiceActor,
    mut rx: mpsc::UnboundedReceiver<ActorCommand>,
) {
    actor.publish();
    loop {
        let mut active_task = actor.active.as_mut().and_then(|active| active.task.take());
        let event =
            wait_for_actor_event(&mut rx, active_task.as_mut(), actor.shutdown_deadline).await;

        match event {
            ActorLoopEvent::Command(Some(command)) => {
                if let Some(task) = active_task.take() {
                    if let Some(active) = actor.active.as_mut() {
                        active.task = Some(task);
                    }
                }
                if actor.handle(command).await {
                    break;
                }
            }
            ActorLoopEvent::Command(None) => {
                if let Some(task) = active_task.take() {
                    if let Some(active) = actor.active.as_mut() {
                        active.task = Some(task);
                    }
                }
                actor.force_shutdown();
                if actor.active.is_none() {
                    actor.ack_shutdown();
                    break;
                }
            }
            ActorLoopEvent::TaskFinished(result) => {
                drop(active_task);
                if actor.complete_active_task(result) {
                    break;
                }
            }
            ActorLoopEvent::Deadline => {
                if let Some(task) = active_task.take() {
                    if let Some(active) = actor.active.as_mut() {
                        active.task = Some(task);
                    }
                }
                actor.force_shutdown();
            }
        }
    }
}

#[cfg(desktop)]
enum ActorLoopEvent {
    Command(Option<ActorCommand>),
    TaskFinished(Result<TurnTaskOutcome, tokio::task::JoinError>),
    Deadline,
}

#[cfg(desktop)]
async fn wait_for_actor_event(
    rx: &mut mpsc::UnboundedReceiver<ActorCommand>,
    task: Option<&mut tokio::task::JoinHandle<TurnTaskOutcome>>,
    deadline: Option<TokioInstant>,
) -> ActorLoopEvent {
    match (task, deadline) {
        (Some(task), Some(deadline)) => {
            tokio::select! {
                command = rx.recv() => ActorLoopEvent::Command(command),
                outcome = &mut *task => ActorLoopEvent::TaskFinished(outcome),
                _ = sleep_until(deadline) => ActorLoopEvent::Deadline,
            }
        }
        (Some(task), None) => {
            tokio::select! {
                command = rx.recv() => ActorLoopEvent::Command(command),
                outcome = &mut *task => ActorLoopEvent::TaskFinished(outcome),
            }
        }
        (None, Some(deadline)) => {
            tokio::select! {
                command = rx.recv() => ActorLoopEvent::Command(command),
                _ = sleep_until(deadline) => ActorLoopEvent::Deadline,
            }
        }
        (None, None) => ActorLoopEvent::Command(rx.recv().await),
    }
}

#[cfg(desktop)]
struct NativeVoiceActor {
    app: Option<AppHandle>,
    sidecar: super::SharedSidecarState,
    tx: mpsc::UnboundedSender<ActorCommand>,
    status: NativeVoiceStatus,
    sequence: u64,
    next_ui_generation: u64,
    runtime: Rc<RefCell<Option<RuntimeBundle>>>,
    runtime_profile: Option<RuntimeProfileKey>,
    active: Option<ActiveTurn>,
    shutdown_reply: Option<std::sync::mpsc::Sender<Result<(), NativeVoiceStopError>>>,
    profile_change_reply: Option<oneshot::Sender<Result<(), NativeVoiceStopError>>>,
    shutdown_deadline: Option<TokioInstant>,
    shutdown_timeout: Duration,
    failure: ActorFailureState,
    #[cfg(test)]
    test_status_tx: Option<mpsc::UnboundedSender<NativeVoiceStatus>>,
}

#[cfg(desktop)]
#[derive(Default)]
struct ActorFailureState {
    sticky_shutdown_error: Option<NativeVoiceStopError>,
}

#[cfg(desktop)]
impl ActorFailureState {
    fn record(&mut self, error: NativeVoiceStopError) {
        if self.sticky_shutdown_error.is_none() {
            self.sticky_shutdown_error = Some(error);
        }
    }

    fn blocks_reuse(&self) -> bool {
        self.sticky_shutdown_error.is_some()
    }

    fn shutdown_result(&self) -> Result<(), NativeVoiceStopError> {
        self.sticky_shutdown_error.map_or(Ok(()), Err)
    }

    fn completion_phase(
        &self,
        cleanup_failed: bool,
        reason_code: Option<&'static str>,
        expected_terminal: bool,
    ) -> NativeVoicePhase {
        if cleanup_failed || self.blocks_reuse() {
            NativeVoicePhase::Faulted
        } else {
            terminal_phase(reason_code, expected_terminal)
        }
    }
}

#[cfg(desktop)]
impl NativeVoiceActor {
    fn new(
        app: AppHandle,
        sidecar: super::SharedSidecarState,
        tx: mpsc::UnboundedSender<ActorCommand>,
    ) -> Self {
        Self {
            app: Some(app),
            sidecar,
            tx,
            status: NativeVoiceStatus::unavailable(PROFILE_REASON),
            sequence: 0,
            next_ui_generation: 1,
            runtime: Rc::new(RefCell::new(None)),
            runtime_profile: None,
            active: None,
            shutdown_reply: None,
            profile_change_reply: None,
            shutdown_deadline: None,
            shutdown_timeout: SHUTDOWN_CLEANUP_TIMEOUT,
            failure: ActorFailureState::default(),
            #[cfg(test)]
            test_status_tx: None,
        }
    }

    #[cfg(test)]
    fn new_test(
        tx: mpsc::UnboundedSender<ActorCommand>,
        test_status_tx: mpsc::UnboundedSender<NativeVoiceStatus>,
    ) -> Self {
        Self {
            app: None,
            sidecar: Arc::new(std::sync::Mutex::new(
                super::SidecarState::new().expect("test sidecar state"),
            )),
            tx,
            status: NativeVoiceStatus::unavailable(PROFILE_REASON),
            sequence: 0,
            next_ui_generation: 1,
            runtime: Rc::new(RefCell::new(None)),
            runtime_profile: None,
            active: None,
            shutdown_reply: None,
            profile_change_reply: None,
            shutdown_deadline: None,
            shutdown_timeout: SHUTDOWN_CLEANUP_TIMEOUT,
            failure: ActorFailureState::default(),
            test_status_tx: Some(test_status_tx),
        }
    }

    fn quarantine_after_ambiguous_prepare_cleanup_failure(&mut self) {
        self.failure.record(NativeVoiceStopError::ShutdownFailed);
        self.set_status(
            NativeVoicePhase::Faulted,
            None,
            Some("handoff_cleanup_failed"),
        );
    }

    async fn handle(&mut self, command: ActorCommand) -> bool {
        match command {
            ActorCommand::Status { reply } => {
                if self.active.is_none() {
                    self.refresh_idle_status();
                }
                let _ = reply.send(Ok(self.status.clone()));
                false
            }
            ActorCommand::Start {
                request,
                profile_generation,
                speech_stages,
                config_revision,
                confirmed_profile_document,
                reply,
            } => {
                let result = self
                    .start(
                        request,
                        profile_generation,
                        speech_stages,
                        config_revision,
                        confirmed_profile_document,
                    )
                    .await;
                let _ = reply.send(result);
                false
            }
            ActorCommand::Finish { request, reply } => {
                let result = self.finish_or_cancel(request, false);
                let _ = reply.send(result);
                false
            }
            ActorCommand::Cancel { request, reply } => {
                let result = self.finish_or_cancel(request, true);
                let _ = reply.send(result);
                false
            }
            ActorCommand::RuntimePhase {
                ui_generation,
                phase,
                reason_code,
            } => {
                if !self.failure.blocks_reuse()
                    && self.active.as_ref().is_some_and(|active| {
                        active.ui_generation == ui_generation
                            && late_phase_allowed(active.expected_terminal, phase)
                    })
                {
                    self.set_status(phase, Some(ui_generation), reason_code);
                }
                false
            }
            ActorCommand::TurnFinished { ui_generation } => {
                // This is only a wakeup. The shared actor loop observes and joins the
                // retained JoinHandle directly before releasing the turn.
                let _ = ui_generation;
                false
            }
            ActorCommand::Shutdown { reply } => {
                if let Some(active) = self.active.as_mut() {
                    active.request_shutdown();
                    let ui_generation = active.ui_generation;
                    self.shutdown_reply = Some(reply);
                    self.shutdown_deadline = Some(TokioInstant::now() + self.shutdown_timeout);
                    self.set_status(
                        if self.failure.blocks_reuse() {
                            NativeVoicePhase::Faulted
                        } else {
                            NativeVoicePhase::Stopping
                        },
                        Some(ui_generation),
                        Some(if self.failure.blocks_reuse() {
                            "local_cleanup_failed"
                        } else {
                            "shutdown"
                        }),
                    );
                    return false;
                }
                self.set_status(
                    if self.failure.blocks_reuse() {
                        NativeVoicePhase::Faulted
                    } else {
                        NativeVoicePhase::Stopping
                    },
                    None,
                    Some(if self.failure.blocks_reuse() {
                        "local_cleanup_failed"
                    } else {
                        "shutdown"
                    }),
                );
                self.shutdown_reply = Some(reply);
                self.ack_shutdown();
                true
            }
            ActorCommand::CancelAndDrainForProfileChange { reply } => {
                if self.active.is_none() {
                    let result = self.failure.shutdown_result();
                    let _ = reply.send(result);
                } else if self.profile_change_reply.is_some() {
                    let _ = reply.send(Err(NativeVoiceStopError::Unavailable));
                } else {
                    if let Some(active) = self.active.as_mut() {
                        active.cancel_for_profile_change();
                        let ui_generation = active.ui_generation;
                        self.set_status(
                            NativeVoicePhase::Stopping,
                            Some(ui_generation),
                            Some("profile_changed"),
                        );
                    }
                    self.profile_change_reply = Some(reply);
                }
                false
            }
        }
    }

    fn complete_active_task(
        &mut self,
        result: Result<TurnTaskOutcome, tokio::task::JoinError>,
    ) -> bool {
        let Some(active) = self.active.as_ref() else {
            self.failure.record(NativeVoiceStopError::ShutdownFailed);
            self.set_status(
                NativeVoicePhase::Faulted,
                None,
                Some("turn_task_owner_missing"),
            );
            if let Some(reply) = self.profile_change_reply.take() {
                let _ = reply.send(Err(NativeVoiceStopError::ShutdownFailed));
            }
            if self.shutdown_reply.is_some() {
                self.ack_shutdown();
                return true;
            }
            return false;
        };
        let expected_terminal = active.expected_terminal;
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(_) => {
                let active = self.active.as_mut().expect("active task owner");
                if active.start_panic_cleanup() {
                    return false;
                }
                TurnTaskOutcome::failed()
            }
        };
        if let Some(active) = self.active.as_ref() {
            active.current_core_generation.set(None);
        }
        let cleanup_failed =
            outcome.cleanup.failed_for_task(outcome.no_core_work) || outcome.handoff_cleanup_failed;
        let reason_code = outcome
            .reason_code
            .or_else(|| cleanup_failed.then_some("local_cleanup_failed"));
        if cleanup_failed {
            self.failure.record(NativeVoiceStopError::ShutdownFailed);
            self.runtime.borrow_mut().take();
            self.runtime_profile = None;
        }
        self.active = None;
        let phase = self
            .failure
            .completion_phase(cleanup_failed, reason_code, expected_terminal);
        self.set_status(
            phase,
            None,
            if matches!(phase, NativeVoicePhase::Faulted) {
                reason_code.or(Some("local_cleanup_failed"))
            } else {
                None
            },
        );
        if let Some(reply) = self.profile_change_reply.take() {
            let result = if cleanup_failed || self.failure.blocks_reuse() {
                Err(NativeVoiceStopError::ShutdownFailed)
            } else {
                Ok(())
            };
            let _ = reply.send(result);
        }
        if self.shutdown_reply.is_some() {
            self.ack_shutdown();
            return true;
        }
        false
    }

    fn force_shutdown(&mut self) {
        if let Some(active) = self.active.as_mut() {
            active.request_shutdown();
        }
        self.failure.record(NativeVoiceStopError::TimedOut);
        self.shutdown_deadline = None;
        self.set_status(
            if self.failure.blocks_reuse() {
                NativeVoicePhase::Faulted
            } else {
                NativeVoicePhase::Stopping
            },
            None,
            Some(if self.failure.blocks_reuse() {
                "local_cleanup_failed"
            } else {
                "shutdown_timeout"
            }),
        );
    }

    fn ack_shutdown(&mut self) {
        if let Some(reply) = self.shutdown_reply.take() {
            let result = self.failure.shutdown_result();
            let _ = reply.send(result);
        }
        self.shutdown_deadline = None;
    }

    fn refresh_idle_status(&mut self) {
        if self.failure.blocks_reuse() {
            if !matches!(self.status.phase, NativeVoicePhase::Faulted) {
                self.set_status(
                    NativeVoicePhase::Faulted,
                    None,
                    Some("local_cleanup_failed"),
                );
            }
            return;
        }
        match self.resolve_profile(false) {
            Ok(profile) => {
                self.status = self.app.as_ref().map_or_else(
                    || NativeVoiceStatus::unavailable(PROFILE_REASON),
                    |app| idle_status(app, &profile),
                )
            }
            Err(reason) => self.status = NativeVoiceStatus::unavailable(reason),
        }
    }

    async fn prepare_local_handoff(
        &mut self,
        adapter: &mut NativeGatewayCaptureHandoff,
        cancellation: &CancellationToken,
    ) -> Result<NativeGatewayCaptureGrant, NativeVoiceCommandError> {
        match timeout(
            HANDOFF_OPERATION_TIMEOUT,
            adapter.prepare(&|| cancellation.is_cancelled()),
        )
        .await
        {
            Err(_) => {
                if recover_ambiguous_prepare(adapter).await.is_err() {
                    self.quarantine_after_ambiguous_prepare_cleanup_failure();
                    return Err(NativeVoiceCommandError::unavailable(
                        "handoff_cleanup_failed",
                    ));
                }
                Err(NativeVoiceCommandError::unavailable(
                    "handoff_prepare_timeout",
                ))
            }
            Ok(Ok(grant)) => Ok(grant),
            Ok(Err(error)) => {
                if prepare_error_needs_ambiguous_recovery(&error)
                    && recover_ambiguous_prepare(adapter).await.is_err()
                {
                    self.quarantine_after_ambiguous_prepare_cleanup_failure();
                    return Err(NativeVoiceCommandError::unavailable(
                        "handoff_cleanup_failed",
                    ));
                }
                Err(map_core_error(error))
            }
        }
    }

    async fn start(
        &mut self,
        request: NativeVoiceStartRequest,
        profile_generation: Option<u64>,
        speech_stages: Option<SpeechStages>,
        config_revision: Option<u64>,
        confirmed_profile_document: Option<String>,
    ) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
        if self.failure.blocks_reuse() {
            return Err(NativeVoiceCommandError::unavailable("local_cleanup_failed"));
        }
        if self.active.is_some() {
            return Err(NativeVoiceCommandError::invalid(ACTIVE_REASON));
        }
        let app = self
            .app
            .as_ref()
            .ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?
            .clone();
        if let Some(generation) = profile_generation {
            let policy_runtime = app
                .try_state::<super::native_node_config::NativeNodeConfigRuntime>()
                .map(|runtime| runtime.inner().clone())
                .ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?;
            if !policy_runtime.profile_generation_is_current(generation) {
                return Err(NativeVoiceCommandError::unavailable(
                    "speech_stage_unavailable",
                ));
            }
        }
        let document = match confirmed_profile_document {
            Some(document) => serde_json::from_str::<ThinProfileDocument>(&document)
                .map_err(|_| NativeVoiceCommandError::unavailable(PROFILE_REASON))?,
            None => load_thin_profile_document()
                .ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?,
        };
        let mut profile = resolve_start_profile_from_document(
            &document,
            request.remote_audio_consent,
            sidecar_running(&self.sidecar),
            load_peer_bearer,
            super::current_unix_ms,
        )?;
        let mut speech_selection = if let Some(stages) = speech_stages.as_ref() {
            apply_speech_stages(profile.local_speech_mut(), stages)
                .map_err(NativeVoiceCommandError::unavailable)?
        } else {
            SpeechStageRuntimeSelection::default()
        };
        if let Some(mesh_stt) = speech_selection.mesh_stt.as_mut() {
            if mesh_stt.model_id.is_none() {
                let mesh_sessions = app
                    .try_state::<crate::mesh_session::MeshSessionState>()
                    .ok_or_else(|| {
                        NativeVoiceCommandError::unavailable("speech_stage_unavailable")
                    })?;
                mesh_stt.model_id = Some(
                    mesh_sessions
                        .resolve_ready_stt_model(&mesh_stt.peer_id, &mesh_stt.resource_id)
                        .await
                        .map_err(|_| {
                            NativeVoiceCommandError::unavailable("speech_stage_unavailable")
                        })?,
                );
            }
        }
        if speech_selection.mesh_stt.is_some() && !request.remote_audio_consent {
            return Err(NativeVoiceCommandError::invalid(REMOTE_CONSENT_REASON));
        }
        install_profile(&mut self.status, &profile);

        let mut profile_key = profile.reusable_key();
        if let Some(key) = profile_key.as_mut() {
            speech_selection.append_cache_identity(&mut key.identity);
        }
        if !runtime_cache_matches(self.runtime_profile.as_ref(), profile_key.as_ref()) {
            *self.runtime.borrow_mut() = None;
            self.runtime_profile = profile_key.clone();
        }
        let mut runtime = match self.runtime.borrow_mut().take() {
            Some(runtime)
                if runtime_cache_matches(self.runtime_profile.as_ref(), profile_key.as_ref()) =>
            {
                runtime
            }
            None => build_runtime(&app, &profile, self.tx.clone(), &speech_selection)?,
            Some(_) => build_runtime(&app, &profile, self.tx.clone(), &speech_selection)?,
        };
        runtime.core.set_lifecycle_config_revision(config_revision);
        self.status.background_eligible = runtime.core.wake_background_ready();

        let core_generation = runtime
            .core
            .next_capture_generation()
            .map_err(map_core_error)?;
        let ui_generation = self.next_safe_ui_generation()?;
        let cancellation = CancellationToken::new();
        let shutdown_requested = Rc::new(Cell::new(false));
        let control = runtime.control.clone();
        let current_core_generation = Rc::clone(&runtime.current_core_generation);
        let start_reason = match request.trigger {
            NativeVoiceTrigger::FocusedPushToTalk => CaptureStartReason::PushToTalk,
            NativeVoiceTrigger::TrayPushToTalk => CaptureStartReason::AssistantRole,
            NativeVoiceTrigger::WakeWord => CaptureStartReason::ForegroundWake,
            NativeVoiceTrigger::BackgroundWake => CaptureStartReason::BackgroundSession,
        };
        let handoff = if let RuntimeProfile::Local { .. } = profile {
            let mut adapter = build_handoff(&profile, start_reason.clone())?;
            let grant = self
                .prepare_local_handoff(&mut adapter, &cancellation)
                .await?;
            Some((adapter, grant))
        } else {
            None
        };
        let lease = match handoff.as_ref() {
            Some((_, grant)) => grant.voice_capture_lease(now_micros()),
            None => VoiceCaptureLease {
                owner: aurora_voice_core::CaptureOwnerKind::Native,
                surface: SURFACE.to_owned(),
                device_route: DEVICE_ROUTE.to_owned(),
                start_reason: start_reason.clone(),
                generation: core_generation,
                created_at: now_micros(),
                route_revision: RouteRevision(ROUTE_REVISION),
                background_eligible: profile.background_voice_eligible(),
                consent_revision: if request.remote_audio_consent { 1 } else { 0 },
                heartbeat_at: now_micros(),
                stop_deadline: None,
            },
        };
        let handoff_slot: HandoffSlot = Rc::new(RefCell::new(handoff));

        runtime.ui_generation.set(Some(ui_generation));
        self.active = Some(ActiveTurn {
            ui_generation,
            continuous: matches!(request.trigger, NativeVoiceTrigger::BackgroundWake),
            _handoff_generation: handoff_slot
                .borrow()
                .as_ref()
                .map(|(_, grant)| grant.voice_capture_lease(now_micros()).generation),
            control: control.clone(),
            current_core_generation: Rc::clone(&current_core_generation),
            shutdown_requested: Rc::clone(&shutdown_requested),
            cancellation: cancellation.clone(),
            handoff_slot: Rc::clone(&handoff_slot),
            task: None,
            panic_cleanup_started: false,
            expected_terminal: false,
        });
        self.set_status(NativeVoicePhase::Starting, Some(ui_generation), None);

        let tx = self.tx.clone();
        let runtime_slot = Rc::clone(&self.runtime);
        let shutdown_requested_for_task = Rc::clone(&shutdown_requested);
        let task = tokio::task::spawn_local(async move {
            let _completion = TurnFinishedSignal {
                tx: tx.clone(),
                ui_generation,
            };
            let mut cleanup = CoreCleanupSummary::default();
            let result = match request.trigger {
                NativeVoiceTrigger::FocusedPushToTalk | NativeVoiceTrigger::TrayPushToTalk => {
                    run_core_generation(
                        &mut runtime.core,
                        &current_core_generation,
                        &mut cleanup,
                        |core| {
                            Box::pin(core.run_push_to_talk_turn(
                                lease,
                                now_micros(),
                                cancellation.clone(),
                            ))
                        },
                    )
                    .await
                }
                NativeVoiceTrigger::WakeWord => {
                    run_core_generation(
                        &mut runtime.core,
                        &current_core_generation,
                        &mut cleanup,
                        |core| {
                            Box::pin(core.run_wake_turn(lease, now_micros(), cancellation.clone()))
                        },
                    )
                    .await
                }
                NativeVoiceTrigger::BackgroundWake => {
                    run_background_session(
                        &mut runtime.core,
                        lease,
                        cancellation.clone(),
                        &current_core_generation,
                        &mut cleanup,
                    )
                    .await
                }
            };
            let reason_code = result.err().map(|error| reason_from_core_error(&error));
            let cleanup_reason =
                release_handoff_slot(&handoff_slot, shutdown_requested_for_task.as_ref()).await;
            let handoff_cleanup_failed = cleanup_reason.is_some();
            cleanup.record_handoff_cleanup_failure(handoff_cleanup_failed);
            let no_core_work = cleanup.invocations == 0 && cancellation.is_cancelled();
            runtime.ui_generation.set(None);
            *runtime_slot.borrow_mut() = Some(runtime);
            TurnTaskOutcome {
                reason_code: reason_code.or(cleanup_reason),
                cleanup,
                no_core_work,
                handoff_cleanup_failed,
            }
        });
        if let Some(active) = self.active.as_mut() {
            active.task = Some(task);
        }
        Ok(self.status.clone())
    }

    fn finish_or_cancel(
        &mut self,
        request: NativeVoiceControlRequest,
        cancel: bool,
    ) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
        let Some(active) = self.active.as_mut() else {
            return Err(NativeVoiceCommandError::invalid(STALE_CONTROL_REASON));
        };
        let reason = stop_reason_code(request.reason);
        active.apply_control(request, cancel)?;
        let ui_generation = active.ui_generation;
        self.set_status(
            if self.failure.blocks_reuse() {
                NativeVoicePhase::Faulted
            } else {
                NativeVoicePhase::Stopping
            },
            Some(ui_generation),
            Some(if self.failure.blocks_reuse() {
                "local_cleanup_failed"
            } else {
                reason
            }),
        );
        Ok(self.status.clone())
    }

    fn resolve_profile(
        &mut self,
        remote_audio_consent: bool,
    ) -> Result<RuntimeProfile, &'static str> {
        let Some(document) = load_thin_profile_document() else {
            return Err(PROFILE_REASON);
        };
        resolve_profile_from_document(
            &document,
            remote_audio_consent,
            sidecar_running(&self.sidecar),
            load_peer_bearer,
            super::current_unix_ms,
        )
    }

    fn next_safe_ui_generation(&mut self) -> Result<u64, NativeVoiceCommandError> {
        let value = self.next_ui_generation;
        if value == 0 || value > i64::MAX as u64 {
            return Err(NativeVoiceCommandError::unavailable("generation_exhausted"));
        }
        self.next_ui_generation = self
            .next_ui_generation
            .checked_add(1)
            .ok_or_else(|| NativeVoiceCommandError::unavailable("generation_exhausted"))?;
        Ok(value)
    }

    fn set_status(
        &mut self,
        phase: NativeVoicePhase,
        generation: Option<u64>,
        reason_code: Option<&'static str>,
    ) {
        let connection = self.status.connection;
        self.status = NativeVoiceStatus {
            available: !matches!(phase, NativeVoicePhase::Unavailable),
            phase,
            generation,
            background_eligible: self.status.background_eligible,
            connection,
            reason_code: reason_code.map(str::to_owned),
            redacted: true,
        };
        self.publish();
    }

    fn publish(&mut self) {
        self.sequence = self.sequence.saturating_add(1);
        let event = NativeVoiceEvent {
            sequence: self.sequence,
            status: self.status.clone(),
        };
        if let Some(app) = self.app.as_ref() {
            let _ = app.emit(STATUS_EVENT, event);
            self.publish_native_event();
        }
        #[cfg(test)]
        if let Some(publisher) = self.test_status_tx.as_ref() {
            let _ = publisher.send(self.status.clone());
        }
    }

    fn publish_native_event(&self) {
        let Ok(status) = serde_json::to_value(&self.status) else {
            return;
        };
        let draft = voice_turn_event(
            voice_turn_kind_for_phase(self.status.phase),
            self.status.generation,
            status,
            self.status.reason_code.clone(),
        )
        .status(voice_turn_status_for_phase(self.status.phase));
        global_native_event_hub().publish_now(draft);
    }
}

#[cfg(desktop)]
fn voice_turn_kind_for_phase(phase: NativeVoicePhase) -> &'static str {
    match phase {
        NativeVoicePhase::Starting => "voice.turn.started",
        NativeVoicePhase::Listening => "voice.turn.transcribing",
        NativeVoicePhase::Processing => "voice.turn.requesting",
        NativeVoicePhase::Speaking => "voice.turn.speaking",
        NativeVoicePhase::Idle | NativeVoicePhase::Stopping => "voice.turn.finalized",
        NativeVoicePhase::Unavailable | NativeVoicePhase::Faulted => "voice.turn.failed",
    }
}

#[cfg(desktop)]
fn voice_turn_status_for_phase(phase: NativeVoicePhase) -> &'static str {
    match phase {
        NativeVoicePhase::Starting
        | NativeVoicePhase::Listening
        | NativeVoicePhase::Processing
        | NativeVoicePhase::Speaking
        | NativeVoicePhase::Stopping => "active",
        NativeVoicePhase::Idle => "ok",
        NativeVoicePhase::Unavailable | NativeVoicePhase::Faulted => "error",
    }
}

#[cfg(desktop)]
struct ActiveTurn {
    ui_generation: u64,
    continuous: bool,
    _handoff_generation: Option<Generation>,
    control: DesktopCaptureControl,
    current_core_generation: Rc<Cell<Option<Generation>>>,
    shutdown_requested: Rc<Cell<bool>>,
    cancellation: CancellationToken,
    handoff_slot: HandoffSlot,
    task: Option<tokio::task::JoinHandle<TurnTaskOutcome>>,
    panic_cleanup_started: bool,
    expected_terminal: bool,
}

#[cfg(desktop)]
struct TurnTaskOutcome {
    reason_code: Option<&'static str>,
    cleanup: CoreCleanupSummary,
    no_core_work: bool,
    handoff_cleanup_failed: bool,
}

#[cfg(desktop)]
impl TurnTaskOutcome {
    fn failed() -> Self {
        Self {
            reason_code: Some("turn_task_failed"),
            cleanup: CoreCleanupSummary {
                failed: true,
                ..CoreCleanupSummary::default()
            },
            no_core_work: false,
            handoff_cleanup_failed: true,
        }
    }
}

#[cfg(desktop)]
impl ActiveTurn {
    fn start_panic_cleanup(&mut self) -> bool {
        if self.panic_cleanup_started {
            return false;
        }
        self.panic_cleanup_started = true;
        let handoff_slot = Rc::clone(&self.handoff_slot);
        let shutdown_requested = Rc::clone(&self.shutdown_requested);
        self.task = Some(tokio::task::spawn_local(async move {
            let _ = release_handoff_slot(&handoff_slot, shutdown_requested.as_ref()).await;
            TurnTaskOutcome::failed()
        }));
        true
    }

    fn apply_control(
        &mut self,
        request: NativeVoiceControlRequest,
        cancel: bool,
    ) -> Result<(), NativeVoiceCommandError> {
        if request.generation != self.ui_generation {
            return Err(NativeVoiceCommandError::invalid(STALE_CONTROL_REASON));
        }
        if control_requires_terminal_suppression(cancel || self.continuous) {
            self.expected_terminal = true;
            self.cancellation.cancel();
            self.interrupt_current_capture();
        } else {
            self.finish_current_capture();
        }
        Ok(())
    }

    fn request_shutdown(&mut self) {
        self.cancellation.cancel();
        self.shutdown_requested.set(true);
        self.interrupt_current_capture();
        self.expected_terminal = true;
    }

    fn cancel_for_profile_change(&mut self) {
        self.expected_terminal = true;
        self.cancellation.cancel();
        self.interrupt_current_capture();
    }

    fn take_task_for_completion(
        &mut self,
        ui_generation: u64,
    ) -> Option<Option<tokio::task::JoinHandle<TurnTaskOutcome>>> {
        (self.ui_generation == ui_generation).then(|| self.task.take())
    }

    fn finish_current_capture(&self) -> Option<Generation> {
        let generation = self.current_core_generation.get()?;
        self.control.finish(generation);
        Some(generation)
    }

    fn interrupt_current_capture(&self) -> Option<Generation> {
        let generation = self.current_core_generation.get()?;
        self.control.interrupt(generation);
        Some(generation)
    }
}

#[cfg(all(desktop, test))]
async fn join_active_turn(task: tokio::task::JoinHandle<TurnTaskOutcome>) -> TurnTaskOutcome {
    task.await.unwrap_or_else(|_| TurnTaskOutcome::failed())
}

#[cfg(desktop)]
#[derive(Clone, Default)]
struct CoreCleanupSummary {
    invocations: u64,
    last_generation: Option<Generation>,
    capture_start_attempted: bool,
    assistant_transport_attempted: bool,
    failed: bool,
}

#[cfg(desktop)]
impl CoreCleanupSummary {
    fn failed_for_task(&self, no_core_work: bool) -> bool {
        self.failed
            || (self.invocations == 0
                && (!no_core_work
                    || self.capture_start_attempted
                    || self.assistant_transport_attempted))
            || (self.invocations > 0 && no_core_work)
    }

    fn record(
        &mut self,
        expected: Generation,
        report: Option<VoiceCleanupReport>,
        generation_failed: bool,
    ) {
        let Some(report) = report.filter(|report| report.generation() == expected) else {
            self.record_values(
                expected,
                false,
                false,
                generation_failed,
                [aurora_voice_core::CleanupCallbackOutcome::NotAttempted; 8],
            );
            self.failed = true;
            return;
        };
        self.record_values(
            expected,
            report.capture_start_attempted(),
            report.assistant_transport_attempted(),
            generation_failed,
            [
                report.wake_cancel(),
                report.stt_cancel(),
                report.tts_cancel(),
                report.transport_cancel(),
                report.output_stop(),
                report.capture_stop(),
                report.capture_lease_release(),
                report.state_reset(),
            ],
        );
    }

    fn record_handoff_cleanup_failure(&mut self, failed: bool) {
        self.failed |= failed;
    }

    fn record_values(
        &mut self,
        expected: Generation,
        capture_start_attempted: bool,
        assistant_transport_attempted: bool,
        generation_failed: bool,
        outcomes: [aurora_voice_core::CleanupCallbackOutcome; 8],
    ) {
        let Some(next_count) = self.invocations.checked_add(1) else {
            self.failed = true;
            return;
        };
        self.invocations = next_count;
        if self
            .last_generation
            .is_some_and(|previous| expected.0 <= previous.0)
        {
            self.failed = true;
        }
        self.last_generation = Some(expected);
        self.capture_start_attempted |= capture_start_attempted;
        self.assistant_transport_attempted |= assistant_transport_attempted;
        if outcomes
            .iter()
            .any(|outcome| *outcome == aurora_voice_core::CleanupCallbackOutcome::ReturnedError)
            || outcomes[6] != aurora_voice_core::CleanupCallbackOutcome::ReturnedOk
            || (capture_start_attempted
                && outcomes[5] != aurora_voice_core::CleanupCallbackOutcome::ReturnedOk)
            || (!capture_start_attempted
                && outcomes[5] != aurora_voice_core::CleanupCallbackOutcome::NotAttempted)
            || (generation_failed
                && outcomes[7] != aurora_voice_core::CleanupCallbackOutcome::ReturnedOk)
            || (!generation_failed
                && outcomes[7] != aurora_voice_core::CleanupCallbackOutcome::NotAttempted)
        {
            self.failed = true;
        }
    }
}

#[cfg(desktop)]
struct TurnFinishedSignal {
    tx: mpsc::UnboundedSender<ActorCommand>,
    ui_generation: u64,
}

#[cfg(desktop)]
impl Drop for TurnFinishedSignal {
    fn drop(&mut self) {
        let _ = self.tx.send(ActorCommand::TurnFinished {
            ui_generation: self.ui_generation,
        });
    }
}

#[cfg(desktop)]
type HandoffSlot = Rc<RefCell<Option<(NativeGatewayCaptureHandoff, NativeGatewayCaptureGrant)>>>;

#[cfg(desktop)]
struct DesktopFiniteStt(Box<dyn FiniteSttPort>);

#[cfg(desktop)]
impl DesktopFiniteStt {
    fn new(provider: impl FiniteSttPort + 'static) -> Self {
        Self(Box::new(provider))
    }
}

#[cfg(desktop)]
#[async_trait(?Send)]
impl FiniteSttPort for DesktopFiniteStt {
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
        self.0.finite_stt_binding()
    }

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError> {
        self.0.warm_finite_stt(binding).await
    }

    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        self.0.transcribe_finite(request, audio, cancellation).await
    }

    async fn cancel_finite_stt_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        self.0.cancel_finite_stt_generation(generation).await
    }
}

#[cfg(desktop)]
struct DesktopTts(Box<dyn TtsSynthesisPort>);

#[cfg(desktop)]
impl DesktopTts {
    fn new(provider: impl TtsSynthesisPort + 'static) -> Self {
        Self(Box::new(provider))
    }
}

#[cfg(desktop)]
#[async_trait(?Send)]
impl TtsSynthesisPort for DesktopTts {
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
        self.0.synthesis_binding()
    }

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError> {
        self.0.warm_synthesis(binding).await
    }

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        self.0.synthesize_text(request, cancellation).await
    }

    async fn cancel_synthesis_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        self.0.cancel_synthesis_generation(generation).await
    }
}

#[cfg(desktop)]
type RuntimeCore = VoiceRuntime<
    DesktopAudioInput,
    DesktopFiniteStt,
    DesktopTts,
    NativeGatewayTransport,
    CpalAudioOutput,
    StatusOnlySink,
>;

#[cfg(desktop)]
struct RuntimeBundle {
    core: RuntimeCore,
    control: DesktopCaptureControl,
    ui_generation: Rc<Cell<Option<u64>>>,
    current_core_generation: Rc<Cell<Option<Generation>>>,
}

#[cfg(desktop)]
enum DesktopAudioInput {
    Production(CpalAudioInput),
    #[cfg(feature = "desktop-native-voice-e2e")]
    Deterministic(DeterministicE2eAudioInput),
}

#[cfg(desktop)]
impl DesktopAudioInput {
    fn runtime() -> Self {
        #[cfg(feature = "desktop-native-voice-e2e")]
        if desktop_native_voice_e2e_enabled() {
            return Self::Deterministic(DeterministicE2eAudioInput::new());
        }
        Self::Production(CpalAudioInput::new(NativeCaptureConfig::default()))
    }

    fn control(&self) -> DesktopCaptureControl {
        match self {
            Self::Production(audio) => DesktopCaptureControl::Production(audio.control()),
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(audio) => DesktopCaptureControl::Deterministic(audio.control()),
        }
    }
}

#[cfg(desktop)]
#[async_trait(?Send)]
impl AudioInput for DesktopAudioInput {
    async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
        match self {
            Self::Production(audio) => audio.start(lease).await,
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(audio) => audio.start(lease).await,
        }
    }

    async fn stop(&mut self, reason: TransitionReason) -> Result<(), VoiceCoreError> {
        match self {
            Self::Production(audio) => audio.stop(reason).await,
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(audio) => audio.stop(reason).await,
        }
    }

    async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
        match self {
            Self::Production(audio) => audio.next_frame().await,
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(audio) => audio.next_frame().await,
        }
    }

    fn current_route_revision(&self) -> RouteRevision {
        match self {
            Self::Production(audio) => audio.current_route_revision(),
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(audio) => audio.current_route_revision(),
        }
    }
}

#[cfg(desktop)]
#[derive(Clone, Debug)]
enum DesktopCaptureControl {
    Production(NativeCaptureControl),
    #[cfg(feature = "desktop-native-voice-e2e")]
    Deterministic(DeterministicE2eCaptureControl),
    #[cfg(test)]
    Test(Arc<Mutex<Vec<(&'static str, u64)>>>),
}

#[cfg(desktop)]
impl DesktopCaptureControl {
    fn finish(&self, generation: Generation) {
        match self {
            Self::Production(control) => control.finish(generation),
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(control) => control.finish(generation),
            #[cfg(test)]
            Self::Test(events) => events
                .lock()
                .expect("test capture events")
                .push(("finish", generation.0)),
        }
    }

    fn interrupt(&self, generation: Generation) {
        match self {
            Self::Production(control) => control.interrupt(generation),
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(control) => control.interrupt(generation),
            #[cfg(test)]
            Self::Test(events) => events
                .lock()
                .expect("test capture events")
                .push(("interrupt", generation.0)),
        }
    }
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
const E2E_AUDIO_FRAME_SAMPLES: usize = 160;
#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
const E2E_AUDIO_FRAME_DURATION: Duration = Duration::from_millis(10);

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
#[derive(Debug)]
struct DeterministicE2eAudioInput {
    shared: Arc<DeterministicE2eCaptureShared>,
    active: Option<DeterministicE2eCaptureSession>,
    route_revision: RouteRevision,
    frame_limit: Option<u64>,
    pause_next_frame: Rc<RefCell<Option<(u64, oneshot::Sender<u64>, oneshot::Receiver<()>)>>>,
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
impl DeterministicE2eAudioInput {
    fn new() -> Self {
        Self {
            shared: Arc::new(DeterministicE2eCaptureShared::default()),
            active: None,
            route_revision: RouteRevision(0),
            frame_limit: None,
            pause_next_frame: Rc::new(RefCell::new(None)),
        }
    }

    fn with_frame_limit(mut self, frame_limit: u64) -> Self {
        self.frame_limit = Some(frame_limit);
        self
    }

    fn pause_next_frame(
        self,
        generation: u64,
        entered: oneshot::Sender<u64>,
        release: oneshot::Receiver<()>,
    ) -> Self {
        *self.pause_next_frame.borrow_mut() = Some((generation, entered, release));
        self
    }

    fn control(&self) -> DeterministicE2eCaptureControl {
        DeterministicE2eCaptureControl {
            shared: Arc::clone(&self.shared),
        }
    }

    fn reset_inactive(&mut self) {
        self.active = None;
        self.shared
            .active_generation
            .store(0, std::sync::atomic::Ordering::SeqCst);
        self.shared
            .finished
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.shared
            .interrupted
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
#[async_trait(?Send)]
impl AudioInput for DeterministicE2eAudioInput {
    async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
        if self.active.is_some() {
            return Err(VoiceCoreError::OwnerAlreadyActive);
        }
        if lease.owner != aurora_voice_core::CaptureOwnerKind::Native
            || lease.generation.0 == 0
            || lease.device_route != DEVICE_ROUTE
        {
            return Err(VoiceCoreError::TransportFault {
                code: "invalid-e2e-capture-lease".to_owned(),
            });
        }
        self.route_revision = lease.route_revision;
        self.shared
            .active_generation
            .store(lease.generation.0, std::sync::atomic::Ordering::SeqCst);
        self.shared
            .started_generations
            .lock()
            .expect("deterministic capture generations")
            .push(lease.generation.0);
        self.shared
            .finished
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.shared
            .interrupted
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.active = Some(DeterministicE2eCaptureSession {
            generation: lease.generation,
            route_revision: lease.route_revision,
            started_at: lease.created_at,
            sequence: 0,
        });
        Ok(())
    }

    async fn stop(&mut self, _reason: TransitionReason) -> Result<(), VoiceCoreError> {
        self.reset_inactive();
        Ok(())
    }

    async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
        tokio::time::sleep(E2E_AUDIO_FRAME_DURATION).await;
        let active_generation = self.active.as_ref().map(|session| session.generation.0);
        let pause = {
            let mut pending = self.pause_next_frame.borrow_mut();
            if pending
                .as_ref()
                .is_some_and(|(generation, _, _)| Some(*generation) == active_generation)
            {
                pending.take()
            } else {
                None
            }
        };
        if let Some((generation, entered, release)) = pause {
            let _ = entered.send(generation);
            let _ = release.await;
        }
        if self
            .shared
            .interrupted
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(VoiceCoreError::Cancelled);
        }
        if self
            .shared
            .finished
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(None);
        }
        let session = self.active.as_mut().ok_or(VoiceCoreError::NoOwnerActive)?;
        if self
            .frame_limit
            .is_some_and(|limit| session.sequence >= limit)
        {
            return Ok(None);
        }
        let samples = (0..E2E_AUDIO_FRAME_SAMPLES)
            .map(|offset| {
                if (session.sequence as usize * E2E_AUDIO_FRAME_SAMPLES + offset) % 32 < 16 {
                    0.2
                } else {
                    -0.2
                }
            })
            .collect();
        let frame = PcmFrame::new(
            samples,
            TimestampMicros(
                session
                    .started_at
                    .0
                    .saturating_add(session.sequence.saturating_mul(10_000)),
            ),
            session.sequence,
            false,
            session.route_revision,
            session.generation,
        )?;
        session.sequence = session.sequence.saturating_add(1);
        Ok(Some(frame))
    }

    fn current_route_revision(&self) -> RouteRevision {
        self.route_revision
    }
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
#[derive(Debug, Default)]
struct DeterministicE2eCaptureShared {
    active_generation: std::sync::atomic::AtomicU64,
    finished: std::sync::atomic::AtomicBool,
    interrupted: std::sync::atomic::AtomicBool,
    started_generations: std::sync::Mutex<Vec<u64>>,
    control_events: std::sync::Mutex<Vec<(&'static str, u64)>>,
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
#[derive(Clone, Debug)]
struct DeterministicE2eCaptureControl {
    shared: Arc<DeterministicE2eCaptureShared>,
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
impl DeterministicE2eCaptureControl {
    fn finish(&self, generation: Generation) {
        if self.active(generation) {
            self.shared
                .control_events
                .lock()
                .expect("deterministic capture events")
                .push(("finish", generation.0));
            self.shared
                .finished
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn interrupt(&self, generation: Generation) {
        if self.active(generation) {
            self.shared
                .control_events
                .lock()
                .expect("deterministic capture events")
                .push(("interrupt", generation.0));
            self.shared
                .interrupted
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn active(&self, generation: Generation) -> bool {
        generation.0 != 0
            && self
                .shared
                .active_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                == generation.0
    }
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
#[derive(Debug)]
struct DeterministicE2eCaptureSession {
    generation: Generation,
    route_revision: RouteRevision,
    started_at: TimestampMicros,
    sequence: u64,
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
fn desktop_native_voice_e2e_enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("AURORA_DESKTOP_NATIVE_VOICE_E2E").as_deref() == Ok("1")
}

#[cfg(desktop)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeProfileKey {
    connection: NativeVoiceConnection,
    identity: String,
}

#[cfg(desktop)]
enum RuntimeProfile {
    Local {
        gateway: Url,
        local_speech: LocalSpeechSelection,
    },
    Remote {
        gateway: Url,
        bearer: String,
        remote_audio_consent: bool,
        local_speech: LocalSpeechSelection,
    },
}

#[cfg(desktop)]
impl RuntimeProfile {
    fn local_with_speech(local_speech: LocalSpeechSelection) -> Result<Self, &'static str> {
        let gateway = super::local_gateway_url().map_err(|_| PROFILE_REASON)?;
        Self::local_from_gateway_with_speech(gateway, local_speech)
    }

    #[cfg(test)]
    fn local_from_gateway(gateway: Url) -> Result<Self, &'static str> {
        Self::local_from_gateway_with_speech(gateway, LocalSpeechSelection::default())
    }

    fn local_from_gateway_with_speech(
        gateway: Url,
        local_speech: LocalSpeechSelection,
    ) -> Result<Self, &'static str> {
        if !super::is_loopback_http_origin(&gateway) {
            return Err(PROFILE_REASON);
        }
        Ok(Self::Local {
            gateway,
            local_speech,
        })
    }

    fn connection(&self) -> NativeVoiceConnection {
        match self {
            Self::Local { .. } => NativeVoiceConnection::ThisDevice,
            Self::Remote { .. } => NativeVoiceConnection::ConnectedDevice,
        }
    }

    fn reusable_key(&self) -> Option<RuntimeProfileKey> {
        match self {
            Self::Local {
                gateway,
                local_speech,
            } => Some(RuntimeProfileKey {
                connection: NativeVoiceConnection::ThisDevice,
                identity: format!(
                    "{}|{}",
                    gateway.origin().ascii_serialization(),
                    local_speech.cache_identity()
                ),
            }),
            Self::Remote { .. } => None,
        }
    }

    fn local_speech(&self) -> &LocalSpeechSelection {
        match self {
            Self::Local { local_speech, .. } | Self::Remote { local_speech, .. } => local_speech,
        }
    }

    fn local_speech_mut(&mut self) -> &mut LocalSpeechSelection {
        match self {
            Self::Local { local_speech, .. } | Self::Remote { local_speech, .. } => local_speech,
        }
    }

    fn permits_remote_audio(&self) -> bool {
        match self {
            Self::Local { .. } => true,
            Self::Remote { local_speech, .. } if local_speech.stt.is_some() => false,
            Self::Remote {
                remote_audio_consent,
                ..
            } => *remote_audio_consent,
        }
    }

    fn requires_remote_audio_consent(&self) -> bool {
        self.connection() == NativeVoiceConnection::ConnectedDevice
            && self.local_speech().stt.is_none()
            && !self.permits_remote_audio()
    }

    fn background_voice_eligible(&self) -> bool {
        self.local_speech().vad.is_some()
            && self.local_speech().kws.is_some()
            && self.local_speech().wake_phrase.is_some()
    }
}

#[cfg(desktop)]
fn idle_status(app: &AppHandle, profile: &RuntimeProfile) -> NativeVoiceStatus {
    NativeVoiceStatus {
        available: true,
        phase: NativeVoicePhase::Idle,
        generation: None,
        background_eligible: installed_wake_bindings_ready(app, profile),
        connection: profile.connection(),
        reason_code: None,
        redacted: true,
    }
}

#[cfg(desktop)]
fn install_profile(status: &mut NativeVoiceStatus, profile: &RuntimeProfile) {
    status.connection = profile.connection();
    status.background_eligible = profile.background_voice_eligible();
}

#[cfg(desktop)]
fn terminal_phase(reason_code: Option<&'static str>, expected_terminal: bool) -> NativeVoicePhase {
    if reason_code.is_none() || (expected_terminal && reason_code == Some("cancelled")) {
        NativeVoicePhase::Idle
    } else {
        NativeVoicePhase::Faulted
    }
}

#[cfg(desktop)]
fn runtime_cache_matches(
    cached: Option<&RuntimeProfileKey>,
    requested: Option<&RuntimeProfileKey>,
) -> bool {
    requested.is_some() && cached == requested
}

#[cfg(desktop)]
async fn run_background_session<A, E, P, T, O, S>(
    core: &mut VoiceRuntime<A, E, P, T, O, S>,
    lease: VoiceCaptureLease,
    cancellation: CancellationToken,
    current_generation: &Rc<Cell<Option<Generation>>>,
    cleanup: &mut CoreCleanupSummary,
) -> Result<String, VoiceCoreError>
where
    A: AudioInput,
    E: FiniteSttPort,
    P: TtsSynthesisPort,
    T: aurora_voice_core::SpeechTransport,
    O: aurora_voice_core::AudioOutput,
    S: RuntimeEventSink,
{
    run_background_session_with_iteration_boundary(
        core,
        lease,
        cancellation,
        current_generation,
        cleanup,
        no_background_iteration_pause,
    )
    .await
}

#[cfg(desktop)]
fn no_background_iteration_pause() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
    Box::pin(std::future::ready(()))
}

#[cfg(desktop)]
async fn run_background_session_with_iteration_boundary<A, E, P, T, O, S, F>(
    core: &mut VoiceRuntime<A, E, P, T, O, S>,
    lease: VoiceCaptureLease,
    cancellation: CancellationToken,
    current_generation: &Rc<Cell<Option<Generation>>>,
    cleanup: &mut CoreCleanupSummary,
    mut after_generation: F,
) -> Result<String, VoiceCoreError>
where
    A: AudioInput,
    E: FiniteSttPort,
    P: TtsSynthesisPort,
    T: aurora_voice_core::SpeechTransport,
    O: aurora_voice_core::AudioOutput,
    S: RuntimeEventSink,
    F: FnMut() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>,
{
    loop {
        cancellation.check()?;
        let result = run_core_generation(core, current_generation, cleanup, |core| {
            Box::pin(core.run_background_turn(lease.clone(), now_micros(), cancellation.clone()))
        })
        .await;
        after_generation().await;
        match result {
            Ok(_) => {
                if cancellation.is_cancelled() {
                    return Err(VoiceCoreError::Cancelled);
                }
            }
            Err(
                VoiceCoreError::WakeNotDetected
                | VoiceCoreError::SpeechNotDetected
                | VoiceCoreError::SpeechTimeout,
            ) => {
                if cancellation.is_cancelled() {
                    // These outcomes normally start another background iteration.
                    // If cancellation arrived after this generation completed, report
                    // the expected stop. Cleanup failures remain sticky in `cleanup`
                    // and still fault the actor when the owned task is joined.
                    return Err(VoiceCoreError::Cancelled);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(desktop)]
trait CoreGenerationSource {
    fn next_generation(&self) -> Result<Generation, VoiceCoreError>;

    fn cleanup_report(&self, generation: Generation) -> Option<VoiceCleanupReport>;
}

#[cfg(desktop)]
impl<A, E, P, T, O, S> CoreGenerationSource for VoiceRuntime<A, E, P, T, O, S>
where
    A: AudioInput,
    E: FiniteSttPort,
    P: TtsSynthesisPort,
    T: aurora_voice_core::SpeechTransport,
    O: aurora_voice_core::AudioOutput,
    S: RuntimeEventSink,
{
    fn next_generation(&self) -> Result<Generation, VoiceCoreError> {
        self.next_capture_generation()
    }

    fn cleanup_report(&self, generation: Generation) -> Option<VoiceCleanupReport> {
        self.cleanup_report_for_generation(generation)
    }
}

#[cfg(desktop)]
async fn run_core_generation<C, F>(
    core: &mut C,
    current_generation: &Rc<Cell<Option<Generation>>>,
    cleanup: &mut CoreCleanupSummary,
    invoke: F,
) -> Result<String, VoiceCoreError>
where
    C: CoreGenerationSource,
    F: for<'a> FnOnce(
        &'a mut C,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, VoiceCoreError>> + 'a>,
    >,
{
    let generation = match core.next_generation() {
        Ok(generation) => generation,
        Err(error) => {
            cleanup.failed = true;
            return Err(error);
        }
    };
    current_generation.set(Some(generation));
    let result = invoke(core).await;
    // The core retains only its most recent generation report, so copy and
    // validate it immediately before another invocation can clear it.
    cleanup.record(generation, core.cleanup_report(generation), result.is_err());
    if current_generation.get() == Some(generation) {
        current_generation.set(None);
    } else {
        cleanup.failed = true;
    }
    result
}

#[cfg(desktop)]
fn installed_wake_bindings_ready(app: &AppHandle, profile: &RuntimeProfile) -> bool {
    if !profile.background_voice_eligible() {
        return false;
    }
    let local_speech = profile.local_speech();
    let (Some(vad), Some(kws), Some(phrase)) = (
        local_speech.vad.as_ref(),
        local_speech.kws.as_ref(),
        local_speech.wake_phrase.as_ref(),
    ) else {
        return false;
    };
    let Ok(manager) = speech_pack_manager(app) else {
        return false;
    };
    manager.resolve_model_bindings(&vad.pack_id).is_ok()
        && build_selected_wake_kws_provider(&manager, kws, phrase).is_ok()
}

#[cfg(desktop)]
fn build_runtime(
    app: &AppHandle,
    profile: &RuntimeProfile,
    tx: mpsc::UnboundedSender<ActorCommand>,
    speech_selection: &SpeechStageRuntimeSelection,
) -> Result<RuntimeBundle, NativeVoiceCommandError> {
    let ui_generation = Rc::new(Cell::new(None));
    let current_core_generation = Rc::new(Cell::new(None));
    let local_speech = profile.local_speech();
    let manager = if local_speech.vad.is_some()
        || local_speech.kws.is_some()
        || local_speech.stt.is_some()
        || local_speech.tts.is_some()
    {
        Some(speech_pack_manager(app)?)
    } else {
        None
    };
    let stt = if let Some(mesh) = speech_selection.mesh_stt.as_ref() {
        let route = RouteFiniteSttBinding::new(
            "mesh.stt",
            FiniteSttRouteScope::RemoteGateway,
            VAD_SAMPLE_RATE_HZ,
            MAX_FINITE_STT_SAMPLES.min(16_000 * 30),
            ROUTE_REVISION,
        )
        .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?;
        let limits = TransportLimits {
            microphone_audio_policy: MicrophoneAudioPolicy::ExplicitRemoteConsent,
            ..TransportLimits::default()
        };
        let config = NativeMeshFiniteSttConfig::new(
            route,
            mesh.peer_id.clone(),
            mesh.resource_id.clone(),
            mesh.model_id.clone(),
            mesh.language.clone(),
            true,
            limits,
        )
        .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?;
        DesktopFiniteStt::new(
            NativeMeshFiniteStt::new(config)
                .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?,
        )
    } else {
        match profile.local_speech().stt.as_ref() {
            Some(selection) => DesktopFiniteStt::new(
                build_installed_stt_provider(
                    manager.as_ref().ok_or_else(|| {
                        NativeVoiceCommandError::unavailable("local_speech_unavailable")
                    })?,
                    &selection.pack_id,
                )
                .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?,
            ),
            None => {
                if profile.requires_remote_audio_consent() {
                    return Err(NativeVoiceCommandError::invalid(REMOTE_CONSENT_REASON));
                }
                let policy = match profile {
                    RuntimeProfile::Local { .. } => MicrophoneAudioPolicy::LoopbackOnly,
                    RuntimeProfile::Remote { .. } => MicrophoneAudioPolicy::ExplicitRemoteConsent,
                };
                let scope = match profile {
                    RuntimeProfile::Local { .. } => FiniteSttRouteScope::LoopbackSidecar,
                    RuntimeProfile::Remote { .. } => FiniteSttRouteScope::RemoteGateway,
                };
                let stt_route = RouteFiniteSttBinding::new(
                    "gateway.default",
                    scope,
                    VAD_SAMPLE_RATE_HZ,
                    MAX_FINITE_STT_SAMPLES.min(16_000 * 30),
                    ROUTE_REVISION,
                )
                .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?;
                DesktopFiniteStt::new(
                    NativeGatewayFiniteStt::new(
                        transport_for_profile(profile)?,
                        NativeGatewayFiniteSttConfig::new(
                            stt_route,
                            speech_selection
                                .gateway_stt_model_id
                                .as_deref()
                                .unwrap_or("realtime")
                                .to_owned(),
                            policy,
                        )
                        .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?,
                    )
                    .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?,
                )
            }
        }
    };
    let tts = if let Some(mesh) = speech_selection.mesh_tts.as_ref() {
        let route = RouteTtsBinding::new(
            "mesh.tts",
            "mesh.default",
            VAD_SAMPLE_RATE_HZ,
            ROUTE_REVISION,
        )
        .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?;
        let config = NativeMeshTtsConfig::new(
            route,
            mesh.peer_id.clone(),
            mesh.resource_id.clone(),
            mesh.model_id.clone(),
            None,
            mesh.language.clone(),
            TransportLimits::default(),
            TTS_MAX_AUDIO_SAMPLES,
        )
        .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?;
        DesktopTts::new(
            NativeMeshTtsSynthesizer::new(config)
                .map_err(|_| NativeVoiceCommandError::unavailable("speech_stage_unavailable"))?,
        )
    } else {
        match profile.local_speech().tts.as_ref() {
            Some(selection) => {
                let voice_id = selection.voice_id.as_deref().ok_or_else(|| {
                    NativeVoiceCommandError::unavailable("local_speech_unavailable")
                })?;
                let voice_catalog = TtsVoiceCatalog::runtime().map_err(|_| {
                    NativeVoiceCommandError::unavailable("local_speech_unavailable")
                })?;
                let voice = voice_catalog.voice(voice_id).ok_or_else(|| {
                    NativeVoiceCommandError::unavailable("local_speech_unavailable")
                })?;
                let manager = manager.as_ref().ok_or_else(|| {
                    NativeVoiceCommandError::unavailable("local_speech_unavailable")
                })?;
                let provider = match voice.model_family.as_str() {
                    "vits_piper" => build_installed_tts_provider(manager, voice_id),
                    "pockettts" if voice.requires_reference_profile() => {
                        let reference_profile_id =
                            selection.reference_profile_id.as_deref().ok_or_else(|| {
                                NativeVoiceCommandError::unavailable("local_speech_unavailable")
                            })?;
                        let reference_profile = load_desktop_tts_reference_profile(
                            app,
                            reference_profile_id,
                            voice_id,
                        )?;
                        build_installed_tts_provider_with_reference(
                            manager,
                            voice_id,
                            Some(reference_profile.to_native()?),
                            optional_desktop_tts_reference_text(
                                reference_profile.reference_text.as_deref(),
                            ),
                        )
                    }
                    "pockettts" => {
                        build_installed_tts_provider_with_reference(manager, voice_id, None, None)
                    }
                    _ => Err(EngineError::InvalidRequest),
                };
                DesktopTts::new(provider.map_err(|_| {
                    NativeVoiceCommandError::unavailable("local_speech_unavailable")
                })?)
            }
            None => {
                let tts_route = RouteTtsBinding::new(
                    "gateway.default",
                    "voice.default",
                    VAD_SAMPLE_RATE_HZ,
                    ROUTE_REVISION,
                )
                .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?;
                DesktopTts::new(NativeGatewayTtsSynthesizer::new(
                    transport_for_profile(profile)?,
                    NativeGatewayTtsConfig::new(tts_route, None, 1.0, TTS_MAX_AUDIO_SAMPLES)
                        .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?,
                ))
            }
        }
    };
    let transport = transport_for_profile(profile)?;
    let audio = DesktopAudioInput::runtime();
    let control = audio.control();
    let output = CpalAudioOutput::new(NativeAudioConfig::default());
    let sink = StatusOnlySink {
        tx,
        ui_generation: Rc::clone(&ui_generation),
    };
    let mut core = VoiceRuntime::new(
        audio,
        stt,
        tts,
        transport,
        output,
        sink,
        SURFACE,
        "tauri-native-voice",
    )
    .map_err(|_| NativeVoiceCommandError::unavailable("runtime_unavailable"))?;
    if let Some((vad, kws, wake_config)) = build_wake_runtime(profile, manager.as_ref())? {
        core = core
            .with_wake_providers(vad, kws, wake_config)
            .map_err(|_| NativeVoiceCommandError::unavailable("wake_unavailable"))?;
    }
    Ok(RuntimeBundle {
        core,
        control,
        ui_generation,
        current_core_generation,
    })
}

#[cfg(desktop)]
fn build_wake_runtime(
    profile: &RuntimeProfile,
    manager: Option<&SpeechPackManager>,
) -> Result<
    Option<(WakeVadProvider, WakeKwsProvider, WakeOrchestrationConfig)>,
    NativeVoiceCommandError,
> {
    let local_speech = profile.local_speech();
    let (Some(vad_selection), Some(kws_selection), Some(wake_phrase)) = (
        local_speech.vad.as_ref(),
        local_speech.kws.as_ref(),
        local_speech.wake_phrase.as_ref(),
    ) else {
        return Ok(None);
    };
    let manager =
        manager.ok_or_else(|| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    let vad_config = VadConfig::default();
    let vad = build_installed_vad_provider(manager, &vad_selection.pack_id, &vad_config)
        .map_err(|_| NativeVoiceCommandError::unavailable("wake_unavailable"))?;
    let kws = build_selected_wake_kws_provider(manager, kws_selection, wake_phrase)
        .map_err(|_| NativeVoiceCommandError::unavailable("wake_unavailable"))?;
    let kws_config = KwsConfig::new(
        [&wake_phrase.phrase_id],
        &wake_phrase.revision,
        NATIVE_WAKE_KWS_THRESHOLD,
        30,
        1,
    )
    .map_err(|_| NativeVoiceCommandError::unavailable("wake_unavailable"))?;
    let wake_config = WakeOrchestrationConfig::new(
        vad.binding().clone(),
        kws.binding().clone(),
        vad_config,
        kws_config,
        1_000,
        500,
    )
    .map_err(|_| NativeVoiceCommandError::unavailable("wake_unavailable"))?;
    Ok(Some((
        Box::new(DesktopWakeVad(vad)),
        Box::new(DesktopWakeKws(kws)),
        wake_config,
    )))
}

#[cfg(desktop)]
struct DesktopWakeVad(SherpaVadProvider<NativeVadBackend>);

#[cfg(desktop)]
struct DesktopWakeKws(SherpaKwsProvider<NativeKwsBackend>);

#[cfg(desktop)]
#[async_trait(?Send)]
impl TaskProvider for DesktopWakeVad {
    fn capabilities(&self) -> Vec<TaskCapability> {
        self.0.capabilities()
    }

    fn resource_report(&self) -> ResourceReport {
        self.0.resource_report()
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        self.0.warm_task(request).await
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.0.unload_task(binding).await
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        self.0.cancel_generation(generation).await
    }
}

#[cfg(desktop)]
#[async_trait(?Send)]
impl VadStreamProvider for DesktopWakeVad {
    async fn start_vad_session(
        &mut self,
        request: BoundVadRequest,
    ) -> Result<BoundStreamSession, EngineError> {
        self.0.start_vad_session(request).await
    }

    async fn push_vad_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<VadAcceptResult, EngineError> {
        self.0.push_vad_frame(session, frame, cancellation).await
    }

    async fn flush_vad_session(
        &mut self,
        session: &BoundStreamSession,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<SpeechSegment>, EngineError> {
        self.0.flush_vad_session(session, cancellation).await
    }

    async fn reset_vad_session(
        &mut self,
        session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        self.0.reset_vad_session(session, reason).await
    }
}

#[cfg(desktop)]
#[async_trait(?Send)]
impl TaskProvider for DesktopWakeKws {
    fn capabilities(&self) -> Vec<TaskCapability> {
        self.0.capabilities()
    }

    fn resource_report(&self) -> ResourceReport {
        self.0.resource_report()
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        self.0.warm_task(request).await
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.0.unload_task(binding).await
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        self.0.cancel_generation(generation).await
    }
}

#[cfg(desktop)]
#[async_trait(?Send)]
impl KwsStreamProvider for DesktopWakeKws {
    async fn start_kws_session(
        &mut self,
        request: BoundKwsRequest,
    ) -> Result<BoundStreamSession, EngineError> {
        self.0.start_kws_session(request).await
    }

    async fn push_kws_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<KwsFrameResult, EngineError> {
        self.0.push_kws_frame(session, frame, cancellation).await
    }

    async fn reset_kws_session(
        &mut self,
        session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        self.0.reset_kws_session(session, reason).await
    }
}

#[cfg(desktop)]
fn build_selected_wake_kws_provider(
    manager: &SpeechPackManager,
    kws_selection: &LocalSpeechAssetSelection,
    phrase: &LocalWakePhraseSelection,
) -> Result<SherpaKwsProvider<NativeKwsBackend>, EngineError> {
    let phrase_input = SherpaKwsPhraseInput::new(&phrase.phrase_id, &phrase.phrase)
        .map_err(|_| EngineError::InvalidRequest)?;
    build_installed_kws_provider_from_phrases(
        manager,
        &kws_selection.pack_id,
        &phrase.revision,
        [phrase_input],
    )
}

#[cfg(desktop)]
fn speech_pack_manager(app: &AppHandle) -> Result<SpeechPackManager, NativeVoiceCommandError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?
        .join("speech-packs");
    speech_pack_manager_at(root)
}

#[cfg(desktop)]
fn speech_pack_manager_at(root: PathBuf) -> Result<SpeechPackManager, NativeVoiceCommandError> {
    let config = SpeechPackManagerConfig::new(root, None)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    SpeechPackManager::open(config)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))
}

#[cfg(desktop)]
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopTtsReferenceProfile {
    version: u8,
    id: String,
    #[serde(default)]
    voice_id: Option<String>,
    sample_rate_hz: i32,
    samples: Vec<f32>,
    #[serde(default)]
    reference_text: Option<String>,
    #[serde(default)]
    revision: Option<String>,
}

#[cfg(desktop)]
impl DesktopTtsReferenceProfile {
    fn new(
        id: String,
        voice_id: Option<String>,
        sample_rate_hz: i32,
        samples: Vec<f32>,
        reference_text: Option<String>,
        revision: Option<String>,
    ) -> Self {
        Self {
            version: TTS_REFERENCE_PROFILE_VERSION,
            id,
            voice_id,
            sample_rate_hz,
            samples,
            reference_text,
            revision,
        }
    }

    fn to_native(&self) -> Result<NativeTtsReferenceAudio, NativeVoiceCommandError> {
        NativeTtsReferenceAudio::new(self.sample_rate_hz, self.samples.clone())
            .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))
    }
}

#[cfg(desktop)]
impl std::fmt::Debug for DesktopTtsReferenceProfile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DesktopTtsReferenceProfile")
            .field("version", &self.version)
            .field("id", &self.id)
            .field("voice_id", &self.voice_id)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("sample_count", &self.samples.len())
            .field("samples", &"<redacted>")
            .field(
                "reference_text_bytes",
                &self.reference_text.as_ref().map(String::len),
            )
            .field("revision", &self.revision)
            .finish()
    }
}

#[cfg(desktop)]
fn desktop_tts_reference_profile_dir_at(root: &Path) -> PathBuf {
    root.join("speech-packs").join("reference-profiles")
}

#[cfg(desktop)]
fn desktop_tts_reference_profile_path_at(root: &Path, profile_id: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(profile_id.as_bytes());
    let digest = hasher.finalize();
    let mut file_name = String::with_capacity(69);
    for byte in digest {
        file_name.push_str(&format!("{byte:02x}"));
    }
    file_name.push_str(".json");
    desktop_tts_reference_profile_dir_at(root).join(file_name)
}

#[cfg(desktop)]
fn optional_desktop_tts_reference_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(desktop)]
fn validate_desktop_tts_reference_profile(
    profile: &DesktopTtsReferenceProfile,
    expected_id: &str,
    expected_voice_id: &str,
) -> Result<(), NativeVoiceCommandError> {
    if profile.version != TTS_REFERENCE_PROFILE_VERSION
        || profile.id != expected_id
        || !valid_reference_profile_id(&profile.id)
        || profile
            .voice_id
            .as_deref()
            .is_some_and(|voice_id| voice_id != expected_voice_id)
    {
        return Err(NativeVoiceCommandError::unavailable(
            "local_speech_unavailable",
        ));
    }
    if let Some(reference_text) = &profile.reference_text {
        if !reference_text.trim().is_empty()
            && (reference_text.len() > TTS_REFERENCE_PROFILE_MAX_TEXT_BYTES
                || reference_text.as_bytes().contains(&0))
        {
            return Err(NativeVoiceCommandError::unavailable(
                "local_speech_unavailable",
            ));
        }
    }
    if profile
        .revision
        .as_deref()
        .is_some_and(|revision| !valid_reference_profile_id(revision))
    {
        return Err(NativeVoiceCommandError::unavailable(
            "local_speech_unavailable",
        ));
    }
    let _ = profile.to_native()?;
    Ok(())
}

#[cfg(desktop)]
fn load_desktop_tts_reference_profile_at(
    root: &Path,
    profile_id: &str,
    expected_voice_id: &str,
) -> Result<DesktopTtsReferenceProfile, NativeVoiceCommandError> {
    if !valid_reference_profile_id(profile_id) {
        return Err(NativeVoiceCommandError::unavailable(
            "local_speech_unavailable",
        ));
    }
    let path = desktop_tts_reference_profile_path_at(root, profile_id);
    let metadata = fs::metadata(&path)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    if !metadata.is_file() || metadata.len() > TTS_REFERENCE_PROFILE_MAX_JSON_BYTES {
        return Err(NativeVoiceCommandError::unavailable(
            "local_speech_unavailable",
        ));
    }
    let payload = fs::read_to_string(&path)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    let profile: DesktopTtsReferenceProfile = serde_json::from_str(&payload)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    validate_desktop_tts_reference_profile(&profile, profile_id, expected_voice_id)?;
    Ok(profile)
}

#[cfg(desktop)]
fn load_desktop_tts_reference_profile(
    app: &AppHandle,
    profile_id: &str,
    expected_voice_id: &str,
) -> Result<DesktopTtsReferenceProfile, NativeVoiceCommandError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    load_desktop_tts_reference_profile_at(&root, profile_id, expected_voice_id)
}

#[cfg(desktop)]
#[allow(dead_code)]
pub(super) fn store_desktop_tts_reference_profile(
    app: &AppHandle,
    profile_id: String,
    voice_id: String,
    sample_rate_hz: i32,
    samples: Vec<f32>,
    reference_text: Option<String>,
    revision: Option<String>,
) -> Result<(), NativeVoiceCommandError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    let profile = DesktopTtsReferenceProfile::new(
        profile_id,
        Some(voice_id.clone()),
        sample_rate_hz,
        samples,
        reference_text,
        revision,
    );
    store_desktop_tts_reference_profile_at(&root, &profile, &voice_id)
}

#[cfg(desktop)]
fn store_desktop_tts_reference_profile_at(
    root: &Path,
    profile: &DesktopTtsReferenceProfile,
    expected_voice_id: &str,
) -> Result<(), NativeVoiceCommandError> {
    validate_desktop_tts_reference_profile(profile, &profile.id, expected_voice_id)?;
    let dir = desktop_tts_reference_profile_dir_at(root);
    fs::create_dir_all(&dir)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    let path = desktop_tts_reference_profile_path_at(root, &profile.id);
    let temp = path.with_extension("json.tmp");
    let payload = serde_json::to_vec(profile)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    if payload.len() as u64 > TTS_REFERENCE_PROFILE_MAX_JSON_BYTES {
        return Err(NativeVoiceCommandError::unavailable(
            "local_speech_unavailable",
        ));
    }
    {
        let mut file = fs::File::create(&temp)
            .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::Permissions::from_mode(0o600);
            file.set_permissions(permissions)
                .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
        }
        file.write_all(&payload)
            .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
        file.sync_all()
            .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    }
    fs::rename(temp, path)
        .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
    Ok(())
}

#[cfg(desktop)]
fn build_handoff(
    profile: &RuntimeProfile,
    start_reason: CaptureStartReason,
) -> Result<NativeGatewayCaptureHandoff, NativeVoiceCommandError> {
    let token = random_prepare_lease_token()
        .map_err(|_| NativeVoiceCommandError::unavailable("handoff_unavailable"))?;
    let config = NativeGatewayCaptureHandoffConfig::new(OWNER_ID, token, SURFACE, DEVICE_ROUTE)
        .map_err(|_| NativeVoiceCommandError::unavailable("handoff_unavailable"))?
        .with_start_reason(start_reason)
        .with_route_revision(RouteRevision(ROUTE_REVISION))
        .with_background_eligible(profile.background_voice_eligible())
        .with_consent_revision(1);
    NativeGatewayCaptureHandoff::new(transport_for_handoff(profile)?, config)
        .map_err(|_| NativeVoiceCommandError::unavailable("handoff_unavailable"))
}

#[cfg(desktop)]
async fn release_handoff_slot(
    handoff_slot: &HandoffSlot,
    shutdown_requested: &Cell<bool>,
) -> Option<&'static str> {
    let handoff = handoff_slot.borrow_mut().take();
    let (mut adapter, grant) = handoff?;
    let restart_capture = !shutdown_requested.get();
    let release_failed = timeout(
        HANDOFF_OPERATION_TIMEOUT,
        adapter.release(&grant, restart_capture, &|| false),
    )
    .await
    .map_or(true, |release| release.is_err());
    let restart_capture = !shutdown_requested.get();
    let cleanup_failed = timeout(HANDOFF_OPERATION_TIMEOUT, adapter.cleanup(restart_capture))
        .await
        .map_or(true, |cleanup| cleanup.is_err());
    if release_failed || cleanup_failed {
        Some("handoff_cleanup_failed")
    } else {
        None
    }
}

#[cfg(desktop)]
async fn recover_ambiguous_prepare(
    adapter: &mut NativeGatewayCaptureHandoff,
) -> Result<(), VoiceCoreError> {
    timeout(
        HANDOFF_RECOVERY_TIMEOUT,
        adapter.recover_ambiguous_prepare(&|| false),
    )
    .await
    .map_err(|_| VoiceCoreError::TransportFault {
        code: "capture_recovery_timeout".to_owned(),
    })?
}

#[cfg(desktop)]
fn prepare_error_needs_ambiguous_recovery(error: &VoiceCoreError) -> bool {
    matches!(
        error,
        VoiceCoreError::Cancelled | VoiceCoreError::TransportFault { .. }
    )
}

#[cfg(desktop)]
fn transport_for_profile(
    profile: &RuntimeProfile,
) -> Result<NativeGatewayTransport, NativeVoiceCommandError> {
    transport_for_profile_with_timeout(profile, Duration::from_secs(30))
}

#[cfg(desktop)]
fn transport_for_handoff(
    profile: &RuntimeProfile,
) -> Result<NativeGatewayTransport, NativeVoiceCommandError> {
    transport_for_profile_with_timeout(profile, HANDOFF_REQUEST_TIMEOUT)
}

#[cfg(desktop)]
fn transport_for_profile_with_timeout(
    profile: &RuntimeProfile,
    request_timeout: Duration,
) -> Result<NativeGatewayTransport, NativeVoiceCommandError> {
    let (gateway, auth, policy, allow_loopback_http) = match profile {
        RuntimeProfile::Local { gateway, .. } => (
            gateway.clone(),
            GatewayAuth::None,
            MicrophoneAudioPolicy::LoopbackOnly,
            true,
        ),
        RuntimeProfile::Remote {
            gateway, bearer, ..
        } => (
            gateway.clone(),
            GatewayAuth::Bearer(bearer.clone()),
            MicrophoneAudioPolicy::ExplicitRemoteConsent,
            false,
        ),
    };
    NativeGatewayTransport::new(
        gateway,
        auth,
        TransportLimits {
            max_request_bytes: 2 * 1024 * 1024,
            max_response_bytes: 8 * 1024 * 1024,
            max_event_bytes: 2 * 1024 * 1024,
            request_timeout,
            stream_idle_timeout: Duration::from_secs(45),
            allow_loopback_http,
            microphone_audio_policy: policy,
        },
    )
    .map_err(|_| NativeVoiceCommandError::unavailable("gateway_unavailable"))
}

#[cfg(desktop)]
struct StatusOnlySink {
    tx: mpsc::UnboundedSender<ActorCommand>,
    ui_generation: Rc<Cell<Option<u64>>>,
}

#[cfg(desktop)]
#[async_trait(?Send)]
impl RuntimeEventSink for StatusOnlySink {
    fn wants_speech_lifecycle(&self) -> bool {
        native_speech_lifecycle_observer_enabled()
    }

    fn speech_lifecycle_callback(
        &self,
    ) -> Option<std::sync::Arc<dyn Fn(SpeechLifecycleEventV1) + Send + Sync>> {
        if !native_speech_lifecycle_observer_enabled() {
            return None;
        }
        let callback: std::sync::Arc<dyn Fn(SpeechLifecycleEventV1) + Send + Sync> =
            std::sync::Arc::new(emit_native_speech_lifecycle);
        Some(callback)
    }

    fn speech_lifecycle(&mut self, event: SpeechLifecycleEventV1) {
        emit_native_speech_lifecycle(event);
    }

    async fn snapshot(&mut self, _snapshot: RedactedSnapshot) -> Result<(), VoiceCoreError> {
        Ok(())
    }

    async fn event(&mut self, event: RuntimeEvent) -> Result<(), VoiceCoreError> {
        let Some(ui_generation) = self.ui_generation.get() else {
            return Ok(());
        };
        if let RuntimeEvent::State { transition } = event {
            let phase = phase_from_state(transition.to);
            let _ = self.tx.send(ActorCommand::RuntimePhase {
                ui_generation,
                phase,
                reason_code: None,
            });
        }
        Ok(())
    }
}

#[cfg(desktop)]
fn phase_from_state(state: VoiceState) -> NativeVoicePhase {
    match state {
        VoiceState::Arming => NativeVoicePhase::Starting,
        VoiceState::ListeningForWake
        | VoiceState::WakeDetected
        | VoiceState::CapturingUtterance => NativeVoicePhase::Listening,
        VoiceState::Transcribing | VoiceState::Dispatching | VoiceState::AwaitingResponse => {
            NativeVoicePhase::Processing
        }
        VoiceState::Speaking => NativeVoicePhase::Speaking,
        VoiceState::Stopping => NativeVoicePhase::Stopping,
        VoiceState::Faulted => NativeVoicePhase::Faulted,
        VoiceState::Idle | VoiceState::Disabled => NativeVoicePhase::Idle,
        VoiceState::Provisioning
        | VoiceState::Unavailable
        | VoiceState::Interrupted
        | VoiceState::Suspended
        | VoiceState::Recovering => NativeVoicePhase::Faulted,
    }
}

#[cfg(desktop)]
fn sidecar_running(sidecar: &super::SharedSidecarState) -> bool {
    sidecar
        .lock()
        .map(|mut sidecar| sidecar.is_running())
        .unwrap_or(false)
}

#[cfg(desktop)]
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ThinProfileDocument {
    V1(ThinProfileDocumentV1),
    V2(RuntimeProfileDocumentV2),
}

#[cfg(desktop)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThinProfileDocumentV1 {
    version: u8,
    active_profile_id: Option<String>,
    profiles: Vec<ThinConnectionProfileV1>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThinConnectionProfileV1 {
    id: String,
    #[serde(rename = "label")]
    _label: String,
    mode: String,
    gateway_url: String,
    #[serde(rename = "signalingUrl")]
    _signaling_url: String,
    #[serde(rename = "nodeName")]
    _node_name: String,
    #[serde(rename = "localStablePeerId")]
    _local_stable_peer_id: String,
    #[serde(default)]
    webrtc_profile: Option<WebRtcProfile>,
}

#[cfg(desktop)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeProfileDocumentV2 {
    version: u8,
    active_profile_id: Option<String>,
    profiles: Vec<RuntimeProfileV2>,
}

#[cfg(desktop)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeProfileV2 {
    version: u8,
    id: String,
    #[serde(rename = "label")]
    _label: String,
    node_mode: String,
    #[serde(rename = "runtimeTier")]
    runtime_tier: String,
    #[serde(default)]
    home_connection: Option<HomeConnectionProfile>,
    local_node: LocalNodeProfile,
}

#[cfg(desktop)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HomeConnectionProfile {
    mode: String,
    #[serde(default)]
    gateway_url: Option<String>,
    #[serde(default)]
    #[serde(rename = "signalingUrl")]
    _signaling_url: Option<String>,
    #[serde(default)]
    home_peer_id: Option<String>,
    #[serde(default)]
    webrtc_profile: Option<WebRtcProfile>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalSpeechSelection {
    #[serde(default)]
    vad: Option<LocalSpeechAssetSelection>,
    #[serde(default)]
    kws: Option<LocalSpeechAssetSelection>,
    #[serde(default)]
    stt: Option<LocalSpeechAssetSelection>,
    #[serde(default)]
    tts: Option<LocalSpeechAssetSelection>,
    #[serde(default)]
    wake_phrase: Option<LocalWakePhraseSelection>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct MeshSpeechStageRuntime {
    peer_id: String,
    resource_id: String,
    model_id: Option<String>,
    language: Option<String>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct SpeechStageRuntimeSelection {
    gateway_stt_model_id: Option<String>,
    mesh_stt: Option<MeshSpeechStageRuntime>,
    mesh_tts: Option<MeshSpeechStageRuntime>,
}

#[cfg(desktop)]
impl SpeechStageRuntimeSelection {
    fn append_cache_identity(&self, identity: &mut String) {
        for (stage, route) in [("stt", &self.mesh_stt), ("tts", &self.mesh_tts)] {
            if let Some(route) = route {
                identity.push_str("|mesh-");
                identity.push_str(stage);
                identity.push('=');
                identity.push_str(&route.peer_id);
                identity.push('/');
                identity.push_str(&route.resource_id);
                identity.push('/');
                identity.push_str(route.model_id.as_deref().unwrap_or(""));
                identity.push('/');
                identity.push_str(route.language.as_deref().unwrap_or(""));
            }
        }
        if let Some(model) = &self.gateway_stt_model_id {
            identity.push_str("|gateway-stt-model=");
            identity.push_str(model);
        }
    }
}

#[cfg(desktop)]
impl LocalSpeechSelection {
    fn cache_identity(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned())
    }
}

#[cfg(desktop)]
fn apply_speech_stages(
    selection: &mut LocalSpeechSelection,
    stages: &SpeechStages,
) -> Result<SpeechStageRuntimeSelection, &'static str> {
    let mut selected = SpeechStageRuntimeSelection::default();
    match select_speech_backend(&stages.stt, selection.stt.is_some())? {
        SpeechStageBackend::Local => validate_local_stage(&stages.stt)?,
        SpeechStageBackend::Gateway => {
            validate_gateway_stage(&stages.stt)?;
            selection.stt = None;
            selected.gateway_stt_model_id = match &stages.stt.model_id {
                NullableField::Value(model) => Some(model.clone()),
                NullableField::Missing | NullableField::Null => None,
            };
        }
        SpeechStageBackend::Mesh => {
            selected.mesh_stt = Some(mesh_stage_runtime(&stages.stt)?);
            selection.stt = None;
        }
    }

    match select_speech_backend(&stages.tts, selection.tts.is_some())? {
        SpeechStageBackend::Local => validate_local_stage(&stages.tts)?,
        SpeechStageBackend::Gateway => {
            validate_gateway_stage(&stages.tts)?;
            // The existing Gateway TTS port has no model-selection field.
            if matches!(&stages.tts.model_id, NullableField::Value(_)) {
                return Err("speech_stage_unavailable");
            }
            selection.tts = None;
        }
        SpeechStageBackend::Mesh => {
            selected.mesh_tts = Some(mesh_stage_runtime(&stages.tts)?);
            selection.tts = None;
        }
    }

    for (stage, configured) in [
        (&stages.kws, selection.kws.is_some()),
        (&stages.vad, selection.vad.is_some()),
    ] {
        let local = stage_uses_local(stage, configured, false, true)?;
        if local {
            validate_local_stage(stage)?;
        }
        if !local && configured {
            return Err("speech_stage_unavailable");
        }
    }
    Ok(selected)
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpeechStageBackend {
    Local,
    Gateway,
    Mesh,
}

#[cfg(desktop)]
fn select_speech_backend(
    stage: &SpeechStageConfig,
    local_available: bool,
) -> Result<SpeechStageBackend, &'static str> {
    match stage.routing.prefer {
        RoutingPreference::LocalOnly => local_available
            .then_some(SpeechStageBackend::Local)
            .ok_or("speech_stage_unavailable"),
        RoutingPreference::Local if local_available => Ok(SpeechStageBackend::Local),
        RoutingPreference::Local if stage.routing.fallback == RoutingFallback::Network => {
            selected_network_backend(stage)
        }
        RoutingPreference::Local => Err("speech_stage_unavailable"),
        RoutingPreference::NetworkOnly | RoutingPreference::Network => {
            selected_network_backend(stage)
        }
    }
}

#[cfg(desktop)]
fn selected_network_backend(stage: &SpeechStageConfig) -> Result<SpeechStageBackend, &'static str> {
    match stage.network_kind {
        Omitted::Value(SpeechNetworkKind::Mesh) => Ok(SpeechStageBackend::Mesh),
        Omitted::Missing | Omitted::Value(SpeechNetworkKind::Gateway) => {
            Ok(SpeechStageBackend::Gateway)
        }
    }
}

#[cfg(desktop)]
fn mesh_stage_runtime(stage: &SpeechStageConfig) -> Result<MeshSpeechStageRuntime, &'static str> {
    let target = match &stage.target {
        NullableField::Value(target) => target,
        NullableField::Missing | NullableField::Null => return Err("speech_stage_unavailable"),
    };
    let resource_id = match &target.resource_id {
        NullableField::Value(resource_id) if !resource_id.trim().is_empty() => resource_id.clone(),
        NullableField::Missing | NullableField::Null | NullableField::Value(_) => {
            return Err("speech_stage_unavailable")
        }
    };
    let target_model = match &target.model_id {
        NullableField::Value(model) => Some(model.clone()),
        NullableField::Missing | NullableField::Null => None,
    };
    let stage_model = match &stage.model_id {
        NullableField::Value(model) => Some(model.clone()),
        NullableField::Missing | NullableField::Null => None,
    };
    if target_model.is_some() && stage_model.is_some() && target_model != stage_model {
        return Err("speech_stage_unavailable");
    }
    let language = match &stage.language {
        NullableField::Value(language) => Some(language.clone()),
        NullableField::Missing | NullableField::Null => None,
    };
    Ok(MeshSpeechStageRuntime {
        peer_id: target.peer_id.clone(),
        resource_id,
        model_id: stage_model.or(target_model),
        language,
    })
}

#[cfg(desktop)]
fn stage_uses_local(
    stage: &SpeechStageConfig,
    local_available: bool,
    gateway_supported: bool,
    optional_local_absence: bool,
) -> Result<bool, &'static str> {
    match stage.routing.prefer {
        RoutingPreference::LocalOnly => {
            if local_available {
                Ok(true)
            } else if optional_local_absence {
                Ok(false)
            } else {
                Err("speech_stage_unavailable")
            }
        }
        RoutingPreference::Local => {
            if local_available {
                Ok(true)
            } else if stage.routing.fallback == RoutingFallback::Network && gateway_supported {
                Ok(false)
            } else {
                Err("speech_stage_unavailable")
            }
        }
        RoutingPreference::NetworkOnly => {
            if gateway_supported {
                Ok(false)
            } else {
                Err("speech_stage_unavailable")
            }
        }
        RoutingPreference::Network => {
            if gateway_supported {
                Ok(false)
            } else if stage.routing.fallback == RoutingFallback::Local && local_available {
                Ok(true)
            } else {
                Err("speech_stage_unavailable")
            }
        }
    }
}

#[cfg(desktop)]
fn validate_gateway_stage(stage: &SpeechStageConfig) -> Result<(), &'static str> {
    if matches!(&stage.network_kind, Omitted::Value(SpeechNetworkKind::Mesh))
        || matches!(&stage.target, NullableField::Value(_))
        || matches!(&stage.language, NullableField::Value(_))
    {
        return Err("speech_stage_unavailable");
    }
    Ok(())
}

#[cfg(desktop)]
fn validate_local_stage(stage: &SpeechStageConfig) -> Result<(), &'static str> {
    if !matches!(&stage.network_kind, Omitted::Missing)
        || matches!(&stage.target, NullableField::Value(_))
        || matches!(&stage.model_id, NullableField::Value(_))
        || matches!(&stage.language, NullableField::Value(_))
    {
        return Err("speech_stage_unavailable");
    }
    Ok(())
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalSpeechAssetSelection {
    pack_id: String,
    pack_revision: String,
    #[serde(default)]
    voice_id: Option<String>,
    #[serde(default)]
    voice_revision: Option<String>,
    #[serde(default)]
    reference_profile_id: Option<String>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalWakePhraseSelection {
    phrase_id: String,
    phrase: String,
    language: String,
    revision: String,
}

#[cfg(desktop)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalNodeProfile {
    #[serde(rename = "nodeName")]
    _node_name: String,
    #[serde(rename = "stablePeerId")]
    _stable_peer_id: String,
    #[serde(rename = "enabledCapabilityPacks")]
    _enabled_capability_packs: Vec<String>,
    #[serde(default)]
    #[serde(rename = "localSpeechPackState")]
    _local_speech_pack_state: Option<Value>,
    #[serde(default)]
    local_speech_selection: Option<LocalSpeechSelection>,
    #[serde(default)]
    #[serde(rename = "meshMembership")]
    _mesh_membership: Option<Value>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebRtcProfile {
    #[serde(rename = "mode")]
    _mode: String,
    #[serde(rename = "appId")]
    _app_id: String,
    #[serde(rename = "room")]
    _room: String,
    #[serde(rename = "roomSecretRef")]
    _room_secret_ref: String,
    #[serde(rename = "signalingBrokers")]
    _signaling_brokers: Vec<String>,
    #[serde(default)]
    expected_stable_peer_id: Option<String>,
    #[serde(default, rename = "expectedSignalingPeerId")]
    _expected_signaling_peer_id: Option<String>,
    #[serde(default, rename = "nodeName")]
    _node_name: Option<String>,
    #[serde(default, rename = "production")]
    _production: Option<bool>,
    #[serde(default, rename = "allowInsecureLoopbackSignaling")]
    _allow_insecure_loopback_signaling: Option<bool>,
    #[serde(default, rename = "requireAppLayerE2ee")]
    _require_app_layer_e2ee: Option<bool>,
    #[serde(default, rename = "stunServers")]
    _stun_servers: Option<Vec<Value>>,
    #[serde(default, rename = "turnServers")]
    _turn_servers: Option<Vec<Value>>,
}

#[cfg(desktop)]
fn load_thin_profile_document() -> Option<ThinProfileDocument> {
    let entry = super::thin_profile_storage_entry().ok()?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(_) => return None,
    };
    serde_json::from_str(&value).ok()
}

#[cfg(desktop)]
fn resolve_remote_profile(
    document: &ThinProfileDocument,
    remote_audio_consent: bool,
    credential_loader: impl Fn(&str) -> Option<ThinBearerCredential>,
    now_ms: impl Fn() -> u64,
) -> Result<RuntimeProfile, &'static str> {
    let Some(candidate) = remote_profile_candidate(document)? else {
        return Err(PROFILE_REASON);
    };
    let local_speech = local_speech_selection(document)?;
    let credential = credential_loader(&candidate.peer_id).ok_or(CREDENTIAL_REASON)?;
    if credential
        .expires_at_ms
        .is_some_and(|expires_at_ms| expires_at_ms <= now_ms())
    {
        return Err(CREDENTIAL_REASON);
    }
    if credential.raw_bearer_token.trim().is_empty() {
        return Err(CREDENTIAL_REASON);
    }
    Ok(RuntimeProfile::Remote {
        gateway: candidate.gateway,
        bearer: credential.raw_bearer_token,
        remote_audio_consent,
        local_speech,
    })
}

#[cfg(desktop)]
fn resolve_profile_from_document(
    document: &ThinProfileDocument,
    remote_audio_consent: bool,
    sidecar_available: bool,
    credential_loader: impl Fn(&str) -> Option<ThinBearerCredential>,
    now_ms: impl Fn() -> u64,
) -> Result<RuntimeProfile, &'static str> {
    let Some(role) = persisted_runtime_role(document)? else {
        return Err(PROFILE_REASON);
    };
    match role {
        PersistedRuntimeRole::RemoteConsole => {
            resolve_remote_profile(document, remote_audio_consent, credential_loader, now_ms)
        }
        PersistedRuntimeRole::PythonFullMeshNode if sidecar_available => {
            RuntimeProfile::local_with_speech(local_speech_selection(document)?)
        }
        PersistedRuntimeRole::PythonFullMeshNode | PersistedRuntimeRole::NonLocalMeshNode => {
            Err(PROFILE_REASON)
        }
    }
}

#[cfg(desktop)]
fn resolve_start_profile_from_document(
    document: &ThinProfileDocument,
    remote_audio_consent: bool,
    sidecar_available: bool,
    credential_loader: impl Fn(&str) -> Option<ThinBearerCredential>,
    now_ms: impl Fn() -> u64,
) -> Result<RuntimeProfile, NativeVoiceCommandError> {
    let role = persisted_runtime_role(document)
        .map_err(NativeVoiceCommandError::unavailable)?
        .ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?;
    if role == PersistedRuntimeRole::RemoteConsole
        && !remote_audio_consent
        && local_speech_selection(document)
            .map_err(NativeVoiceCommandError::unavailable)?
            .stt
            .is_none()
    {
        return Err(NativeVoiceCommandError::invalid(REMOTE_CONSENT_REASON));
    }
    resolve_profile_from_document(
        document,
        remote_audio_consent,
        sidecar_available,
        credential_loader,
        now_ms,
    )
    .map_err(NativeVoiceCommandError::unavailable)
}

#[cfg(desktop)]
fn local_speech_selection(
    document: &ThinProfileDocument,
) -> Result<LocalSpeechSelection, &'static str> {
    let selection = match document {
        ThinProfileDocument::V1(_) => LocalSpeechSelection::default(),
        ThinProfileDocument::V2(document) => {
            if document.version != 2 {
                return Err(PROFILE_REASON);
            }
            let active_id = document
                .active_profile_id
                .as_deref()
                .ok_or(PROFILE_REASON)?;
            let profile = document
                .profiles
                .iter()
                .find(|profile| profile.id == active_id)
                .ok_or(PROFILE_REASON)?;
            profile
                .local_node
                .local_speech_selection
                .clone()
                .unwrap_or_default()
        }
    };
    validate_local_speech_selection(&selection)?;
    Ok(selection)
}

#[cfg(desktop)]
fn validate_local_speech_selection(selection: &LocalSpeechSelection) -> Result<(), &'static str> {
    let speech_catalog = SpeechModelCatalog::embedded().map_err(|_| PROFILE_REASON)?;
    for (selected, expected_task) in [
        (
            selection.vad.as_ref(),
            SpeechCatalogTask::VoiceActivityDetection,
        ),
        (selection.kws.as_ref(), SpeechCatalogTask::KeywordSpotting),
        (selection.stt.as_ref(), SpeechCatalogTask::SpeechToText),
    ] {
        let Some(selected) = selected else {
            continue;
        };
        if selected.pack_revision != speech_catalog.revision()
            || selected.voice_id.is_some()
            || selected.voice_revision.is_some()
            || selected.reference_profile_id.is_some()
            || speech_catalog
                .model(&selected.pack_id)
                .is_none_or(|entry| entry.task != expected_task)
        {
            return Err(PROFILE_REASON);
        }
    }
    match (&selection.kws, &selection.wake_phrase) {
        (None, Some(_)) => return Err(PROFILE_REASON),
        (Some(kws), Some(phrase)) => {
            let entry = speech_catalog.model(&kws.pack_id).ok_or(PROFILE_REASON)?;
            if !entry
                .languages
                .iter()
                .any(|language| language == &phrase.language)
                || !valid_wake_phrase_selection(phrase)
            {
                return Err(PROFILE_REASON);
            }
        }
        (None, None) | (Some(_), None) => {}
    }
    if let Some(selected) = &selection.tts {
        let catalog = TtsVoiceCatalog::runtime().map_err(|_| PROFILE_REASON)?;
        let voice_id = selected.voice_id.as_deref().ok_or(PROFILE_REASON)?;
        let voice = catalog.voice(voice_id).ok_or(PROFILE_REASON)?;
        if selected.pack_revision != catalog.revision()
            || selected.voice_revision.as_deref() != Some(catalog.revision())
            || voice.language != selected.pack_id
        {
            return Err(PROFILE_REASON);
        }
        if voice.requires_reference_profile() {
            match selected.reference_profile_id.as_deref() {
                Some(reference_profile_id) if valid_reference_profile_id(reference_profile_id) => {}
                _ => return Err(PROFILE_REASON),
            }
        } else if selected.reference_profile_id.is_some() && voice.model_family != "pockettts" {
            return Err(PROFILE_REASON);
        }
    }
    Ok(())
}

#[cfg(desktop)]
fn valid_reference_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

#[cfg(desktop)]
fn valid_wake_phrase_selection(selection: &LocalWakePhraseSelection) -> bool {
    fn valid_id(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 128
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':')
            })
    }

    valid_id(&selection.phrase_id)
        && valid_id(&selection.revision)
        && !selection.phrase.trim().is_empty()
        && selection.phrase.len() <= 256
        && !selection.phrase.chars().any(char::is_control)
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PersistedRuntimeRole {
    RemoteConsole,
    PythonFullMeshNode,
    NonLocalMeshNode,
}

#[cfg(desktop)]
fn persisted_runtime_role(
    document: &ThinProfileDocument,
) -> Result<Option<PersistedRuntimeRole>, &'static str> {
    match document {
        ThinProfileDocument::V1(document) => {
            if document.version != 1 {
                return Err(PROFILE_REASON);
            }
            Ok(document
                .active_profile_id
                .as_deref()
                .map(|_| PersistedRuntimeRole::RemoteConsole))
        }
        ThinProfileDocument::V2(document) => {
            if document.version != 2 {
                return Err(PROFILE_REASON);
            }
            let Some(active_id) = document.active_profile_id.as_deref() else {
                return Ok(None);
            };
            let Some(profile) = document
                .profiles
                .iter()
                .find(|profile| profile.id == active_id)
            else {
                return Ok(None);
            };
            if profile.version != 2 {
                return Err(PROFILE_REASON);
            }
            match profile.node_mode.as_str() {
                "remote-console" => Ok(Some(PersistedRuntimeRole::RemoteConsole)),
                "mesh-node" if profile.runtime_tier == "python-full" => {
                    Ok(Some(PersistedRuntimeRole::PythonFullMeshNode))
                }
                "mesh-node" => Ok(Some(PersistedRuntimeRole::NonLocalMeshNode)),
                _ => Err(PROFILE_REASON),
            }
        }
    }
}

#[cfg(desktop)]
struct RemoteProfileCandidate {
    gateway: Url,
    peer_id: String,
}

#[cfg(desktop)]
fn remote_profile_candidate(
    document: &ThinProfileDocument,
) -> Result<Option<RemoteProfileCandidate>, &'static str> {
    match document {
        ThinProfileDocument::V1(document) => {
            if document.version != 1 {
                return Err(PROFILE_REASON);
            }
            let Some(active_id) = document.active_profile_id.as_deref() else {
                return Ok(None);
            };
            let Some(profile) = document
                .profiles
                .iter()
                .find(|profile| profile.id == active_id)
            else {
                return Ok(None);
            };
            gateway_candidate(
                &profile.id,
                &profile.mode,
                Some(&profile.gateway_url),
                profile
                    .webrtc_profile
                    .as_ref()
                    .and_then(|profile| profile.expected_stable_peer_id.as_deref()),
            )
        }
        ThinProfileDocument::V2(document) => {
            if document.version != 2 {
                return Err(PROFILE_REASON);
            }
            let Some(active_id) = document.active_profile_id.as_deref() else {
                return Ok(None);
            };
            let Some(profile) = document
                .profiles
                .iter()
                .find(|profile| profile.id == active_id)
            else {
                return Ok(None);
            };
            if profile.version != 2 {
                return Err(PROFILE_REASON);
            }
            if profile.node_mode != "remote-console" {
                return Ok(None);
            }
            let Some(home) = &profile.home_connection else {
                return Ok(None);
            };
            gateway_candidate(
                &profile.id,
                &home.mode,
                home.gateway_url.as_deref(),
                home.home_peer_id.as_deref().or_else(|| {
                    home.webrtc_profile
                        .as_ref()
                        .and_then(|profile| profile.expected_stable_peer_id.as_deref())
                }),
            )
        }
    }
}

#[cfg(desktop)]
fn gateway_candidate(
    _profile_id: &str,
    mode: &str,
    gateway_url: Option<&str>,
    peer_id: Option<&str>,
) -> Result<Option<RemoteProfileCandidate>, &'static str> {
    if !matches!(mode, "http-only" | "webrtc-preferred") {
        return Ok(None);
    }
    let gateway = Url::parse(gateway_url.unwrap_or("")).map_err(|_| PROFILE_REASON)?;
    let Some(peer_id) = peer_id else {
        return Err(CREDENTIAL_REASON);
    };
    if gateway.scheme() != "https" || gateway.host_str().is_none() || peer_id.trim().is_empty() {
        return Err(PROFILE_REASON);
    }
    Ok(Some(RemoteProfileCandidate {
        gateway,
        peer_id: peer_id.to_owned(),
    }))
}

#[cfg(desktop)]
struct ThinBearerCredential {
    raw_bearer_token: String,
    expires_at_ms: Option<u64>,
}

#[cfg(desktop)]
fn load_peer_bearer(peer_id: &str) -> Option<ThinBearerCredential> {
    let record = super::load_unexpired_thin_peer_credential_record(peer_id)
        .ok()
        .flatten()?;
    Some(ThinBearerCredential {
        raw_bearer_token: record.raw_bearer_token,
        expires_at_ms: record.expires_at_ms,
    })
}

#[cfg(desktop)]
fn random_prepare_lease_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)?;
    let mut token = String::with_capacity(64);
    for byte in bytes {
        token.push_str(&format!("{byte:02x}"));
    }
    Ok(token)
}

#[cfg(desktop)]
fn now_micros() -> TimestampMicros {
    TimestampMicros(super::current_unix_ms().saturating_mul(1000))
}

#[cfg(desktop)]
fn stop_reason_code(reason: NativeVoiceStopReason) -> &'static str {
    match reason {
        NativeVoiceStopReason::UserRequest => "user_request",
        NativeVoiceStopReason::WindowHidden => "window_hidden",
        NativeVoiceStopReason::PermissionRevoked => "permission_revoked",
        NativeVoiceStopReason::Shutdown => "shutdown",
    }
}

#[cfg(desktop)]
fn map_core_error(error: VoiceCoreError) -> NativeVoiceCommandError {
    NativeVoiceCommandError::unavailable(reason_from_core_error(&error))
}

#[cfg(desktop)]
fn reason_from_core_error(error: &VoiceCoreError) -> &'static str {
    match error {
        VoiceCoreError::OwnerAlreadyActive => ACTIVE_REASON,
        VoiceCoreError::StaleGeneration | VoiceCoreError::OwnerMismatch => STALE_CONTROL_REASON,
        VoiceCoreError::Cancelled => "cancelled",
        VoiceCoreError::GenerationExhausted => "generation_exhausted",
        VoiceCoreError::WakeUnavailable => "wake_unavailable",
        VoiceCoreError::WakeNotDetected => "wake_not_detected",
        VoiceCoreError::SpeechNotDetected => "speech_not_detected",
        VoiceCoreError::SpeechTimeout => "speech_timeout",
        VoiceCoreError::TransportFault { .. } => "gateway_unavailable",
        VoiceCoreError::Engine(_) => "engine_unavailable",
        VoiceCoreError::InvalidIdentifier | VoiceCoreError::InvalidTransition => "invalid_state",
        VoiceCoreError::NoOwnerActive => "no_active_capture",
        VoiceCoreError::EmptyFrame
        | VoiceCoreError::SampleCountMismatch
        | VoiceCoreError::SampleOutOfRange
        | VoiceCoreError::SampleNotFinite => "invalid_audio",
        VoiceCoreError::BufferClosed
        | VoiceCoreError::Backpressure
        | VoiceCoreError::LockPoisoned => "runtime_unavailable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(desktop)]
    async fn blocking_release_handoff() -> (
        HandoffSlot,
        oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
        std::sync::mpsc::Receiver<bool>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};

        fn read_request(stream: &mut TcpStream) -> Vec<u8> {
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0_u8; 1];
                stream.read_exact(&mut byte).expect("request header");
                header.push(byte[0]);
            }
            let headers = String::from_utf8(header).expect("HTTP header");
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let mut body = vec![0; content_length];
            stream.read_exact(&mut body).expect("request body");
            body
        }

        fn respond(stream: &mut TcpStream, body: &str) {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("HTTP response");
        }

        let listener = TcpListener::bind("127.0.0.1:0").expect("local fixture listener");
        let address = listener.local_addr().expect("fixture address");
        let (release_started_tx, release_started_rx) = oneshot::channel();
        let (release_continue_tx, release_continue_rx) = std::sync::mpsc::channel();
        let (release_restart_tx, release_restart_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut prepare, _) = listener.accept().expect("prepare connection");
            let _ = read_request(&mut prepare);
            respond(
                &mut prepare,
                r#"{"generation":1,"granted":true,"lease_id":"host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","message":"granted","owner":"native","python_capture_active":false,"redacted":true,"status":"granted","stopped_python_capture":true}"#,
            );

            let (mut release, _) = listener.accept().expect("release connection");
            let release_body = read_request(&mut release);
            let _ = release_restart_tx.send(
                String::from_utf8_lossy(&release_body).contains("\"restart_python_capture\":true"),
            );
            let _ = release_started_tx.send(());
            let _ = release_continue_rx.recv();
            respond(
                &mut release,
                r#"{"generation":1,"message":"invalid release acknowledgement","owner":"none","python_capture_active":false,"redacted":true,"released":true,"restarted_python_capture":true,"status":"released"}"#,
            );
            let (mut cleanup, _) = listener.accept().expect("cleanup connection");
            let cleanup_body = read_request(&mut cleanup);
            let _ = release_restart_tx.send(
                String::from_utf8_lossy(&cleanup_body).contains("\"restart_python_capture\":true"),
            );
            respond(
                &mut cleanup,
                r#"{"generation":2,"message":"released","owner":"none","python_capture_active":false,"redacted":true,"released":true,"restarted_python_capture":false,"status":"released"}"#,
            );
        });

        let transport = NativeGatewayTransport::new(
            Url::parse(&format!("http://{address}/")).expect("loopback URL"),
            GatewayAuth::None,
            TransportLimits {
                allow_loopback_http: true,
                microphone_audio_policy: MicrophoneAudioPolicy::LoopbackOnly,
                ..TransportLimits::default()
            },
        )
        .expect("loopback transport");
        let config = NativeGatewayCaptureHandoffConfig::new(
            "tauri-native-voice",
            "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "desktop",
            "default",
        )
        .expect("handoff config");
        let mut adapter =
            NativeGatewayCaptureHandoff::new(transport, config).expect("loopback handoff");
        let grant = adapter.prepare(&|| false).await.expect("prepare lease");
        (
            Rc::new(RefCell::new(Some((adapter, grant)))),
            release_started_rx,
            release_continue_tx,
            release_restart_rx,
            server,
        )
    }

    #[cfg(desktop)]
    #[test]
    fn mesh_speech_stage_keeps_exact_peer_resource_and_rejects_mismatch() {
        let stage: SpeechStageConfig = serde_json::from_value(json!({
            "routing": { "prefer": "network_only", "fallback": "error" },
            "networkKind": "mesh",
            "target": {
                "peerId": "peer-123",
                "resourceId": "remote:local-456:Transcription",
                "modelId": "model-789"
            },
            "modelId": "model-789",
            "language": "en-us"
        }))
        .expect("valid mesh stage");
        assert_eq!(
            select_speech_backend(&stage, false),
            Ok(SpeechStageBackend::Mesh)
        );
        assert_eq!(
            mesh_stage_runtime(&stage),
            Ok(MeshSpeechStageRuntime {
                peer_id: "peer-123".to_owned(),
                resource_id: "remote:local-456:Transcription".to_owned(),
                model_id: Some("model-789".to_owned()),
                language: Some("en-us".to_owned()),
            })
        );

        let mismatch: SpeechStageConfig = serde_json::from_value(json!({
            "routing": { "prefer": "network_only", "fallback": "error" },
            "networkKind": "mesh",
            "target": {
                "peerId": "peer-123",
                "resourceId": "remote:local-456:Transcription",
                "modelId": "bound-model"
            },
            "modelId": "other-model"
        }))
        .expect("well-shaped conflicting stage");
        assert_eq!(
            mesh_stage_runtime(&mismatch),
            Err("speech_stage_unavailable")
        );

        let missing_resource: SpeechStageConfig = serde_json::from_value(json!({
            "routing": { "prefer": "network_only", "fallback": "error" },
            "networkKind": "mesh",
            "target": { "peerId": "peer-123" }
        }))
        .expect("well-shaped stage without selected resource");
        assert_eq!(
            mesh_stage_runtime(&missing_resource),
            Err("speech_stage_unavailable")
        );
    }

    #[cfg(desktop)]
    fn unique_test_dir(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("aurora-{name}-{}-{suffix}", std::process::id()))
    }

    #[cfg(desktop)]
    #[test]
    fn wake_failures_map_to_stable_redacted_reason_codes() {
        assert_eq!(
            reason_from_core_error(&VoiceCoreError::WakeUnavailable),
            "wake_unavailable"
        );
        assert_eq!(
            reason_from_core_error(&VoiceCoreError::WakeNotDetected),
            "wake_not_detected"
        );
        assert_eq!(
            reason_from_core_error(&VoiceCoreError::SpeechNotDetected),
            "speech_not_detected"
        );
        assert_eq!(
            reason_from_core_error(&VoiceCoreError::SpeechTimeout),
            "speech_timeout"
        );
    }

    #[test]
    fn start_request_rejects_unknown_fields() {
        let value = json!({
            "trigger": "focused_push_to_talk",
            "remoteAudioConsent": false,
            "transcript": "do not accept"
        });
        assert!(serde_json::from_value::<NativeVoiceStartRequest>(value).is_err());
    }

    #[test]
    fn status_serializes_only_redacted_bounded_fields() {
        let status = NativeVoiceStatus {
            available: true,
            phase: NativeVoicePhase::Listening,
            generation: Some(7),
            background_eligible: false,
            connection: NativeVoiceConnection::ThisDevice,
            reason_code: None,
            redacted: true,
        };
        let value = serde_json::to_value(status).expect("status");
        assert_eq!(
            value,
            json!({
                "available": true,
                "phase": "listening",
                "generation": 7,
                "backgroundEligible": false,
                "connection": "this_device",
                "reasonCode": null,
                "redacted": true
            })
        );
        let rendered = value.to_string();
        for forbidden in [
            "audio",
            "transcript",
            "response",
            "endpoint",
            "auth",
            "model",
        ] {
            assert!(!rendered.contains(forbidden));
        }
    }

    #[test]
    fn control_request_rejects_unknown_fields() {
        let value = json!({
            "generation": 1,
            "reason": "user_request",
            "coreGeneration": 99
        });
        assert!(serde_json::from_value::<NativeVoiceControlRequest>(value).is_err());
    }

    #[test]
    fn status_events_are_monotonic_and_redacted() {
        let first = NativeVoiceEvent {
            sequence: 1,
            status: NativeVoiceStatus::unavailable(PROFILE_REASON),
        };
        let second = NativeVoiceEvent {
            sequence: 2,
            status: NativeVoiceStatus {
                available: true,
                phase: NativeVoicePhase::Idle,
                generation: None,
                background_eligible: false,
                connection: NativeVoiceConnection::ConnectedDevice,
                reason_code: None,
                redacted: true,
            },
        };
        assert!(second.sequence > first.sequence);
        assert!(second.status.redacted);
        assert!(serde_json::to_string(&second)
            .expect("event")
            .contains("\"redacted\":true"));
    }

    #[test]
    fn phase_mapping_discards_transcript_and_level_events() {
        assert_eq!(
            phase_from_state(VoiceState::CapturingUtterance),
            NativeVoicePhase::Listening
        );
        assert_eq!(
            phase_from_state(VoiceState::Transcribing),
            NativeVoicePhase::Processing
        );
        assert_eq!(
            phase_from_state(VoiceState::Speaking),
            NativeVoicePhase::Speaking
        );
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[tokio::test(flavor = "current_thread")]
    async fn deterministic_e2e_input_is_paced_and_generation_scoped() {
        let generation = Generation(7);
        let mut audio = DeterministicE2eAudioInput::new();
        let control = audio.control();
        audio
            .start(VoiceCaptureLease {
                owner: aurora_voice_core::CaptureOwnerKind::Native,
                surface: SURFACE.to_owned(),
                device_route: DEVICE_ROUTE.to_owned(),
                start_reason: CaptureStartReason::PushToTalk,
                generation,
                created_at: TimestampMicros(1_000),
                route_revision: RouteRevision(ROUTE_REVISION),
                background_eligible: false,
                consent_revision: 0,
                heartbeat_at: TimestampMicros(1_000),
                stop_deadline: None,
            })
            .await
            .expect("start deterministic input");

        let first = audio
            .next_frame()
            .await
            .expect("first frame")
            .expect("first frame present");
        assert_eq!(first.generation(), generation);
        assert_eq!(first.route_revision(), RouteRevision(ROUTE_REVISION));
        assert_eq!(first.sequence(), 0);
        assert_eq!(first.sample_count(), E2E_AUDIO_FRAME_SAMPLES);
        assert!(first.samples().iter().any(|sample| *sample != 0.0));

        control.finish(Generation(8));
        assert!(audio
            .next_frame()
            .await
            .expect("stale finish ignored")
            .is_some());
        control.finish(generation);
        assert!(audio.next_frame().await.expect("finish observed").is_none());
    }

    #[test]
    fn remote_profile_requires_https_http_capability_and_credential() {
        let document = ThinProfileDocument::V1(ThinProfileDocumentV1 {
            version: 1,
            active_profile_id: Some("p1".to_owned()),
            profiles: vec![ThinConnectionProfileV1 {
                id: "p1".to_owned(),
                _label: "Home".to_owned(),
                mode: "webrtc-only".to_owned(),
                gateway_url: "https://gateway.example.test".to_owned(),
                _signaling_url: "wss://signal.example.test".to_owned(),
                _node_name: "Remote".to_owned(),
                _local_stable_peer_id: "local-thin-peer".to_owned(),
                webrtc_profile: Some(test_webrtc_profile("home-peer")),
            }],
        });
        assert!(matches!(
            resolve_remote_profile(&document, true, |_| None, || 10),
            Err(PROFILE_REASON)
        ));

        let document = ThinProfileDocument::V1(ThinProfileDocumentV1 {
            version: 1,
            active_profile_id: Some("p1".to_owned()),
            profiles: vec![ThinConnectionProfileV1 {
                id: "p1".to_owned(),
                _label: "Home".to_owned(),
                mode: "http-only".to_owned(),
                gateway_url: "https://gateway.example.test".to_owned(),
                _signaling_url: "wss://signal.example.test".to_owned(),
                _node_name: "Remote".to_owned(),
                _local_stable_peer_id: "local-thin-peer".to_owned(),
                webrtc_profile: Some(test_webrtc_profile("home-peer")),
            }],
        });
        let without_audio_consent = resolve_remote_profile(
            &document,
            false,
            |_| {
                Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: Some(20),
                })
            },
            || 10,
        )
        .expect("profile resolution does not imply microphone upload");
        assert!(without_audio_consent.requires_remote_audio_consent());
        assert!(matches!(
            resolve_remote_profile(
                &document,
                true,
                |_| Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: Some(5),
                }),
                || 10
            ),
            Err(CREDENTIAL_REASON)
        ));
        let resolved = resolve_remote_profile(
            &document,
            true,
            |peer_id| {
                assert_eq!(peer_id, "home-peer");
                Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: Some(20),
                })
            },
            || 10,
        )
        .expect("remote profile");
        assert_eq!(
            resolved.connection(),
            NativeVoiceConnection::ConnectedDevice
        );
    }

    #[test]
    fn runtime_v2_profile_requires_remote_console_home_peer_and_https_gateway() {
        let mut document = test_runtime_profile_document("http-only", Some("home-peer"));
        let resolved = resolve_remote_profile(
            &document,
            true,
            |peer_id| {
                assert_eq!(peer_id, "home-peer");
                Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: None,
                })
            },
            || 10,
        )
        .expect("runtime profile");
        assert_eq!(
            resolved.connection(),
            NativeVoiceConnection::ConnectedDevice
        );

        document = test_runtime_profile_document("webrtc-only", Some("home-peer"));
        assert!(matches!(
            resolve_remote_profile(&document, true, |_| None, || 10),
            Err(PROFILE_REASON)
        ));

        document = test_runtime_profile_document("http-only", None);
        assert!(matches!(
            resolve_remote_profile(&document, true, |_| None, || 10),
            Err(CREDENTIAL_REASON)
        ));

        document = test_runtime_profile_document("http-only", Some("home-peer"));
        if let ThinProfileDocument::V2(inner) = &mut document {
            inner.profiles[0].node_mode = "mesh-node".to_owned();
        }
        assert!(matches!(
            resolve_remote_profile(&document, true, |_| None, || 10),
            Err(PROFILE_REASON)
        ));
    }

    #[test]
    fn persisted_runtime_role_decides_native_profile_before_sidecar_state() {
        let remote_document = test_runtime_profile_document("http-only", Some("home-peer"));
        let remote = resolve_profile_from_document(
            &remote_document,
            true,
            true,
            |peer_id| {
                assert_eq!(peer_id, "home-peer");
                Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: None,
                })
            },
            || 10,
        )
        .expect("remote profile remains remote");
        assert_eq!(remote.connection(), NativeVoiceConnection::ConnectedDevice);

        let mut mesh_document = test_runtime_profile_document("http-only", Some("home-peer"));
        if let ThinProfileDocument::V2(inner) = &mut mesh_document {
            inner.profiles[0].node_mode = "mesh-node".to_owned();
            inner.profiles[0].runtime_tier = "python-full".to_owned();
        }
        let local = resolve_profile_from_document(&mesh_document, true, true, |_| None, || 10)
            .expect("mesh node uses available sidecar");
        assert_eq!(local.connection(), NativeVoiceConnection::ThisDevice);
        assert!(matches!(
            resolve_profile_from_document(&mesh_document, true, false, |_| None, || 10),
            Err(PROFILE_REASON)
        ));

        let mut lightweight_mesh = test_runtime_profile_document("http-only", Some("home-peer"));
        if let ThinProfileDocument::V2(inner) = &mut lightweight_mesh {
            inner.profiles[0].node_mode = "mesh-node".to_owned();
            inner.profiles[0].runtime_tier = "lightweight-ts".to_owned();
        }
        assert!(matches!(
            resolve_profile_from_document(&lightweight_mesh, true, true, |_| None, || 10),
            Err(PROFILE_REASON)
        ));

        let mut missing_active = test_runtime_profile_document("http-only", Some("home-peer"));
        if let ThinProfileDocument::V2(inner) = &mut missing_active {
            inner.active_profile_id = None;
        }
        assert!(matches!(
            resolve_profile_from_document(&missing_active, true, true, |_| None, || 10),
            Err(PROFILE_REASON)
        ));
    }

    #[test]
    fn legacy_remote_profile_is_not_shadowed_by_running_sidecar() {
        let document = ThinProfileDocument::V1(ThinProfileDocumentV1 {
            version: 1,
            active_profile_id: Some("legacy-remote".to_owned()),
            profiles: vec![ThinConnectionProfileV1 {
                id: "legacy-remote".to_owned(),
                _label: "Legacy remote".to_owned(),
                mode: "http-only".to_owned(),
                gateway_url: "https://gateway.example.test".to_owned(),
                _signaling_url: "wss://signal.example.test".to_owned(),
                _node_name: "Remote".to_owned(),
                _local_stable_peer_id: "legacy-local-peer".to_owned(),
                webrtc_profile: Some(test_webrtc_profile("home-peer")),
            }],
        });
        let resolved = resolve_profile_from_document(
            &document,
            true,
            true,
            |peer_id| {
                assert_eq!(peer_id, "home-peer");
                Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: None,
                })
            },
            || 10,
        )
        .expect("legacy remote profile should remain remote");

        assert_eq!(
            resolved.connection(),
            NativeVoiceConnection::ConnectedDevice
        );
    }

    #[test]
    fn local_profile_uses_configured_loopback_gateway_origin() {
        let gateway = Url::parse("http://127.0.0.1:9123").expect("loopback gateway");
        let profile = RuntimeProfile::local_from_gateway(gateway).expect("local profile");
        let RuntimeProfile::Local { gateway, .. } = profile else {
            panic!("expected local profile");
        };
        assert_eq!(gateway.as_str(), "http://127.0.0.1:9123/");

        let remote = Url::parse("https://gateway.example.test").expect("remote gateway");
        assert!(matches!(
            RuntimeProfile::local_from_gateway(remote),
            Err(PROFILE_REASON)
        ));
    }

    #[test]
    fn remote_runtime_profiles_are_never_reused_across_starts() {
        let catalog = SpeechModelCatalog::embedded().expect("catalog");
        let stt_model_id = catalog
            .models_for_task(SpeechCatalogTask::SpeechToText)
            .first()
            .expect("stt model")
            .model_id
            .clone();
        let local_a = RuntimeProfile::Local {
            gateway: Url::parse("http://127.0.0.1:8000").expect("local a"),
            local_speech: LocalSpeechSelection::default(),
        };
        let local_b = RuntimeProfile::Local {
            gateway: Url::parse("http://127.0.0.1:8000").expect("local b"),
            local_speech: LocalSpeechSelection::default(),
        };
        assert!(runtime_cache_matches(
            local_a.reusable_key().as_ref(),
            local_b.reusable_key().as_ref()
        ));
        let local_exact_stt = RuntimeProfile::Local {
            gateway: Url::parse("http://127.0.0.1:8000").expect("local exact"),
            local_speech: LocalSpeechSelection {
                stt: Some(LocalSpeechAssetSelection {
                    pack_id: stt_model_id,
                    pack_revision: catalog.revision().to_owned(),
                    voice_id: None,
                    voice_revision: None,
                    reference_profile_id: None,
                }),
                ..LocalSpeechSelection::default()
            },
        };
        assert!(!runtime_cache_matches(
            local_a.reusable_key().as_ref(),
            local_exact_stt.reusable_key().as_ref()
        ));

        let remote_original = RuntimeProfile::Remote {
            gateway: Url::parse("https://gateway.example.test").expect("remote original"),
            bearer: "old-secret".to_owned(),
            remote_audio_consent: true,
            local_speech: LocalSpeechSelection::default(),
        };
        let remote_rotated = RuntimeProfile::Remote {
            gateway: Url::parse("https://rotated.example.test").expect("remote rotated"),
            bearer: "new-secret".to_owned(),
            remote_audio_consent: true,
            local_speech: LocalSpeechSelection::default(),
        };
        assert!(remote_original.reusable_key().is_none());
        assert!(remote_rotated.reusable_key().is_none());
        assert!(!runtime_cache_matches(
            remote_original.reusable_key().as_ref(),
            remote_rotated.reusable_key().as_ref()
        ));
    }

    #[test]
    fn remote_gateway_stt_requires_remote_audio_consent_but_local_stt_does_not() {
        let catalog = SpeechModelCatalog::embedded().expect("catalog");
        let stt_model_id = catalog
            .models_for_task(SpeechCatalogTask::SpeechToText)
            .first()
            .expect("stt model")
            .model_id
            .clone();
        let mut document = test_runtime_profile_document("http-only", Some("home-peer"));
        let profile = match &mut document {
            ThinProfileDocument::V2(document) => document.profiles.first_mut().expect("profile"),
            ThinProfileDocument::V1(_) => panic!("expected v2"),
        };
        profile.local_node.local_speech_selection = Some(LocalSpeechSelection {
            stt: Some(LocalSpeechAssetSelection {
                pack_id: stt_model_id,
                pack_revision: catalog.revision().to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        });

        let resolved = resolve_profile_from_document(
            &document,
            false,
            false,
            |_| {
                Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: None,
                })
            },
            || 10,
        )
        .expect("local STT remote console");
        assert!(!resolved.permits_remote_audio());
        assert!(!resolved.requires_remote_audio_consent());

        let gateway_stt = RuntimeProfile::Remote {
            gateway: Url::parse("https://gateway.example.test").expect("remote"),
            bearer: "secret".to_owned(),
            remote_audio_consent: false,
            local_speech: LocalSpeechSelection::default(),
        };
        assert!(!gateway_stt.permits_remote_audio());
        assert!(gateway_stt.requires_remote_audio_consent());
    }

    #[test]
    fn remote_microphone_consent_is_checked_before_credentials() {
        let document = test_runtime_profile_document("http-only", Some("home-peer"));
        let credential_loader_called = Cell::new(false);
        let error = match resolve_start_profile_from_document(
            &document,
            false,
            false,
            |_| {
                credential_loader_called.set(true);
                None
            },
            || 10,
        ) {
            Ok(_) => panic!("remote microphone capture must require consent"),
            Err(error) => error,
        };

        assert_eq!(error.code, "invalid_state");
        assert_eq!(error.reason_code, REMOTE_CONSENT_REASON);
        assert!(error.redacted);
        assert!(!credential_loader_called.get());
    }

    #[test]
    fn runtime_v2_exact_local_speech_selection_validates_catalog_pins() {
        let speech_catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let voice_catalog = TtsVoiceCatalog::embedded().expect("voice catalog");
        let vad_models = speech_catalog.models_for_task(SpeechCatalogTask::VoiceActivityDetection);
        let kws_models = speech_catalog.models_for_task(SpeechCatalogTask::KeywordSpotting);
        let stt_models = speech_catalog.models_for_task(SpeechCatalogTask::SpeechToText);
        let vad = vad_models.first().expect("vad model");
        let kws = kws_models.first().expect("kws model");
        let stt = stt_models.first().expect("stt model");
        let voice = voice_catalog
            .entries
            .iter()
            .find(|entry| entry.model_family == "vits_piper")
            .expect("piper tts voice");
        let selection = LocalSpeechSelection {
            vad: Some(LocalSpeechAssetSelection {
                pack_id: vad.model_id.clone(),
                pack_revision: speech_catalog.revision().to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            kws: Some(LocalSpeechAssetSelection {
                pack_id: kws.model_id.clone(),
                pack_revision: speech_catalog.revision().to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            stt: Some(LocalSpeechAssetSelection {
                pack_id: stt.model_id.clone(),
                pack_revision: speech_catalog.revision().to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            tts: Some(LocalSpeechAssetSelection {
                pack_id: voice.language.clone(),
                pack_revision: voice_catalog.revision().to_owned(),
                voice_id: Some(voice.voice_id.clone()),
                voice_revision: Some(voice_catalog.revision().to_owned()),
                reference_profile_id: None,
            }),
            wake_phrase: None,
        };
        validate_local_speech_selection(&selection).expect("exact catalog selection");

        let mut document = test_runtime_profile_document("http-only", Some("home-peer"));
        if let ThinProfileDocument::V2(inner) = &mut document {
            inner.profiles[0].local_node._local_speech_pack_state = Some(serde_json::json!({
                "status": "installed"
            }));
            inner.profiles[0].local_node.local_speech_selection = Some(selection);
        }
        let resolved = resolve_profile_from_document(
            &document,
            false,
            false,
            |_| {
                Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: None,
                })
            },
            || 10,
        )
        .expect("v2 exact local speech profile");
        assert!(!resolved.requires_remote_audio_consent());
    }

    #[test]
    fn local_speech_selection_rejects_stale_or_cross_task_entries() {
        let speech_catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let vad_models = speech_catalog.models_for_task(SpeechCatalogTask::VoiceActivityDetection);
        let stt_models = speech_catalog.models_for_task(SpeechCatalogTask::SpeechToText);
        let vad = vad_models.first().expect("vad model");
        let stt = stt_models.first().expect("stt model");

        let stale_revision = LocalSpeechSelection {
            stt: Some(LocalSpeechAssetSelection {
                pack_id: stt.model_id.clone(),
                pack_revision: "stale".to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&stale_revision),
            Err(PROFILE_REASON)
        );

        let cross_task = LocalSpeechSelection {
            stt: Some(LocalSpeechAssetSelection {
                pack_id: vad.model_id.clone(),
                pack_revision: speech_catalog.revision().to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&cross_task),
            Err(PROFILE_REASON)
        );

        let voice_fields_on_stt = LocalSpeechSelection {
            stt: Some(LocalSpeechAssetSelection {
                pack_id: stt.model_id.clone(),
                pack_revision: speech_catalog.revision().to_owned(),
                voice_id: Some("standard:piper:en_us-ljspeech-medium".to_owned()),
                voice_revision: None,
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&voice_fields_on_stt),
            Err(PROFILE_REASON)
        );
    }

    #[test]
    fn wake_phrase_is_bound_to_the_selected_kws_language() {
        let catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let kws = catalog
            .models_for_task(SpeechCatalogTask::KeywordSpotting)
            .into_iter()
            .find(|entry| entry.model_id == "kws:zipformer:gigaspeech")
            .expect("English KWS model");
        let phrase = LocalWakePhraseSelection {
            phrase_id: "hey-aurora.en".to_owned(),
            phrase: "Hey Aurora".to_owned(),
            language: "en".to_owned(),
            revision: "wakephrase-v1-en".to_owned(),
        };
        let selection = LocalSpeechSelection {
            kws: Some(LocalSpeechAssetSelection {
                pack_id: kws.model_id.clone(),
                pack_revision: catalog.revision().to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            wake_phrase: Some(phrase.clone()),
            ..LocalSpeechSelection::default()
        };
        validate_local_speech_selection(&selection).expect("exact English wake phrase");

        let without_kws = LocalSpeechSelection {
            wake_phrase: Some(phrase.clone()),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&without_kws),
            Err(PROFILE_REASON)
        );

        let wrong_language = LocalSpeechSelection {
            wake_phrase: Some(LocalWakePhraseSelection {
                language: "zh".to_owned(),
                ..phrase
            }),
            ..selection
        };
        assert_eq!(
            validate_local_speech_selection(&wrong_language),
            Err(PROFILE_REASON)
        );
    }

    #[test]
    fn local_speech_selection_rejects_invalid_tts_voice_binding() {
        let voice_catalog = TtsVoiceCatalog::embedded().expect("voice catalog");
        let voice = voice_catalog
            .entries
            .iter()
            .find(|entry| entry.model_family == "vits_piper")
            .expect("piper tts voice");

        let wrong_language = LocalSpeechSelection {
            tts: Some(LocalSpeechAssetSelection {
                pack_id: "not-the-voice-language".to_owned(),
                pack_revision: voice_catalog.revision().to_owned(),
                voice_id: Some(voice.voice_id.clone()),
                voice_revision: Some(voice_catalog.revision().to_owned()),
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&wrong_language),
            Err(PROFILE_REASON)
        );

        let stale_voice_catalog = LocalSpeechSelection {
            tts: Some(LocalSpeechAssetSelection {
                pack_id: voice.language.clone(),
                pack_revision: voice_catalog.revision().to_owned(),
                voice_id: Some(voice.voice_id.clone()),
                voice_revision: Some("stale".to_owned()),
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&stale_voice_catalog),
            Err(PROFILE_REASON)
        );

        let stale_language_pack = LocalSpeechSelection {
            tts: Some(LocalSpeechAssetSelection {
                pack_id: voice.language.clone(),
                pack_revision: "stale".to_owned(),
                voice_id: Some(voice.voice_id.clone()),
                voice_revision: Some(voice_catalog.revision().to_owned()),
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&stale_language_pack),
            Err(PROFILE_REASON)
        );

        let model_without_selected_voice = LocalSpeechSelection {
            tts: Some(LocalSpeechAssetSelection {
                pack_id: voice.language.clone(),
                pack_revision: voice_catalog.revision().to_owned(),
                voice_id: None,
                voice_revision: None,
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&model_without_selected_voice),
            Err(PROFILE_REASON)
        );
    }

    #[test]
    fn pocket_tts_selection_requires_explicit_reference_profile() {
        let voice_catalog = TtsVoiceCatalog::embedded().expect("voice catalog");
        let voice = voice_catalog
            .entries
            .iter()
            .find(|entry| entry.model_family == "pockettts")
            .expect("pockettts voice");

        let missing_reference = LocalSpeechSelection {
            tts: Some(LocalSpeechAssetSelection {
                pack_id: voice.language.clone(),
                pack_revision: voice_catalog.revision().to_owned(),
                voice_id: Some(voice.voice_id.clone()),
                voice_revision: Some(voice_catalog.revision().to_owned()),
                reference_profile_id: None,
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&missing_reference),
            Err(PROFILE_REASON)
        );

        let explicit_reference = LocalSpeechSelection {
            tts: Some(LocalSpeechAssetSelection {
                pack_id: voice.language.clone(),
                pack_revision: voice_catalog.revision().to_owned(),
                voice_id: Some(voice.voice_id.clone()),
                voice_revision: Some(voice_catalog.revision().to_owned()),
                reference_profile_id: Some("speaker:voice-1".to_owned()),
            }),
            ..LocalSpeechSelection::default()
        };
        validate_local_speech_selection(&explicit_reference).expect("pocket reference profile");

        let runtime_catalog = TtsVoiceCatalog::runtime().expect("runtime voice catalog");
        let public_english = runtime_catalog
            .voice("standard:pockettts:aurora-pockettts-en-2026-04")
            .expect("public english overlay");
        let public_french = runtime_catalog
            .voice("standard:pockettts:aurora-pockettts-fr-24l")
            .expect("public french overlay");
        for overlay in [public_english, public_french] {
            let without_profile = LocalSpeechSelection {
                tts: Some(LocalSpeechAssetSelection {
                    pack_id: overlay.language.clone(),
                    pack_revision: runtime_catalog.revision().to_owned(),
                    voice_id: Some(overlay.voice_id.clone()),
                    voice_revision: Some(runtime_catalog.revision().to_owned()),
                    reference_profile_id: None,
                }),
                ..LocalSpeechSelection::default()
            };
            validate_local_speech_selection(&without_profile)
                .expect("public overlay does not require a user profile");
        }

        let piper = voice_catalog
            .entries
            .iter()
            .find(|entry| entry.model_family == "vits_piper")
            .expect("piper voice");
        let piper_with_reference = LocalSpeechSelection {
            tts: Some(LocalSpeechAssetSelection {
                pack_id: piper.language.clone(),
                pack_revision: voice_catalog.revision().to_owned(),
                voice_id: Some(piper.voice_id.clone()),
                voice_revision: Some(voice_catalog.revision().to_owned()),
                reference_profile_id: Some("speaker:voice-1".to_owned()),
            }),
            ..LocalSpeechSelection::default()
        };
        assert_eq!(
            validate_local_speech_selection(&piper_with_reference),
            Err(PROFILE_REASON)
        );
    }

    #[cfg(desktop)]
    #[test]
    fn desktop_tts_reference_profiles_are_private_bounded_and_redacted() {
        let root = unique_test_dir("desktop-tts-reference");
        let voice_id = "standard:pockettts:en-us-test";
        let profile = DesktopTtsReferenceProfile::new(
            "speaker:voice-1".to_owned(),
            Some(voice_id.to_owned()),
            16_000,
            vec![0.0, 0.1, -0.1, 0.0],
            Some("reference text".to_owned()),
            Some("rev-1".to_owned()),
        );
        store_desktop_tts_reference_profile_at(&root, &profile, voice_id).expect("store profile");
        let path = desktop_tts_reference_profile_path_at(&root, "speaker:voice-1");
        assert!(path.exists());
        assert!(!path.to_string_lossy().contains("speaker:voice-1"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let loaded = load_desktop_tts_reference_profile_at(&root, "speaker:voice-1", voice_id)
            .expect("load profile");
        assert_eq!(loaded.reference_text.as_deref(), Some("reference text"));
        let debug = format!("{loaded:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("0.1"));

        let audio_only = DesktopTtsReferenceProfile::new(
            "speaker:audio-only".to_owned(),
            Some(voice_id.to_owned()),
            16_000,
            vec![0.0, 0.1, -0.1, 0.0],
            None,
            Some("rev-1".to_owned()),
        );
        store_desktop_tts_reference_profile_at(&root, &audio_only, voice_id)
            .expect("store audio-only profile");
        let loaded_audio_only =
            load_desktop_tts_reference_profile_at(&root, "speaker:audio-only", voice_id)
                .expect("load audio-only profile");
        assert_eq!(loaded_audio_only.reference_text, None);
        assert_eq!(
            optional_desktop_tts_reference_text(loaded_audio_only.reference_text.as_deref()),
            None
        );

        let blank_text = DesktopTtsReferenceProfile::new(
            "speaker:blank-text".to_owned(),
            Some(voice_id.to_owned()),
            16_000,
            vec![0.0, 0.1, -0.1, 0.0],
            Some("   ".to_owned()),
            Some("rev-1".to_owned()),
        );
        store_desktop_tts_reference_profile_at(&root, &blank_text, voice_id)
            .expect("store blank-text profile");
        let loaded_blank =
            load_desktop_tts_reference_profile_at(&root, "speaker:blank-text", voice_id)
                .expect("load blank-text profile");
        assert_eq!(
            optional_desktop_tts_reference_text(loaded_blank.reference_text.as_deref()),
            None
        );

        let empty = DesktopTtsReferenceProfile::new(
            "speaker:empty".to_owned(),
            Some(voice_id.to_owned()),
            16_000,
            Vec::new(),
            None,
            None,
        );
        assert!(store_desktop_tts_reference_profile_at(&root, &empty, voice_id).is_err());

        let unknown = serde_json::json!({
            "version": TTS_REFERENCE_PROFILE_VERSION,
            "id": "speaker:unknown",
            "voiceId": voice_id,
            "sampleRateHz": 16000,
            "samples": [0.0, 0.1],
            "rawAudioPath": "/private/path.wav"
        });
        let unknown_path = desktop_tts_reference_profile_path_at(&root, "speaker:unknown");
        fs::write(&unknown_path, unknown.to_string()).expect("write unknown profile");
        assert!(load_desktop_tts_reference_profile_at(&root, "speaker:unknown", voice_id).is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn requested_cancel_terminal_path_returns_idle_not_faulted() {
        assert_eq!(
            terminal_phase(Some("cancelled"), true),
            NativeVoicePhase::Idle
        );
        assert_eq!(
            terminal_phase(Some("cancelled"), false),
            NativeVoicePhase::Faulted
        );
        assert_eq!(terminal_phase(None, false), NativeVoicePhase::Idle);
    }

    #[test]
    fn active_status_uses_resolved_profile_connection_without_endpoints() {
        let speech_catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let vad_model_id = speech_catalog
            .models_for_task(SpeechCatalogTask::VoiceActivityDetection)
            .first()
            .expect("vad model")
            .model_id
            .clone();
        let kws_model_id = speech_catalog
            .models_for_task(SpeechCatalogTask::KeywordSpotting)
            .first()
            .expect("kws model")
            .model_id
            .clone();
        let local_profile = RuntimeProfile::Local {
            gateway: Url::parse("http://127.0.0.1:8000").expect("local gateway"),
            local_speech: LocalSpeechSelection {
                vad: Some(LocalSpeechAssetSelection {
                    pack_id: vad_model_id,
                    pack_revision: speech_catalog.revision().to_owned(),
                    voice_id: None,
                    voice_revision: None,
                    reference_profile_id: None,
                }),
                kws: Some(LocalSpeechAssetSelection {
                    pack_id: kws_model_id,
                    pack_revision: speech_catalog.revision().to_owned(),
                    voice_id: None,
                    voice_revision: None,
                    reference_profile_id: None,
                }),
                wake_phrase: Some(LocalWakePhraseSelection {
                    phrase_id: DEFAULT_WAKE_PHRASE_ID.to_owned(),
                    phrase: DEFAULT_WAKE_PHRASE_TEXT.to_owned(),
                    language: "en".to_owned(),
                    revision: DEFAULT_WAKE_PHRASE_REVISION.to_owned(),
                }),
                ..LocalSpeechSelection::default()
            },
        };
        let mut local = NativeVoiceStatus::unavailable(PROFILE_REASON);
        install_profile(&mut local, &local_profile);
        assert_eq!(local.connection, NativeVoiceConnection::ThisDevice);
        assert!(local.background_eligible);

        let remote_profile = RuntimeProfile::Remote {
            gateway: Url::parse("https://gateway.example.test").expect("remote gateway"),
            bearer: "secret".to_owned(),
            remote_audio_consent: true,
            local_speech: local_profile.local_speech().clone(),
        };
        let mut remote = NativeVoiceStatus::unavailable(PROFILE_REASON);
        install_profile(&mut remote, &remote_profile);
        assert_eq!(remote.connection, NativeVoiceConnection::ConnectedDevice);
        assert!(remote.background_eligible);
        let rendered = serde_json::to_string(&remote).expect("remote status");
        assert!(!rendered.contains("gateway.example"));
        assert!(!rendered.contains("https://"));
    }

    #[test]
    fn wake_background_requires_both_local_vad_and_kws() {
        let speech_catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let vad_model_id = speech_catalog
            .models_for_task(SpeechCatalogTask::VoiceActivityDetection)
            .first()
            .expect("vad model")
            .model_id
            .clone();
        let kws_model_id = speech_catalog
            .models_for_task(SpeechCatalogTask::KeywordSpotting)
            .first()
            .expect("kws model")
            .model_id
            .clone();
        let gateway = Url::parse("http://127.0.0.1:8000").expect("local gateway");

        let no_wake = RuntimeProfile::Local {
            gateway: gateway.clone(),
            local_speech: LocalSpeechSelection::default(),
        };
        assert!(!no_wake.background_voice_eligible());

        let vad_only = RuntimeProfile::Local {
            gateway: gateway.clone(),
            local_speech: LocalSpeechSelection {
                vad: Some(LocalSpeechAssetSelection {
                    pack_id: vad_model_id.clone(),
                    pack_revision: speech_catalog.revision().to_owned(),
                    voice_id: None,
                    voice_revision: None,
                    reference_profile_id: None,
                }),
                ..LocalSpeechSelection::default()
            },
        };
        assert!(!vad_only.background_voice_eligible());

        let local_wake = RuntimeProfile::Local {
            gateway: gateway.clone(),
            local_speech: LocalSpeechSelection {
                vad: Some(LocalSpeechAssetSelection {
                    pack_id: vad_model_id,
                    pack_revision: speech_catalog.revision().to_owned(),
                    voice_id: None,
                    voice_revision: None,
                    reference_profile_id: None,
                }),
                kws: Some(LocalSpeechAssetSelection {
                    pack_id: kws_model_id,
                    pack_revision: speech_catalog.revision().to_owned(),
                    voice_id: None,
                    voice_revision: None,
                    reference_profile_id: None,
                }),
                wake_phrase: Some(LocalWakePhraseSelection {
                    phrase_id: DEFAULT_WAKE_PHRASE_ID.to_owned(),
                    phrase: DEFAULT_WAKE_PHRASE_TEXT.to_owned(),
                    language: "en".to_owned(),
                    revision: DEFAULT_WAKE_PHRASE_REVISION.to_owned(),
                }),
                ..LocalSpeechSelection::default()
            },
        };
        assert!(local_wake.background_voice_eligible());

        let remote_wake = RuntimeProfile::Remote {
            gateway: Url::parse("https://gateway.example.test").expect("remote gateway"),
            bearer: "secret".to_owned(),
            remote_audio_consent: true,
            local_speech: local_wake.local_speech().clone(),
        };
        assert!(remote_wake.background_voice_eligible());
        assert!(SherpaKwsPhraseInput::new(
            DEFAULT_WAKE_PHRASE_ID,
            &local_wake
                .local_speech()
                .wake_phrase
                .as_ref()
                .expect("wake phrase")
                .phrase,
        )
        .is_ok());
    }

    #[test]
    fn accepted_start_reports_starting_without_waiting_for_audio_readiness() {
        let accepted = accepted_start_status(9, NativeVoiceConnection::ThisDevice);
        assert_eq!(accepted.phase, NativeVoicePhase::Starting);
        assert_eq!(accepted.generation, Some(9));
        assert!(accepted.available);
        assert!(!accepted.background_eligible);
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn profile_change_cancel_waits_for_turn_settlement_and_keeps_actor_live() {
        LocalSet::new()
            .run_until(async {
                let (tx, rx) = mpsc::unbounded_channel();
                let (status_tx, mut status_rx) = mpsc::unbounded_channel();
                let (entered_tx, entered_rx) = oneshot::channel();
                let (release_tx, release_rx) = oneshot::channel();
                let cancellation = CancellationToken::new();
                let task_cancellation = cancellation.clone();
                let task = tokio::task::spawn_local(async move {
                    let _ = entered_tx.send(());
                    release_rx.await.expect("release drained turn");
                    assert!(task_cancellation.is_cancelled());
                    TurnTaskOutcome {
                        reason_code: None,
                        cleanup: CoreCleanupSummary::default(),
                        no_core_work: true,
                        handoff_cleanup_failed: false,
                    }
                });

                let mut actor = NativeVoiceActor::new_test(tx.clone(), status_tx);
                actor.status.phase = NativeVoicePhase::Listening;
                actor.status.generation = Some(17);
                actor.active = Some(ActiveTurn {
                    ui_generation: 17,
                    continuous: false,
                    _handoff_generation: None,
                    control: DesktopCaptureControl::Test(Arc::new(Mutex::new(Vec::new()))),
                    current_core_generation: Rc::new(Cell::new(None)),
                    shutdown_requested: Rc::new(Cell::new(false)),
                    cancellation,
                    handoff_slot: Rc::new(RefCell::new(None)),
                    task: Some(task),
                    panic_cleanup_started: false,
                    expected_terminal: false,
                });
                let actor_task = tokio::task::spawn_local(run_actor_loop(actor, rx));
                entered_rx.await.expect("turn is running");

                let (release_reply, mut release_result) = oneshot::channel();
                tx.send(ActorCommand::CancelAndDrainForProfileChange {
                    reply: release_reply,
                })
                .expect("profile release reaches running actor");
                loop {
                    let status = status_rx.recv().await.expect("actor status");
                    if status.phase == NativeVoicePhase::Stopping && status.generation == Some(17) {
                        break;
                    }
                }
                assert!(
                    matches!(
                        release_result.try_recv(),
                        Err(oneshot::error::TryRecvError::Empty)
                    ),
                    "release waits for actual turn-task settlement"
                );
                release_tx.send(()).expect("allow task cleanup to finish");
                assert_eq!(release_result.await, Ok(Ok(())));

                let (status_reply, status_result) = oneshot::channel();
                tx.send(ActorCommand::Status {
                    reply: status_reply,
                })
                .expect("actor remains available after profile release");
                status_result
                    .await
                    .expect("actor answers after profile release")
                    .expect("status remains readable");
                assert!(!actor_task.is_finished());

                let (idle_reply, idle_result) = oneshot::channel();
                tx.send(ActorCommand::CancelAndDrainForProfileChange { reply: idle_reply })
                    .expect("later profile release reaches retained actor");
                assert_eq!(idle_result.await, Ok(Ok(())));
                actor_task.abort();
            })
            .await;
    }

    #[test]
    fn prepare_error_path_requires_cleanup_before_start_failure() {
        assert_eq!(
            prepare_error_outcome(true, false),
            PrepareErrorOutcome::ReturnOriginalError
        );
        assert_eq!(
            prepare_error_outcome(true, true),
            PrepareErrorOutcome::ReturnCleanupError
        );
    }

    #[test]
    fn prepare_timeout_path_preserves_cleanup_failure_precedence() {
        assert_eq!(
            prepare_timeout_outcome(false),
            PrepareTimeoutOutcome::ReturnPrepareTimeout
        );
        assert_eq!(
            prepare_timeout_outcome(true),
            PrepareTimeoutOutcome::ReturnCleanupError
        );
    }

    #[test]
    fn host_stop_wait_covers_nested_cleanup_deadlines() {
        assert!(
            HANDOFF_OPERATION_TIMEOUT > HANDOFF_REQUEST_TIMEOUT,
            "outer operation timeout must not race transport request timeout"
        );
        assert!(
            HANDOFF_RECOVERY_TIMEOUT
                > HANDOFF_REQUEST_TIMEOUT + HANDOFF_REQUEST_TIMEOUT + Duration::from_secs(1),
            "ambiguous prepare recovery must cover retry prepare plus release"
        );
        assert!(
            HOST_STOP_WAIT_TIMEOUT
                > worst_case_queued_shutdown_before_stop_wait() + Duration::from_secs(1),
            "host wait must cover queued prepare, recovery cleanup, shutdown wait, forced release, and forced cleanup"
        );
    }

    #[cfg(desktop)]
    fn voice_state_with_test_actor(
        run: impl FnOnce(mpsc::UnboundedReceiver<ActorCommand>) + Send + 'static,
    ) -> NativeVoiceState {
        let state = NativeVoiceState::default();
        *state.inner.lock().expect("native voice lifecycle lock") =
            NativeVoiceLifecycle::Running(NativeVoiceHandle::with_test_actor(run));
        state
    }

    #[cfg(desktop)]
    async fn wait_until_stopping(state: &NativeVoiceState) -> Arc<ShutdownOperation> {
        for _ in 0..256 {
            if let NativeVoiceLifecycle::Stopping(operation) =
                &*state.inner.lock().expect("native voice lifecycle lock")
            {
                return Arc::clone(operation);
            }
            tokio::task::yield_now().await;
        }
        panic!("stop did not close actor admission");
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn actor_admission_orders_shutdown_and_waits_for_os_thread_join() {
        let (status_started_tx, status_started_rx) = tokio::sync::oneshot::channel();
        let (release_status_tx, release_status_rx) = std::sync::mpsc::channel();
        let (shutdown_ack_tx, shutdown_ack_rx) = tokio::sync::oneshot::channel();
        let (release_exit_tx, release_exit_rx) = std::sync::mpsc::channel();
        let (thread_exit_tx, thread_exit_rx) = tokio::sync::oneshot::channel();
        let shutdown_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let actor_shutdown_count = Arc::clone(&shutdown_count);
        let state = voice_state_with_test_actor(move |mut rx| {
            let mut status_started_tx = Some(status_started_tx);
            while let Some(command) = rx.blocking_recv() {
                match command {
                    ActorCommand::Status { reply } => {
                        if let Some(started_tx) = status_started_tx.take() {
                            let _ = started_tx.send(());
                        }
                        let _ = release_status_rx.recv();
                        let _ = reply.send(Ok(NativeVoiceStatus::unavailable("test")));
                    }
                    ActorCommand::Shutdown { reply } => {
                        actor_shutdown_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let _ = reply.send(Ok(()));
                        let _ = shutdown_ack_tx.send(());
                        let _ = release_exit_rx.recv();
                        let _ = thread_exit_tx.send(());
                        break;
                    }
                    _ => panic!("unexpected actor command in shutdown-order test"),
                }
            }
        });

        let status_state = state.clone();
        let status = tokio::spawn(async move { request_status(&status_state).await });
        status_started_rx
            .await
            .expect("status admitted before stop");

        let stop_state = state.clone();
        let stop = tokio::spawn(async move { stop_state.stop().await });
        let _operation = wait_until_stopping(&state).await;
        assert!(request_status(&state).await.is_err());

        release_status_tx.send(()).expect("release admitted status");
        assert!(status.await.expect("status task").is_ok());
        shutdown_ack_rx
            .await
            .expect("shutdown follows admitted status");
        tokio::task::yield_now().await;
        assert!(
            !stop.is_finished(),
            "ack must not replace the OS-thread join"
        );

        release_exit_tx
            .send(())
            .expect("allow actor thread to exit");
        thread_exit_rx
            .await
            .expect("actor thread reached its exit path");
        stop.await.expect("stop task").expect("joined actor");
        assert_eq!(shutdown_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_stop_waiters_share_job_after_one_is_dropped() {
        let (shutdown_ack_tx, shutdown_ack_rx) = tokio::sync::oneshot::channel();
        let (release_exit_tx, release_exit_rx) = std::sync::mpsc::channel();
        let (thread_exit_tx, thread_exit_rx) = tokio::sync::oneshot::channel();
        let shutdown_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let actor_shutdown_count = Arc::clone(&shutdown_count);
        let state = voice_state_with_test_actor(move |mut rx| {
            while let Some(command) = rx.blocking_recv() {
                if let ActorCommand::Shutdown { reply } = command {
                    actor_shutdown_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = reply.send(Ok(()));
                    let _ = shutdown_ack_tx.send(());
                    let _ = release_exit_rx.recv();
                    let _ = thread_exit_tx.send(());
                    break;
                }
            }
        });

        let first_state = state.clone();
        let first = tokio::spawn(async move { first_state.stop().await });
        let original_operation = wait_until_stopping(&state).await;
        let second_state = state.clone();
        let (second_started_tx, second_started_rx) = tokio::sync::oneshot::channel();
        let second = tokio::spawn(async move {
            let _ = second_started_tx.send(());
            second_state.stop().await
        });
        second_started_rx.await.expect("second stop waiter started");
        let retained_operation = wait_until_stopping(&state).await;
        assert!(Arc::ptr_eq(&original_operation, &retained_operation));
        shutdown_ack_rx
            .await
            .expect("one shutdown job acknowledged");
        assert_eq!(shutdown_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!first.is_finished());
        assert!(!second.is_finished(), "the actor thread is still owned");
        first.abort();
        let _ = first.await;

        release_exit_tx
            .send(())
            .expect("allow actor thread to exit");
        thread_exit_rx.await.expect("actor thread exit");
        second
            .await
            .expect("second waiter task")
            .expect("shared result");
        assert_eq!(shutdown_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn queued_short_stop_deadline_quarantines_shared_shutdown_job() {
        let (shutdown_ack_tx, shutdown_ack_rx) = oneshot::channel();
        let (release_exit_tx, release_exit_rx) = std::sync::mpsc::channel();
        let state = voice_state_with_test_actor(move |mut rx| {
            while let Some(command) = rx.blocking_recv() {
                if let ActorCommand::Shutdown { reply } = command {
                    let _ = reply.send(Ok(()));
                    let _ = shutdown_ack_tx.send(());
                    let _ = release_exit_rx.recv();
                    break;
                }
            }
        });

        let first_state = state.clone();
        let first = tokio::spawn(async move { first_state.stop().await });
        let operation = wait_until_stopping(&state).await;
        shutdown_ack_rx
            .await
            .expect("actor ack precedes blocked join");
        for _ in 0..256 {
            if operation.progress.try_lock().is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            operation.progress.try_lock().is_err(),
            "first waiter owns progress gate"
        );

        let second_state = state.clone();
        let second = tokio::spawn(async move {
            second_state
                .stop_with_timeout(Duration::from_millis(10))
                .await
        });
        assert_eq!(
            second.await.expect("short waiter"),
            Err(NativeVoiceStopError::TimedOut)
        );
        assert_eq!(
            operation.result(),
            Some(Err(NativeVoiceStopError::TimedOut)),
            "the waiter timeout wins the shared shutdown outcome"
        );

        release_exit_tx.send(()).expect("allow thread join");
        assert_eq!(
            first.await.expect("first waiter"),
            Err(NativeVoiceStopError::TimedOut)
        );
        assert_eq!(
            state.stop_with_timeout(Duration::from_secs(1)).await,
            Err(NativeVoiceStopError::TimedOut),
            "a later waiter cannot turn completed cleanup into a clean stop"
        );
        assert!(matches!(
            &*state.inner.lock().expect("native voice lifecycle lock"),
            NativeVoiceLifecycle::Stopping(_)
        ));
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn timed_out_stop_keeps_lifecycle_quarantined_after_job_finishes() {
        let (shutdown_ack_tx, shutdown_ack_rx) = tokio::sync::oneshot::channel();
        let (release_exit_tx, release_exit_rx) = std::sync::mpsc::channel();
        let (thread_exit_tx, thread_exit_rx) = tokio::sync::oneshot::channel();
        let state = voice_state_with_test_actor(move |mut rx| {
            while let Some(command) = rx.blocking_recv() {
                if let ActorCommand::Shutdown { reply } = command {
                    let _ = reply.send(Ok(()));
                    let _ = shutdown_ack_tx.send(());
                    let _ = release_exit_rx.recv();
                    let _ = thread_exit_tx.send(());
                    break;
                }
            }
        });

        let result = state.stop_with_timeout(Duration::ZERO).await;
        assert_eq!(result, Err(NativeVoiceStopError::TimedOut));
        let operation = wait_until_stopping(&state).await;
        shutdown_ack_rx
            .await
            .expect("actor acknowledged before thread join");
        assert!(request_status(&state).await.is_err());
        assert_eq!(
            operation.result(),
            Some(Err(NativeVoiceStopError::TimedOut)),
            "timeout is sticky while the retained job is still running"
        );

        release_exit_tx
            .send(())
            .expect("allow the retained job to finish");
        thread_exit_rx.await.expect("actor thread exit");
        for _ in 0..256 {
            if operation.progress.lock().await.job.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(operation.progress.lock().await.job.is_finished());
        assert_eq!(
            state.stop_with_timeout(Duration::from_secs(1)).await,
            Err(NativeVoiceStopError::TimedOut)
        );
        assert!(matches!(
            &*state.inner.lock().expect("native voice lifecycle lock"),
            NativeVoiceLifecycle::Stopping(_)
        ));
    }

    #[cfg(desktop)]
    fn successful_test_turn() -> TurnTaskOutcome {
        TurnTaskOutcome {
            reason_code: None,
            cleanup: CoreCleanupSummary::default(),
            no_core_work: true,
            handoff_cleanup_failed: false,
        }
    }

    #[cfg(desktop)]
    #[test]
    fn actor_failure_quarantine_survives_clean_completion_and_inactive_shutdown() {
        let mut failure = ActorFailureState::default();
        assert!(!failure.blocks_reuse());
        assert_eq!(failure.shutdown_result(), Ok(()));
        failure.record(NativeVoiceStopError::ShutdownFailed);

        assert!(failure.blocks_reuse(), "new turns remain rejected");
        assert_eq!(
            failure.completion_phase(false, None, false),
            NativeVoicePhase::Faulted,
            "a later clean task cannot publish Idle after cleanup failure"
        );
        assert_eq!(
            failure.shutdown_result(),
            Err(NativeVoiceStopError::ShutdownFailed),
            "an inactive shutdown still returns the retained failure"
        );

        failure.record(NativeVoiceStopError::TimedOut);
        assert_eq!(
            failure.shutdown_result(),
            Err(NativeVoiceStopError::ShutdownFailed),
            "later outcomes do not erase the first quarantine reason"
        );
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn ambiguous_prepare_cleanup_failure_stays_quarantined_through_actor_dispatch() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let listener = std::net::TcpListener::bind("127.0.0.1:0")
                    .expect("loopback handoff fixture listener");
                let address = listener.local_addr().expect("fixture address");
                let (request_count_tx, request_count_rx) = std::sync::mpsc::channel();
                let server = std::thread::spawn(move || {
                    for _ in 0..2 {
                        let (stream, _) = listener.accept().expect("prepare/recovery request");
                        drop(stream);
                        request_count_tx.send(()).expect("record accepted request");
                    }
                });
                let transport = NativeGatewayTransport::new(
                    Url::parse(&format!("http://{address}/")).expect("loopback transport URL"),
                    GatewayAuth::None,
                    TransportLimits {
                        allow_loopback_http: true,
                        microphone_audio_policy: MicrophoneAudioPolicy::LoopbackOnly,
                        ..TransportLimits::default()
                    },
                )
                .expect("loopback transport");
                let config = NativeGatewayCaptureHandoffConfig::new(
                    "tauri-native-voice",
                    "host-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "desktop",
                    "default",
                )
                .expect("handoff config");
                let mut adapter = NativeGatewayCaptureHandoff::new(transport, config)
                    .expect("controlled Gateway handoff");
                let (command_tx, command_rx) = mpsc::unbounded_channel();
                let (status_tx, mut status_rx) = mpsc::unbounded_channel();
                let mut actor = NativeVoiceActor::new_test(command_tx.clone(), status_tx);
                let prepare_error = actor
                    .prepare_local_handoff(&mut adapter, &CancellationToken::new())
                    .await
                    .expect_err("prepare and ambiguous recovery both fail");
                assert_eq!(prepare_error.reason_code, "handoff_cleanup_failed");
                assert!(actor.failure.blocks_reuse());
                assert_eq!(request_count_rx.try_iter().count(), 2);
                server.join().expect("join handoff fixture");
                let actor_task = tokio::task::spawn_local(run_actor_loop(actor, command_rx));

                let (start_reply, start_result) = oneshot::channel();
                command_tx
                    .send(ActorCommand::Start {
                        request: NativeVoiceStartRequest {
                            trigger: NativeVoiceTrigger::FocusedPushToTalk,
                            remote_audio_consent: false,
                        },
                        profile_generation: None,
                        speech_stages: None,
                        config_revision: None,
                        confirmed_profile_document: None,
                        reply: start_reply,
                    })
                    .expect("dispatch start after ambiguous prepare recovery failure");
                assert_eq!(
                    start_result
                        .await
                        .expect("start result")
                        .unwrap_err()
                        .reason_code,
                    "local_cleanup_failed"
                );

                let (status_reply, status_result) = oneshot::channel();
                command_tx
                    .send(ActorCommand::RuntimePhase {
                        ui_generation: 1,
                        phase: NativeVoicePhase::Listening,
                        reason_code: None,
                    })
                    .expect("dispatch stale runtime event");
                command_tx
                    .send(ActorCommand::Status {
                        reply: status_reply,
                    })
                    .expect("read quarantined actor status");
                let status = status_result.await.expect("status reply").expect("status");
                assert_eq!(status.phase, NativeVoicePhase::Faulted);
                assert_eq!(
                    status.reason_code.as_deref(),
                    Some("handoff_cleanup_failed")
                );

                let (shutdown_reply, shutdown_result) = std::sync::mpsc::channel();
                command_tx
                    .send(ActorCommand::Shutdown {
                        reply: shutdown_reply,
                    })
                    .expect("dispatch inactive shutdown after failed recovery");
                actor_task.await.expect("headless actor loop exits");
                assert_eq!(
                    shutdown_result
                        .try_recv()
                        .expect("shutdown acknowledgement"),
                    Err(NativeVoiceStopError::ShutdownFailed)
                );
                let mut published = Vec::new();
                while let Ok(status) = status_rx.try_recv() {
                    published.push(status);
                }
                assert!(published.iter().all(|status| {
                    status.phase == NativeVoicePhase::Faulted
                        && matches!(
                            status.reason_code.as_deref(),
                            Some("handoff_cleanup_failed" | "local_cleanup_failed")
                        )
                }));
            })
            .await;
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn headless_actor_dispatch_keeps_failure_sticky_through_start_status_and_completion() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (command_tx, command_rx) = mpsc::unbounded_channel();
                let (status_tx, mut status_rx) = mpsc::unbounded_channel();
                let (release_task_tx, release_task_rx) = oneshot::channel();
                let task = tokio::task::spawn_local(async move {
                    release_task_rx.await.expect("release scripted turn");
                    let mut cleanup = CoreCleanupSummary::default();
                    cleanup.record_values(
                        Generation(17),
                        true,
                        false,
                        false,
                        [
                            aurora_voice_core::CleanupCallbackOutcome::NotAttempted,
                            aurora_voice_core::CleanupCallbackOutcome::NotAttempted,
                            aurora_voice_core::CleanupCallbackOutcome::NotAttempted,
                            aurora_voice_core::CleanupCallbackOutcome::NotAttempted,
                            aurora_voice_core::CleanupCallbackOutcome::NotAttempted,
                            aurora_voice_core::CleanupCallbackOutcome::ReturnedOk,
                            aurora_voice_core::CleanupCallbackOutcome::ReturnedOk,
                            aurora_voice_core::CleanupCallbackOutcome::NotAttempted,
                        ],
                    );
                    assert!(
                        !cleanup.failed_for_task(false),
                        "the later assigned generation has a clean cleanup summary"
                    );
                    TurnTaskOutcome {
                        reason_code: None,
                        cleanup,
                        no_core_work: false,
                        handoff_cleanup_failed: false,
                    }
                });
                let capture_events = Arc::new(Mutex::new(Vec::new()));
                let mut actor = NativeVoiceActor::new_test(command_tx.clone(), status_tx);
                actor.quarantine_after_ambiguous_prepare_cleanup_failure();
                actor.status.generation = Some(93);
                actor.active = Some(ActiveTurn {
                    ui_generation: 93,
                    continuous: false,
                    _handoff_generation: None,
                    control: DesktopCaptureControl::Test(Arc::clone(&capture_events)),
                    current_core_generation: Rc::new(Cell::new(Some(Generation(17)))),
                    shutdown_requested: Rc::new(Cell::new(false)),
                    cancellation: CancellationToken::new(),
                    handoff_slot: Rc::new(RefCell::new(None)),
                    task: Some(task),
                    panic_cleanup_started: false,
                    expected_terminal: false,
                });
                let actor_task = tokio::task::spawn_local(run_actor_loop(actor, command_rx));

                let (start_reply, start_result) = oneshot::channel();
                command_tx
                    .send(ActorCommand::Start {
                        request: NativeVoiceStartRequest {
                            trigger: NativeVoiceTrigger::FocusedPushToTalk,
                            remote_audio_consent: false,
                        },
                        profile_generation: None,
                        speech_stages: None,
                        config_revision: None,
                        confirmed_profile_document: None,
                        reply: start_reply,
                    })
                    .expect("dispatch start through actor loop");
                let start_error = start_result.await.expect("start reply").unwrap_err();
                assert_eq!(start_error.reason_code, "local_cleanup_failed");

                let (phase_reply, phase_result) = oneshot::channel();
                command_tx
                    .send(ActorCommand::RuntimePhase {
                        ui_generation: 93,
                        phase: NativeVoicePhase::Listening,
                        reason_code: None,
                    })
                    .expect("dispatch late runtime phase");
                command_tx
                    .send(ActorCommand::Status { reply: phase_reply })
                    .expect("dispatch status after late phase");
                let status = phase_result.await.expect("status reply").expect("status");
                assert_eq!(status.phase, NativeVoicePhase::Faulted);
                assert_eq!(
                    status.reason_code.as_deref(),
                    Some("handoff_cleanup_failed")
                );

                let (finish_reply, finish_result) = oneshot::channel();
                command_tx
                    .send(ActorCommand::Finish {
                        request: NativeVoiceControlRequest {
                            generation: 93,
                            reason: NativeVoiceStopReason::UserRequest,
                        },
                        reply: finish_reply,
                    })
                    .expect("dispatch finish through actor loop");
                let finish_status = finish_result.await.expect("finish reply").expect("finish");
                assert_eq!(finish_status.phase, NativeVoicePhase::Faulted);
                assert_eq!(
                    &*capture_events.lock().expect("test capture events"),
                    &[("finish", 17)]
                );

                while status_rx.try_recv().is_ok() {}
                release_task_tx
                    .send(())
                    .expect("complete actual owned task");
                let mut completed = false;
                while !completed {
                    match status_rx.recv().await.expect("actor status event") {
                        status
                            if status.phase == NativeVoicePhase::Faulted
                                && status.generation.is_none() =>
                        {
                            completed = true;
                        }
                        _ => {}
                    }
                }

                let (post_completion_reply, post_completion_result) = oneshot::channel();
                command_tx
                    .send(ActorCommand::Status {
                        reply: post_completion_reply,
                    })
                    .expect("dispatch status after completion");
                assert_eq!(
                    post_completion_result
                        .await
                        .expect("post-completion status")
                        .expect("status")
                        .phase,
                    NativeVoicePhase::Faulted
                );

                let (shutdown_reply, shutdown_result) = std::sync::mpsc::channel();
                command_tx
                    .send(ActorCommand::Shutdown {
                        reply: shutdown_reply,
                    })
                    .expect("dispatch shutdown after failed generation");
                actor_task.await.expect("actor loop exits after shutdown");
                assert_eq!(
                    shutdown_result.try_recv().expect("shutdown result"),
                    Err(NativeVoiceStopError::ShutdownFailed)
                );
            })
            .await;
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn stale_turn_completion_preserves_task_and_latest_capture_generation() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let input = CpalAudioInput::new(NativeCaptureConfig::default());
                let binding = Rc::new(Cell::new(Some(Generation(1))));
                let (release_tx, release_rx) = tokio::sync::oneshot::channel();
                let task = tokio::task::spawn_local(async move {
                    let _ = release_rx.await;
                    successful_test_turn()
                });
                let mut active = ActiveTurn {
                    ui_generation: 41,
                    continuous: false,
                    _handoff_generation: None,
                    control: DesktopCaptureControl::Production(input.control()),
                    current_core_generation: Rc::clone(&binding),
                    shutdown_requested: Rc::new(Cell::new(false)),
                    cancellation: CancellationToken::new(),
                    handoff_slot: Rc::new(RefCell::new(None)),
                    task: Some(task),
                    panic_cleanup_started: false,
                    expected_terminal: false,
                };

                assert_eq!(active.interrupt_current_capture(), Some(Generation(1)));
                binding.set(Some(Generation(2)));
                assert_eq!(active.finish_current_capture(), Some(Generation(2)));
                assert_eq!(binding.get(), Some(Generation(2)));

                assert!(active.take_task_for_completion(40).is_none());
                assert!(active.task.as_ref().is_some_and(|task| !task.is_finished()));
                assert_eq!(binding.get(), Some(Generation(2)));

                let task = active
                    .take_task_for_completion(41)
                    .expect("matching UI generation")
                    .expect("owned task remains present");
                release_tx.send(()).expect("finish matching task");
                let outcome = join_active_turn(task).await;
                assert!(!outcome.cleanup.failed_for_task(outcome.no_core_work));
            })
            .await;
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[tokio::test(flavor = "current_thread")]
    async fn second_core_generation_remains_bound_for_controls_and_stale_completion() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (mut core, cancelled, entered, release, control) =
                    paused_report_test_e2e_runtime([false, false], 2);
                let binding = Rc::new(Cell::new(None));
                let mut first_summary = CoreCleanupSummary::default();
                let first_cancellation = CancellationToken::new();
                first_cancellation.cancel();
                assert!(
                    run_core_generation(&mut core, &binding, &mut first_summary, |core| {
                        Box::pin(core.run_push_to_talk_transcription(
                            e2e_transcription_lease(),
                            TimestampMicros(1),
                            first_cancellation,
                        ))
                    })
                    .await
                    .is_err()
                );
                assert_eq!(first_summary.last_generation, Some(Generation(1)));
                assert_eq!(
                    binding.get(),
                    None,
                    "cancellation between turns clears binding"
                );

                let task_binding = Rc::clone(&binding);
                let task_cancellation = CancellationToken::new();
                let invocation_cancellation = task_cancellation.clone();
                let task = tokio::task::spawn_local(async move {
                    let mut summary = CoreCleanupSummary::default();
                    let result =
                        run_core_generation(&mut core, &task_binding, &mut summary, |core| {
                            Box::pin(core.run_push_to_talk_transcription(
                                e2e_transcription_lease(),
                                TimestampMicros(2),
                                invocation_cancellation,
                            ))
                        })
                        .await;
                    TurnTaskOutcome {
                        reason_code: result.err().map(|error| reason_from_core_error(&error)),
                        cleanup: summary,
                        no_core_work: false,
                        handoff_cleanup_failed: false,
                    }
                });

                for _ in 0..256 {
                    if control.active(Generation(2)) {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                assert!(
                    control.active(Generation(2)),
                    "the second actual core generation owns its capture"
                );
                assert_eq!(binding.get(), Some(Generation(2)));

                let mut active = ActiveTurn {
                    ui_generation: 47,
                    continuous: true,
                    _handoff_generation: None,
                    control: DesktopCaptureControl::Deterministic(control.clone()),
                    current_core_generation: Rc::clone(&binding),
                    shutdown_requested: Rc::new(Cell::new(false)),
                    cancellation: task_cancellation,
                    handoff_slot: Rc::new(RefCell::new(None)),
                    task: Some(task),
                    panic_cleanup_started: false,
                    expected_terminal: false,
                };

                assert!(active.take_task_for_completion(46).is_none());
                assert_eq!(binding.get(), Some(Generation(2)));
                assert!(active.task.as_ref().is_some_and(|task| !task.is_finished()));

                assert_eq!(active.finish_current_capture(), Some(Generation(2)));
                assert!(control
                    .shared
                    .finished
                    .load(std::sync::atomic::Ordering::SeqCst));
                assert_eq!(entered.await.expect("second actual core callback"), 2);
                // Cancel, shutdown and deadline all route to the same current
                // generation-bound interruption path while that actual core
                // generation is finishing its cleanup callback.
                active.cancellation.cancel();
                assert_eq!(active.interrupt_current_capture(), Some(Generation(2)));
                active.shutdown_requested.set(true);
                assert_eq!(active.interrupt_current_capture(), Some(Generation(2)));
                assert_eq!(active.interrupt_current_capture(), Some(Generation(2)));
                assert!(control
                    .shared
                    .interrupted
                    .load(std::sync::atomic::Ordering::SeqCst));

                release
                    .send(())
                    .expect("allow second core cleanup to report");
                let task = active
                    .take_task_for_completion(47)
                    .expect("matching outer UI generation")
                    .expect("retained actual generation task");
                let outcome = join_active_turn(task).await;
                assert_eq!(outcome.cleanup.invocations, 1);
                assert_eq!(outcome.cleanup.last_generation, Some(Generation(2)));
                assert!(!outcome.cleanup.failed_for_task(outcome.no_core_work));
                assert!(outcome.cleanup.capture_start_attempted);
                assert_eq!(binding.get(), None);
                assert_eq!(&*cancelled.borrow(), &[1, 2]);
            })
            .await;
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[tokio::test(flavor = "current_thread")]
    async fn background_session_keeps_second_real_core_generation_bound_through_shutdown() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (mut core, control, second_capture_entered, release_second_capture) =
                    paused_background_test_runtime(2, false);
                let current_generation = Rc::new(Cell::new(None));
                let task_generation = Rc::clone(&current_generation);
                let cancellation = CancellationToken::new();
                let task_cancellation = cancellation.clone();
                let captured_summary = Rc::new(RefCell::new(None));
                let captured_summary_from_task = Rc::clone(&captured_summary);
                let task = tokio::task::spawn_local(async move {
                    let mut cleanup = CoreCleanupSummary::default();
                    let result = run_background_session(
                        &mut core,
                        VoiceCaptureLease {
                            background_eligible: true,
                            ..cancelled_transcription_lease()
                        },
                        task_cancellation,
                        &task_generation,
                        &mut cleanup,
                    )
                    .await;
                    *captured_summary_from_task.borrow_mut() = Some(cleanup.clone());
                    TurnTaskOutcome {
                        reason_code: result.err().map(|error| reason_from_core_error(&error)),
                        cleanup,
                        no_core_work: false,
                        handoff_cleanup_failed: false,
                    }
                });

                assert_eq!(
                    second_capture_entered
                        .await
                        .expect("second generation capture"),
                    2
                );
                assert_eq!(
                    current_generation.get(),
                    Some(Generation(2)),
                    "one continuous background session has entered its second core generation"
                );
                assert!(control.active(Generation(2)), "capture is still active");
                assert_eq!(current_generation.get(), Some(Generation(2)));

                let (tx, rx) = mpsc::unbounded_channel();
                let (status_tx, mut status_rx) = mpsc::unbounded_channel();
                let mut actor = NativeVoiceActor::new_test(tx.clone(), status_tx);
                actor.shutdown_timeout = Duration::ZERO;
                actor.status.phase = NativeVoicePhase::Listening;
                actor.status.generation = Some(91);
                actor.active = Some(ActiveTurn {
                    ui_generation: 91,
                    continuous: true,
                    _handoff_generation: None,
                    control: DesktopCaptureControl::Deterministic(control.clone()),
                    current_core_generation: Rc::clone(&current_generation),
                    shutdown_requested: Rc::new(Cell::new(false)),
                    cancellation,
                    handoff_slot: Rc::new(RefCell::new(None)),
                    task: Some(task),
                    panic_cleanup_started: false,
                    expected_terminal: false,
                });
                let actor_task = tokio::task::spawn_local(run_actor_loop(actor, rx));

                tx.send(ActorCommand::TurnFinished { ui_generation: 90 })
                    .expect("stale completion wakeup enters actual actor queue");
                let (stale_reply, stale_result) = oneshot::channel();
                tx.send(ActorCommand::Status { reply: stale_reply })
                    .expect("query after stale completion wakeup");
                let stale_status = stale_result
                    .await
                    .expect("status after stale completion")
                    .expect("status");
                assert_eq!(stale_status.generation, Some(91));
                assert!(control.active(Generation(2)));
                assert_eq!(current_generation.get(), Some(Generation(2)));

                tx.send(ActorCommand::TurnFinished { ui_generation: 91 })
                    .expect("early completion wakeup enters actual actor queue");
                let (status_reply, status_result) = oneshot::channel();
                tx.send(ActorCommand::Status {
                    reply: status_reply,
                })
                .expect("query while actual second capture is blocked");
                let status = status_result
                    .await
                    .expect("active status reply")
                    .expect("status");
                assert_eq!(status.generation, Some(91));
                assert!(control.active(Generation(2)));
                assert_eq!(current_generation.get(), Some(Generation(2)));

                let (start_reply, start_result) = oneshot::channel();
                tx.send(ActorCommand::Start {
                    request: NativeVoiceStartRequest {
                        trigger: NativeVoiceTrigger::FocusedPushToTalk,
                        remote_audio_consent: false,
                    },
                    profile_generation: None,
                    speech_stages: None,
                    config_revision: None,
                    confirmed_profile_document: None,
                    reply: start_reply,
                })
                .expect("dispatch restart attempt during live second capture");
                assert_eq!(
                    start_result
                        .await
                        .expect("start result")
                        .unwrap_err()
                        .reason_code,
                    ACTIVE_REASON
                );

                let (finish_reply, finish_result) = oneshot::channel();
                tx.send(ActorCommand::Finish {
                    request: NativeVoiceControlRequest {
                        generation: 91,
                        reason: NativeVoiceStopReason::UserRequest,
                    },
                    reply: finish_reply,
                })
                .expect("dispatch finish through actor loop");
                assert_eq!(
                    finish_result
                        .await
                        .expect("finish result")
                        .expect("finish")
                        .phase,
                    NativeVoicePhase::Stopping
                );
                assert!(control.active(Generation(2)));
                assert!(control
                    .shared
                    .interrupted
                    .load(std::sync::atomic::Ordering::SeqCst));

                let (cancel_reply, cancel_result) = oneshot::channel();
                tx.send(ActorCommand::Cancel {
                    request: NativeVoiceControlRequest {
                        generation: 91,
                        reason: NativeVoiceStopReason::UserRequest,
                    },
                    reply: cancel_reply,
                })
                .expect("dispatch cancel through actor loop");
                assert_eq!(
                    cancel_result
                        .await
                        .expect("cancel result")
                        .expect("cancel")
                        .phase,
                    NativeVoicePhase::Stopping
                );
                assert!(control.active(Generation(2)));

                let (shutdown_reply, shutdown_result) = std::sync::mpsc::channel();
                tx.send(ActorCommand::Shutdown {
                    reply: shutdown_reply,
                })
                .expect("dispatch shutdown through actor loop");
                assert_eq!(current_generation.get(), Some(Generation(2)));

                let timeout_status = loop {
                    let status = status_rx.recv().await.expect("actor deadline status");
                    if status.reason_code.as_deref() == Some("local_cleanup_failed")
                        && status.generation.is_none()
                    {
                        break status;
                    }
                };
                assert_eq!(timeout_status.phase, NativeVoicePhase::Faulted);
                assert!(control.active(Generation(2)));
                assert!(matches!(
                    shutdown_result.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Empty)
                ));

                release_second_capture
                    .send(())
                    .expect("allow live capture to finish after deadline");
                actor_task.await.expect("headless actor loop exits");
                assert_eq!(
                    shutdown_result.try_recv().expect("actor shutdown result"),
                    Err(NativeVoiceStopError::TimedOut)
                );

                let cleanup = captured_summary.borrow();
                let cleanup = cleanup.as_ref().expect("actor-owned task cleanup report");
                assert_eq!(cleanup.invocations, 2);
                assert_eq!(cleanup.last_generation, Some(Generation(2)));
                assert!(cleanup.capture_start_attempted);
                assert_eq!(current_generation.get(), None);
                assert!(!control.active(Generation(2)));
                assert_eq!(
                    *control
                        .shared
                        .started_generations
                        .lock()
                        .expect("captured core generations"),
                    vec![1, 2]
                );
                assert_eq!(
                    *control
                        .shared
                        .control_events
                        .lock()
                        .expect("generation-scoped control calls"),
                    vec![
                        ("interrupt", 2),
                        ("interrupt", 2),
                        ("interrupt", 2),
                        ("interrupt", 2)
                    ]
                );
            })
            .await;
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[tokio::test(flavor = "current_thread")]
    async fn background_cancel_between_iterations_prevents_next_capture() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (mut core, control, _unused_pause_entered, _unused_pause_release) =
                    paused_background_test_runtime(99, false);
                let (boundary_entered_tx, boundary_entered_rx) = oneshot::channel();
                let (release_between_iterations, release_between_iterations_rx) =
                    oneshot::channel();
                let boundary_gate = Rc::new(RefCell::new(Some((
                    boundary_entered_tx,
                    release_between_iterations_rx,
                ))));
                let current_generation = Rc::new(Cell::new(None));
                let task_generation = Rc::clone(&current_generation);
                let cancellation = CancellationToken::new();
                let task_cancellation = cancellation.clone();
                let captured_summary = Rc::new(RefCell::new(None));
                let captured_summary_from_task = Rc::clone(&captured_summary);
                let task = tokio::task::spawn_local(async move {
                    let mut cleanup = CoreCleanupSummary::default();
                    let boundary_gate = Rc::clone(&boundary_gate);
                    let result = run_background_session_with_iteration_boundary(
                        &mut core,
                        VoiceCaptureLease {
                            background_eligible: true,
                            ..cancelled_transcription_lease()
                        },
                        task_cancellation,
                        &task_generation,
                        &mut cleanup,
                        move || {
                            let gate = boundary_gate.borrow_mut().take();
                            Box::pin(async move {
                                if let Some((entered, release)) = gate {
                                    let _ = entered.send(());
                                    let _ = release.await;
                                }
                            })
                        },
                    )
                    .await;
                    *captured_summary_from_task.borrow_mut() = Some(cleanup.clone());
                    TurnTaskOutcome {
                        reason_code: result.err().map(|error| reason_from_core_error(&error)),
                        cleanup,
                        no_core_work: false,
                        handoff_cleanup_failed: false,
                    }
                });

                boundary_entered_rx
                    .await
                    .expect("first generation fully cleaned up");
                assert_eq!(current_generation.get(), None);
                assert!(!control.active(Generation(1)));
                assert_eq!(
                    *control
                        .shared
                        .started_generations
                        .lock()
                        .expect("first generation started"),
                    vec![1]
                );

                let (tx, rx) = mpsc::unbounded_channel();
                let (status_tx, mut status_rx) = mpsc::unbounded_channel();
                let mut actor = NativeVoiceActor::new_test(tx.clone(), status_tx);
                actor.status.phase = NativeVoicePhase::Listening;
                actor.status.generation = Some(92);
                actor.active = Some(ActiveTurn {
                    ui_generation: 92,
                    continuous: true,
                    _handoff_generation: None,
                    control: DesktopCaptureControl::Deterministic(control.clone()),
                    current_core_generation: Rc::clone(&current_generation),
                    shutdown_requested: Rc::new(Cell::new(false)),
                    cancellation,
                    handoff_slot: Rc::new(RefCell::new(None)),
                    task: Some(task),
                    panic_cleanup_started: false,
                    expected_terminal: false,
                });
                let actor_task = tokio::task::spawn_local(run_actor_loop(actor, rx));

                let (cancel_reply, cancel_result) = oneshot::channel();
                tx.send(ActorCommand::Cancel {
                    request: NativeVoiceControlRequest {
                        generation: 92,
                        reason: NativeVoiceStopReason::UserRequest,
                    },
                    reply: cancel_reply,
                })
                .expect("cancel between background iterations through actor");
                assert_eq!(
                    cancel_result
                        .await
                        .expect("cancel response")
                        .expect("cancel")
                        .phase,
                    NativeVoicePhase::Stopping
                );
                release_between_iterations
                    .send(())
                    .expect("allow completed generation loop to observe cancellation");

                let completed = loop {
                    let status = status_rx.recv().await.expect("actor completion status");
                    if status.generation.is_none() {
                        break status;
                    }
                };
                assert_eq!(completed.phase, NativeVoicePhase::Idle);
                assert_eq!(
                    *control
                        .shared
                        .started_generations
                        .lock()
                        .expect("background generation list"),
                    vec![1],
                    "cancellation before the next loop iteration prevents another capture"
                );
                let cleanup = captured_summary.borrow();
                let cleanup = cleanup.as_ref().expect("actual actor-owned task report");
                assert_eq!(cleanup.invocations, 1);
                assert_eq!(cleanup.last_generation, Some(Generation(1)));
                assert_eq!(current_generation.get(), None);

                let (shutdown_reply, shutdown_result) = std::sync::mpsc::channel();
                tx.send(ActorCommand::Shutdown {
                    reply: shutdown_reply,
                })
                .expect("stop headless actor after background task completion");
                actor_task.await.expect("actor exits after shutdown");
                assert_eq!(shutdown_result.try_recv().expect("shutdown result"), Ok(()));
            })
            .await;
    }

    #[cfg(desktop)]
    #[test]
    fn multi_generation_summary_keeps_missing_reports_sticky() {
        let mut summary = CoreCleanupSummary::default();
        summary.record(Generation(1), None, true);
        assert_eq!(summary.invocations, 1);
        assert_eq!(summary.last_generation, Some(Generation(1)));
        assert!(summary.failed_for_task(false));

        summary.record(Generation(2), None, true);
        assert_eq!(summary.invocations, 2);
        assert_eq!(summary.last_generation, Some(Generation(2)));
        assert!(summary.failed_for_task(false));
    }

    #[cfg(desktop)]
    #[test]
    fn later_clean_generation_does_not_erase_earlier_cleanup_failure() {
        use aurora_voice_core::CleanupCallbackOutcome::{ReturnedError, ReturnedOk};

        let mut summary = CoreCleanupSummary::default();
        let mut first = [ReturnedOk; 8];
        first[1] = ReturnedError;
        first[7] = aurora_voice_core::CleanupCallbackOutcome::NotAttempted;
        let mut second = [ReturnedOk; 8];
        second[7] = aurora_voice_core::CleanupCallbackOutcome::NotAttempted;
        summary.record_values(Generation(1), true, true, false, first);
        summary.record_values(Generation(2), true, true, false, second);

        assert_eq!(summary.invocations, 2);
        assert_eq!(summary.last_generation, Some(Generation(2)));
        assert!(summary.capture_start_attempted);
        assert!(summary.assistant_transport_attempted);
        assert!(summary.failed_for_task(false));
    }

    #[cfg(desktop)]
    struct ReportTestAudio {
        start_fails: bool,
    }

    #[cfg(desktop)]
    #[async_trait::async_trait(?Send)]
    impl AudioInput for ReportTestAudio {
        async fn start(&mut self, _lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
            if self.start_fails {
                Err(VoiceCoreError::TransportFault {
                    code: "scripted_capture_start_failure".to_owned(),
                })
            } else {
                Ok(())
            }
        }

        async fn stop(&mut self, _reason: TransitionReason) -> Result<(), VoiceCoreError> {
            Ok(())
        }

        async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
            Ok(None)
        }

        fn current_route_revision(&self) -> RouteRevision {
            RouteRevision(1)
        }
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    struct BackgroundTestVad {
        binding: TaskPackBinding,
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[async_trait::async_trait(?Send)]
    impl TaskProvider for BackgroundTestVad {
        fn capabilities(&self) -> Vec<TaskCapability> {
            vec![TaskCapability::new(self.binding.clone()).streaming(true)]
        }

        fn resource_report(&self) -> ResourceReport {
            ResourceReport {
                loaded_tasks: vec![aurora_voice_engine::VoiceTask::VoiceActivityDetection],
                memory_bytes: 0,
                active_streams: 0,
                readiness: aurora_voice_engine::TaskReadiness::Ready,
            }
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

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[async_trait::async_trait(?Send)]
    impl VadStreamProvider for BackgroundTestVad {
        async fn start_vad_session(
            &mut self,
            request: BoundVadRequest,
        ) -> Result<BoundStreamSession, EngineError> {
            BoundStreamSession::new(
                aurora_voice_engine::StreamSessionId(request.request().request().generation),
                request.request(),
            )
        }

        async fn push_vad_frame(
            &mut self,
            _session: &BoundStreamSession,
            _frame: aurora_voice_engine::StreamingAudioFrame<'_>,
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

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    struct BackgroundTestKws {
        binding: TaskPackBinding,
        config: KwsConfig,
        cooldown: aurora_voice_engine::KwsCooldownState,
        pause: Rc<RefCell<Option<ReportTestPause>>>,
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[async_trait::async_trait(?Send)]
    impl TaskProvider for BackgroundTestKws {
        fn capabilities(&self) -> Vec<TaskCapability> {
            vec![TaskCapability::new(self.binding.clone()).streaming(true)]
        }

        fn resource_report(&self) -> ResourceReport {
            ResourceReport {
                loaded_tasks: vec![aurora_voice_engine::VoiceTask::KeywordSpotting],
                memory_bytes: 0,
                active_streams: 0,
                readiness: aurora_voice_engine::TaskReadiness::Ready,
            }
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

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    #[async_trait::async_trait(?Send)]
    impl KwsStreamProvider for BackgroundTestKws {
        async fn start_kws_session(
            &mut self,
            request: BoundKwsRequest,
        ) -> Result<BoundStreamSession, EngineError> {
            BoundStreamSession::new(
                aurora_voice_engine::StreamSessionId(request.request().request().generation),
                request.request(),
            )
        }

        async fn push_kws_frame(
            &mut self,
            _session: &BoundStreamSession,
            _frame: aurora_voice_engine::StreamingAudioFrame<'_>,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<KwsFrameResult, EngineError> {
            KwsFrameResult::new(&self.config, &mut self.cooldown, Vec::new(), None)
        }

        async fn reset_kws_session(
            &mut self,
            session: &BoundStreamSession,
            _reason: StreamResetReason,
        ) -> Result<(), EngineError> {
            let pending = {
                let mut pause = self.pause.borrow_mut();
                if pause
                    .as_ref()
                    .is_some_and(|pause| pause.generation == session.generation())
                {
                    pause.take()
                } else {
                    None
                }
            };
            if let Some(pause) = pending {
                let generation = session.generation();
                let _ = pause.entered.send(generation);
                let _ = pause.release.await;
            }
            Ok(())
        }
    }

    #[cfg(desktop)]
    struct ReportTestStt {
        cancel_results: Rc<RefCell<std::collections::VecDeque<bool>>>,
        cancelled: Rc<RefCell<Vec<u64>>>,
        pause: Rc<RefCell<Option<ReportTestPause>>>,
    }

    #[cfg(desktop)]
    struct ReportTestPause {
        generation: u64,
        entered: oneshot::Sender<u64>,
        release: oneshot::Receiver<()>,
    }

    #[cfg(desktop)]
    #[async_trait::async_trait(?Send)]
    impl FiniteSttPort for ReportTestStt {
        fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
            Err(EngineError::InvalidRequest)
        }

        async fn warm_finite_stt(
            &mut self,
            _binding: FiniteSttProviderBinding,
        ) -> Result<(), EngineError> {
            Err(EngineError::InvalidRequest)
        }

        async fn transcribe_finite(
            &mut self,
            _request: BoundFiniteSttRequest,
            _audio: FiniteSttAudio,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<FiniteSttResult, EngineError> {
            Err(EngineError::InvalidRequest)
        }

        async fn cancel_finite_stt_generation(
            &mut self,
            generation: u64,
        ) -> Result<(), EngineError> {
            self.cancelled.borrow_mut().push(generation);
            let pause = {
                let mut pending = self.pause.borrow_mut();
                if pending
                    .as_ref()
                    .is_some_and(|pause| pause.generation == generation)
                {
                    pending.take()
                } else {
                    None
                }
            };
            if let Some(pause) = pause {
                let _ = pause.entered.send(generation);
                let _ = pause.release.await;
            }
            if self
                .cancel_results
                .borrow_mut()
                .pop_front()
                .unwrap_or(false)
            {
                Err(EngineError::InvalidRequest)
            } else {
                Ok(())
            }
        }
    }

    #[cfg(desktop)]
    struct ReportTestTts;

    #[cfg(desktop)]
    #[async_trait::async_trait(?Send)]
    impl TtsSynthesisPort for ReportTestTts {
        fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
            Err(EngineError::InvalidRequest)
        }

        async fn warm_synthesis(
            &mut self,
            _binding: TtsSynthesisProviderBinding,
        ) -> Result<(), EngineError> {
            Err(EngineError::InvalidRequest)
        }

        async fn synthesize_text(
            &mut self,
            _request: BoundTtsSynthesisRequest,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<TtsSynthesisResult, EngineError> {
            Err(EngineError::InvalidRequest)
        }

        async fn cancel_synthesis_generation(
            &mut self,
            _generation: u64,
        ) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[cfg(desktop)]
    struct ReportTestTransport;

    #[cfg(desktop)]
    #[async_trait::async_trait(?Send)]
    impl aurora_voice_core::SpeechTransport for ReportTestTransport {
        async fn assistant_turn(
            &mut self,
            _request: aurora_voice_core::AssistantTurnRequest,
            _cancellation: CancellationToken,
        ) -> Result<aurora_voice_core::AssistantTurnResponse, VoiceCoreError> {
            Err(VoiceCoreError::Cancelled)
        }

        async fn cancel_session(&mut self, _generation: Generation) -> Result<(), VoiceCoreError> {
            Ok(())
        }
    }

    #[cfg(desktop)]
    struct ReportTestOutput;

    #[cfg(desktop)]
    #[async_trait::async_trait(?Send)]
    impl aurora_voice_core::AudioOutput for ReportTestOutput {
        async fn play(
            &mut self,
            _context: aurora_voice_core::AudioPlaybackContext,
            _audio: TtsSynthesisResult,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<aurora_voice_core::AudioPlaybackReceipt, VoiceCoreError> {
            Err(VoiceCoreError::Cancelled)
        }

        async fn stop(
            &mut self,
            _generation: Generation,
            _reason: TransitionReason,
        ) -> Result<(), VoiceCoreError> {
            Ok(())
        }
    }

    #[cfg(desktop)]
    struct ReportTestSink;

    #[cfg(desktop)]
    #[async_trait::async_trait(?Send)]
    impl RuntimeEventSink for ReportTestSink {
        async fn snapshot(&mut self, _snapshot: RedactedSnapshot) -> Result<(), VoiceCoreError> {
            Ok(())
        }

        async fn event(&mut self, _event: RuntimeEvent) -> Result<(), VoiceCoreError> {
            Ok(())
        }
    }

    #[cfg(desktop)]
    type ReportTestRuntime = VoiceRuntime<
        ReportTestAudio,
        ReportTestStt,
        ReportTestTts,
        ReportTestTransport,
        ReportTestOutput,
        ReportTestSink,
    >;

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    type BackgroundTestRuntime = VoiceRuntime<
        DeterministicE2eAudioInput,
        ReportTestStt,
        ReportTestTts,
        ReportTestTransport,
        ReportTestOutput,
        ReportTestSink,
    >;

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    fn paused_background_test_runtime(
        pause_generation: u64,
        pause_kws_reset: bool,
    ) -> (
        BackgroundTestRuntime,
        DeterministicE2eCaptureControl,
        oneshot::Receiver<u64>,
        oneshot::Sender<()>,
    ) {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let audio = DeterministicE2eAudioInput::new().with_frame_limit(1);
        let (audio, kws_pause) = if pause_kws_reset {
            (
                audio,
                Some(ReportTestPause {
                    generation: pause_generation,
                    entered: entered_tx,
                    release: release_rx,
                }),
            )
        } else {
            (
                audio.pause_next_frame(pause_generation, entered_tx, release_rx),
                None,
            )
        };
        let control = audio.control();
        let catalog = SpeechModelCatalog::embedded().expect("embedded speech catalog");
        let vad_entry = catalog
            .models_for_task(SpeechCatalogTask::VoiceActivityDetection)
            .into_iter()
            .next()
            .expect("catalog VAD entry");
        let kws_entry = catalog
            .models_for_task(SpeechCatalogTask::KeywordSpotting)
            .into_iter()
            .next()
            .expect("catalog KWS entry");
        let vad_binding = TaskPackBinding::from_speech_catalog_entry(
            catalog,
            vad_entry,
            aurora_voice_engine::RuntimeTarget::Desktop,
            aurora_voice_engine::TargetOs::Linux,
            aurora_voice_engine::TargetArch::X86_64,
        )
        .expect("catalog VAD binding");
        let kws_binding = TaskPackBinding::from_speech_catalog_entry(
            catalog,
            kws_entry,
            aurora_voice_engine::RuntimeTarget::Desktop,
            aurora_voice_engine::TargetOs::Linux,
            aurora_voice_engine::TargetArch::X86_64,
        )
        .expect("catalog KWS binding");
        let kws_config =
            KwsConfig::new(["wake.test"], "phrases:test", 0.5, 0, 1).expect("wake KWS config");
        let wake_config = WakeOrchestrationConfig::new(
            vad_binding.clone(),
            kws_binding.clone(),
            VadConfig::default(),
            kws_config.clone(),
            2,
            2,
        )
        .expect("wake orchestration config");
        let core = VoiceRuntime::new(
            audio,
            ReportTestStt {
                cancel_results: Rc::new(RefCell::new(std::collections::VecDeque::new())),
                cancelled: Rc::new(RefCell::new(Vec::new())),
                pause: Rc::new(RefCell::new(None)),
            },
            ReportTestTts,
            ReportTestTransport,
            ReportTestOutput,
            ReportTestSink,
            "desktop",
            "native-background-report-test",
        )
        .expect("scripted background runtime")
        .with_wake_providers(
            Box::new(BackgroundTestVad {
                binding: vad_binding,
            }),
            Box::new(BackgroundTestKws {
                binding: kws_binding,
                config: kws_config,
                cooldown: aurora_voice_engine::KwsCooldownState::new(),
                pause: Rc::new(RefCell::new(kws_pause)),
            }),
            wake_config,
        )
        .expect("scripted wake providers");
        (core, control, entered_rx, release_tx)
    }

    #[cfg(desktop)]
    fn report_test_runtime(
        cancel_errors: impl IntoIterator<Item = bool>,
    ) -> (ReportTestRuntime, Rc<RefCell<Vec<u64>>>) {
        let cancelled = Rc::new(RefCell::new(Vec::new()));
        let core = VoiceRuntime::new(
            ReportTestAudio { start_fails: false },
            ReportTestStt {
                cancel_results: Rc::new(RefCell::new(cancel_errors.into_iter().collect())),
                cancelled: Rc::clone(&cancelled),
                pause: Rc::new(RefCell::new(None)),
            },
            ReportTestTts,
            ReportTestTransport,
            ReportTestOutput,
            ReportTestSink,
            "desktop",
            "native-voice-report-test",
        )
        .expect("scripted public runtime ports are valid");
        (core, cancelled)
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    fn paused_report_test_runtime(
        cancel_errors: impl IntoIterator<Item = bool>,
        pause_generation: u64,
    ) -> (
        ReportTestRuntime,
        Rc<RefCell<Vec<u64>>>,
        oneshot::Receiver<u64>,
        oneshot::Sender<()>,
    ) {
        let cancelled = Rc::new(RefCell::new(Vec::new()));
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let core = VoiceRuntime::new(
            ReportTestAudio { start_fails: false },
            ReportTestStt {
                cancel_results: Rc::new(RefCell::new(cancel_errors.into_iter().collect())),
                cancelled: Rc::clone(&cancelled),
                pause: Rc::new(RefCell::new(Some(ReportTestPause {
                    generation: pause_generation,
                    entered: entered_tx,
                    release: release_rx,
                }))),
            },
            ReportTestTts,
            ReportTestTransport,
            ReportTestOutput,
            ReportTestSink,
            "desktop",
            "native-voice-report-test",
        )
        .expect("scripted public runtime ports are valid");
        (core, cancelled, entered_rx, release_tx)
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    type ReportTestE2eRuntime = VoiceRuntime<
        DeterministicE2eAudioInput,
        ReportTestStt,
        ReportTestTts,
        ReportTestTransport,
        ReportTestOutput,
        ReportTestSink,
    >;

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    fn paused_report_test_e2e_runtime(
        cancel_errors: impl IntoIterator<Item = bool>,
        pause_generation: u64,
    ) -> (
        ReportTestE2eRuntime,
        Rc<RefCell<Vec<u64>>>,
        oneshot::Receiver<u64>,
        oneshot::Sender<()>,
        DeterministicE2eCaptureControl,
    ) {
        let cancelled = Rc::new(RefCell::new(Vec::new()));
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let audio = DeterministicE2eAudioInput::new();
        let control = audio.control();
        let core = VoiceRuntime::new(
            audio,
            ReportTestStt {
                cancel_results: Rc::new(RefCell::new(cancel_errors.into_iter().collect())),
                cancelled: Rc::clone(&cancelled),
                pause: Rc::new(RefCell::new(Some(ReportTestPause {
                    generation: pause_generation,
                    entered: entered_tx,
                    release: release_rx,
                }))),
            },
            ReportTestTts,
            ReportTestTransport,
            ReportTestOutput,
            ReportTestSink,
            "desktop",
            "native-voice-report-test",
        )
        .expect("scripted public runtime ports are valid");
        (core, cancelled, entered_rx, release_tx, control)
    }

    #[cfg(desktop)]
    fn cancelled_transcription_lease() -> VoiceCaptureLease {
        VoiceCaptureLease {
            owner: aurora_voice_core::CaptureOwnerKind::Native,
            surface: "desktop".to_owned(),
            device_route: "default".to_owned(),
            start_reason: CaptureStartReason::PushToTalk,
            generation: Generation(0),
            created_at: TimestampMicros(1),
            route_revision: RouteRevision(1),
            background_eligible: false,
            consent_revision: 0,
            heartbeat_at: TimestampMicros(1),
            stop_deadline: None,
        }
    }

    #[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
    fn e2e_transcription_lease() -> VoiceCaptureLease {
        let mut lease = cancelled_transcription_lease();
        lease.device_route = DEVICE_ROUTE.to_owned();
        lease
    }

    #[cfg(desktop)]
    async fn run_scripted_cancelled_generation(
        core: &mut ReportTestRuntime,
        current_generation: &Rc<Cell<Option<Generation>>>,
        summary: &mut CoreCleanupSummary,
    ) -> Result<String, VoiceCoreError> {
        run_core_generation(core, current_generation, summary, |core| {
            let cancellation = CancellationToken::new();
            cancellation.cancel();
            Box::pin(core.run_push_to_talk_transcription(
                cancelled_transcription_lease(),
                TimestampMicros(1),
                cancellation,
            ))
        })
        .await
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn actual_core_reports_aggregate_across_generations_and_keep_early_failure_sticky() {
        use aurora_voice_core::CleanupCallbackOutcome::{ReturnedError, ReturnedOk};

        let (mut core, cancelled) = report_test_runtime([true, false]);
        let binding = Rc::new(Cell::new(None));
        let mut summary = CoreCleanupSummary::default();

        assert!(
            run_scripted_cancelled_generation(&mut core, &binding, &mut summary)
                .await
                .is_err()
        );
        let first = core
            .cleanup_report_for_generation(Generation(1))
            .expect("VoiceRuntime produced generation one cleanup report");
        assert_eq!(first.generation(), Generation(1));
        assert_eq!(first.stt_cancel(), ReturnedError);
        assert_eq!(first.capture_lease_release(), ReturnedOk);
        assert_eq!(first.state_reset(), ReturnedOk);
        assert_eq!(
            first.capture_stop(),
            aurora_voice_core::CleanupCallbackOutcome::NotAttempted
        );

        assert!(
            run_scripted_cancelled_generation(&mut core, &binding, &mut summary)
                .await
                .is_err()
        );
        let second = core
            .cleanup_report_for_generation(Generation(2))
            .expect("VoiceRuntime produced generation two cleanup report");
        assert_eq!(second.generation(), Generation(2));
        assert_eq!(second.stt_cancel(), ReturnedOk);
        assert_eq!(second.capture_lease_release(), ReturnedOk);
        assert_eq!(
            second.state_reset(),
            aurora_voice_core::CleanupCallbackOutcome::ReturnedOk
        );
        assert_eq!(&*cancelled.borrow(), &[1, 2]);
        assert_eq!(summary.invocations, 2);
        assert_eq!(summary.last_generation, Some(Generation(2)));
        assert!(summary.failed_for_task(false));

        summary.record_handoff_cleanup_failure(false);
        assert!(summary.failed_for_task(false));
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn actual_core_report_mismatch_missing_report_and_handoff_failure_fail_closed() {
        let (mut core, _) = report_test_runtime([false, false]);
        let binding = Rc::new(Cell::new(None));
        let mut actual_summary = CoreCleanupSummary::default();

        assert!(
            run_scripted_cancelled_generation(&mut core, &binding, &mut actual_summary)
                .await
                .is_err()
        );
        let actual = core
            .cleanup_report_for_generation(Generation(1))
            .expect("actual core report");
        assert!(!actual_summary.failed_for_task(false));

        let mut mismatched = CoreCleanupSummary::default();
        mismatched.record(Generation(2), Some(actual), true);
        assert_eq!(mismatched.last_generation, Some(Generation(2)));
        assert!(mismatched.failed_for_task(false));

        let mut missing = CoreCleanupSummary::default();
        missing.record(Generation(1), None, true);
        assert!(missing.failed_for_task(false));

        let mut missing_state_reset = [aurora_voice_core::CleanupCallbackOutcome::ReturnedOk; 8];
        missing_state_reset[7] = aurora_voice_core::CleanupCallbackOutcome::NotAttempted;
        let mut failed_state_reset = CoreCleanupSummary::default();
        failed_state_reset.record_values(Generation(1), true, false, true, missing_state_reset);
        assert!(failed_state_reset.failed_for_task(false));

        assert!(
            run_scripted_cancelled_generation(&mut core, &binding, &mut actual_summary)
                .await
                .is_err()
        );
        assert!(!actual_summary.failed_for_task(false));
        actual_summary.record_handoff_cleanup_failure(true);
        assert!(actual_summary.failed_for_task(false));
        actual_summary.record_handoff_cleanup_failure(false);
        assert!(actual_summary.failed_for_task(false));
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn attempted_capture_without_a_successful_stop_is_not_a_clean_summary() {
        use aurora_voice_core::CleanupCallbackOutcome::ReturnedOk;

        let core = VoiceRuntime::new(
            ReportTestAudio { start_fails: true },
            ReportTestStt {
                cancel_results: Rc::new(RefCell::new(std::collections::VecDeque::new())),
                cancelled: Rc::new(RefCell::new(Vec::new())),
                pause: Rc::new(RefCell::new(None)),
            },
            ReportTestTts,
            ReportTestTransport,
            ReportTestOutput,
            ReportTestSink,
            "desktop",
            "native-voice-start-failure-test",
        )
        .expect("scripted public runtime ports are valid");
        let mut core = core;
        let binding = Rc::new(Cell::new(None));
        let mut summary = CoreCleanupSummary::default();
        let result = run_core_generation(&mut core, &binding, &mut summary, |core| {
            Box::pin(core.run_push_to_talk_transcription(
                cancelled_transcription_lease(),
                TimestampMicros(1),
                CancellationToken::new(),
            ))
        })
        .await;

        assert!(result.is_err());
        let report = core
            .cleanup_report_for_generation(Generation(1))
            .expect("VoiceRuntime report for attempted capture");
        assert!(report.capture_start_attempted());
        assert_eq!(
            report.capture_stop(),
            aurora_voice_core::CleanupCallbackOutcome::NotAttempted
        );
        assert_eq!(report.capture_lease_release(), ReturnedOk);
        assert!(summary.failed_for_task(false));
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn matching_completion_message_does_not_replace_owned_task_join() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (tx, mut rx) = mpsc::unbounded_channel();
                let (release_tx, release_rx) = tokio::sync::oneshot::channel();
                let task_tx = tx.clone();
                let mut task = tokio::task::spawn_local(async move {
                    let _ = task_tx.send(ActorCommand::TurnFinished { ui_generation: 17 });
                    let _ = release_rx.await;
                    successful_test_turn()
                });
                let first = wait_for_actor_event(&mut rx, Some(&mut task), None).await;
                assert!(matches!(
                    first,
                    ActorLoopEvent::Command(Some(ActorCommand::TurnFinished { ui_generation: 17 }))
                ));
                assert!(!task.is_finished());
                let deadline = TokioInstant::now();
                assert!(matches!(
                    wait_for_actor_event(&mut rx, Some(&mut task), Some(deadline)).await,
                    ActorLoopEvent::Deadline
                ));
                assert!(
                    !task.is_finished(),
                    "deadline must not detach or drop the task"
                );
                release_tx.send(()).expect("finish owned turn");
                let result = wait_for_actor_event(&mut rx, Some(&mut task), None).await;
                assert!(matches!(
                    result,
                    ActorLoopEvent::TaskFinished(Ok(TurnTaskOutcome { .. }))
                ));
            })
            .await;
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn actor_observes_task_panic_without_completion_message() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (tx, mut rx) = mpsc::unbounded_channel();
                let task_tx = tx.clone();
                let mut task = tokio::task::spawn_local(async move {
                    drop(task_tx);
                    panic_in_test_turn().await
                });
                assert!(matches!(
                    wait_for_actor_event(&mut rx, Some(&mut task), None).await,
                    ActorLoopEvent::TaskFinished(Err(_))
                ));
                assert!(rx.try_recv().is_err(), "no completion message was sent");
            })
            .await;
    }

    #[cfg(desktop)]
    #[tokio::test(flavor = "current_thread")]
    async fn panic_handoff_recovery_stays_actor_polled_across_shutdown_and_deadline() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (handoff_slot, release_started, release_continue, restart_requests, server) =
                    blocking_release_handoff().await;
                let binding = Rc::new(Cell::new(None));
                let task = tokio::task::spawn_local(panic_in_test_turn());
                let (tx, rx) = mpsc::unbounded_channel();
                let (status_tx, mut status_rx) = mpsc::unbounded_channel();
                let mut actor = NativeVoiceActor::new_test(tx.clone(), status_tx);
                actor.shutdown_timeout = Duration::ZERO;
                actor.status.phase = NativeVoicePhase::Speaking;
                actor.status.generation = Some(71);
                actor.active = Some(ActiveTurn {
                    ui_generation: 71,
                    continuous: false,
                    _handoff_generation: Some(Generation(1)),
                    control: DesktopCaptureControl::Test(Arc::new(Mutex::new(Vec::new()))),
                    current_core_generation: Rc::clone(&binding),
                    shutdown_requested: Rc::new(Cell::new(false)),
                    cancellation: CancellationToken::new(),
                    handoff_slot,
                    task: Some(task),
                    panic_cleanup_started: false,
                    expected_terminal: false,
                });
                tx.send(ActorCommand::TurnFinished { ui_generation: 71 })
                    .expect("early completion wakeup arrives before task join");
                let actor_task = tokio::task::spawn_local(run_actor_loop(actor, rx));
                release_started
                    .await
                    .expect("actual Gateway handoff release started");

                let (shutdown_reply, shutdown_result) = std::sync::mpsc::channel();
                tx.send(ActorCommand::Shutdown {
                    reply: shutdown_reply,
                })
                .expect("dispatch shutdown while actual actor cleanup is pending");
                let deadline_status = loop {
                    let status = status_rx.recv().await.expect("actor status");
                    if status.phase == NativeVoicePhase::Faulted && status.generation.is_none() {
                        break status;
                    }
                };
                assert_eq!(
                    deadline_status.reason_code.as_deref(),
                    Some("local_cleanup_failed")
                );
                assert!(matches!(
                    shutdown_result.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Empty)
                ));

                release_continue
                    .send(())
                    .expect("finish actual release response");
                actor_task
                    .await
                    .expect("actor loop exits after owned cleanup");
                assert_eq!(
                    shutdown_result.try_recv().expect("actor shutdown result"),
                    Err(NativeVoiceStopError::TimedOut)
                );
                assert_eq!(
                    [
                        restart_requests.recv().expect("initial release mode"),
                        restart_requests.recv().expect("retry cleanup mode"),
                    ],
                    [true, false],
                    "shutdown during release disables the subsequent cleanup restart"
                );
                server.join().expect("join local Gateway fixture");
            })
            .await;
    }

    #[cfg(desktop)]
    async fn panic_in_test_turn() -> TurnTaskOutcome {
        panic!("controlled native turn panic");
    }

    #[test]
    fn late_runtime_phase_cannot_regress_after_terminal_request() {
        assert!(!control_requires_terminal_suppression(false));
        assert!(control_requires_terminal_suppression(true));
        assert!(!late_phase_allowed(false, NativeVoicePhase::Idle));
        assert!(late_phase_allowed(false, NativeVoicePhase::Processing));
        assert!(late_phase_allowed(true, NativeVoicePhase::Stopping));
        assert!(!late_phase_allowed(true, NativeVoicePhase::Processing));
        assert!(!late_phase_allowed(true, NativeVoicePhase::Speaking));
        assert!(!late_phase_allowed(true, NativeVoicePhase::Listening));
    }

    #[test]
    fn tray_toggle_policy_finishes_listening_or_starts_idle() {
        assert_eq!(
            tray_decision(NativeVoicePhase::Listening),
            TrayDecision::Finish
        );
        assert_eq!(tray_decision(NativeVoicePhase::Idle), TrayDecision::Start);
        assert_eq!(
            tray_decision(NativeVoicePhase::Processing),
            TrayDecision::Noop
        );
    }

    #[test]
    fn random_prepare_lease_token_is_high_entropy_sized() {
        let token = random_prepare_lease_token().expect("token");
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn native_voice_permission_is_scoped_to_main_and_thin_desktop_capabilities() {
        let permission = include_str!("../permissions/aurora-native-voice.toml");
        for command in [
            "aurora_native_voice_status",
            "aurora_native_voice_start",
            "aurora_native_voice_finish",
            "aurora_native_voice_cancel",
        ] {
            assert!(permission.contains(command), "{command}");
        }
        let main = include_str!("../capabilities/aurora-main.json");
        let thin = include_str!("../capabilities/aurora-thin.json");
        let overlay = include_str!("../capabilities/aurora-overlay.json");
        let android = include_str!("../capabilities/aurora-android-thin.json");
        let ios = include_str!("../capabilities/aurora-ios-thin.json");
        let e2e_permission = include_str!("../permissions/aurora-native-voice-e2e.toml");
        let e2e_config = include_str!("../tauri.desktop-native-voice-e2e.conf.json");
        let build_manifest = include_str!("../build.rs");
        assert!(main.contains("aurora-native-voice"));
        assert!(thin.contains("aurora-native-voice"));
        assert!(!overlay.contains("aurora-native-voice"));
        assert!(!android.contains("aurora-native-voice"));
        assert!(!ios.contains("aurora-native-voice"));
        assert!(e2e_permission.contains("aurora_native_voice_tray_toggle_e2e"));
        assert!(e2e_config.contains("aurora-native-voice-e2e"));
        assert!(build_manifest.contains("aurora_native_voice_tray_toggle_e2e"));
        assert!(!main.contains("aurora-native-voice-e2e"));
        assert!(!thin.contains("aurora-native-voice-e2e"));
    }
}

#[cfg(test)]
fn test_webrtc_profile(expected_stable_peer_id: &str) -> WebRtcProfile {
    WebRtcProfile {
        _mode: "webrtc-preferred".to_owned(),
        _app_id: "aurora".to_owned(),
        _room: "room".to_owned(),
        _room_secret_ref: "secret-ref".to_owned(),
        _signaling_brokers: vec!["wss://signal.example.test".to_owned()],
        expected_stable_peer_id: Some(expected_stable_peer_id.to_owned()),
        _expected_signaling_peer_id: None,
        _node_name: None,
        _production: None,
        _allow_insecure_loopback_signaling: None,
        _require_app_layer_e2ee: None,
        _stun_servers: None,
        _turn_servers: None,
    }
}

#[cfg(test)]
fn test_runtime_profile_document(mode: &str, home_peer_id: Option<&str>) -> ThinProfileDocument {
    ThinProfileDocument::V2(RuntimeProfileDocumentV2 {
        version: 2,
        active_profile_id: Some("p2".to_owned()),
        profiles: vec![RuntimeProfileV2 {
            version: 2,
            id: "p2".to_owned(),
            _label: "Home".to_owned(),
            node_mode: "remote-console".to_owned(),
            runtime_tier: "none".to_owned(),
            home_connection: Some(HomeConnectionProfile {
                mode: mode.to_owned(),
                gateway_url: Some("https://gateway.example.test".to_owned()),
                _signaling_url: Some("wss://signal.example.test".to_owned()),
                home_peer_id: home_peer_id.map(str::to_owned),
                webrtc_profile: home_peer_id.map(test_webrtc_profile),
            }),
            local_node: LocalNodeProfile {
                _node_name: "Thin".to_owned(),
                _stable_peer_id: "local-thin-peer".to_owned(),
                _enabled_capability_packs: Vec::new(),
                _local_speech_pack_state: None,
                local_speech_selection: None,
                _mesh_membership: None,
            },
        }],
    })
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum TrayDecision {
    Start,
    Finish,
    Noop,
}

#[cfg(test)]
fn tray_decision(phase: NativeVoicePhase) -> TrayDecision {
    match phase {
        NativeVoicePhase::Idle => TrayDecision::Start,
        NativeVoicePhase::Listening => TrayDecision::Finish,
        _ => TrayDecision::Noop,
    }
}

#[cfg(test)]
fn accepted_start_status(
    ui_generation: u64,
    connection: NativeVoiceConnection,
) -> NativeVoiceStatus {
    NativeVoiceStatus {
        available: true,
        phase: NativeVoicePhase::Starting,
        generation: Some(ui_generation),
        background_eligible: false,
        connection,
        reason_code: None,
        redacted: true,
    }
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum PrepareErrorOutcome {
    ReturnOriginalError,
    ReturnCleanupError,
}

#[cfg(test)]
fn prepare_error_outcome(prepare_failed: bool, cleanup_failed: bool) -> PrepareErrorOutcome {
    debug_assert!(prepare_failed);
    if cleanup_failed {
        PrepareErrorOutcome::ReturnCleanupError
    } else {
        PrepareErrorOutcome::ReturnOriginalError
    }
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
enum PrepareTimeoutOutcome {
    ReturnPrepareTimeout,
    ReturnCleanupError,
}

#[cfg(test)]
fn prepare_timeout_outcome(cleanup_failed: bool) -> PrepareTimeoutOutcome {
    if cleanup_failed {
        PrepareTimeoutOutcome::ReturnCleanupError
    } else {
        PrepareTimeoutOutcome::ReturnPrepareTimeout
    }
}

#[cfg(test)]
fn worst_case_queued_shutdown_before_stop_wait() -> Duration {
    HANDOFF_OPERATION_TIMEOUT
        + HANDOFF_RECOVERY_TIMEOUT
        + SHUTDOWN_CLEANUP_TIMEOUT
        + HANDOFF_OPERATION_TIMEOUT
        + HANDOFF_OPERATION_TIMEOUT
}

fn late_phase_allowed(expected_terminal: bool, phase: NativeVoicePhase) -> bool {
    !matches!(phase, NativeVoicePhase::Idle)
        && (!expected_terminal || matches!(phase, NativeVoicePhase::Stopping))
}

fn control_requires_terminal_suppression(cancel: bool) -> bool {
    cancel
}
