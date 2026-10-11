//! Finite local speech methods for the authenticated desktop peer host.
//!
//! The commands intentionally accept no caller identity. Each admission is
//! tied to the current native profile/policy snapshot and holds its profile
//! transition lease until model work and cancellation have actually returned.

use super::native_node_config::NativeNodeConfigRuntime;
use aurora_mesh_authority::authority::AuthenticatedPeerContext;
use aurora_mesh_authority::types::{
    PeerHostAuthorizationStore, PeerHostAuthorizeRequest, PeerHostIdentity,
};
use aurora_voice_core::node_policy::{
    NodeConfigDocumentV2, NullableField, RoutingPreference, SpeechStageConfig,
};
use aurora_voice_engine::StreamResetReason;
use aurora_voice_engine::{
    BoundKwsRequest, BoundTaskRequest, BoundTtsSynthesisRequest, BoundVadRequest,
    FiniteSttAudioBuilder, FiniteSttPort, KwsConfig, KwsStreamProvider, SpeechCatalogTask,
    SpeechModelCatalog, StreamingAudioFrame, TaskProvider, TaskReadiness, TaskRequest,
    TtsSynthesisConfig, TtsSynthesisPort, TtsVoiceCatalog, VadConfig, VadStreamProvider, VoiceTask,
    TTS_MAX_TEXT_BYTES, VAD_SAMPLE_RATE_HZ, VAD_WINDOW_SIZE_SAMPLES,
};
use aurora_voice_native::{
    build_installed_kws_provider_from_phrases, build_installed_stt_provider,
    build_installed_tts_provider, build_installed_vad_provider, SpeechPackManager,
    SpeechPackManagerConfig,
};
use aurora_voice_sherpa::SherpaKwsPhraseInput;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;

const MAX_ACTIVE_OPERATIONS: usize = 2;
const MAX_STT_SAMPLES: usize = 16_000 * 60;
const MAX_STT_BYTES: usize = MAX_STT_SAMPLES * 2;
const MAX_TTS_SAMPLES: usize = 48_000 * 60;
const TTS_CHUNK_SAMPLES: usize = 4096;
const STAGE_MAX_CHUNK_BYTES: usize = 64 * 1024;
const STAGE_MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const STAGE_IDLE_LEASE: Duration = Duration::from_secs(15);
const STAGE_MAX_LIFETIME: Duration = Duration::from_secs(300);
const STAGE_MAX_SESSIONS: usize = 1;
const STAGE_MAX_TOMBSTONES: usize = 8;
const STAGE_TOMBSTONE_LEASE: Duration = Duration::from_secs(30);
const STAGE_MAX_QUEUE: usize = 4;

#[derive(Default)]
pub(crate) struct NativeSpeechHostState {
    operations: Arc<Mutex<HashMap<String, Arc<NativeSpeechOperation>>>>,
    stages: Arc<Mutex<HashMap<String, Arc<NativePeerSpeechStageSession>>>>,
}

struct NativePeerSpeechStageSession {
    gate: AsyncMutex<()>,
    data: Mutex<NativePeerSpeechStageData>,
}

struct NativePeerSpeechStageData {
    session_id: String,
    stage: String,
    owner: NativePeerSpeechOwner,
    operation_id: String,
    attempt_id: String,
    generation: u64,
    consumer_config_revision: u64,
    consumer_route_revision: String,
    host_generation: u64,
    host_revision: u64,
    model_id: String,
    model_revision: String,
    sender: SyncSender<NativePeerSpeechStageCommand>,
    started: Instant,
    last_activity: Instant,
    next_sequence: u64,
    accepted_chunks: u64,
    input_bytes: usize,
    output_count: u64,
    terminal: Option<(String, String)>,
    terminal_at: Option<Instant>,
    final_sequence: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NativePeerSpeechOwner {
    peer_id: String,
    connection_epoch: Option<String>,
    authenticated_at_ms: i64,
    credential_revision: i64,
    token_id: String,
    room_name: String,
    verifier_peer_id: String,
    channel_binding: String,
    claimant_signaling_peer_id: String,
    verifier_signaling_peer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativePeerSpeechStageCall {
    operation: String,
    stage: String,
    payload: Value,
    call_context: NativePeerSpeechCallContext,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativePeerSpeechCallContext {
    id: String,
    method_id: String,
    remote_peer_id: String,
    identity: PeerHostIdentity,
    authenticated_peer_context: AuthenticatedPeerContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct NativePeerSpeechStageStart {
    schema: String,
    stage: String,
    mode: String,
    operation_id: String,
    attempt_id: String,
    request_id: String,
    generation: u64,
    config_revision: u64,
    route_revision: String,
    capability_revision: u64,
    #[serde(default)]
    target_peer_id: Option<String>,
    #[serde(default)]
    target_resource_id: Option<String>,
    #[serde(default)]
    consent_revision: Option<String>,
    remaining_deadline_ms: u64,
    exact_selector: bool,
    experimental_remote: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct NativePeerSpeechStageFrame {
    session_id: String,
    attempt_id: String,
    generation: u64,
    sequence: u64,
    payload_kind: String,
    payload_size_bytes: usize,
    #[serde(default)]
    is_final: bool,
    audio_data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct NativePeerSpeechStageEnd {
    session_id: String,
    #[serde(default)]
    final_sequence: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct NativePeerSpeechStageSessionRef {
    session_id: String,
    #[serde(default)]
    reason: Option<String>,
}

enum NativePeerSpeechStageCommand {
    Frame {
        sequence: u64,
        samples: Vec<f32>,
        reply: SyncSender<Result<u64, ()>>,
    },
    End {
        reply: SyncSender<Result<u64, ()>>,
    },
    Cancel {
        reply: SyncSender<Result<(), ()>>,
    },
}

enum NativePeerSpeechStageEngine {
    Kws {
        provider: Box<dyn KwsStreamProvider>,
        session: aurora_voice_engine::BoundStreamSession,
        config: KwsConfig,
        engine_sequence: u64,
    },
    Vad {
        provider: Box<dyn VadStreamProvider>,
        session: aurora_voice_engine::BoundStreamSession,
        config: VadConfig,
        pending: Vec<f32>,
        engine_sequence: u64,
    },
}

#[derive(Clone)]
struct NativePeerSpeechWorkerConfig {
    root: std::path::PathBuf,
    stage: String,
    choice: HostedStageChoice,
    generation: u64,
    app: AppHandle,
    stages: Arc<Mutex<HashMap<String, Arc<NativePeerSpeechStageSession>>>>,
    session_id: String,
    host_generation: u64,
    host_revision: u64,
}

fn spawn_hosted_stage_worker(
    config: NativePeerSpeechWorkerConfig,
    ready_deadline: Instant,
) -> Result<SyncSender<NativePeerSpeechStageCommand>, String> {
    let (commands, receiver) = mpsc::sync_channel(STAGE_MAX_QUEUE);
    let (ready, result) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("aurora-hosted-speech-stage".to_owned())
        .spawn(move || {
            let mut engine = match initialize_hosted_stage_engine(&config, ready_deadline) {
                Ok(engine) => {
                    let _ = ready.send(Ok(()));
                    engine
                }
                Err(()) => {
                    let _ = ready.send(Err(()));
                    return;
                }
            };
            let started = Instant::now();
            let mut last_activity = started;
            loop {
                let remaining = STAGE_IDLE_LEASE
                    .saturating_sub(last_activity.elapsed())
                    .min(STAGE_MAX_LIFETIME.saturating_sub(started.elapsed()))
                    .min(Duration::from_millis(500));
                if remaining.is_zero() {
                    engine.cancel();
                    if let Ok(mut stages) = config.stages.lock() {
                        stages.remove(&config.session_id);
                    }
                    return;
                }
                let command = match receiver.recv_timeout(remaining) {
                    Ok(command) => command,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        engine.cancel();
                        return;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let current = tauri::async_runtime::block_on(async {
                            if !native_host_is_foreground(&config.app).await {
                                return false;
                            }
                            let Some(node_config) =
                                config.app.try_state::<NativeNodeConfigRuntime>()
                            else {
                                return false;
                            };
                            let Ok((transition, generation, document, _)) =
                                node_config.transcription_admission_snapshot().await
                            else {
                                return false;
                            };
                            drop(transition);
                            generation == config.host_generation
                                && document.revision == config.host_revision
                                && node_config.profile_generation_is_current(generation)
                        });
                        if !current {
                            engine.cancel();
                            if let Ok(mut stages) = config.stages.lock() {
                                stages.remove(&config.session_id);
                            }
                            return;
                        }
                        continue;
                    }
                };
                match command {
                    NativePeerSpeechStageCommand::Frame {
                        sequence,
                        samples,
                        reply,
                    } => {
                        let result = engine.push_frame(sequence, &samples);
                        let terminal = result.is_err();
                        if terminal {
                            engine.cancel();
                            if let Ok(mut stages) = config.stages.lock() {
                                stages.remove(&config.session_id);
                            }
                            let _ = reply.send(result);
                            return;
                        } else {
                            last_activity = Instant::now();
                        }
                        let _ = reply.send(result);
                    }
                    NativePeerSpeechStageCommand::End { reply } => {
                        let output_count = engine.finish();
                        if output_count.is_err() {
                            engine.cancel();
                        }
                        drop(engine);
                        let _ = reply.send(output_count);
                        return;
                    }
                    NativePeerSpeechStageCommand::Cancel { reply } => {
                        let result = engine.cancel();
                        drop(engine);
                        let _ = reply.send(result);
                        return;
                    }
                }
            }
        })
        .map_err(|_| "Speech stream engine is unavailable".to_owned())?;
    let remaining_deadline = ready_deadline.saturating_duration_since(Instant::now());
    if remaining_deadline.is_zero() {
        return Err("Speech stream engine is unavailable".to_owned());
    }
    result
        .recv_timeout(remaining_deadline)
        .map_err(|_| "Speech stream engine is unavailable".to_owned())?
        .map_err(|_| "Speech stream engine is unavailable".to_owned())?;
    Ok(commands)
}

fn initialize_hosted_stage_engine(
    config: &NativePeerSpeechWorkerConfig,
    ready_deadline: Instant,
) -> Result<NativePeerSpeechStageEngine, ()> {
    let manager = SpeechPackManager::open(
        SpeechPackManagerConfig::new(config.root.clone(), None).map_err(|_| ())?,
    )
    .map_err(|_| ())?;
    match config.stage.as_str() {
        "kws" => {
            let phrase_id = config.choice.phrase_id.as_deref().ok_or(())?;
            let phrase = config.choice.phrase.as_deref().ok_or(())?;
            let phrase_revision = config.choice.phrase_revision.as_deref().ok_or(())?;
            let mut provider = Box::new(
                build_installed_kws_provider_from_phrases(
                    &manager,
                    &config.choice.model_id,
                    phrase_revision,
                    [SherpaKwsPhraseInput::new(phrase_id, phrase).map_err(|_| ())?],
                )
                .map_err(|_| ())?,
            ) as Box<dyn KwsStreamProvider>;
            let capability = provider
                .capabilities()
                .into_iter()
                .find(|capability| {
                    capability.task() == VoiceTask::KeywordSpotting
                        && capability.local_only()
                        && capability.streaming_enabled()
                })
                .ok_or(())?;
            let task_request = BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::KeywordSpotting,
                    language: config.choice.language.clone(),
                    generation: config.generation,
                },
                capability.binding().clone(),
            )
            .map_err(|_| ())?;
            block_on_stage_deadline(ready_deadline, provider.warm_task(task_request.clone()))
                .map_err(|_| ())?
                .map_err(|_| ())?;
            let kws_config = KwsConfig::new(
                [phrase_id.to_owned()],
                phrase_revision,
                aurora_voice_native::NATIVE_WAKE_KWS_THRESHOLD,
                0,
                1,
            )
            .map_err(|_| ())?;
            let request = BoundKwsRequest::new(task_request, kws_config.clone()).map_err(|_| ())?;
            let session =
                block_on_stage_deadline(ready_deadline, provider.start_kws_session(request))
                    .map_err(|_| ())?
                    .map_err(|_| ())?;
            Ok(NativePeerSpeechStageEngine::Kws {
                provider,
                session,
                config: kws_config,
                engine_sequence: 0,
            })
        }
        "vad" => {
            let vad_config = VadConfig::default();
            let mut provider = Box::new(
                build_installed_vad_provider(&manager, &config.choice.model_id, &vad_config)
                    .map_err(|_| ())?,
            ) as Box<dyn VadStreamProvider>;
            let capability = provider
                .capabilities()
                .into_iter()
                .find(|capability| {
                    capability.task() == VoiceTask::VoiceActivityDetection
                        && capability.local_only()
                        && capability.streaming_enabled()
                })
                .ok_or(())?;
            let task_request = BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::VoiceActivityDetection,
                    language: config.choice.language.clone(),
                    generation: config.generation,
                },
                capability.binding().clone(),
            )
            .map_err(|_| ())?;
            block_on_stage_deadline(ready_deadline, provider.warm_task(task_request.clone()))
                .map_err(|_| ())?
                .map_err(|_| ())?;
            let request = BoundVadRequest::new(task_request, vad_config.clone()).map_err(|_| ())?;
            let session =
                block_on_stage_deadline(ready_deadline, provider.start_vad_session(request))
                    .map_err(|_| ())?
                    .map_err(|_| ())?;
            Ok(NativePeerSpeechStageEngine::Vad {
                provider,
                session,
                config: vad_config,
                pending: Vec::new(),
                engine_sequence: 0,
            })
        }
        _ => Err(()),
    }
}

fn block_on_stage_deadline<F: Future>(deadline: Instant, future: F) -> Result<F::Output, ()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(());
    }
    tauri::async_runtime::block_on(async move { tokio::time::timeout(remaining, future).await })
        .map_err(|_| ())
}

impl NativePeerSpeechStageEngine {
    fn push_frame(&mut self, _wire_sequence: u64, samples: &[f32]) -> Result<u64, ()> {
        match self {
            Self::Kws {
                provider,
                session,
                engine_sequence,
                ..
            } => {
                let mut output_count = 0_u64;
                for frame_samples in samples.chunks(16_000) {
                    let frame = StreamingAudioFrame::new(
                        *engine_sequence,
                        VAD_SAMPLE_RATE_HZ,
                        1,
                        frame_samples,
                        false,
                    )
                    .map_err(|_| ())?;
                    *engine_sequence = engine_sequence.saturating_add(1);
                    let result = tauri::async_runtime::block_on(provider.push_kws_frame(
                        session,
                        frame,
                        &|| false,
                    ))
                    .map_err(|_| ())?;
                    output_count = output_count.saturating_add(result.matches().len() as u64);
                }
                Ok(output_count)
            }
            Self::Vad {
                provider,
                session,
                config,
                pending,
                engine_sequence,
            } => {
                pending.extend_from_slice(samples);
                let mut output_count = 0_u64;
                while pending.len() >= VAD_WINDOW_SIZE_SAMPLES {
                    let window = pending.drain(..VAD_WINDOW_SIZE_SAMPLES).collect::<Vec<_>>();
                    config.validate_frame_samples(&window).map_err(|_| ())?;
                    let frame = StreamingAudioFrame::new(
                        *engine_sequence,
                        VAD_SAMPLE_RATE_HZ,
                        1,
                        &window,
                        false,
                    )
                    .map_err(|_| ())?;
                    *engine_sequence = engine_sequence.saturating_add(1);
                    let result = tauri::async_runtime::block_on(provider.push_vad_frame(
                        session,
                        frame,
                        &|| false,
                    ))
                    .map_err(|_| ())?;
                    output_count = output_count
                        .saturating_add(u64::from(result.detected()))
                        .saturating_add(result.segments().len() as u64);
                }
                Ok(output_count)
            }
        }
    }

    fn finish(&mut self) -> Result<u64, ()> {
        match self {
            Self::Kws {
                provider, session, ..
            } => {
                tauri::async_runtime::block_on(
                    provider.reset_kws_session(session, StreamResetReason::Manual),
                )
                .map_err(|_| ())?;
                Ok(0)
            }
            Self::Vad {
                provider,
                session,
                pending,
                engine_sequence,
                ..
            } => {
                let mut output_count = 0_u64;
                if !pending.is_empty() {
                    let tail = std::mem::take(pending);
                    let frame = StreamingAudioFrame::end_tail(
                        *engine_sequence,
                        VAD_SAMPLE_RATE_HZ,
                        1,
                        &tail,
                        false,
                    )
                    .map_err(|_| ())?;
                    *engine_sequence = engine_sequence.saturating_add(1);
                    let result = tauri::async_runtime::block_on(provider.push_vad_frame(
                        session,
                        frame,
                        &|| false,
                    ))
                    .map_err(|_| ())?;
                    output_count = output_count
                        .saturating_add(u64::from(result.detected()))
                        .saturating_add(result.segments().len() as u64);
                }
                let segments =
                    tauri::async_runtime::block_on(provider.flush_vad_session(session, &|| false))
                        .map_err(|_| ())?;
                let count = output_count.saturating_add(segments.len() as u64);
                tauri::async_runtime::block_on(
                    provider.reset_vad_session(session, StreamResetReason::Manual),
                )
                .map_err(|_| ())?;
                Ok(count)
            }
        }
    }

    fn cancel(&mut self) -> Result<(), ()> {
        match self {
            Self::Kws {
                provider, session, ..
            } => tauri::async_runtime::block_on(
                provider.reset_kws_session(session, StreamResetReason::Manual),
            )
            .map_err(|_| ()),
            Self::Vad {
                provider, session, ..
            } => tauri::async_runtime::block_on(
                provider.reset_vad_session(session, StreamResetReason::Manual),
            )
            .map_err(|_| ()),
        }
    }
}

struct NativeSpeechOperation {
    cancelled: AtomicBool,
    finished: AtomicBool,
    finished_notify: Notify,
}

struct OperationCompletionGuard {
    operations: Arc<Mutex<HashMap<String, Arc<NativeSpeechOperation>>>>,
    operation_id: String,
    operation: Arc<NativeSpeechOperation>,
}

impl Drop for OperationCompletionGuard {
    fn drop(&mut self) {
        finish_operation(&self.operations, &self.operation_id, &self.operation);
    }
}

impl NativeSpeechOperation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finished_notify: Notify::new(),
        }
    }

    fn finish(&self) {
        self.finished.store(true, Ordering::Release);
        self.finished_notify.notify_waiters();
        self.finished_notify.notify_one();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechStageSnapshot {
    enabled: bool,
    model_id: Option<String>,
    language: Option<String>,
    voice_id: Option<String>,
    implementation: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePeerHostedStageSnapshot {
    enabled: bool,
    model_id: String,
    model_revision: String,
    language: Option<String>,
    phrase_revision: Option<String>,
    format: &'static str,
    sample_rate_hz: u32,
    channels: u16,
    frame_samples: Option<u32>,
    max_chunk_bytes: usize,
    max_input_bytes: usize,
    max_queue: usize,
    idle_lease_ms: u64,
    max_active_ms: u64,
    max_concurrent_sessions: usize,
    implementation: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechHostSnapshot {
    revision: u64,
    stt: Option<NativeSpeechStageSnapshot>,
    tts: Option<NativeSpeechStageSnapshot>,
    kws: Option<NativePeerHostedStageSnapshot>,
    vad: Option<NativePeerHostedStageSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeSpeechTranscribeRequest {
    operation_id: String,
    model_id: String,
    language: Option<String>,
    sample_rate_hz: u32,
    audio_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechTranscribeResult {
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeSpeechSynthesizeRequest {
    operation_id: String,
    model_id: Option<String>,
    voice_id: Option<String>,
    language: Option<String>,
    text: String,
    speed: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechSynthesizeResult {
    sample_rate_hz: u32,
    duration_ms: u64,
    audio_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSpeechCancelResult {
    cancelled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativePeerSpeechStageOperation {
    Begin,
    Frame,
    End,
    Cancel,
    Status,
    Result,
}

impl NativePeerSpeechStageOperation {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "begin" => Ok(Self::Begin),
            "frame" => Ok(Self::Frame),
            "end" => Ok(Self::End),
            "cancel" => Ok(Self::Cancel),
            "status" => Ok(Self::Status),
            "result" => Ok(Self::Result),
            _ => Err("Speech stream request is unavailable".to_owned()),
        }
    }

    fn method_id(self, stage: &str) -> Result<&'static str, String> {
        let method = match (stage, self) {
            ("kws", Self::Begin) => "WakeWord.StreamStart",
            ("kws", Self::Frame) => "WakeWord.StreamChunk",
            ("kws", Self::End) => "WakeWord.StreamEnd",
            ("kws", Self::Cancel) => "WakeWord.StreamCancel",
            ("kws", Self::Status) => "WakeWord.StreamStatus",
            ("kws", Self::Result) => "WakeWord.StreamResult",
            ("vad", Self::Begin) => "VAD.StreamStart",
            ("vad", Self::Frame) => "VAD.StreamChunk",
            ("vad", Self::End) => "VAD.StreamEnd",
            ("vad", Self::Cancel) => "VAD.StreamCancel",
            ("vad", Self::Status) => "VAD.StreamStatus",
            ("vad", Self::Result) => "VAD.StreamResult",
            _ => return Err("Speech stream stage is unavailable".to_owned()),
        };
        Ok(method)
    }
}

impl NativePeerSpeechOwner {
    fn from_context(context: &NativePeerSpeechCallContext) -> Result<Self, String> {
        let authenticated = &context.authenticated_peer_context;
        let selector = &authenticated.selector;
        let transport = &authenticated.transport;
        if context.id.is_empty()
            || context.id.len() > 128
            || context.remote_peer_id != context.identity.caller_peer_id
            || context.remote_peer_id != selector.claimant_peer_id
            || selector.token_id.is_empty()
            || selector.room_name.is_empty()
            || selector.verifier_peer_id.is_empty()
            || transport.channel_binding.is_empty()
            || authenticated.credential_revision < 0
        {
            return Err("Speech stream owner is unavailable".to_owned());
        }
        Ok(Self {
            peer_id: context.remote_peer_id.clone(),
            connection_epoch: authenticated.connection_epoch.clone(),
            authenticated_at_ms: authenticated.authenticated_at_ms,
            credential_revision: authenticated.credential_revision,
            token_id: selector.token_id.clone(),
            room_name: selector.room_name.clone(),
            verifier_peer_id: selector.verifier_peer_id.clone(),
            channel_binding: transport.channel_binding.clone(),
            claimant_signaling_peer_id: transport.claimant_signaling_peer_id.clone(),
            verifier_signaling_peer_id: transport.verifier_signaling_peer_id.clone(),
        })
    }
}

fn current_epoch_ms() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Speech stream authorization is unavailable".to_owned())?;
    i64::try_from(elapsed.as_millis())
        .map_err(|_| "Speech stream authorization is unavailable".to_owned())
}

async fn authorize_peer_speech_call(
    app: &AppHandle,
    context: &NativePeerSpeechCallContext,
    method_id: &'static str,
) -> Result<bool, String> {
    if context.method_id != method_id {
        return Err("Speech stream method is unavailable".to_owned());
    }
    let descriptor = aurora_contracts::method_by_id(method_id)
        .ok_or_else(|| "Speech stream method is unavailable".to_owned())?;
    let request = PeerHostAuthorizeRequest {
        remote_peer_id: context.remote_peer_id.clone(),
        method_id: method_id.to_owned(),
        required_permissions: descriptor
            .required_permissions
            .iter()
            .map(|permission| (*permission).to_owned())
            .collect(),
        identity: context.identity.clone(),
        authenticated_peer_context: Some(context.authenticated_peer_context.clone()),
        now_ms: current_epoch_ms()?,
    };
    let state = app
        .try_state::<crate::mesh_authority::MeshAuthorityState>()
        .ok_or_else(|| "Speech stream authorization is unavailable".to_owned())?;
    let mut authority = state.lock().await;
    let decision = authority
        .authorize(&request)
        .await
        .map_err(|_| "Speech stream authorization is unavailable".to_owned())?;
    Ok(decision.allowed)
}

async fn native_host_is_foreground(app: &AppHandle) -> bool {
    match app.try_state::<crate::mesh_session::MeshSessionState>() {
        Some(state) => state.is_foreground_for_native_work().await,
        None => false,
    }
}

fn generated_stage_value(schema_id: &str, value: Value) -> Result<Value, String> {
    aurora_contracts::normalize_generated_contract(schema_id, value)
        .map_err(|_| "Speech stream contract is unavailable".to_owned())
}

fn owned_stage_session(
    host: &NativeSpeechHostState,
    stage: &str,
    owner: &NativePeerSpeechOwner,
    session_id: &str,
) -> Result<Arc<NativePeerSpeechStageSession>, String> {
    prune_expired_peer_stages(host);
    let stages = host
        .stages
        .lock()
        .map_err(|_| "Speech stream is unavailable".to_owned())?;
    let session = stages
        .get(session_id)
        .cloned()
        .ok_or_else(|| "Speech stream is unavailable".to_owned())?;
    let data = session
        .data
        .lock()
        .map_err(|_| "Speech stream is unavailable".to_owned())?;
    if data.stage != stage || &data.owner != owner {
        return Err("Speech stream is unavailable".to_owned());
    }
    drop(data);
    Ok(session)
}

fn prune_expired_peer_stages(host: &NativeSpeechHostState) {
    let Ok(mut stages) = host.stages.lock() else {
        return;
    };
    stages.retain(|_, session| {
        let Ok(data) = session.data.lock() else {
            return false;
        };
        if data.terminal.is_some() {
            data.terminal_at
                .is_some_and(|terminal_at| terminal_at.elapsed() < STAGE_TOMBSTONE_LEASE)
        } else {
            true
        }
    });
    let mut tombstones = stages
        .iter()
        .filter_map(|(id, session)| {
            session.data.lock().ok().and_then(|data| {
                data.terminal_at
                    .map(|terminal_at| (terminal_at, id.clone()))
            })
        })
        .collect::<Vec<_>>();
    tombstones.sort_unstable_by_key(|(terminal_at, _)| *terminal_at);
    let excess = tombstones.len().saturating_sub(STAGE_MAX_TOMBSTONES);
    for (_, id) in tombstones.into_iter().take(excess) {
        stages.remove(&id);
    }
}

fn active_hosted_stage_count(host: &NativeSpeechHostState) -> usize {
    host.stages
        .lock()
        .map(|stages| active_hosted_stage_count_in(&stages))
        .unwrap_or(STAGE_MAX_SESSIONS)
}

fn active_hosted_stage_count_in(
    stages: &HashMap<String, Arc<NativePeerSpeechStageSession>>,
) -> usize {
    stages
        .values()
        .filter(|session| {
            session
                .data
                .lock()
                .map(|data| data.terminal.is_none())
                .unwrap_or(false)
        })
        .count()
}

fn stage_status(data: &NativePeerSpeechStageData) -> Value {
    // Consumer revisions remain correlation fields; the host has its own
    // persisted capability revision and never equates the two.
    let _bound_correlation = (
        &data.operation_id,
        data.consumer_config_revision,
        &data.consumer_route_revision,
        &data.model_id,
        &data.model_revision,
    );
    let lease_ms = if data.terminal.is_some() {
        0
    } else {
        STAGE_IDLE_LEASE
            .saturating_sub(data.last_activity.elapsed())
            .as_millis() as u64
    };
    let state = data
        .terminal
        .as_ref()
        .map(|(state, _)| state.as_str())
        .unwrap_or(if data.accepted_chunks == 0 {
            "admitted"
        } else {
            "active"
        });
    let terminal_outcome = data.terminal.as_ref().map(|(_, reason)| reason.as_str());
    json!({
        "session_id": data.session_id,
        "state": state,
        "next_sequence": data.next_sequence,
        "credits": if data.terminal.is_some() { 0 } else { STAGE_MAX_QUEUE },
        "lease_remaining_ms": lease_ms,
        "terminal_outcome": terminal_outcome,
        "accepted_chunks": data.accepted_chunks,
        "dropped_chunks": 0
    })
}

fn stage_result(data: &NativePeerSpeechStageData) -> Result<Value, String> {
    let Some((state, reason)) = data.terminal.as_ref() else {
        return Err("Speech stream result is not ready".to_owned());
    };
    Ok(json!({
        "session_id": data.session_id,
        "stage": data.stage,
        "mode": "streaming",
        "state": state,
        "reason_code": reason,
        "final_sequence": data.final_sequence,
        "input_count": data.accepted_chunks,
        "output_count": data.output_count,
        "redacted": true
    }))
}

async fn cancel_worker(sender: SyncSender<NativePeerSpeechStageCommand>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, response) = mpsc::sync_channel(1);
        sender
            .send(NativePeerSpeechStageCommand::Cancel { reply })
            .map_err(|_| "Speech stream cleanup is unavailable".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Speech stream cleanup is unavailable".to_owned())?
            .map_err(|_| "Speech stream cleanup is unavailable".to_owned())
    })
    .await
    .map_err(|_| "Speech stream cleanup is unavailable".to_owned())?
}

async fn cancel_peer_stage(
    host: &NativeSpeechHostState,
    stage: &str,
    owner: &NativePeerSpeechOwner,
    payload: Value,
    output_schema_id: &'static str,
) -> Result<Value, String> {
    let request: NativePeerSpeechStageSessionRef = serde_json::from_value(payload)
        .map_err(|_| "Speech stream cancellation is unavailable".to_owned())?;
    let session = owned_stage_session(host, stage, owner, &request.session_id)?;
    let _gate = session.gate.lock().await;
    let (sender, already_terminal) = {
        let data = session
            .data
            .lock()
            .map_err(|_| "Speech stream cleanup is unavailable".to_owned())?;
        (data.sender.clone(), data.terminal.is_some())
    };
    let reason = request.reason.as_deref().unwrap_or("canceled");
    if !matches!(reason, "canceled" | "timed_out" | "revoked" | "interrupted") {
        return Err("Speech stream cancellation is unavailable".to_owned());
    }
    if !already_terminal {
        cancel_worker(sender).await?;
    }
    let result = {
        let mut data = session
            .data
            .lock()
            .map_err(|_| "Speech stream cleanup is unavailable".to_owned())?;
        if data.terminal.is_none() {
            data.terminal = Some((reason.to_owned(), reason.to_owned()));
            data.terminal_at = Some(Instant::now());
        }
        stage_result(&data)?
    };
    generated_stage_value(output_schema_id, result)
}

async fn process_peer_stage_frame(
    app: &AppHandle,
    host: &NativeSpeechHostState,
    stage: &str,
    owner: &NativePeerSpeechOwner,
    payload: Value,
    host_generation: u64,
    host_revision: u64,
    output_schema_id: &'static str,
) -> Result<Value, String> {
    let frame: NativePeerSpeechStageFrame = serde_json::from_value(payload)
        .map_err(|_| "Speech stream frame is unavailable".to_owned())?;
    if frame.payload_kind != "audio"
        || frame.is_final
        || frame.payload_size_bytes == 0
        || frame.payload_size_bytes > STAGE_MAX_CHUNK_BYTES
        || frame.audio_data.len() > STAGE_MAX_CHUNK_BYTES * 2
    {
        return Err("Speech stream frame is unavailable".to_owned());
    }
    let encoded = BASE64
        .decode(frame.audio_data.as_bytes())
        .map_err(|_| "Speech stream frame is unavailable".to_owned())?;
    if encoded.is_empty() || encoded.len() != frame.payload_size_bytes || encoded.len() % 2 != 0 {
        return Err("Speech stream frame is unavailable".to_owned());
    }
    let mut samples = Vec::with_capacity(encoded.len() / 2);
    for bytes in encoded.chunks_exact(2) {
        samples.push(i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0);
    }
    let session = owned_stage_session(host, stage, owner, &frame.session_id)?;
    let _gate = session.gate.lock().await;
    let (sender, bytes_before) = {
        let data = session
            .data
            .lock()
            .map_err(|_| "Speech stream is unavailable".to_owned())?;
        if data.terminal.is_some()
            || data.generation != frame.generation
            || data.attempt_id != frame.attempt_id
            || data.next_sequence != frame.sequence
            || data.host_generation != host_generation
            || data.host_revision != host_revision
            || data.started.elapsed() >= STAGE_MAX_LIFETIME
            || data.last_activity.elapsed() >= STAGE_IDLE_LEASE
            || data.input_bytes.saturating_add(encoded.len()) > STAGE_MAX_INPUT_BYTES
        {
            return Err("Speech stream is no longer active".to_owned());
        }
        (data.sender.clone(), data.input_bytes)
    };
    if !native_host_is_foreground(app).await {
        return Err("Speech stream is unavailable while the node is backgrounded".to_owned());
    }
    let sample_count = samples.len();
    let output_count = tauri::async_runtime::spawn_blocking(move || {
        let (reply, response) = mpsc::sync_channel(1);
        sender
            .try_send(NativePeerSpeechStageCommand::Frame {
                sequence: frame.sequence,
                samples,
                reply,
            })
            .map_err(|_| "Speech stream queue is full".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "Speech stream engine is unavailable".to_owned())?
            .map_err(|_| "Speech stream engine is unavailable".to_owned())
    })
    .await
    .map_err(|_| "Speech stream engine is unavailable".to_owned())??;
    let status = {
        let mut data = session
            .data
            .lock()
            .map_err(|_| "Speech stream is unavailable".to_owned())?;
        data.next_sequence = data.next_sequence.saturating_add(1);
        data.accepted_chunks = data.accepted_chunks.saturating_add(1);
        data.input_bytes = bytes_before.saturating_add(sample_count.saturating_mul(2));
        data.output_count = data.output_count.saturating_add(output_count);
        data.last_activity = Instant::now();
        stage_status(&data)
    };
    generated_stage_value(output_schema_id, status)
}

async fn end_peer_stage(
    host: &NativeSpeechHostState,
    stage: &str,
    owner: &NativePeerSpeechOwner,
    payload: Value,
    host_generation: u64,
    host_revision: u64,
    output_schema_id: &'static str,
) -> Result<Value, String> {
    let request: NativePeerSpeechStageEnd = serde_json::from_value(payload)
        .map_err(|_| "Speech stream finalization is unavailable".to_owned())?;
    let session = owned_stage_session(host, stage, owner, &request.session_id)?;
    let _gate = session.gate.lock().await;
    let (sender, final_sequence) = {
        let data = session
            .data
            .lock()
            .map_err(|_| "Speech stream finalization is unavailable".to_owned())?;
        if data.terminal.is_some()
            || data.host_generation != host_generation
            || data.host_revision != host_revision
            || data.accepted_chunks == 0
            || request
                .final_sequence
                .is_some_and(|sequence| sequence != data.next_sequence.saturating_sub(1))
            || data.started.elapsed() >= STAGE_MAX_LIFETIME
            || data.last_activity.elapsed() >= STAGE_IDLE_LEASE
        {
            return Err("Speech stream is no longer active".to_owned());
        }
        (data.sender.clone(), data.next_sequence.saturating_sub(1))
    };
    let final_output = tauri::async_runtime::spawn_blocking(move || {
        let (reply, response) = mpsc::sync_channel(1);
        sender
            .send(NativePeerSpeechStageCommand::End { reply })
            .map_err(|_| "Speech stream finalization is unavailable".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "Speech stream finalization is unavailable".to_owned())?
            .map_err(|_| "Speech stream finalization is unavailable".to_owned())
    })
    .await
    .map_err(|_| "Speech stream finalization is unavailable".to_owned())??;
    let result = {
        let mut data = session
            .data
            .lock()
            .map_err(|_| "Speech stream finalization is unavailable".to_owned())?;
        data.output_count = data.output_count.saturating_add(final_output);
        data.final_sequence = Some(final_sequence);
        data.terminal = Some(("completed".to_owned(), "completed".to_owned()));
        data.terminal_at = Some(Instant::now());
        stage_result(&data)?
    };
    generated_stage_value(output_schema_id, result)
}

async fn query_peer_stage(
    host: &NativeSpeechHostState,
    stage: &str,
    owner: &NativePeerSpeechOwner,
    operation: NativePeerSpeechStageOperation,
    payload: Value,
    host_generation: u64,
    host_revision: u64,
    output_schema_id: &'static str,
) -> Result<Value, String> {
    let request: NativePeerSpeechStageSessionRef = serde_json::from_value(payload)
        .map_err(|_| "Speech stream query is unavailable".to_owned())?;
    let session = owned_stage_session(host, stage, owner, &request.session_id)?;
    let _gate = session.gate.lock().await;
    let (result, terminal) = {
        let data = session
            .data
            .lock()
            .map_err(|_| "Speech stream query is unavailable".to_owned())?;
        if data.host_generation != host_generation || data.host_revision != host_revision {
            return Err("Speech stream policy changed".to_owned());
        }
        let value = match operation {
            NativePeerSpeechStageOperation::Status => stage_status(&data),
            NativePeerSpeechStageOperation::Result => stage_result(&data)?,
            _ => return Err("Speech stream query is unavailable".to_owned()),
        };
        (value, data.terminal.is_some())
    };
    let normalized = generated_stage_value(output_schema_id, result)?;
    if operation == NativePeerSpeechStageOperation::Result && terminal {
        if let Ok(mut stages) = host.stages.lock() {
            stages.remove(&request.session_id);
        }
    }
    Ok(normalized)
}

#[tauri::command]
pub(crate) async fn aurora_peer_host_local_speech_stage(
    app: AppHandle,
    node_config: State<'_, NativeNodeConfigRuntime>,
    host: State<'_, NativeSpeechHostState>,
    request: NativePeerSpeechStageCall,
) -> Result<Value, String> {
    let call = request;
    let operation = NativePeerSpeechStageOperation::parse(&call.operation)?;
    let method_id = operation.method_id(&call.stage)?;
    let context_owner = NativePeerSpeechOwner::from_context(&call.call_context)?;
    let authorized = authorize_peer_speech_call(&app, &call.call_context, method_id).await?;
    if !authorized && operation != NativePeerSpeechStageOperation::Cancel {
        return Err("Speech stream authorization is unavailable".to_owned());
    }
    if !native_host_is_foreground(&app).await && operation != NativePeerSpeechStageOperation::Cancel
    {
        return Err("Speech stream is unavailable while the node is backgrounded".to_owned());
    }
    let descriptor = aurora_contracts::method_by_id(method_id)
        .ok_or_else(|| "Speech stream method is unavailable".to_owned())?;
    let payload = generated_stage_value(descriptor.input_schema_id, call.payload)?;
    if operation == NativePeerSpeechStageOperation::Cancel {
        return cancel_peer_stage(
            &host,
            &call.stage,
            &context_owner,
            payload,
            descriptor.output_schema_id,
        )
        .await;
    }

    let (_transition, host_generation, document, profile_json) = node_config
        .transcription_admission_snapshot()
        .await
        .map_err(|_| "Speech stream policy is unavailable".to_owned())?;
    if !node_config.profile_generation_is_current(host_generation) {
        return Err("Speech stream policy changed".to_owned());
    }
    match operation {
        NativePeerSpeechStageOperation::Begin => {
            begin_peer_stage(
                &app,
                &host,
                &call.stage,
                &context_owner,
                payload,
                &document,
                &profile_json,
                host_generation,
                descriptor.output_schema_id,
            )
            .await
        }
        NativePeerSpeechStageOperation::Frame => {
            process_peer_stage_frame(
                &app,
                &host,
                &call.stage,
                &context_owner,
                payload,
                host_generation,
                document.revision,
                descriptor.output_schema_id,
            )
            .await
        }
        NativePeerSpeechStageOperation::End => {
            end_peer_stage(
                &host,
                &call.stage,
                &context_owner,
                payload,
                host_generation,
                document.revision,
                descriptor.output_schema_id,
            )
            .await
        }
        NativePeerSpeechStageOperation::Status | NativePeerSpeechStageOperation::Result => {
            query_peer_stage(
                &host,
                &call.stage,
                &context_owner,
                operation,
                payload,
                host_generation,
                document.revision,
                descriptor.output_schema_id,
            )
            .await
        }
        NativePeerSpeechStageOperation::Cancel => unreachable!(),
    }
}

async fn begin_peer_stage(
    app: &AppHandle,
    host: &NativeSpeechHostState,
    stage_name: &str,
    owner: &NativePeerSpeechOwner,
    payload: Value,
    document: &NodeConfigDocumentV2,
    profile_json: &str,
    host_generation: u64,
    output_schema_id: &'static str,
) -> Result<Value, String> {
    prune_expired_peer_stages(host);
    if active_hosted_stage_count(host) >= STAGE_MAX_SESSIONS {
        return Err("Speech stream capacity is unavailable".to_owned());
    }
    let start: NativePeerSpeechStageStart = serde_json::from_value(payload)
        .map_err(|_| "Speech stream admission is unavailable".to_owned())?;
    if start.schema != "speech-stage-admission.v1"
        || start.stage != stage_name
        || start.mode != "streaming"
        || !start.experimental_remote
        || !start.exact_selector
        || start.remaining_deadline_ms == 0
        || start.remaining_deadline_ms > 60_000
    {
        return Err("Speech stream admission is unavailable".to_owned());
    }
    let request_deadline = Instant::now() + Duration::from_millis(start.remaining_deadline_ms);
    validate_operation_id(&start.operation_id)?;
    validate_operation_id(&start.attempt_id)?;
    validate_operation_id(&start.request_id)?;
    if start
        .target_peer_id
        .as_deref()
        .is_some_and(|peer_id| peer_id != owner.verifier_peer_id)
    {
        return Err("Speech stream target is unavailable".to_owned());
    }
    let _target_resource_id = start.target_resource_id.as_deref();
    let _consent_revision_is_not_authority = start.consent_revision.as_deref();
    if start.capability_revision != document.revision {
        return Err("Speech stream capability changed".to_owned());
    }
    let selection = profile_selection(profile_json)?;
    if !selection.mesh_node {
        return Err("Speech stream is unavailable for this profile".to_owned());
    }
    let policy_stage = match stage_name {
        "kws" => &document.speech.stages.kws,
        "vad" => &document.speech.stages.vad,
        _ => return Err("Speech stream stage is unavailable".to_owned()),
    };
    if !policy_stage.experimental_remote
        || !match stage_name {
            "kws" => document.speech.sharing.kws,
            "vad" => document.speech.sharing.vad,
            _ => false,
        }
        || !is_local_stage(policy_stage)
    {
        return Err("Speech stream sharing is unavailable".to_owned());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Speech stream is unavailable".to_owned())?;
    let root = app_data.join("speech-packs");
    let (kws_choice, vad_choice) = tauri::async_runtime::spawn_blocking({
        let document = document.clone();
        let selection = selection;
        let root = root.clone();
        move || {
            let manager =
                SpeechPackManager::open(SpeechPackManagerConfig::new(root, None).ok()?).ok()?;
            resolve_hosted_stage_choices(&document, &selection, &manager)
        }
    })
    .await
    .map_err(|_| "Speech stream is unavailable".to_owned())?
    .ok_or_else(|| "Selected speech model is unavailable".to_owned())?;
    let choice = match stage_name {
        "kws" => kws_choice,
        "vad" => vad_choice,
        _ => None,
    }
    .ok_or_else(|| "Selected speech model is unavailable".to_owned())?;
    let worker_stage = stage_name.to_owned();
    let worker_choice = choice.clone();
    let worker_root = root.clone();
    let worker_generation = start.generation;
    let worker_app = app.clone();
    let worker_stages = Arc::clone(&host.stages);
    let worker_host_generation = host_generation;
    let worker_host_revision = document.revision;
    let (session_id, sender) = tauri::async_runtime::spawn_blocking(move || {
        if Instant::now() >= request_deadline {
            return Err("Speech stream admission deadline elapsed".to_owned());
        }
        let mut nonce = [0_u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|_| "Speech stream is unavailable".to_owned())?;
        let session_id = nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let sender = spawn_hosted_stage_worker(
            NativePeerSpeechWorkerConfig {
                root: worker_root,
                stage: worker_stage,
                choice: worker_choice,
                generation: worker_generation,
                app: worker_app,
                stages: worker_stages,
                session_id: session_id.clone(),
                host_generation: worker_host_generation,
                host_revision: worker_host_revision,
            },
            request_deadline,
        )?;
        Ok::<_, String>((session_id, sender))
    })
    .await
    .map_err(|_| "Speech stream is unavailable".to_owned())??;
    let mut stages = host
        .stages
        .lock()
        .map_err(|_| "Speech stream is unavailable".to_owned())?;
    if active_hosted_stage_count_in(&stages) >= STAGE_MAX_SESSIONS
        || stages.contains_key(&session_id)
    {
        let (reply, _response) = mpsc::sync_channel(1);
        let _ = sender.try_send(NativePeerSpeechStageCommand::Cancel { reply });
        return Err("Speech stream capacity is unavailable".to_owned());
    }
    let session = Arc::new(NativePeerSpeechStageSession {
        gate: AsyncMutex::new(()),
        data: Mutex::new(NativePeerSpeechStageData {
            session_id: session_id.clone(),
            stage: stage_name.to_owned(),
            owner: owner.clone(),
            operation_id: start.operation_id.clone(),
            attempt_id: start.attempt_id.clone(),
            generation: start.generation,
            consumer_config_revision: start.config_revision,
            consumer_route_revision: start.route_revision,
            host_generation,
            host_revision: document.revision,
            model_id: choice.model_id,
            model_revision: choice.model_revision,
            sender,
            started: Instant::now(),
            last_activity: Instant::now(),
            next_sequence: 0,
            accepted_chunks: 0,
            input_bytes: 0,
            output_count: 0,
            terminal: None,
            terminal_at: None,
            final_sequence: None,
        }),
    });
    stages.insert(session_id.clone(), session);
    let admission = json!({
        "schema": "speech.stage-session-admission.v1",
        "session_id": session_id,
        "operation_id": start.operation_id,
        "attempt_id": start.attempt_id,
        "generation": start.generation,
        "status": "admitted",
        "reason_code": "admitted",
        "capability_revision": document.revision,
        "accepted_format": "pcm_s16le",
        "accepted_limits": {
            "max_chunk_bytes": STAGE_MAX_CHUNK_BYTES,
            "max_input_bytes": STAGE_MAX_INPUT_BYTES,
            "max_text_bytes": 4096,
            "max_queue": STAGE_MAX_QUEUE,
            "heartbeat_ms": 5000,
            "idle_lease_ms": STAGE_IDLE_LEASE.as_millis(),
            "max_active_ms": STAGE_MAX_LIFETIME.as_millis()
        },
        "next_sequence": 0,
        "credits": STAGE_MAX_QUEUE,
        "lease_remaining_ms": STAGE_IDLE_LEASE.as_millis()
    });
    generated_stage_value(output_schema_id, admission)
}

#[tauri::command]
pub(crate) async fn aurora_native_speech_host_snapshot(
    app: AppHandle,
    node_config: State<'_, NativeNodeConfigRuntime>,
) -> Result<NativeSpeechHostSnapshot, String> {
    let hosted_foreground = native_host_is_foreground(&app).await;
    let (_transition, generation, document, profile_json) = node_config
        .transcription_admission_snapshot()
        .await
        .map_err(|_| "Local speech is unavailable".to_owned())?;
    let selection = profile_selection(&profile_json)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local speech is unavailable".to_owned())?;
    let root = app_data.join("speech-packs");
    tauri::async_runtime::spawn_blocking(move || {
        let manager =
            SpeechPackManager::open(SpeechPackManagerConfig::new(root, None).ok()?).ok()?;
        let (stt_choice, tts_choice) = resolve_stage_choices(&document, &selection, &manager);
        let stt = stt_choice.and_then(|choice| {
            let model_id = choice.model_id?;
            let mut provider = build_installed_stt_provider(&manager, &model_id).ok()?;
            let binding = provider.finite_stt_binding().ok()?;
            if !matches!(
                &binding,
                aurora_voice_engine::FiniteSttProviderBinding::LocalTask(_)
            ) {
                return None;
            }
            tauri::async_runtime::block_on(provider.warm_finite_stt(binding)).ok()?;
            Some(NativeSpeechStageSnapshot {
                enabled: true,
                model_id: Some(model_id),
                language: choice.language,
                voice_id: None,
                implementation: "native",
            })
        });
        let tts = tts_choice.and_then(|choice| {
            let voice_id = choice.voice_id?;
            let mut provider = build_installed_tts_provider(&manager, &voice_id).ok()?;
            let binding = provider.synthesis_binding().ok()?;
            if !matches!(
                &binding,
                aurora_voice_engine::TtsSynthesisProviderBinding::LocalTask(_)
            ) {
                return None;
            }
            tauri::async_runtime::block_on(provider.warm_synthesis(binding)).ok()?;
            Some(NativeSpeechStageSnapshot {
                enabled: true,
                model_id: choice.model_id,
                language: choice.language,
                voice_id: Some(voice_id),
                implementation: "native",
            })
        });
        let (kws, vad) =
            resolve_hosted_stage_choices(&document, &selection, &manager).map(|(kws, vad)| {
                let kws = hosted_foreground
                    .then_some(kws)
                    .flatten()
                    .and_then(|choice| {
                        let phrase_id = choice.phrase_id.as_deref()?;
                        let phrase = choice.phrase.as_deref()?;
                        let phrase_revision = choice.phrase_revision.as_deref()?;
                        let mut provider = build_installed_kws_provider_from_phrases(
                            &manager,
                            &choice.model_id,
                            phrase_revision,
                            [SherpaKwsPhraseInput::new(phrase_id, phrase).ok()?],
                        )
                        .ok()?;
                        let capability =
                            provider.capabilities().into_iter().find(|capability| {
                                capability.task() == VoiceTask::KeywordSpotting
                                    && capability.local_only()
                                    && capability.streaming_enabled()
                            })?;
                        let request = BoundTaskRequest::new(
                            TaskRequest {
                                task: VoiceTask::KeywordSpotting,
                                language: choice.language.clone(),
                                generation,
                            },
                            capability.binding().clone(),
                        )
                        .ok()?;
                        tauri::async_runtime::block_on(provider.warm_task(request)).ok()?;
                        (provider.resource_report().readiness == TaskReadiness::Ready).then(|| {
                            NativePeerHostedStageSnapshot {
                                enabled: true,
                                model_id: choice.model_id,
                                model_revision: choice.model_revision,
                                language: choice.language,
                                phrase_revision: choice.phrase_revision,
                                format: "pcm_s16le",
                                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                                channels: 1,
                                frame_samples: None,
                                max_chunk_bytes: STAGE_MAX_CHUNK_BYTES,
                                max_input_bytes: STAGE_MAX_INPUT_BYTES,
                                max_queue: STAGE_MAX_QUEUE,
                                idle_lease_ms: STAGE_IDLE_LEASE.as_millis() as u64,
                                max_active_ms: STAGE_MAX_LIFETIME.as_millis() as u64,
                                max_concurrent_sessions: 1,
                                implementation: "native",
                            }
                        })
                    });
                let vad = hosted_foreground
                    .then_some(vad)
                    .flatten()
                    .and_then(|choice| {
                        let mut provider = build_installed_vad_provider(
                            &manager,
                            &choice.model_id,
                            &VadConfig::default(),
                        )
                        .ok()?;
                        let capability =
                            provider.capabilities().into_iter().find(|capability| {
                                capability.task() == VoiceTask::VoiceActivityDetection
                                    && capability.local_only()
                                    && capability.streaming_enabled()
                            })?;
                        let request = BoundTaskRequest::new(
                            TaskRequest {
                                task: VoiceTask::VoiceActivityDetection,
                                language: choice.language.clone(),
                                generation,
                            },
                            capability.binding().clone(),
                        )
                        .ok()?;
                        tauri::async_runtime::block_on(provider.warm_task(request)).ok()?;
                        (provider.resource_report().readiness == TaskReadiness::Ready).then(|| {
                            NativePeerHostedStageSnapshot {
                                enabled: true,
                                model_id: choice.model_id,
                                model_revision: choice.model_revision,
                                language: choice.language,
                                phrase_revision: None,
                                format: "pcm_s16le",
                                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                                channels: 1,
                                frame_samples: Some(VAD_WINDOW_SIZE_SAMPLES as u32),
                                max_chunk_bytes: STAGE_MAX_CHUNK_BYTES,
                                max_input_bytes: STAGE_MAX_INPUT_BYTES,
                                max_queue: STAGE_MAX_QUEUE,
                                idle_lease_ms: STAGE_IDLE_LEASE.as_millis() as u64,
                                max_active_ms: STAGE_MAX_LIFETIME.as_millis() as u64,
                                max_concurrent_sessions: 1,
                                implementation: "native",
                            }
                        })
                    });
                (kws, vad)
            })?;
        Some(NativeSpeechHostSnapshot {
            revision: document.revision,
            stt,
            tts,
            kws,
            vad,
        })
    })
    .await
    .map_err(|_| "Local speech is unavailable".to_owned())?
    .ok_or_else(|| "Local speech is unavailable".to_owned())
}

#[tauri::command]
pub(crate) async fn aurora_peer_host_local_speech_transcribe(
    app: AppHandle,
    node_config: State<'_, NativeNodeConfigRuntime>,
    host: State<'_, NativeSpeechHostState>,
    request: NativeSpeechTranscribeRequest,
) -> Result<NativeSpeechTranscribeResult, String> {
    if !native_host_is_foreground(&app).await {
        return Err("Local speech is unavailable while the node is backgrounded".to_owned());
    }
    validate_operation_id(&request.operation_id)?;
    if request.sample_rate_hz != 16_000 || request.audio_base64.len() > 5_600_000 {
        return Err("Local transcription request is unavailable".to_owned());
    }
    let encoded = BASE64
        .decode(request.audio_base64.as_bytes())
        .map_err(|_| "Local transcription request is unavailable".to_owned())?;
    if encoded.is_empty() || encoded.len() > MAX_STT_BYTES || encoded.len() % 2 != 0 {
        return Err("Local transcription request is unavailable".to_owned());
    }
    let mut pcm = Vec::with_capacity(encoded.len() / 2);
    for bytes in encoded.chunks_exact(2) {
        pcm.push(i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0);
    }

    let operation = begin_operation(&host, &request.operation_id)?;
    let completion = OperationCompletionGuard {
        operations: Arc::clone(&host.operations),
        operation_id: request.operation_id.clone(),
        operation: Arc::clone(&operation),
    };
    let (_transition, generation, document, profile_json) = node_config
        .transcription_admission_snapshot()
        .await
        .map_err(|_| "Local transcription is unavailable".to_owned())?;
    if operation.cancelled.load(Ordering::Acquire) {
        return Err("Local transcription was cancelled".to_owned());
    }
    let selection = profile_selection(&profile_json)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local transcription is unavailable".to_owned())?
        .join("speech-packs");
    let requested_model_id = request.model_id;
    let requested_language = request.language;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _completion = completion;
        let result = (|| {
            let _transition = _transition;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local transcription was cancelled".to_owned());
            }
            let manager = SpeechPackManager::open(
                SpeechPackManagerConfig::new(root, None)
                    .map_err(|_| "Local transcription is unavailable".to_owned())?,
            )
            .map_err(|_| "Local transcription is unavailable".to_owned())?;
            let choice = resolve_stage_choices(&document, &selection, &manager)
                .0
                .ok_or_else(|| "Local transcription is unavailable".to_owned())?;
            let model_id = choice
                .model_id
                .as_deref()
                .ok_or_else(|| "Local transcription is unavailable".to_owned())?;
            if requested_model_id != model_id
                || requested_language.as_deref() != choice.language.as_deref()
            {
                return Err("Local transcription selection changed".to_owned());
            }
            let model_id = model_id.to_owned();
            let language = choice.language;
            let mut provider = build_installed_stt_provider(&manager, &model_id)
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            let binding = provider
                .finite_stt_binding()
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            let task_request = BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::SpeechToText,
                    language: language.clone(),
                    generation,
                },
                match binding {
                    aurora_voice_engine::FiniteSttProviderBinding::LocalTask(binding) => *binding,
                    aurora_voice_engine::FiniteSttProviderBinding::Route(_) => {
                        return Err("Selected local transcription is unavailable".to_owned())
                    }
                },
            )
            .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            let mut builder = FiniteSttAudioBuilder::new(task_request)
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            for frame in pcm.chunks(16_000 * 30) {
                if operation.cancelled.load(Ordering::Acquire) {
                    return Err("Local transcription was cancelled".to_owned());
                }
                builder
                    .push_frame(frame)
                    .map_err(|_| "Local transcription request is unavailable".to_owned())?;
            }
            let (bound, audio) = builder
                .finish()
                .map_err(|_| "Local transcription request is unavailable".to_owned())?;
            let provider_binding = provider
                .finite_stt_binding()
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            tauri::async_runtime::block_on(provider.warm_finite_stt(provider_binding))
                .map_err(|_| "Selected local transcription is unavailable".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local transcription was cancelled".to_owned());
            }
            let output =
                tauri::async_runtime::block_on(provider.transcribe_finite(bound, audio, &|| {
                    operation.cancelled.load(Ordering::Acquire)
                }))
                .map_err(|_| "Local transcription could not be completed".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local transcription was cancelled".to_owned());
            }
            Ok(NativeSpeechTranscribeResult {
                text: output.transcript().to_owned(),
            })
        })();
        result
    })
    .await;
    joined.map_err(|_| "Local transcription could not be completed".to_owned())?
}

#[tauri::command]
pub(crate) async fn aurora_peer_host_local_speech_synthesize(
    app: AppHandle,
    node_config: State<'_, NativeNodeConfigRuntime>,
    host: State<'_, NativeSpeechHostState>,
    request: NativeSpeechSynthesizeRequest,
) -> Result<NativeSpeechSynthesizeResult, String> {
    if !native_host_is_foreground(&app).await {
        return Err("Local speech is unavailable while the node is backgrounded".to_owned());
    }
    validate_operation_id(&request.operation_id)?;
    if request.text.is_empty()
        || request.text.len() > TTS_MAX_TEXT_BYTES
        || request.speed.is_some_and(|speed| speed != 1.0)
    {
        return Err("Local synthesis request is unavailable".to_owned());
    }
    let operation = begin_operation(&host, &request.operation_id)?;
    let completion = OperationCompletionGuard {
        operations: Arc::clone(&host.operations),
        operation_id: request.operation_id.clone(),
        operation: Arc::clone(&operation),
    };
    let (_transition, generation, document, profile_json) = node_config
        .transcription_admission_snapshot()
        .await
        .map_err(|_| "Local synthesis is unavailable".to_owned())?;
    if operation.cancelled.load(Ordering::Acquire) {
        return Err("Local synthesis was cancelled".to_owned());
    }
    let selection = profile_selection(&profile_json)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Local synthesis is unavailable".to_owned())?
        .join("speech-packs");
    let requested_model_id = request.model_id;
    let requested_voice_id = request.voice_id;
    let requested_language = request.language;
    let text = request.text;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _completion = completion;
        let result = (|| {
            let _transition = _transition;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local synthesis was cancelled".to_owned());
            }
            let manager = SpeechPackManager::open(
                SpeechPackManagerConfig::new(root, None)
                    .map_err(|_| "Local synthesis is unavailable".to_owned())?,
            )
            .map_err(|_| "Local synthesis is unavailable".to_owned())?;
            let choice = resolve_stage_choices(&document, &selection, &manager)
                .1
                .ok_or_else(|| "Local synthesis is unavailable".to_owned())?;
            if requested_model_id
                .as_deref()
                .is_some_and(|requested| Some(requested) != choice.model_id.as_deref())
                || requested_voice_id
                    .as_deref()
                    .is_some_and(|voice| Some(voice) != choice.voice_id.as_deref())
                || requested_language.as_deref() != choice.language.as_deref()
            {
                return Err("Local synthesis selection changed".to_owned());
            }
            let voice_id = choice
                .voice_id
                .ok_or_else(|| "Local synthesis is unavailable".to_owned())?;
            let language = choice.language;
            let mut provider = build_installed_tts_provider(&manager, &voice_id)
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let binding = provider
                .synthesis_binding()
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let config = TtsSynthesisConfig::new(
                voice_id.clone(),
                binding.voice_state_compatibility_group_id().to_owned(),
                binding.sample_rate_hz(),
                TTS_CHUNK_SAMPLES,
                None,
            )
            .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let task_binding = match binding {
                aurora_voice_engine::TtsSynthesisProviderBinding::LocalTask(binding) => *binding,
                aurora_voice_engine::TtsSynthesisProviderBinding::Route(_) => {
                    return Err("Selected local synthesis is unavailable".to_owned())
                }
            };
            let task_request = BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::TextToSpeech,
                    language: language.clone(),
                    generation,
                },
                task_binding,
            )
            .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            let synthesis_request = BoundTtsSynthesisRequest::new(task_request, text, config)
                .map_err(|_| "Local synthesis request is unavailable".to_owned())?;
            let provider_binding = provider
                .synthesis_binding()
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            tauri::async_runtime::block_on(provider.warm_synthesis(provider_binding))
                .map_err(|_| "Selected local synthesis is unavailable".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) {
                return Err("Local synthesis was cancelled".to_owned());
            }
            let audio = tauri::async_runtime::block_on(
                provider.synthesize_text(synthesis_request, &|| {
                    operation.cancelled.load(Ordering::Acquire)
                }),
            )
            .map_err(|_| "Local synthesis could not be completed".to_owned())?;
            if operation.cancelled.load(Ordering::Acquire) || audio.cancelled() {
                return Err("Local synthesis was cancelled".to_owned());
            }
            let first = audio
                .chunks()
                .first()
                .ok_or_else(|| "Local synthesis could not be completed".to_owned())?;
            let sample_rate_hz = first.sample_rate_hz();
            if sample_rate_hz == 0 || sample_rate_hz > 48_000 {
                return Err("Local synthesis could not be completed".to_owned());
            }
            let mut samples = Vec::new();
            for chunk in audio.chunks() {
                if chunk.sample_rate_hz() != sample_rate_hz
                    || samples.len().saturating_add(chunk.samples().len()) > MAX_TTS_SAMPLES
                {
                    return Err("Local synthesis output exceeds the supported limit".to_owned());
                }
                samples.extend_from_slice(chunk.samples());
            }
            let duration_ms = ((samples.len() as u128) * 1000 / u128::from(sample_rate_hz)) as u64;
            if duration_ms > 60_000 {
                return Err("Local synthesis output exceeds the supported limit".to_owned());
            }
            let mut bytes = Vec::with_capacity(samples.len() * 2);
            for sample in samples {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            Ok(NativeSpeechSynthesizeResult {
                sample_rate_hz,
                duration_ms,
                audio_base64: BASE64.encode(bytes),
            })
        })();
        result
    })
    .await;
    joined.map_err(|_| "Local synthesis could not be completed".to_owned())?
}

#[tauri::command]
pub(crate) async fn aurora_peer_host_local_speech_cancel(
    host: State<'_, NativeSpeechHostState>,
    operation_id: String,
) -> Result<NativeSpeechCancelResult, String> {
    let operation = host
        .operations
        .lock()
        .ok()
        .and_then(|operations| operations.get(&operation_id).cloned());
    let Some(operation) = operation else {
        return Ok(NativeSpeechCancelResult { cancelled: false });
    };
    operation.cancelled.store(true, Ordering::Release);
    loop {
        let notified = operation.finished_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if operation.finished.load(Ordering::Acquire) {
            break;
        }
        notified.await;
    }
    Ok(NativeSpeechCancelResult { cancelled: true })
}

#[derive(Clone)]
struct StageChoice {
    model_id: Option<String>,
    voice_id: Option<String>,
    language: Option<String>,
}

#[derive(Clone)]
struct HostedStageChoice {
    model_id: String,
    model_revision: String,
    language: Option<String>,
    phrase_id: Option<String>,
    phrase: Option<String>,
    phrase_revision: Option<String>,
}

fn resolve_hosted_stage_choices(
    document: &NodeConfigDocumentV2,
    selection: &ProfileSelection,
    manager: &SpeechPackManager,
) -> Option<(Option<HostedStageChoice>, Option<HostedStageChoice>)> {
    if !selection.mesh_node {
        return Some((None, None));
    }
    let kws = (|| {
        let stage = &document.speech.stages.kws;
        if !document.speech.sharing.kws || !stage.experimental_remote || !is_local_stage(stage) {
            return None;
        }
        let selected = selection.kws.as_ref()?;
        let phrase = selection.wake_phrase.as_ref()?;
        let catalog = SpeechModelCatalog::embedded().ok()?;
        if selected.pack_revision != catalog.revision() {
            return None;
        }
        let entry = catalog.model(&selected.pack_id)?;
        if entry.task != SpeechCatalogTask::KeywordSpotting
            || nullable_string(&stage.model_id).is_some_and(|model| model != selected.pack_id)
        {
            return None;
        }
        let bindings = manager.resolve_model_bindings(&selected.pack_id).ok()?;
        if bindings.model_id != selected.pack_id
            || bindings.task != SpeechCatalogTask::KeywordSpotting
            || !bindings.languages.contains(&phrase.language)
        {
            return None;
        }
        Some(HostedStageChoice {
            model_id: selected.pack_id.clone(),
            model_revision: selected.pack_revision.clone(),
            language: Some(phrase.language.clone()),
            phrase_id: Some(phrase.phrase_id.clone()),
            phrase: Some(phrase.phrase.clone()),
            phrase_revision: Some(phrase.revision.clone()),
        })
    })();
    let vad = (|| {
        let stage = &document.speech.stages.vad;
        if !document.speech.sharing.vad || !stage.experimental_remote || !is_local_stage(stage) {
            return None;
        }
        let selected = selection.vad.as_ref()?;
        let catalog = SpeechModelCatalog::embedded().ok()?;
        if selected.pack_revision != catalog.revision() {
            return None;
        }
        let entry = catalog.model(&selected.pack_id)?;
        if entry.task != SpeechCatalogTask::VoiceActivityDetection
            || nullable_string(&stage.model_id).is_some_and(|model| model != selected.pack_id)
        {
            return None;
        }
        let bindings = manager.resolve_model_bindings(&selected.pack_id).ok()?;
        if bindings.model_id != selected.pack_id
            || bindings.task != SpeechCatalogTask::VoiceActivityDetection
            || stage_language(stage).is_some_and(|language| !bindings.languages.contains(&language))
        {
            return None;
        }
        Some(HostedStageChoice {
            model_id: selected.pack_id.clone(),
            model_revision: selected.pack_revision.clone(),
            language: stage_language(stage),
            phrase_id: None,
            phrase: None,
            phrase_revision: None,
        })
    })();
    Some((kws, vad))
}

fn resolve_stage_choices(
    document: &NodeConfigDocumentV2,
    selection: &ProfileSelection,
    manager: &SpeechPackManager,
) -> (Option<StageChoice>, Option<StageChoice>) {
    let stt = (|| {
        let stage = &document.speech.stages.stt;
        if !document.speech.sharing.stt || !is_local_stage(stage) {
            return None;
        }
        let selected = selection.stt.as_ref()?;
        let catalog = SpeechModelCatalog::embedded().ok()?;
        if selected.pack_revision != catalog.revision() {
            return None;
        }
        let entry = catalog.model(&selected.pack_id)?;
        if entry.task != SpeechCatalogTask::SpeechToText
            || nullable_string(&stage.model_id).is_some_and(|model| model != selected.pack_id)
        {
            return None;
        }
        let bindings = manager.resolve_model_bindings(&selected.pack_id).ok()?;
        if bindings.model_id != selected.pack_id
            || bindings.task != SpeechCatalogTask::SpeechToText
            || stage_language(stage).is_some_and(|language| !bindings.languages.contains(&language))
            || stage_language(stage).is_none()
                && bindings.languages.len() != 1
                && bindings.language_scope != "multilingual"
        {
            return None;
        }
        Some(StageChoice {
            model_id: Some(selected.pack_id.clone()),
            voice_id: None,
            language: stage_language(stage)
                .or_else(|| (bindings.languages.len() == 1).then(|| bindings.languages[0].clone())),
        })
    })();
    let tts = (|| {
        let stage = &document.speech.stages.tts;
        if !document.speech.sharing.tts || !is_local_stage(stage) {
            return None;
        }
        let selected = selection.tts.as_ref()?;
        if selected.reference_profile_id.is_some() {
            return None;
        }
        let catalog = TtsVoiceCatalog::runtime().ok()?;
        if selected.pack_revision != catalog.revision()
            || selected.voice_revision.as_deref() != Some(catalog.revision())
        {
            return None;
        }
        let voice_id = selected.voice_id.as_deref()?;
        let voice = catalog.voice(voice_id)?;
        if voice.language != selected.pack_id
            || stage_language(stage).is_some_and(|language| language != voice.language)
        {
            return None;
        }
        let bindings = manager.resolve_voice_bindings(voice_id).ok()?;
        if bindings.voice_id != voice_id
            || bindings.task_binding.task() != VoiceTask::TextToSpeech
            || bindings.task_binding.catalog_model_family() != Some(voice.model_family.as_str())
        {
            return None;
        }
        // Report only identity read from the verified provider binding; never
        // infer a model selector from the chosen voice ID.
        let model_id = bindings
            .task_binding
            .catalog_model_family()
            .map(str::to_owned);
        if nullable_string(&stage.model_id)
            .is_some_and(|configured| Some(configured) != model_id.as_deref())
        {
            return None;
        }
        // The profile's selected pack language is the actual runtime binding
        // when the policy leaves language unset.
        let language = stage_language(stage).unwrap_or_else(|| selected.pack_id.clone());
        if !bindings
            .task_binding
            .languages()
            .iter()
            .any(|supported| supported.language == language)
        {
            return None;
        }
        Some(StageChoice {
            model_id,
            voice_id: Some(voice_id.to_owned()),
            language: Some(language),
        })
    })();
    (stt, tts)
}

fn is_local_stage(stage: &SpeechStageConfig) -> bool {
    matches!(
        stage.routing.prefer,
        RoutingPreference::Local | RoutingPreference::LocalOnly
    )
}

fn nullable_string(field: &NullableField<String>) -> Option<&str> {
    match field {
        NullableField::Value(value) => Some(value.as_str()),
        NullableField::Missing | NullableField::Null => None,
    }
}

fn stage_language(stage: &SpeechStageConfig) -> Option<String> {
    nullable_string(&stage.language).map(str::to_owned)
}

#[derive(Clone)]
struct ProfileSpeechAsset {
    pack_id: String,
    pack_revision: String,
    voice_id: Option<String>,
    voice_revision: Option<String>,
    reference_profile_id: Option<String>,
}

#[derive(Clone)]
struct ProfileWakePhrase {
    phrase_id: String,
    phrase: String,
    language: String,
    revision: String,
}

struct ProfileSelection {
    mesh_node: bool,
    stt: Option<ProfileSpeechAsset>,
    tts: Option<ProfileSpeechAsset>,
    kws: Option<ProfileSpeechAsset>,
    vad: Option<ProfileSpeechAsset>,
    wake_phrase: Option<ProfileWakePhrase>,
}

fn profile_selection(document: &str) -> Result<ProfileSelection, String> {
    let value: Value = serde_json::from_str(document)
        .map_err(|_| "Selected local profile is unavailable".to_owned())?;
    let active_id = value
        .get("activeProfileId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Selected local profile is unavailable".to_owned())?;
    let profile = value
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(active_id))
        })
        .ok_or_else(|| "Selected local profile is unavailable".to_owned())?;
    let selection = profile
        .get("localNode")
        .and_then(|node| node.get("localSpeechSelection"))
        .ok_or_else(|| "Selected local speech packs are unavailable".to_owned())?;
    Ok(ProfileSelection {
        mesh_node: profile.get("nodeMode").and_then(Value::as_str) == Some("mesh-node"),
        stt: profile_asset(selection.get("stt")),
        tts: profile_asset(selection.get("tts")),
        kws: profile_asset(selection.get("kws")),
        vad: profile_asset(selection.get("vad")),
        wake_phrase: profile_wake_phrase(selection.get("wakePhrase")),
    })
}

fn profile_wake_phrase(value: Option<&Value>) -> Option<ProfileWakePhrase> {
    let value = value?;
    Some(ProfileWakePhrase {
        phrase_id: value.get("phraseId")?.as_str()?.to_owned(),
        phrase: value.get("phrase")?.as_str()?.to_owned(),
        language: value.get("language")?.as_str()?.to_owned(),
        revision: value.get("revision")?.as_str()?.to_owned(),
    })
}

fn profile_asset(value: Option<&Value>) -> Option<ProfileSpeechAsset> {
    let value = value?;
    Some(ProfileSpeechAsset {
        pack_id: value.get("packId")?.as_str()?.to_owned(),
        pack_revision: value.get("packRevision")?.as_str()?.to_owned(),
        voice_id: value
            .get("voiceId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        voice_revision: value
            .get("voiceRevision")
            .and_then(Value::as_str)
            .map(str::to_owned),
        reference_profile_id: value
            .get("referenceProfileId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err("Local speech request is unavailable".to_owned());
    }
    Ok(())
}

fn begin_operation(
    host: &NativeSpeechHostState,
    operation_id: &str,
) -> Result<Arc<NativeSpeechOperation>, String> {
    let mut operations = host
        .operations
        .lock()
        .map_err(|_| "Local speech is unavailable".to_owned())?;
    if operations.contains_key(operation_id) || operations.len() >= MAX_ACTIVE_OPERATIONS {
        return Err("Local speech is busy".to_owned());
    }
    let operation = Arc::new(NativeSpeechOperation::new());
    operations.insert(operation_id.to_owned(), Arc::clone(&operation));
    Ok(operation)
}

fn finish_operation(
    operations: &Mutex<HashMap<String, Arc<NativeSpeechOperation>>>,
    operation_id: &str,
    operation: &Arc<NativeSpeechOperation>,
) {
    operation.finish();
    if let Ok(mut operations) = operations.lock() {
        if operations
            .get(operation_id)
            .is_some_and(|current| Arc::ptr_eq(current, operation))
        {
            operations.remove(operation_id);
        }
    }
}
