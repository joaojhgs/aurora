//! Android-native voice session executor.
//!
//! This module owns the shared Rust [`VoiceRuntime`] for an Android turn. Kotlin
//! owns the platform capture/playback threads, but it never owns voice state,
//! generations, transport calls, or cancellation semantics.

use crate::{
    AndroidAudioInput, AndroidAudioOutput, AndroidCaptureControl, AndroidPcmIngress, GatewayAuth,
    MicrophoneAudioPolicy, NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig,
    NativeGatewayTransport, NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer, TransportLimits,
};
use async_trait::async_trait;
use aurora_voice_core::{
    CancellationToken, CaptureOwnerKind, CaptureStartReason, Generation, RedactedSnapshot,
    RouteFiniteSttBinding, RouteRevision, RouteTtsBinding, RuntimeEvent, RuntimeEventSink,
    TimestampMicros, VoiceCaptureLease, VoiceCoreError, VoiceRuntime, VoiceState,
};
use aurora_voice_engine::{FiniteSttRouteScope, MAX_FINITE_STT_SAMPLES, VAD_SAMPLE_RATE_HZ};
use std::future::Future;
use std::pin::Pin;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::runtime::Builder as TokioRuntimeBuilder;
use tokio::sync::mpsc as tokio_mpsc;
use url::Url;

const ROUTE_REVISION: u64 = 1;
const ANDROID_SURFACE: &str = "android";
const ANDROID_RUNTIME_ID: &str = "android-native-voice";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(45);

type RuntimeCore = VoiceRuntime<
    AndroidAudioInput,
    NativeGatewayFiniteStt,
    NativeGatewayTtsSynthesizer,
    NativeGatewayTransport,
    AndroidAudioOutput,
    AndroidSessionSink,
>;

#[derive(Clone, Debug)]
pub struct AndroidVoiceSessionConfig {
    gateway: Url,
    auth: GatewayAuth,
    remote_audio_consent: bool,
}

impl AndroidVoiceSessionConfig {
    pub fn new(gateway: Url, auth: GatewayAuth, remote_audio_consent: bool) -> Self {
        Self {
            gateway,
            auth,
            remote_audio_consent,
        }
    }
}

#[repr(i64)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndroidVoiceSessionPhase {
    Idle,
    Starting,
    Listening,
    Processing,
    Speaking,
    Stopping,
    Faulted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidVoiceSessionStatus {
    pub active: bool,
    pub phase: AndroidVoiceSessionPhase,
    pub generation: Option<Generation>,
    pub completed_turns: u64,
    pub failed_turns: u64,
    pub last_error: Option<String>,
}

impl Default for AndroidVoiceSessionStatus {
    fn default() -> Self {
        Self {
            active: false,
            phase: AndroidVoiceSessionPhase::Idle,
            generation: None,
            completed_turns: 0,
            failed_turns: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AndroidVoiceSessionCommandError {
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
        mode: AndroidVoiceStartMode,
        reply: mpsc::Sender<Result<Generation, AndroidVoiceSessionCommandError>>,
    },
    Finish {
        generation: Generation,
        reply: mpsc::Sender<Result<(), AndroidVoiceSessionCommandError>>,
    },
    Cancel {
        generation: Generation,
        reply: mpsc::Sender<Result<(), AndroidVoiceSessionCommandError>>,
    },
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndroidVoiceStartMode {
    PushToTalk,
    BackgroundSession,
}

/// Native Android voice runtime handle shared by JNI capture, playback, and
/// foreground-service controls.
pub struct AndroidVoiceSession {
    ingress: AndroidPcmIngress,
    output: AndroidAudioOutput,
    commands: tokio_mpsc::UnboundedSender<Command>,
    status: Arc<Mutex<AndroidVoiceSessionStatus>>,
    join: Mutex<Option<thread::JoinHandle<()>>>,
}

impl AndroidVoiceSession {
    pub fn new(
        config: AndroidVoiceSessionConfig,
        ingress_capacity_chunks: usize,
        max_chunk_samples: usize,
        output_capacity_chunks: usize,
    ) -> Result<Self, AndroidVoiceSessionCommandError> {
        let ingress = AndroidPcmIngress::new(ingress_capacity_chunks, max_chunk_samples);
        let output = AndroidAudioOutput::new(output_capacity_chunks);
        let input = AndroidAudioInput::new(ingress.clone());
        let control = input.control();
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus::default()));
        let sink = AndroidSessionSink {
            status: Arc::clone(&status),
        };
        let runtime = build_runtime(&config, input, output.clone(), sink)?;
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let thread_status = Arc::clone(&status);
        let thread_control = control.clone();
        let join = thread::Builder::new()
            .name("aurora-android-voice".to_owned())
            .spawn(move || {
                run_session_thread(
                    runtime,
                    command_rx,
                    thread_status,
                    thread_control,
                    config.remote_audio_consent,
                )
            })
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        Ok(Self {
            ingress,
            output,
            commands,
            status,
            join: Mutex::new(Some(join)),
        })
    }

    pub fn ingress(&self) -> AndroidPcmIngress {
        self.ingress.clone()
    }

    pub fn output(&self) -> AndroidAudioOutput {
        self.output.clone()
    }

    pub fn status(&self) -> AndroidVoiceSessionStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| AndroidVoiceSessionStatus {
                phase: AndroidVoiceSessionPhase::Faulted,
                last_error: Some("status_unavailable".to_owned()),
                ..AndroidVoiceSessionStatus::default()
            })
    }

    pub fn start(&self) -> Result<Generation, AndroidVoiceSessionCommandError> {
        self.start_with_mode(AndroidVoiceStartMode::PushToTalk)
    }

    pub fn start_background(&self) -> Result<Generation, AndroidVoiceSessionCommandError> {
        self.start_with_mode(AndroidVoiceStartMode::BackgroundSession)
    }

    fn start_with_mode(
        &self,
        mode: AndroidVoiceStartMode,
    ) -> Result<Generation, AndroidVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        self.commands
            .send(Command::Start { mode, reply })
            .map_err(|_| AndroidVoiceSessionCommandError::Closed)?;
        response
            .recv()
            .unwrap_or(Err(AndroidVoiceSessionCommandError::Closed))
    }

    pub fn finish(&self, generation: u64) -> Result<(), AndroidVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        self.commands
            .send(Command::Finish {
                generation: Generation(generation),
                reply,
            })
            .map_err(|_| AndroidVoiceSessionCommandError::Closed)?;
        response
            .recv()
            .unwrap_or(Err(AndroidVoiceSessionCommandError::Closed))
    }

    pub fn cancel(&self, generation: u64) -> Result<(), AndroidVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        self.commands
            .send(Command::Cancel {
                generation: Generation(generation),
                reply,
            })
            .map_err(|_| AndroidVoiceSessionCommandError::Closed)?;
        response
            .recv()
            .unwrap_or(Err(AndroidVoiceSessionCommandError::Closed))
    }

    pub fn close(&self) {
        let _ = self.commands.send(Command::Shutdown);
        self.ingress.close();
        self.output.close();
        if let Ok(mut join) = self.join.lock() {
            if let Some(handle) = join.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for AndroidVoiceSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn build_runtime(
    config: &AndroidVoiceSessionConfig,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
) -> Result<RuntimeCore, AndroidVoiceSessionCommandError> {
    let policy = if config.gateway.scheme() == "http" && is_loopback(&config.gateway) {
        MicrophoneAudioPolicy::LoopbackOnly
    } else {
        if !config.remote_audio_consent {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
        MicrophoneAudioPolicy::ExplicitRemoteConsent
    };
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
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let tts_route = RouteTtsBinding::new(
        "gateway.default",
        "voice.default",
        VAD_SAMPLE_RATE_HZ,
        ROUTE_REVISION,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
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
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let transport_for_tts =
        NativeGatewayTransport::new(config.gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let transport_for_assistant =
        NativeGatewayTransport::new(config.gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let stt = NativeGatewayFiniteStt::new(
        transport_for_stt,
        NativeGatewayFiniteSttConfig::realtime(stt_route, policy)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let tts = NativeGatewayTtsSynthesizer::new(
        transport_for_tts,
        NativeGatewayTtsConfig::new(tts_route, None, 1.0, 16_000 * 30)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    );
    VoiceRuntime::new(
        input,
        stt,
        tts,
        transport_for_assistant,
        output,
        sink,
        ANDROID_SURFACE,
        ANDROID_RUNTIME_ID,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)
}

fn is_loopback(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    )
}

fn capture_start_reason(mode: AndroidVoiceStartMode) -> CaptureStartReason {
    match mode {
        AndroidVoiceStartMode::PushToTalk => CaptureStartReason::PushToTalk,
        AndroidVoiceStartMode::BackgroundSession => CaptureStartReason::BackgroundSession,
    }
}

fn background_eligible(mode: AndroidVoiceStartMode) -> bool {
    matches!(mode, AndroidVoiceStartMode::BackgroundSession)
}

fn run_session_thread(
    mut voice_runtime: RuntimeCore,
    mut commands: tokio_mpsc::UnboundedReceiver<Command>,
    status: Arc<Mutex<AndroidVoiceSessionStatus>>,
    control: AndroidCaptureControl,
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
                        let _ = reply.send(Err(AndroidVoiceSessionCommandError::AlreadyActive));
                        continue;
                    }
                    let generation = match voice_runtime.next_capture_generation() {
                        Ok(generation) => generation,
                        Err(_) => {
                            let _ = reply.send(Err(AndroidVoiceSessionCommandError::Unavailable));
                            continue;
                        }
                    };
                    let now = now_micros();
                    let lease = VoiceCaptureLease {
                        owner: CaptureOwnerKind::Native,
                        surface: ANDROID_SURFACE.to_owned(),
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
                    let _ = reply.send(Err(AndroidVoiceSessionCommandError::NotActive));
                }
            }
        }
    });
}

async fn run_turn<'a>(
    runtime: &'a mut RuntimeCore,
    commands: &'a mut tokio_mpsc::UnboundedReceiver<Command>,
    mode: AndroidVoiceStartMode,
    lease: VoiceCaptureLease,
    at: TimestampMicros,
    cancellation: CancellationToken,
    control: AndroidCaptureControl,
) -> Result<String, VoiceCoreError> {
    let generation = lease.generation;
    let mut turn: Pin<Box<dyn Future<Output = Result<String, VoiceCoreError>> + 'a>> = match mode {
        AndroidVoiceStartMode::PushToTalk => {
            Box::pin(runtime.run_push_to_talk_turn(lease, at, cancellation.clone()))
        }
        AndroidVoiceStartMode::BackgroundSession => {
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
                        let _ = reply.send(Err(AndroidVoiceSessionCommandError::NotActive));
                    }
                    Some(Command::Start { reply, .. }) => {
                        let _ = reply.send(Err(AndroidVoiceSessionCommandError::AlreadyActive));
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
struct AndroidSessionSink {
    status: Arc<Mutex<AndroidVoiceSessionStatus>>,
}

#[async_trait(?Send)]
impl RuntimeEventSink for AndroidSessionSink {
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

fn phase_for_state(state: VoiceState) -> AndroidVoiceSessionPhase {
    match state {
        VoiceState::Arming | VoiceState::ListeningForWake | VoiceState::WakeDetected => {
            AndroidVoiceSessionPhase::Starting
        }
        VoiceState::CapturingUtterance => AndroidVoiceSessionPhase::Listening,
        VoiceState::Transcribing | VoiceState::Dispatching | VoiceState::AwaitingResponse => {
            AndroidVoiceSessionPhase::Processing
        }
        VoiceState::Speaking => AndroidVoiceSessionPhase::Speaking,
        VoiceState::Stopping => AndroidVoiceSessionPhase::Stopping,
        VoiceState::Faulted => AndroidVoiceSessionPhase::Faulted,
        VoiceState::Idle | VoiceState::Disabled => AndroidVoiceSessionPhase::Idle,
        VoiceState::Provisioning
        | VoiceState::Unavailable
        | VoiceState::Interrupted
        | VoiceState::Suspended
        | VoiceState::Recovering => AndroidVoiceSessionPhase::Faulted,
    }
}

fn set_active(status: &Arc<Mutex<AndroidVoiceSessionStatus>>, generation: Generation) {
    if let Ok(mut status) = status.lock() {
        status.active = true;
        status.phase = AndroidVoiceSessionPhase::Starting;
        status.generation = Some(generation);
        status.last_error = None;
    }
}

fn active_generation(status: &Arc<Mutex<AndroidVoiceSessionStatus>>) -> Option<Generation> {
    status.lock().ok().and_then(|status| status.generation)
}

fn finish_status(
    status: &Arc<Mutex<AndroidVoiceSessionStatus>>,
    result: Result<String, VoiceCoreError>,
) {
    if let Ok(mut status) = status.lock() {
        status.active = false;
        status.phase = if result.is_ok() {
            AndroidVoiceSessionPhase::Idle
        } else {
            AndroidVoiceSessionPhase::Faulted
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

fn set_fault(status: &Arc<Mutex<AndroidVoiceSessionStatus>>, code: &str) {
    if let Ok(mut status) = status.lock() {
        status.active = false;
        status.phase = AndroidVoiceSessionPhase::Faulted;
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
    fn loopback_policy_is_selected_without_exposing_credentials() {
        let url = Url::parse("http://127.0.0.1:8000").expect("url");
        assert!(is_loopback(&url));
        let remote = Url::parse("https://gateway.example.test").expect("url");
        assert!(!is_loopback(&remote));
    }

    #[test]
    fn state_mapping_is_product_safe() {
        assert_eq!(
            phase_for_state(VoiceState::Speaking),
            AndroidVoiceSessionPhase::Speaking
        );
        assert_eq!(
            phase_for_state(VoiceState::Faulted),
            AndroidVoiceSessionPhase::Faulted
        );
    }

    #[test]
    fn background_mode_uses_background_lease_semantics() {
        assert_eq!(
            capture_start_reason(AndroidVoiceStartMode::BackgroundSession),
            CaptureStartReason::BackgroundSession
        );
        assert!(background_eligible(
            AndroidVoiceStartMode::BackgroundSession
        ));
        assert_eq!(
            capture_start_reason(AndroidVoiceStartMode::PushToTalk),
            CaptureStartReason::PushToTalk
        );
        assert!(!background_eligible(AndroidVoiceStartMode::PushToTalk));
    }

    #[test]
    fn session_cancel_releases_the_generation_without_network_work() {
        let config = AndroidVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let session = AndroidVoiceSession::new(config, 2, 128, 2).expect("session");
        let generation = session.start().expect("start");
        session.cancel(generation.0).expect("cancel");
        for _ in 0..100 {
            if !session.status().active {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let status = session.status();
        assert!(!status.active);
        assert_eq!(status.failed_turns, 1);
        assert_eq!(status.last_error.as_deref(), Some("cancelled"));
    }
}
