use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(desktop)]
use {
    async_trait::async_trait,
    aurora_voice_core::{
        AudioInput, CancellationToken, CaptureStartReason, Generation, PcmFrame, RedactedSnapshot,
        RouteRevision, RuntimeEvent, RuntimeEventSink, TimestampMicros, TransitionReason,
        VoiceCaptureLease, VoiceCoreError, VoiceRuntime, VoiceState, WakeKwsProvider,
        WakeOrchestrationConfig, WakeVadProvider,
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
        build_installed_vad_provider, CpalAudioInput, CpalAudioOutput, GatewayAuth,
        MicrophoneAudioPolicy, NativeAudioConfig, NativeCaptureConfig, NativeCaptureControl,
        NativeGatewayCaptureGrant, NativeGatewayCaptureHandoff, NativeGatewayCaptureHandoffConfig,
        NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig, NativeGatewayTransport,
        NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer, SpeechPackManager,
        SpeechPackManagerConfig, TransportLimits, NATIVE_WAKE_KWS_THRESHOLD,
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
    inner: Arc<Mutex<Option<NativeVoiceHandle>>>,
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
                if guard.is_none() {
                    *guard = Some(NativeVoiceHandle::spawn(app, sidecar));
                }
            }
        }
    }

    pub fn stop(&self) {
        #[cfg(desktop)]
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(handle) = guard.take() {
                handle.stop();
            }
        }
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
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    #[cfg(desktop)]
    {
        send_actor(&state, |reply| ActorCommand::Start { request, reply }).await
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, request);
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
    state: State<'_, NativeVoiceState>,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    if !cfg!(all(debug_assertions, feature = "desktop-native-voice-e2e"))
        || std::env::var("AURORA_DESKTOP_NATIVE_VOICE_E2E").as_deref() != Ok("1")
    {
        return Err(NativeVoiceCommandError::unavailable(E2E_UNAVAILABLE_REASON));
    }
    #[cfg(desktop)]
    {
        tray_toggle_status(&state).await
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
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
        return send_actor(state, |reply| ActorCommand::Start {
            request: NativeVoiceStartRequest {
                trigger: NativeVoiceTrigger::TrayPushToTalk,
                remote_audio_consent: false,
            },
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
    tauri::async_runtime::spawn(async move {
        let _ = tray_toggle_status(&state).await;
    });
}

#[cfg(desktop)]
async fn send_actor(
    state: &NativeVoiceState,
    build: impl FnOnce(
        oneshot::Sender<Result<NativeVoiceStatus, NativeVoiceCommandError>>,
    ) -> ActorCommand,
) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
    let tx = state
        .inner
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|handle| handle.tx.clone()))
        .ok_or_else(|| NativeVoiceCommandError::unavailable(UNAVAILABLE_REASON))?;
    let (reply, rx) = oneshot::channel();
    tx.send(build(reply))
        .map_err(|_| NativeVoiceCommandError::unavailable(UNAVAILABLE_REASON))?;
    rx.await
        .map_err(|_| NativeVoiceCommandError::unavailable(UNAVAILABLE_REASON))?
}

#[cfg(desktop)]
#[derive(Clone)]
struct NativeVoiceHandle {
    tx: mpsc::UnboundedSender<ActorCommand>,
}

#[cfg(desktop)]
impl NativeVoiceHandle {
    fn spawn(app: AppHandle, sidecar: super::SharedSidecarState) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let thread_tx = tx.clone();
        let builder = thread::Builder::new().name("aurora-native-voice".to_owned());
        builder
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
        Self { tx }
    }

    fn stop(self) {
        let (reply, rx) = std::sync::mpsc::channel();
        let _ = self.tx.send(ActorCommand::Shutdown { reply });
        let _ = rx.recv_timeout(HOST_STOP_WAIT_TIMEOUT);
    }
}

#[cfg(desktop)]
enum ActorCommand {
    Status {
        reply: oneshot::Sender<Result<NativeVoiceStatus, NativeVoiceCommandError>>,
    },
    Start {
        request: NativeVoiceStartRequest,
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
        reason_code: Option<&'static str>,
    },
    Shutdown {
        reply: std::sync::mpsc::Sender<()>,
    },
}

#[cfg(desktop)]
async fn run_actor(
    app: AppHandle,
    sidecar: super::SharedSidecarState,
    tx: mpsc::UnboundedSender<ActorCommand>,
    mut rx: mpsc::UnboundedReceiver<ActorCommand>,
) {
    let mut actor = NativeVoiceActor::new(app, sidecar, tx);
    actor.publish();
    loop {
        if let Some(deadline) = actor.shutdown_deadline {
            tokio::select! {
                command = rx.recv() => {
                    let Some(command) = command else {
                        actor.force_shutdown().await;
                        break;
                    };
                    if actor.handle(command).await {
                        break;
                    }
                }
                _ = sleep_until(deadline) => {
                    actor.force_shutdown().await;
                    break;
                }
            }
        } else {
            let Some(command) = rx.recv().await else {
                break;
            };
            if actor.handle(command).await {
                break;
            }
        }
    }
}

#[cfg(desktop)]
struct NativeVoiceActor {
    app: AppHandle,
    sidecar: super::SharedSidecarState,
    tx: mpsc::UnboundedSender<ActorCommand>,
    status: NativeVoiceStatus,
    sequence: u64,
    next_ui_generation: u64,
    runtime: Rc<RefCell<Option<RuntimeBundle>>>,
    runtime_profile: Option<RuntimeProfileKey>,
    active: Option<ActiveTurn>,
    shutdown_reply: Option<std::sync::mpsc::Sender<()>>,
    shutdown_deadline: Option<TokioInstant>,
}

#[cfg(desktop)]
impl NativeVoiceActor {
    fn new(
        app: AppHandle,
        sidecar: super::SharedSidecarState,
        tx: mpsc::UnboundedSender<ActorCommand>,
    ) -> Self {
        Self {
            app,
            sidecar,
            tx,
            status: NativeVoiceStatus::unavailable(PROFILE_REASON),
            sequence: 0,
            next_ui_generation: 1,
            runtime: Rc::new(RefCell::new(None)),
            runtime_profile: None,
            active: None,
            shutdown_reply: None,
            shutdown_deadline: None,
        }
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
            ActorCommand::Start { request, reply } => {
                let result = self.start(request).await;
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
                if self.active.as_ref().is_some_and(|active| {
                    active.ui_generation == ui_generation
                        && late_phase_allowed(active.expected_terminal, phase)
                }) {
                    self.set_status(phase, Some(ui_generation), reason_code);
                }
                false
            }
            ActorCommand::TurnFinished {
                ui_generation,
                reason_code,
            } => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|active| active.ui_generation == ui_generation)
                {
                    let expected_terminal = self
                        .active
                        .as_ref()
                        .is_some_and(|active| active.expected_terminal);
                    self.active = None;
                    let phase = terminal_phase(reason_code, expected_terminal);
                    self.set_status(
                        phase,
                        None,
                        if matches!(phase, NativeVoicePhase::Faulted) {
                            reason_code
                        } else {
                            None
                        },
                    );
                } else {
                    self.refresh_idle_status();
                }
                if self.shutdown_reply.is_some() {
                    self.ack_shutdown();
                    return true;
                }
                false
            }
            ActorCommand::Shutdown { reply } => {
                if let Some(active) = self.active.as_mut() {
                    active.cancellation.cancel();
                    active.control.interrupt(active.core_generation);
                    active.expected_terminal = true;
                    let ui_generation = active.ui_generation;
                    self.shutdown_reply = Some(reply);
                    self.shutdown_deadline = Some(TokioInstant::now() + SHUTDOWN_CLEANUP_TIMEOUT);
                    self.set_status(
                        NativeVoicePhase::Stopping,
                        Some(ui_generation),
                        Some("shutdown"),
                    );
                    return false;
                }
                self.set_status(NativeVoicePhase::Stopping, None, Some("shutdown"));
                self.shutdown_reply = Some(reply);
                self.ack_shutdown();
                true
            }
        }
    }

    async fn force_shutdown(&mut self) {
        if let Some(active) = self.active.take() {
            active.cancellation.cancel();
            active.control.interrupt(active.core_generation);
            if let Some(reason_code) = release_handoff_slot(&active.handoff_slot, false).await {
                self.set_status(NativeVoicePhase::Faulted, None, Some(reason_code));
            }
        }
        self.ack_shutdown();
    }

    fn ack_shutdown(&mut self) {
        if let Some(reply) = self.shutdown_reply.take() {
            let _ = reply.send(());
        }
        self.shutdown_deadline = None;
    }

    fn refresh_idle_status(&mut self) {
        match self.resolve_profile(false) {
            Ok(profile) => self.status = idle_status(&self.app, &profile),
            Err(reason) => self.status = NativeVoiceStatus::unavailable(reason),
        }
    }

    async fn start(
        &mut self,
        request: NativeVoiceStartRequest,
    ) -> Result<NativeVoiceStatus, NativeVoiceCommandError> {
        if self.active.is_some() {
            return Err(NativeVoiceCommandError::invalid(ACTIVE_REASON));
        }
        let document = load_thin_profile_document()
            .ok_or_else(|| NativeVoiceCommandError::unavailable(PROFILE_REASON))?;
        let profile = resolve_start_profile_from_document(
            &document,
            request.remote_audio_consent,
            sidecar_running(&self.sidecar),
            load_peer_bearer,
            super::current_unix_ms,
        )?;
        install_profile(&mut self.status, &profile);

        let profile_key = profile.reusable_key();
        if !runtime_cache_matches(self.runtime_profile.as_ref(), profile_key.as_ref()) {
            *self.runtime.borrow_mut() = None;
            self.runtime_profile = profile_key.clone();
        }
        let app = self.app.clone();
        let mut runtime = match self.runtime.borrow_mut().take() {
            Some(runtime)
                if runtime_cache_matches(self.runtime_profile.as_ref(), profile_key.as_ref()) =>
            {
                runtime
            }
            None => build_runtime(&app, &profile, self.tx.clone())?,
            Some(_) => build_runtime(&app, &profile, self.tx.clone())?,
        };
        self.status.background_eligible = runtime.core.wake_background_ready();

        let core_generation = runtime
            .core
            .next_capture_generation()
            .map_err(map_core_error)?;
        let ui_generation = self.next_safe_ui_generation()?;
        let cancellation = CancellationToken::new();
        let control = runtime.control.clone();
        let start_reason = match request.trigger {
            NativeVoiceTrigger::FocusedPushToTalk => CaptureStartReason::PushToTalk,
            NativeVoiceTrigger::TrayPushToTalk => CaptureStartReason::AssistantRole,
            NativeVoiceTrigger::WakeWord => CaptureStartReason::ForegroundWake,
            NativeVoiceTrigger::BackgroundWake => CaptureStartReason::BackgroundSession,
        };
        let handoff = if let RuntimeProfile::Local { .. } = profile {
            let mut adapter = build_handoff(&profile, start_reason.clone())?;
            let grant = match timeout(
                HANDOFF_OPERATION_TIMEOUT,
                adapter.prepare(&|| cancellation.is_cancelled()),
            )
            .await
            {
                Err(_) => {
                    if recover_ambiguous_prepare(&mut adapter).await.is_err() {
                        return Err(NativeVoiceCommandError::unavailable(
                            "handoff_cleanup_failed",
                        ));
                    }
                    return Err(NativeVoiceCommandError::unavailable(
                        "handoff_prepare_timeout",
                    ));
                }
                Ok(Ok(grant)) => grant,
                Ok(Err(error)) => {
                    if prepare_error_needs_ambiguous_recovery(&error)
                        && recover_ambiguous_prepare(&mut adapter).await.is_err()
                    {
                        return Err(NativeVoiceCommandError::unavailable(
                            "handoff_cleanup_failed",
                        ));
                    }
                    return Err(map_core_error(error));
                }
            };
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
            core_generation,
            continuous: matches!(request.trigger, NativeVoiceTrigger::BackgroundWake),
            _handoff_generation: handoff_slot
                .borrow()
                .as_ref()
                .map(|(_, grant)| grant.voice_capture_lease(now_micros()).generation),
            control: control.clone(),
            cancellation: cancellation.clone(),
            handoff_slot: Rc::clone(&handoff_slot),
            expected_terminal: false,
        });
        self.set_status(NativeVoicePhase::Starting, Some(ui_generation), None);

        let tx = self.tx.clone();
        let runtime_slot = Rc::clone(&self.runtime);
        tokio::task::spawn_local(async move {
            let result = match request.trigger {
                NativeVoiceTrigger::FocusedPushToTalk | NativeVoiceTrigger::TrayPushToTalk => {
                    runtime
                        .core
                        .run_push_to_talk_turn(lease, now_micros(), cancellation.clone())
                        .await
                }
                NativeVoiceTrigger::WakeWord => {
                    runtime
                        .core
                        .run_wake_turn(lease, now_micros(), cancellation.clone())
                        .await
                }
                NativeVoiceTrigger::BackgroundWake => {
                    run_background_session(&mut runtime.core, lease, cancellation.clone()).await
                }
            };
            let reason_code = result.err().map(|error| reason_from_core_error(&error));
            let cleanup_reason = release_handoff_slot(&handoff_slot, true).await;
            runtime.ui_generation.set(None);
            *runtime_slot.borrow_mut() = Some(runtime);
            let _ = tx.send(ActorCommand::TurnFinished {
                ui_generation,
                reason_code: reason_code.or(cleanup_reason),
            });
        });
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
        if request.generation != active.ui_generation {
            return Err(NativeVoiceCommandError::invalid(STALE_CONTROL_REASON));
        }
        if control_requires_terminal_suppression(cancel || active.continuous) {
            active.expected_terminal = true;
            active.cancellation.cancel();
            active.control.interrupt(active.core_generation);
        } else {
            active.control.finish(active.core_generation);
        }
        let ui_generation = active.ui_generation;
        let reason = stop_reason_code(request.reason);
        self.set_status(
            NativeVoicePhase::Stopping,
            Some(ui_generation),
            Some(reason),
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
        let _ = self.app.emit(STATUS_EVENT, event);
    }
}

#[cfg(desktop)]
struct ActiveTurn {
    ui_generation: u64,
    core_generation: Generation,
    continuous: bool,
    _handoff_generation: Option<Generation>,
    control: DesktopCaptureControl,
    cancellation: CancellationToken,
    handoff_slot: HandoffSlot,
    expected_terminal: bool,
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
}

#[cfg(desktop)]
impl DesktopCaptureControl {
    fn finish(&self, generation: Generation) {
        match self {
            Self::Production(control) => control.finish(generation),
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(control) => control.finish(generation),
        }
    }

    fn interrupt(&self, generation: Generation) {
        match self {
            Self::Production(control) => control.interrupt(generation),
            #[cfg(feature = "desktop-native-voice-e2e")]
            Self::Deterministic(control) => control.interrupt(generation),
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
}

#[cfg(all(desktop, feature = "desktop-native-voice-e2e"))]
impl DeterministicE2eAudioInput {
    fn new() -> Self {
        Self {
            shared: Arc::new(DeterministicE2eCaptureShared::default()),
            active: None,
            route_revision: RouteRevision(0),
        }
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
                .finished
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn interrupt(&self, generation: Generation) {
        if self.active(generation) {
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
        let gateway = super::gateway_url().map_err(|_| PROFILE_REASON)?;
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
async fn run_background_session(
    core: &mut RuntimeCore,
    lease: VoiceCaptureLease,
    cancellation: CancellationToken,
) -> Result<String, VoiceCoreError> {
    loop {
        cancellation.check()?;
        match core
            .run_background_turn(lease.clone(), now_micros(), cancellation.clone())
            .await
        {
            Ok(_) => {
                if cancellation.is_cancelled() {
                    return Err(VoiceCoreError::Cancelled);
                }
            }
            Err(VoiceCoreError::WakeNotDetected)
            | Err(VoiceCoreError::SpeechNotDetected)
            | Err(VoiceCoreError::SpeechTimeout)
                if !cancellation.is_cancelled() => {}
            Err(error) => return Err(error),
        }
    }
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
) -> Result<RuntimeBundle, NativeVoiceCommandError> {
    let ui_generation = Rc::new(Cell::new(None));
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
    let stt = match profile.local_speech().stt.as_ref() {
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
                    NativeGatewayFiniteSttConfig::realtime(stt_route, policy)
                        .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?,
                )
                .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?,
            )
        }
    };
    let tts = match profile.local_speech().tts.as_ref() {
        Some(selection) => {
            let voice_id = selection
                .voice_id
                .as_deref()
                .ok_or_else(|| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
            let voice_catalog = TtsVoiceCatalog::runtime()
                .map_err(|_| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
            let voice = voice_catalog
                .voice(voice_id)
                .ok_or_else(|| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
            let manager = manager
                .as_ref()
                .ok_or_else(|| NativeVoiceCommandError::unavailable("local_speech_unavailable"))?;
            let provider = match voice.model_family.as_str() {
                "vits_piper" => build_installed_tts_provider(manager, voice_id),
                "pockettts" if voice.requires_reference_profile() => {
                    let reference_profile_id =
                        selection.reference_profile_id.as_deref().ok_or_else(|| {
                            NativeVoiceCommandError::unavailable("local_speech_unavailable")
                        })?;
                    let reference_profile =
                        load_desktop_tts_reference_profile(app, reference_profile_id, voice_id)?;
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
            DesktopTts::new(
                provider.map_err(|_| {
                    NativeVoiceCommandError::unavailable("local_speech_unavailable")
                })?,
            )
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
    restart_capture: bool,
) -> Option<&'static str> {
    let handoff = handoff_slot.borrow_mut().take();
    let (mut adapter, grant) = handoff?;
    let release_failed = timeout(
        HANDOFF_OPERATION_TIMEOUT,
        adapter.release(&grant, restart_capture, &|| false),
    )
    .await
    .map_or(true, |release| release.is_err());
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
impl LocalSpeechSelection {
    fn cache_identity(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned())
    }
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
    fn stale_ui_generation_controls_are_rejected_by_reducer() {
        let active = ActiveTurnSnapshot {
            ui_generation: 7,
            core_generation: Generation(3),
        };
        assert!(control_matches(&active, 7));
        assert!(!control_matches(&active, 3));
        assert!(!control_matches(&active, 8));
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
    fn shutdown_waits_for_terminal_cleanup_before_ack() {
        let active = ShutdownSnapshot {
            active_turn: true,
            cleanup_finished: false,
            forced_timeout: false,
        };
        assert!(!active.can_ack_shutdown());
        let finished = ShutdownSnapshot {
            active_turn: false,
            cleanup_finished: true,
            forced_timeout: false,
        };
        assert!(finished.can_ack_shutdown());
        assert!(finished.restart_python_capture_after_cleanup());
        let timed_out = ShutdownSnapshot {
            active_turn: true,
            cleanup_finished: false,
            forced_timeout: true,
        };
        assert!(!timed_out.restart_python_capture_after_cleanup());
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
#[derive(Debug)]
struct ActiveTurnSnapshot {
    ui_generation: u64,
    core_generation: Generation,
}

#[cfg(test)]
fn control_matches(active: &ActiveTurnSnapshot, ui_generation: u64) -> bool {
    let _ = active.core_generation;
    active.ui_generation == ui_generation
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
struct ShutdownSnapshot {
    active_turn: bool,
    cleanup_finished: bool,
    forced_timeout: bool,
}

#[cfg(test)]
impl ShutdownSnapshot {
    fn can_ack_shutdown(&self) -> bool {
        !self.active_turn && self.cleanup_finished
    }

    fn restart_python_capture_after_cleanup(&self) -> bool {
        !self.forced_timeout && self.cleanup_finished
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
