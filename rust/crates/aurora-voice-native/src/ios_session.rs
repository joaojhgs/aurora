//! iOS-native voice session executor.
//!
//! Swift owns AVAudioSession/AVAudioEngine and drains the bounded playback
//! queue. This module owns the shared Rust voice runtime, typed Gateway
//! transport, generations, cancellation, and redacted lifecycle status.

use crate::{
    GatewayAuth, MicrophoneAudioPolicy, NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig,
    NativeGatewayTransport, NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer, TransportLimits,
};
use async_trait::async_trait;
use aurora_voice_core::{
    CancellationToken, CaptureOwnerKind, CaptureStartReason, Generation, RedactedSnapshot,
    RouteFiniteSttBinding, RouteRevision, RouteTtsBinding, RuntimeEvent, RuntimeEventSink,
    TimestampMicros, VoiceCaptureLease, VoiceCoreError, VoiceRuntime, VoiceState,
};
use aurora_voice_engine::{
    FiniteSttRouteScope, ModelPackError, ModelStoreScope, PackTask, MAX_FINITE_STT_SAMPLES,
    VAD_SAMPLE_RATE_HZ,
};
use aurora_voice_ios_bridge::{
    AuroraIosAudioInput, AuroraIosAudioOutput, AuroraIosAudioState, AuroraIosCaptureControl,
};
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::runtime::Builder as TokioRuntimeBuilder;
use tokio::sync::mpsc as tokio_mpsc;
use url::Url;

const ROUTE_REVISION: u64 = 1;
const IOS_SURFACE: &str = "ios";
const IOS_RUNTIME_ID: &str = "ios-native-voice";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const DEFAULT_INPUT_CAPACITY_CHUNKS: usize = 8;
const DEFAULT_INPUT_MAX_CHUNK_SAMPLES: usize = 4_096;
const DEFAULT_OUTPUT_CAPACITY_CHUNKS: usize = 16;
const MAX_IOS_PACK_BINDINGS: usize = 16;
const MAX_IOS_PACK_PATH_BYTES: usize = 4096;

type RuntimeCore = VoiceRuntime<
    AuroraIosAudioInput,
    NativeGatewayFiniteStt,
    NativeGatewayTtsSynthesizer,
    NativeGatewayTransport,
    AuroraIosAudioOutput,
    IosSessionSink,
>;

/// Credentials and route policy for one iOS native session.
#[derive(Clone, PartialEq, Eq)]
pub struct IosVoiceSessionConfig {
    gateway: Url,
    auth: GatewayAuth,
    remote_audio_consent: bool,
    pack_bindings: IosVoicePackBindings,
}

impl IosVoiceSessionConfig {
    pub fn new(gateway: Url, auth: GatewayAuth, remote_audio_consent: bool) -> Self {
        Self {
            gateway,
            auth,
            remote_audio_consent,
            pack_bindings: IosVoicePackBindings::default(),
        }
    }

    pub fn with_pack_bindings(
        gateway: Url,
        auth: GatewayAuth,
        remote_audio_consent: bool,
        pack_bindings: IosVoicePackBindings,
    ) -> Self {
        Self {
            gateway,
            auth,
            remote_audio_consent,
            pack_bindings,
        }
    }
}

impl fmt::Debug for IosVoiceSessionConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IosVoiceSessionConfig")
            .field("endpoint_class", &endpoint_class(&self.gateway))
            .field("auth", &self.auth)
            .field("remote_audio_consent", &self.remote_audio_consent)
            .field("pack_binding_count", &self.pack_bindings.len())
            .finish()
    }
}

/// One iOS-selected active model-pack binding.
#[derive(Clone, PartialEq, Eq)]
pub struct IosVoicePackBinding {
    task: PackTask,
    slot_id: String,
    pack_path: PathBuf,
}

impl IosVoicePackBinding {
    pub fn new(
        task: PackTask,
        slot_id: impl Into<String>,
        pack_path: impl Into<PathBuf>,
    ) -> Result<Self, ModelPackError> {
        let slot_id = slot_id.into();
        ModelStoreScope::new(task, slot_id.clone())?;
        let pack_path = pack_path.into();
        if pack_path.as_os_str().is_empty()
            || pack_path.as_os_str().len() > MAX_IOS_PACK_PATH_BYTES
            || !matches!(
                task,
                PackTask::Kws | PackTask::Wakeword | PackTask::Vad | PackTask::Stt | PackTask::Tts
            )
        {
            return Err(ModelPackError::Store { code: "binding" });
        }
        Ok(Self {
            task,
            slot_id,
            pack_path,
        })
    }

    pub fn task(&self) -> PackTask {
        self.task
    }

    pub fn slot_id(&self) -> &str {
        &self.slot_id
    }

    pub fn pack_path(&self) -> &PathBuf {
        &self.pack_path
    }
}

impl fmt::Debug for IosVoicePackBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IosVoicePackBinding")
            .field("task", &self.task)
            .field("slot_id", &self.slot_id)
            .field("pack_path", &"<redacted>")
            .finish()
    }
}

/// Bounded set of active iOS model-pack bindings selected by Swift.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct IosVoicePackBindings {
    bindings: Vec<IosVoicePackBinding>,
}

impl IosVoicePackBindings {
    pub fn new(bindings: Vec<IosVoicePackBinding>) -> Result<Self, ModelPackError> {
        if bindings.len() > MAX_IOS_PACK_BINDINGS {
            return Err(ModelPackError::Store { code: "binding" });
        }
        let mut seen = std::collections::BTreeSet::new();
        for binding in &bindings {
            let key = (binding.task, binding.slot_id.clone());
            if !seen.insert(key) {
                return Err(ModelPackError::Store { code: "binding" });
            }
        }
        Ok(Self { bindings })
    }

    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty()
    }

    pub fn len(&self) -> usize {
        self.bindings.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &IosVoicePackBinding> {
        self.bindings.iter()
    }
}

impl fmt::Debug for IosVoicePackBindings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IosVoicePackBindings")
            .field("binding_count", &self.bindings.len())
            .finish()
    }
}

#[repr(i64)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IosVoiceSessionPhase {
    Idle,
    Starting,
    Listening,
    Processing,
    Speaking,
    Stopping,
    Faulted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IosVoiceSessionStatus {
    pub active: bool,
    pub phase: IosVoiceSessionPhase,
    pub generation: Option<Generation>,
    pub completed_turns: u64,
    pub failed_turns: u64,
    pub last_error: Option<String>,
}

impl Default for IosVoiceSessionStatus {
    fn default() -> Self {
        Self {
            active: false,
            phase: IosVoiceSessionPhase::Idle,
            generation: None,
            completed_turns: 0,
            failed_turns: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum IosVoiceSessionCommandError {
    #[error("voice session is already active")]
    AlreadyActive,
    #[error("voice session is not active")]
    NotActive,
    #[error("voice session is unavailable")]
    Unavailable,
    #[error("voice session command channel is closed")]
    Closed,
}

enum Command {
    Start {
        mode: IosVoiceStartMode,
        reply: mpsc::Sender<Result<Generation, IosVoiceSessionCommandError>>,
    },
    Finish {
        generation: Generation,
        reply: mpsc::Sender<Result<(), IosVoiceSessionCommandError>>,
    },
    Cancel {
        generation: Generation,
        reply: mpsc::Sender<Result<(), IosVoiceSessionCommandError>>,
    },
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IosVoiceStartMode {
    PushToTalk,
    BackgroundSession,
}

/// Native iOS session handle shared by Swift audio callbacks and lifecycle commands.
pub struct IosVoiceSession {
    audio_state: AuroraIosAudioState,
    output: AuroraIosAudioOutput,
    capture_control: AuroraIosCaptureControl,
    commands: tokio_mpsc::UnboundedSender<Command>,
    status: Arc<Mutex<IosVoiceSessionStatus>>,
    join: Mutex<Option<thread::JoinHandle<()>>>,
}

impl IosVoiceSession {
    pub fn new_default(config: IosVoiceSessionConfig) -> Result<Self, IosVoiceSessionCommandError> {
        Self::new(
            config,
            DEFAULT_INPUT_CAPACITY_CHUNKS,
            DEFAULT_INPUT_MAX_CHUNK_SAMPLES,
            DEFAULT_OUTPUT_CAPACITY_CHUNKS,
        )
    }

    pub fn new(
        config: IosVoiceSessionConfig,
        input_capacity_chunks: usize,
        max_input_chunk_samples: usize,
        output_capacity_chunks: usize,
    ) -> Result<Self, IosVoiceSessionCommandError> {
        let audio_state =
            AuroraIosAudioState::new(input_capacity_chunks.max(1), max_input_chunk_samples.max(1));
        let output = AuroraIosAudioOutput::new(output_capacity_chunks.max(1));
        let input = AuroraIosAudioInput::new(audio_state.clone());
        let capture_control = input.control();
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let sink = IosSessionSink {
            status: Arc::clone(&status),
        };
        let runtime = build_runtime(&config, input, output.clone(), sink)?;
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let thread_status = Arc::clone(&status);
        let thread_control = capture_control.clone();
        let join = thread::Builder::new()
            .name("aurora-ios-voice".to_owned())
            .spawn(move || {
                run_session_thread(
                    runtime,
                    command_rx,
                    thread_status,
                    thread_control,
                    config.remote_audio_consent,
                )
            })
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
        Ok(Self {
            audio_state,
            output,
            capture_control,
            commands,
            status,
            join: Mutex::new(Some(join)),
        })
    }

    pub fn audio_state(&self) -> AuroraIosAudioState {
        self.audio_state.clone()
    }

    /// Return a borrowed opaque pointer valid while this session remains alive.
    pub fn audio_state_ptr(&self) -> *mut AuroraIosAudioState {
        (&self.audio_state as *const AuroraIosAudioState).cast_mut()
    }

    pub fn output(&self) -> AuroraIosAudioOutput {
        self.output.clone()
    }

    /// Return a borrowed opaque pointer valid while this session remains alive.
    pub fn output_ptr(&self) -> *mut AuroraIosAudioOutput {
        (&self.output as *const AuroraIosAudioOutput).cast_mut()
    }

    pub fn capture_control(&self) -> AuroraIosCaptureControl {
        self.capture_control.clone()
    }

    pub fn status(&self) -> IosVoiceSessionStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| IosVoiceSessionStatus {
                phase: IosVoiceSessionPhase::Faulted,
                last_error: Some("status_unavailable".to_owned()),
                ..IosVoiceSessionStatus::default()
            })
    }

    pub fn start(&self) -> Result<Generation, IosVoiceSessionCommandError> {
        self.start_with_mode(IosVoiceStartMode::PushToTalk)
    }

    pub fn start_background(&self) -> Result<Generation, IosVoiceSessionCommandError> {
        self.start_with_mode(IosVoiceStartMode::BackgroundSession)
    }

    fn start_with_mode(
        &self,
        mode: IosVoiceStartMode,
    ) -> Result<Generation, IosVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        self.commands
            .send(Command::Start { mode, reply })
            .map_err(|_| IosVoiceSessionCommandError::Closed)?;
        response
            .recv()
            .unwrap_or(Err(IosVoiceSessionCommandError::Closed))
    }

    pub fn finish(&self, generation: u64) -> Result<(), IosVoiceSessionCommandError> {
        self.send_generation_command(generation, false)
    }

    pub fn cancel(&self, generation: u64) -> Result<(), IosVoiceSessionCommandError> {
        self.send_generation_command(generation, true)
    }

    fn send_generation_command(
        &self,
        generation: u64,
        cancel: bool,
    ) -> Result<(), IosVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        let command = if cancel {
            Command::Cancel {
                generation: Generation(generation),
                reply,
            }
        } else {
            Command::Finish {
                generation: Generation(generation),
                reply,
            }
        };
        self.commands
            .send(command)
            .map_err(|_| IosVoiceSessionCommandError::Closed)?;
        response
            .recv()
            .unwrap_or(Err(IosVoiceSessionCommandError::Closed))
    }

    pub fn close(&self) {
        let _ = self.commands.send(Command::Shutdown);
        self.audio_state.close();
        self.output.close();
        if let Ok(mut join) = self.join.lock() {
            if let Some(handle) = join.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for IosVoiceSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn build_runtime(
    config: &IosVoiceSessionConfig,
    input: AuroraIosAudioInput,
    output: AuroraIosAudioOutput,
    sink: IosSessionSink,
) -> Result<RuntimeCore, IosVoiceSessionCommandError> {
    if !config.pack_bindings.is_empty() {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let policy = microphone_policy(config)?;
    let scope = if matches!(policy, MicrophoneAudioPolicy::LoopbackOnly) {
        FiniteSttRouteScope::LoopbackSidecar
    } else {
        FiniteSttRouteScope::RemoteGateway
    };
    let stt_route = RouteFiniteSttBinding::new(
        "gateway.default",
        scope,
        VAD_SAMPLE_RATE_HZ,
        MAX_FINITE_STT_SAMPLES.min(16_000 * 30),
        ROUTE_REVISION,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let tts_route = RouteTtsBinding::new(
        "gateway.default",
        "voice.default",
        VAD_SAMPLE_RATE_HZ,
        ROUTE_REVISION,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let limits = TransportLimits {
        max_request_bytes: 2 * 1024 * 1024,
        max_response_bytes: 8 * 1024 * 1024,
        max_event_bytes: 2 * 1024 * 1024,
        request_timeout: REQUEST_TIMEOUT,
        stream_idle_timeout: STREAM_IDLE_TIMEOUT,
        allow_loopback_http: matches!(policy, MicrophoneAudioPolicy::LoopbackOnly),
        microphone_audio_policy: policy,
    };
    let transport_for_stt =
        NativeGatewayTransport::new(config.gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let transport_for_tts =
        NativeGatewayTransport::new(config.gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let transport_for_assistant =
        NativeGatewayTransport::new(config.gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let stt = NativeGatewayFiniteStt::new(
        transport_for_stt,
        NativeGatewayFiniteSttConfig::realtime(stt_route, policy)
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let tts = NativeGatewayTtsSynthesizer::new(
        transport_for_tts,
        NativeGatewayTtsConfig::new(tts_route, None, 1.0, 16_000 * 30)
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?,
    );
    VoiceRuntime::new(
        input,
        stt,
        tts,
        transport_for_assistant,
        output,
        sink,
        IOS_SURFACE,
        IOS_RUNTIME_ID,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)
}

fn is_loopback(url: &Url) -> bool {
    url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        )
}

fn endpoint_class(url: &Url) -> &'static str {
    if is_loopback(url) {
        "loopback"
    } else {
        "remote"
    }
}

fn microphone_policy(
    config: &IosVoiceSessionConfig,
) -> Result<MicrophoneAudioPolicy, IosVoiceSessionCommandError> {
    if is_loopback(&config.gateway) {
        Ok(MicrophoneAudioPolicy::LoopbackOnly)
    } else if config.remote_audio_consent {
        Ok(MicrophoneAudioPolicy::ExplicitRemoteConsent)
    } else {
        Err(IosVoiceSessionCommandError::Unavailable)
    }
}

fn capture_start_reason(mode: IosVoiceStartMode) -> CaptureStartReason {
    match mode {
        IosVoiceStartMode::PushToTalk => CaptureStartReason::PushToTalk,
        IosVoiceStartMode::BackgroundSession => CaptureStartReason::BackgroundSession,
    }
}

fn background_eligible(mode: IosVoiceStartMode) -> bool {
    matches!(mode, IosVoiceStartMode::BackgroundSession)
}

fn run_session_thread(
    mut voice_runtime: RuntimeCore,
    mut commands: tokio_mpsc::UnboundedReceiver<Command>,
    status: Arc<Mutex<IosVoiceSessionStatus>>,
    control: AuroraIosCaptureControl,
    remote_audio_consent: bool,
) {
    let tokio_runtime = match TokioRuntimeBuilder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            set_fault(&status, "runtime_unavailable");
            return;
        }
    };
    tokio_runtime.block_on(async move {
        loop {
            let Some(command) = commands.recv().await else {
                break;
            };
            match command {
                Command::Start { mode, reply } => {
                    if voice_runtime.has_active_capture() {
                        let _ = reply.send(Err(IosVoiceSessionCommandError::AlreadyActive));
                        continue;
                    }
                    let generation = match voice_runtime.next_capture_generation() {
                        Ok(generation) => generation,
                        Err(_) => {
                            let _ = reply.send(Err(IosVoiceSessionCommandError::Unavailable));
                            continue;
                        }
                    };
                    let now = now_micros();
                    let lease = VoiceCaptureLease {
                        owner: CaptureOwnerKind::Native,
                        surface: IOS_SURFACE.to_owned(),
                        device_route: "default".to_owned(),
                        start_reason: capture_start_reason(mode),
                        generation,
                        created_at: now,
                        route_revision: RouteRevision(ROUTE_REVISION),
                        background_eligible: background_eligible(mode),
                        consent_revision: if remote_audio_consent { 1 } else { 0 },
                        heartbeat_at: now,
                        stop_deadline: None,
                    };
                    let cancellation = CancellationToken::new();
                    set_active(&status, generation);
                    let _ = reply.send(Ok(generation));
                    let result = run_turn(
                        &mut voice_runtime,
                        &mut commands,
                        mode,
                        lease,
                        now,
                        cancellation,
                        control.clone(),
                    )
                    .await;
                    finish_status(&status, result);
                }
                Command::Shutdown => {
                    if let Some(generation) = active_generation(&status) {
                        control.interrupt(generation);
                    }
                    break;
                }
                Command::Finish { reply, .. } | Command::Cancel { reply, .. } => {
                    let _ = reply.send(Err(IosVoiceSessionCommandError::NotActive));
                }
            }
        }
    });
}

async fn run_turn<'a>(
    runtime: &'a mut RuntimeCore,
    commands: &'a mut tokio_mpsc::UnboundedReceiver<Command>,
    mode: IosVoiceStartMode,
    lease: VoiceCaptureLease,
    at: TimestampMicros,
    cancellation: CancellationToken,
    control: AuroraIosCaptureControl,
) -> Result<String, VoiceCoreError> {
    let generation = lease.generation;
    let mut turn: Pin<Box<dyn Future<Output = Result<String, VoiceCoreError>> + 'a>> = match mode {
        IosVoiceStartMode::PushToTalk => {
            Box::pin(runtime.run_push_to_talk_turn(lease, at, cancellation.clone()))
        }
        IosVoiceStartMode::BackgroundSession => {
            Box::pin(runtime.run_background_turn(lease, at, cancellation.clone()))
        }
    };
    loop {
        tokio::select! {
            result = &mut turn => return result,
            command = commands.recv() => {
                match command {
                    Some(Command::Finish { generation: requested, reply }) if requested == generation => {
                        control.finish(generation);
                        let _ = reply.send(Ok(()));
                    }
                    Some(Command::Cancel { generation: requested, reply }) if requested == generation => {
                        cancellation.cancel();
                        control.interrupt(generation);
                        let _ = reply.send(Ok(()));
                    }
                    Some(Command::Finish { reply, .. }) | Some(Command::Cancel { reply, .. }) => {
                        let _ = reply.send(Err(IosVoiceSessionCommandError::NotActive));
                    }
                    Some(Command::Start { reply, .. }) => {
                        let _ = reply.send(Err(IosVoiceSessionCommandError::AlreadyActive));
                    }
                    Some(Command::Shutdown) | None => {
                        cancellation.cancel();
                        control.interrupt(generation);
                        return Err(VoiceCoreError::Cancelled);
                    }
                }
            }
        }
    }
}

#[derive(Clone)]
struct IosSessionSink {
    status: Arc<Mutex<IosVoiceSessionStatus>>,
}

#[async_trait(?Send)]
impl RuntimeEventSink for IosSessionSink {
    async fn snapshot(&mut self, snapshot: RedactedSnapshot) -> Result<(), VoiceCoreError> {
        if let Ok(mut status) = self.status.lock() {
            status.phase = phase_for_state(snapshot.state);
            status.generation = Some(snapshot.generation);
        }
        Ok(())
    }

    async fn event(&mut self, event: RuntimeEvent) -> Result<(), VoiceCoreError> {
        if let RuntimeEvent::State { transition } = event {
            if let Ok(mut status) = self.status.lock() {
                status.phase = phase_for_state(transition.to);
                status.generation = Some(transition.generation);
            }
        }
        Ok(())
    }
}

fn phase_for_state(state: VoiceState) -> IosVoiceSessionPhase {
    match state {
        VoiceState::Arming | VoiceState::ListeningForWake | VoiceState::WakeDetected => {
            IosVoiceSessionPhase::Starting
        }
        VoiceState::CapturingUtterance => IosVoiceSessionPhase::Listening,
        VoiceState::Transcribing | VoiceState::Dispatching | VoiceState::AwaitingResponse => {
            IosVoiceSessionPhase::Processing
        }
        VoiceState::Speaking => IosVoiceSessionPhase::Speaking,
        VoiceState::Stopping => IosVoiceSessionPhase::Stopping,
        VoiceState::Faulted => IosVoiceSessionPhase::Faulted,
        VoiceState::Idle | VoiceState::Disabled => IosVoiceSessionPhase::Idle,
        VoiceState::Provisioning
        | VoiceState::Unavailable
        | VoiceState::Interrupted
        | VoiceState::Suspended
        | VoiceState::Recovering => IosVoiceSessionPhase::Faulted,
    }
}

fn set_active(status: &Arc<Mutex<IosVoiceSessionStatus>>, generation: Generation) {
    if let Ok(mut status) = status.lock() {
        status.active = true;
        status.phase = IosVoiceSessionPhase::Starting;
        status.generation = Some(generation);
        status.last_error = None;
    }
}

fn active_generation(status: &Arc<Mutex<IosVoiceSessionStatus>>) -> Option<Generation> {
    status.lock().ok().and_then(|status| status.generation)
}

fn finish_status(
    status: &Arc<Mutex<IosVoiceSessionStatus>>,
    result: Result<String, VoiceCoreError>,
) {
    if let Ok(mut status) = status.lock() {
        status.active = false;
        status.phase = if result.is_ok() {
            IosVoiceSessionPhase::Idle
        } else {
            IosVoiceSessionPhase::Faulted
        };
        status.generation = None;
        match result {
            Ok(_) => status.completed_turns = status.completed_turns.saturating_add(1),
            Err(error) => {
                status.failed_turns = status.failed_turns.saturating_add(1);
                status.last_error = Some(error_code(&error).to_owned());
            }
        }
    }
}

fn set_fault(status: &Arc<Mutex<IosVoiceSessionStatus>>, code: &str) {
    if let Ok(mut status) = status.lock() {
        status.active = false;
        status.phase = IosVoiceSessionPhase::Faulted;
        status.last_error = Some(code.to_owned());
    }
}

fn error_code(error: &VoiceCoreError) -> &'static str {
    match error {
        VoiceCoreError::Cancelled => "cancelled",
        VoiceCoreError::TransportFault { .. } => "transport_fault",
        VoiceCoreError::Engine(_) => "engine_fault",
        VoiceCoreError::Backpressure => "backpressure",
        VoiceCoreError::InvalidTransition => "invalid_transition",
        _ => "turn_failed",
    }
}

fn now_micros() -> TimestampMicros {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .min(u128::from(u64::MAX));
    TimestampMicros(micros as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_debug_redacts_endpoint_and_auth_material() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("https://user:pass@gateway.example.test/path?token=secret").expect("url"),
            GatewayAuth::Bearer("native-secret".to_owned()),
            true,
        );
        let debug = format!("{config:?}");
        assert!(debug.contains("endpoint_class"));
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains("gateway.example.test"));
        assert!(!debug.contains("native-secret"));
        assert!(!debug.contains("token=secret"));
        assert!(!debug.contains("user:pass"));
    }

    #[test]
    fn ios_pack_bindings_are_bounded_deduplicated_and_redacted() {
        let binding = IosVoicePackBinding::new(PackTask::Stt, "default", "/private/model-pack")
            .expect("binding");
        assert_eq!(binding.task(), PackTask::Stt);
        assert_eq!(binding.slot_id(), "default");
        assert_eq!(
            IosVoicePackBindings::new(vec![binding.clone()])
                .expect("bindings")
                .len(),
            1
        );
        assert!(IosVoicePackBindings::new(vec![binding.clone(), binding.clone()]).is_err());
        let debug = format!("{binding:?}");
        assert!(debug.contains("Stt"));
        assert!(!debug.contains("/private/model-pack"));
    }

    #[test]
    fn ios_session_with_pack_bindings_fails_closed_without_native_engine() {
        let bindings = IosVoicePackBindings::new(vec![IosVoicePackBinding::new(
            PackTask::Stt,
            "default",
            "/private/model-pack",
        )
        .expect("binding")])
        .expect("bindings");
        let config = IosVoiceSessionConfig::with_pack_bindings(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
            bindings,
        );
        let audio_state = AuroraIosAudioState::new(1, 1);
        let output = AuroraIosAudioOutput::new(1);
        let input = AuroraIosAudioInput::new(audio_state);
        let sink = IosSessionSink {
            status: Arc::new(Mutex::new(IosVoiceSessionStatus::default())),
        };
        assert!(matches!(
            build_runtime(&config, input, output, sink),
            Err(IosVoiceSessionCommandError::Unavailable)
        ));
    }

    #[test]
    fn loopback_policy_does_not_require_remote_consent() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        assert_eq!(
            microphone_policy(&config),
            Ok(MicrophoneAudioPolicy::LoopbackOnly)
        );
    }

    #[test]
    fn remote_policy_requires_explicit_consent() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("https://gateway.example.test").expect("url"),
            GatewayAuth::None,
            false,
        );
        assert_eq!(
            microphone_policy(&config),
            Err(IosVoiceSessionCommandError::Unavailable)
        );
    }

    #[test]
    fn start_modes_preserve_background_lease_semantics() {
        assert_eq!(
            capture_start_reason(IosVoiceStartMode::PushToTalk),
            CaptureStartReason::PushToTalk
        );
        assert!(!background_eligible(IosVoiceStartMode::PushToTalk));
        assert_eq!(
            capture_start_reason(IosVoiceStartMode::BackgroundSession),
            CaptureStartReason::BackgroundSession
        );
        assert!(background_eligible(IosVoiceStartMode::BackgroundSession));
    }

    #[test]
    fn status_mapping_is_product_safe() {
        assert_eq!(
            phase_for_state(VoiceState::CapturingUtterance),
            IosVoiceSessionPhase::Listening
        );
        assert_eq!(
            phase_for_state(VoiceState::Unavailable),
            IosVoiceSessionPhase::Faulted
        );
    }

    #[test]
    fn session_cancel_releases_generation_without_network_work() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let session = IosVoiceSession::new_default(config).expect("session");
        let generation = session.start().expect("start");
        session.cancel(generation.0).expect("cancel");
        for _ in 0..100 {
            if !session.status().active {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let status = session.status();
        assert!(!status.active);
        assert_eq!(status.failed_turns, 1);
        assert_eq!(status.last_error.as_deref(), Some("cancelled"));
    }
}
