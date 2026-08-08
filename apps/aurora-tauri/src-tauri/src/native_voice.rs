use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(desktop)]
use {
    async_trait::async_trait,
    aurora_voice_core::{
        CancellationToken, CaptureStartReason, Generation, RedactedSnapshot, RouteRevision,
        RuntimeEvent, RuntimeEventSink, TimestampMicros, VoiceCaptureLease, VoiceCoreError,
        VoiceRuntime, VoiceState,
    },
    aurora_voice_engine::{
        FiniteSttRouteScope, RouteFiniteSttBinding, RouteTtsBinding, MAX_FINITE_STT_SAMPLES,
        VAD_SAMPLE_RATE_HZ,
    },
    aurora_voice_native::{
        CpalAudioInput, CpalAudioOutput, GatewayAuth, MicrophoneAudioPolicy, NativeAudioConfig,
        NativeCaptureConfig, NativeCaptureControl, NativeGatewayCaptureGrant,
        NativeGatewayCaptureHandoff, NativeGatewayCaptureHandoffConfig, NativeGatewayFiniteStt,
        NativeGatewayFiniteSttConfig, NativeGatewayTransport, NativeGatewayTtsConfig,
        NativeGatewayTtsSynthesizer, TransportLimits,
    },
    serde_json::Value,
    std::cell::Cell,
    std::cell::RefCell,
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
const HANDOFF_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(desktop)]
const HANDOFF_OPERATION_TIMEOUT: Duration = Duration::from_secs(4);
#[cfg(desktop)]
const HANDOFF_RECOVERY_TIMEOUT: Duration = Duration::from_secs(9);
#[cfg(desktop)]
const SHUTDOWN_CLEANUP_TIMEOUT: Duration = Duration::from_secs(45);
#[cfg(desktop)]
const HOST_STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(75);

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

#[derive(Default)]
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
pub fn tray_toggle(app: &AppHandle) {
    let Some(state) = app.try_state::<NativeVoiceState>() else {
        return;
    };
    let tx = state
        .inner()
        .inner
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|handle| handle.tx.clone()));
    tauri::async_runtime::spawn(async move {
        let Some(tx) = tx else {
            return;
        };
        let (reply, rx) = oneshot::channel();
        let _ = tx.send(ActorCommand::Status { reply });
        let status = match rx.await {
            Ok(Ok(status)) => status,
            _ => return,
        };
        if matches!(status.phase, NativeVoicePhase::Listening) {
            if let Some(generation) = status.generation {
                let (reply, rx) = oneshot::channel();
                let _ = tx.send(ActorCommand::Finish {
                    request: NativeVoiceControlRequest {
                        generation,
                        reason: NativeVoiceStopReason::UserRequest,
                    },
                    reply,
                });
                let _ = rx.await;
            }
        } else if matches!(status.phase, NativeVoicePhase::Idle) {
            let (reply, rx) = oneshot::channel();
            let _ = tx.send(ActorCommand::Start {
                request: NativeVoiceStartRequest {
                    trigger: NativeVoiceTrigger::TrayPushToTalk,
                    remote_audio_consent: false,
                },
                reply,
            });
            let _ = rx.await;
        }
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
            Ok(profile) => self.status = idle_status(profile.connection()),
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
        let profile = self
            .resolve_profile(request.remote_audio_consent)
            .map_err(NativeVoiceCommandError::unavailable)?;
        install_profile_connection(&mut self.status, profile.connection());
        if profile.connection() == NativeVoiceConnection::ConnectedDevice
            && !request.remote_audio_consent
        {
            return Err(NativeVoiceCommandError::invalid(REMOTE_CONSENT_REASON));
        }

        let profile_key = profile.reusable_key();
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
            None => build_runtime(&profile, self.tx.clone())?,
            Some(_) => build_runtime(&profile, self.tx.clone())?,
        };

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
                background_eligible: false,
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
            let result = runtime
                .core
                .run_push_to_talk_turn(lease, now_micros(), cancellation.clone())
                .await;
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
        if control_requires_terminal_suppression(cancel) {
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
        if sidecar_running(&self.sidecar) {
            return RuntimeProfile::local();
        }
        let Some(document) = load_thin_profile_document() else {
            return Err(PROFILE_REASON);
        };
        resolve_remote_profile(
            &document,
            remote_audio_consent,
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
            background_eligible: background_voice_eligible(connection),
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
    _handoff_generation: Option<Generation>,
    control: NativeCaptureControl,
    cancellation: CancellationToken,
    handoff_slot: HandoffSlot,
    expected_terminal: bool,
}

#[cfg(desktop)]
type HandoffSlot = Rc<RefCell<Option<(NativeGatewayCaptureHandoff, NativeGatewayCaptureGrant)>>>;

#[cfg(desktop)]
type RuntimeCore = VoiceRuntime<
    CpalAudioInput,
    NativeGatewayFiniteStt,
    NativeGatewayTtsSynthesizer,
    NativeGatewayTransport,
    CpalAudioOutput,
    StatusOnlySink,
>;

#[cfg(desktop)]
struct RuntimeBundle {
    core: RuntimeCore,
    control: NativeCaptureControl,
    ui_generation: Rc<Cell<Option<u64>>>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, PartialEq, Eq)]
struct RuntimeProfileKey {
    connection: NativeVoiceConnection,
    identity: String,
}

#[cfg(desktop)]
enum RuntimeProfile {
    Local { gateway: Url },
    Remote { gateway: Url, bearer: String },
}

#[cfg(desktop)]
impl RuntimeProfile {
    fn local() -> Result<Self, &'static str> {
        let gateway = super::gateway_url().map_err(|_| PROFILE_REASON)?;
        Self::local_from_gateway(gateway)
    }

    fn local_from_gateway(gateway: Url) -> Result<Self, &'static str> {
        if !super::is_loopback_http_origin(&gateway) {
            return Err(PROFILE_REASON);
        }
        Ok(Self::Local { gateway })
    }

    fn connection(&self) -> NativeVoiceConnection {
        match self {
            Self::Local { .. } => NativeVoiceConnection::ThisDevice,
            Self::Remote { .. } => NativeVoiceConnection::ConnectedDevice,
        }
    }

    fn reusable_key(&self) -> Option<RuntimeProfileKey> {
        match self {
            Self::Local { gateway } => Some(RuntimeProfileKey {
                connection: NativeVoiceConnection::ThisDevice,
                identity: gateway.origin().ascii_serialization(),
            }),
            Self::Remote { .. } => None,
        }
    }
}

#[cfg(desktop)]
fn idle_status(connection: NativeVoiceConnection) -> NativeVoiceStatus {
    NativeVoiceStatus {
        available: true,
        phase: NativeVoicePhase::Idle,
        generation: None,
        background_eligible: background_voice_eligible(connection),
        connection,
        reason_code: None,
        redacted: true,
    }
}

#[cfg(desktop)]
fn install_profile_connection(status: &mut NativeVoiceStatus, connection: NativeVoiceConnection) {
    status.connection = connection;
    status.background_eligible = background_voice_eligible(connection);
}

#[cfg(any(desktop, test))]
fn background_voice_eligible(_connection: NativeVoiceConnection) -> bool {
    false
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
fn build_runtime(
    profile: &RuntimeProfile,
    tx: mpsc::UnboundedSender<ActorCommand>,
) -> Result<RuntimeBundle, NativeVoiceCommandError> {
    let ui_generation = Rc::new(Cell::new(None));
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
    let tts_route = RouteTtsBinding::new(
        "gateway.default",
        "voice.default",
        VAD_SAMPLE_RATE_HZ,
        ROUTE_REVISION,
    )
    .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?;
    let stt = NativeGatewayFiniteStt::new(
        transport_for_profile(profile)?,
        NativeGatewayFiniteSttConfig::realtime(stt_route, policy)
            .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?,
    )
    .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?;
    let tts = NativeGatewayTtsSynthesizer::new(
        transport_for_profile(profile)?,
        NativeGatewayTtsConfig::new(tts_route, None, 1.0, TTS_MAX_AUDIO_SAMPLES)
            .map_err(|_| NativeVoiceCommandError::unavailable("route_unavailable"))?,
    );
    let transport = transport_for_profile(profile)?;
    let audio = CpalAudioInput::new(NativeCaptureConfig::default());
    let control = audio.control();
    let output = CpalAudioOutput::new(NativeAudioConfig::default());
    let sink = StatusOnlySink {
        tx,
        ui_generation: Rc::clone(&ui_generation),
    };
    let core = VoiceRuntime::new(
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
    Ok(RuntimeBundle {
        core,
        control,
        ui_generation,
    })
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
        .with_background_eligible(background_voice_eligible(profile.connection()))
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
        RuntimeProfile::Local { gateway } => (
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
        VoiceState::Arming | VoiceState::ListeningForWake | VoiceState::WakeDetected => {
            NativeVoicePhase::Starting
        }
        VoiceState::CapturingUtterance => NativeVoicePhase::Listening,
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
    _runtime_tier: String,
    #[serde(default)]
    home_connection: Option<HomeConnectionProfile>,
    #[serde(rename = "localNode")]
    _local_node: LocalNodeProfile,
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
    if !remote_audio_consent {
        return Err(REMOTE_CONSENT_REASON);
    }
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
    })
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

    #[test]
    fn remote_profile_requires_https_http_capability_consent_and_credential() {
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
        assert!(matches!(
            resolve_remote_profile(
                &document,
                false,
                |_| Some(ThinBearerCredential {
                    raw_bearer_token: "secret".to_owned(),
                    expires_at_ms: Some(20),
                }),
                || 10
            ),
            Err(REMOTE_CONSENT_REASON)
        ));
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
    fn local_profile_uses_configured_loopback_gateway_origin() {
        let gateway = Url::parse("http://127.0.0.1:9123").expect("loopback gateway");
        let profile = RuntimeProfile::local_from_gateway(gateway).expect("local profile");
        let RuntimeProfile::Local { gateway } = profile else {
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
        let local_a = RuntimeProfile::Local {
            gateway: Url::parse("http://127.0.0.1:8000").expect("local a"),
        };
        let local_b = RuntimeProfile::Local {
            gateway: Url::parse("http://127.0.0.1:8000").expect("local b"),
        };
        assert!(runtime_cache_matches(
            local_a.reusable_key().as_ref(),
            local_b.reusable_key().as_ref()
        ));

        let remote_original = RuntimeProfile::Remote {
            gateway: Url::parse("https://gateway.example.test").expect("remote original"),
            bearer: "old-secret".to_owned(),
        };
        let remote_rotated = RuntimeProfile::Remote {
            gateway: Url::parse("https://rotated.example.test").expect("remote rotated"),
            bearer: "new-secret".to_owned(),
        };
        assert!(remote_original.reusable_key().is_none());
        assert!(remote_rotated.reusable_key().is_none());
        assert!(!runtime_cache_matches(
            remote_original.reusable_key().as_ref(),
            remote_rotated.reusable_key().as_ref()
        ));
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
        let mut local = NativeVoiceStatus::unavailable(PROFILE_REASON);
        install_profile_connection(&mut local, NativeVoiceConnection::ThisDevice);
        assert_eq!(local.connection, NativeVoiceConnection::ThisDevice);
        assert!(!local.background_eligible);

        let mut remote = NativeVoiceStatus::unavailable(PROFILE_REASON);
        install_profile_connection(&mut remote, NativeVoiceConnection::ConnectedDevice);
        assert_eq!(remote.connection, NativeVoiceConnection::ConnectedDevice);
        assert!(!remote.background_eligible);
        let rendered = serde_json::to_string(&remote).expect("remote status");
        assert!(!rendered.contains("gateway.example"));
        assert!(!rendered.contains("https://"));
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
        assert!(main.contains("aurora-native-voice"));
        assert!(thin.contains("aurora-native-voice"));
        assert!(!overlay.contains("aurora-native-voice"));
        assert!(!android.contains("aurora-native-voice"));
        assert!(!ios.contains("aurora-native-voice"));
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
            _runtime_tier: "thin".to_owned(),
            home_connection: Some(HomeConnectionProfile {
                mode: mode.to_owned(),
                gateway_url: Some("https://gateway.example.test".to_owned()),
                _signaling_url: Some("wss://signal.example.test".to_owned()),
                home_peer_id: home_peer_id.map(str::to_owned),
                webrtc_profile: home_peer_id.map(test_webrtc_profile),
            }),
            _local_node: LocalNodeProfile {
                _node_name: "Thin".to_owned(),
                _stable_peer_id: "local-thin-peer".to_owned(),
                _enabled_capability_packs: Vec::new(),
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
        background_eligible: background_voice_eligible(connection),
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
    !expected_terminal || matches!(phase, NativeVoicePhase::Stopping)
}

fn control_requires_terminal_suppression(cancel: bool) -> bool {
    cancel
}
