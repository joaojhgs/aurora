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
#[cfg(feature = "ios-sherpa")]
use aurora_voice_core::WakeOrchestrationConfig;
use aurora_voice_core::{
    CancellationToken, CaptureOwnerKind, CaptureStartReason, Generation, RedactedSnapshot,
    RouteFiniteSttBinding, RouteRevision, RouteTtsBinding, RuntimeEvent, RuntimeEventSink,
    TimestampMicros, VoiceCaptureLease, VoiceCoreError, VoiceRuntime, VoiceState,
};
use aurora_voice_engine::{
    FiniteSttRouteScope, ModelPackError, ModelStoreScope, PackTask, MAX_FINITE_STT_SAMPLES,
    VAD_SAMPLE_RATE_HZ,
};
#[cfg(feature = "ios-sherpa")]
use aurora_voice_engine::{KwsConfig, TaskPackBinding, VadConfig, VoiceTask};
use aurora_voice_ios_bridge::{
    AuroraIosAudioInput, AuroraIosAudioOutput, AuroraIosAudioState, AuroraIosCaptureControl,
};
#[cfg(feature = "ios-sherpa")]
use aurora_voice_sherpa::{
    NativeKwsBackend, NativeKwsModelFiles, NativeSttBackend, NativeSttModelFiles, NativeTtsBackend,
    NativeTtsVitsPiperModelFiles, NativeVadBackend, SherpaFiniteSttEngine, SherpaKwsPhrase,
    SherpaKwsPhraseSet, SherpaKwsProvider, SherpaTtsProvider, SherpaVadProvider,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::future::Future;
use std::io::Read;
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
pub const MAX_IOS_PACK_BINDINGS: usize = 16;
const MAX_IOS_PACK_PATH_BYTES: usize = 4096;

#[cfg(not(feature = "ios-sherpa"))]
type IosFiniteSttProvider = NativeGatewayFiniteStt;
#[cfg(feature = "ios-sherpa")]
type IosFiniteSttProvider = SherpaFiniteSttEngine<NativeSttBackend>;
#[cfg(not(feature = "ios-sherpa"))]
type IosTtsProvider = NativeGatewayTtsSynthesizer;
#[cfg(feature = "ios-sherpa")]
type IosTtsProvider = SherpaTtsProvider<NativeTtsBackend>;

type RuntimeCore = VoiceRuntime<
    AuroraIosAudioInput,
    IosFiniteSttProvider,
    IosTtsProvider,
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
    pack_id: String,
    pack_path: PathBuf,
    expected_sha256: String,
    expected_size_bytes: u64,
    runtime_revision: String,
    language: String,
    sample_rate_hz: u32,
    frame_size: u32,
    files: Vec<IosVoicePackFileBinding>,
}

impl IosVoicePackBinding {
    pub fn new(
        task: PackTask,
        slot_id: impl Into<String>,
        pack_id: impl Into<String>,
        pack_path: impl Into<PathBuf>,
        expected_sha256: impl Into<String>,
        expected_size_bytes: u64,
        runtime_revision: impl Into<String>,
        language: impl Into<String>,
        sample_rate_hz: u32,
        frame_size: u32,
        files: Vec<IosVoicePackFileBinding>,
    ) -> Result<Self, ModelPackError> {
        let slot_id = slot_id.into();
        ModelStoreScope::new(task, slot_id.clone())?;
        let pack_id = pack_id.into();
        let pack_path = pack_path.into();
        let expected_sha256 = expected_sha256.into();
        let runtime_revision = runtime_revision.into();
        let language = language.into();
        if pack_id.is_empty()
            || pack_path.as_os_str().is_empty()
            || pack_path.as_os_str().len() > MAX_IOS_PACK_PATH_BYTES
            || !is_hex_sha256(&expected_sha256)
            || expected_size_bytes == 0
            || runtime_revision.is_empty()
            || language.is_empty()
            || sample_rate_hz == 0
            || frame_size == 0
            || files.is_empty()
            || !matches!(
                task,
                PackTask::Kws | PackTask::Wakeword | PackTask::Vad | PackTask::Stt | PackTask::Tts
            )
        {
            return Err(ModelPackError::Store { code: "binding" });
        }
        let mut seen = BTreeSet::new();
        for file in &files {
            if !seen.insert(file.file_id.clone()) {
                return Err(ModelPackError::Store { code: "binding" });
            }
        }
        Ok(Self {
            task,
            slot_id,
            pack_id,
            pack_path,
            expected_sha256,
            expected_size_bytes,
            runtime_revision,
            language,
            sample_rate_hz,
            frame_size,
            files,
        })
    }

    pub fn task(&self) -> PackTask {
        self.task
    }

    pub fn slot_id(&self) -> &str {
        &self.slot_id
    }

    pub fn pack_id(&self) -> &str {
        &self.pack_id
    }

    pub fn pack_path(&self) -> &PathBuf {
        &self.pack_path
    }

    pub fn expected_sha256(&self) -> &str {
        &self.expected_sha256
    }

    pub fn expected_size_bytes(&self) -> u64 {
        self.expected_size_bytes
    }

    pub fn runtime_revision(&self) -> &str {
        &self.runtime_revision
    }

    pub fn language(&self) -> &str {
        &self.language
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn frame_size(&self) -> u32 {
        self.frame_size
    }

    pub fn files(&self) -> &[IosVoicePackFileBinding] {
        &self.files
    }
}

impl fmt::Debug for IosVoicePackBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IosVoicePackBinding")
            .field("task", &self.task)
            .field("slot_id", &self.slot_id)
            .field("pack_id_bytes", &self.pack_id.len())
            .field("pack_path", &"<redacted>")
            .field("expected_sha256_bytes", &self.expected_sha256.len())
            .field("expected_size_bytes", &self.expected_size_bytes)
            .field("runtime_revision_bytes", &self.runtime_revision.len())
            .field("language_bytes", &self.language.len())
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("frame_size", &self.frame_size)
            .field("file_count", &self.files.len())
            .finish()
    }
}

/// One exact local file inside an iOS-selected Sherpa pack.
#[derive(Clone, PartialEq, Eq)]
pub struct IosVoicePackFileBinding {
    file_id: String,
    path: PathBuf,
    expected_sha256: String,
    expected_size_bytes: u64,
}

impl IosVoicePackFileBinding {
    pub fn new(
        file_id: impl Into<String>,
        path: impl Into<PathBuf>,
        expected_sha256: impl Into<String>,
        expected_size_bytes: u64,
    ) -> Result<Self, ModelPackError> {
        let file_id = file_id.into();
        let path = path.into();
        let expected_sha256 = expected_sha256.into();
        if file_id.is_empty()
            || path.as_os_str().is_empty()
            || path.as_os_str().len() > MAX_IOS_PACK_PATH_BYTES
            || !is_hex_sha256(&expected_sha256)
            || expected_size_bytes == 0
        {
            return Err(ModelPackError::Store { code: "binding" });
        }
        Ok(Self {
            file_id,
            path,
            expected_sha256,
            expected_size_bytes,
        })
    }

    pub fn file_id(&self) -> &str {
        &self.file_id
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn expected_sha256(&self) -> &str {
        &self.expected_sha256
    }

    pub fn expected_size_bytes(&self) -> u64 {
        self.expected_size_bytes
    }
}

impl fmt::Debug for IosVoicePackFileBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IosVoicePackFileBinding")
            .field("file_id", &self.file_id)
            .field("path", &"<redacted>")
            .field("expected_sha256_bytes", &self.expected_sha256.len())
            .field("expected_size_bytes", &self.expected_size_bytes)
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
    let verified = verify_ios_pack_bindings(&config.pack_bindings)?;
    if !verified.is_empty() {
        return build_local_ios_runtime(config, input, output, sink, verified);
    }
    build_gateway_runtime(config, input, output, sink)
}

#[cfg(not(feature = "ios-sherpa"))]
fn build_local_ios_runtime(
    _config: &IosVoiceSessionConfig,
    _input: AuroraIosAudioInput,
    _output: AuroraIosAudioOutput,
    _sink: IosSessionSink,
    _verified: BTreeMap<PackTask, IosVoicePackBinding>,
) -> Result<RuntimeCore, IosVoiceSessionCommandError> {
    Err(IosVoiceSessionCommandError::Unavailable)
}

#[cfg(feature = "ios-sherpa")]
fn build_local_ios_runtime(
    config: &IosVoiceSessionConfig,
    input: AuroraIosAudioInput,
    output: AuroraIosAudioOutput,
    sink: IosSessionSink,
    verified: BTreeMap<PackTask, IosVoicePackBinding>,
) -> Result<RuntimeCore, IosVoiceSessionCommandError> {
    let policy = microphone_policy(config)?;
    if !matches!(policy, MicrophoneAudioPolicy::LoopbackOnly) {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let transport_for_assistant = assistant_transport(config, policy)?;
    let vad_binding = verified_binding(&verified, PackTask::Vad)?;
    let kws_binding = verified
        .get(&PackTask::Kws)
        .or_else(|| verified.get(&PackTask::Wakeword))
        .ok_or(IosVoiceSessionCommandError::Unavailable)?;
    let stt_binding = verified_binding(&verified, PackTask::Stt)?;
    let tts_binding = verified_binding(&verified, PackTask::Tts)?;

    let vad_task = task_pack_binding(vad_binding, VoiceTask::VoiceActivityDetection)?;
    let kws_task = task_pack_binding(kws_binding, VoiceTask::KeywordSpotting)?;
    let stt_task = task_pack_binding(stt_binding, VoiceTask::SpeechToText)?;
    let tts_task = task_pack_binding(tts_binding, VoiceTask::TextToSpeech)?;

    let vad_config = VadConfig::default();
    let vad_model = required_file(vad_binding, "model")?;
    let vad_backend = NativeVadBackend::from_selected_model(
        &vad_task,
        vad_model.file_id(),
        vad_model.path().clone(),
        &vad_config,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let vad = SherpaVadProvider::new(vad_task.clone(), vad_backend)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;

    let kws_files = NativeKwsModelFiles {
        encoder_file_id: "encoder-int8".to_owned(),
        encoder_path: required_file(kws_binding, "encoder-int8")?.path().clone(),
        decoder_file_id: "decoder".to_owned(),
        decoder_path: required_file(kws_binding, "decoder")?.path().clone(),
        joiner_file_id: "joiner-int8".to_owned(),
        joiner_path: required_file(kws_binding, "joiner-int8")?.path().clone(),
        tokens_file_id: "tokens".to_owned(),
        tokens_path: required_file(kws_binding, "tokens")?.path().clone(),
    };
    let kws_backend = NativeKwsBackend::from_selected_model(&kws_task, kws_files)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let phrase_set = SherpaKwsPhraseSet::new(
        kws_binding.runtime_revision().to_owned(),
        [SherpaKwsPhrase::new("wake.main", "AURORA", "AURORA")
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?],
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let kws = SherpaKwsProvider::new(kws_task.clone(), phrase_set.clone(), kws_backend)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;

    let stt_decoder = stt_decoder_file(stt_binding)?;
    let stt_files = NativeSttModelFiles {
        encoder_file_id: "encoder".to_owned(),
        encoder_path: required_file(stt_binding, "encoder")?.path().clone(),
        decoder_file_id: stt_decoder.file_id().to_owned(),
        decoder_path: stt_decoder.path().clone(),
        tokens_file_id: "tokens".to_owned(),
        tokens_path: required_file(stt_binding, "tokens")?.path().clone(),
        language: Some(stt_binding.language().to_owned()),
    };
    let stt_backend = NativeSttBackend::from_selected_model_files(&stt_task, stt_files)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let stt = SherpaFiniteSttEngine::new(stt_task, stt_backend)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;

    let tts_files = NativeTtsVitsPiperModelFiles {
        model_file_id: "model".to_owned(),
        model_path: required_file(tts_binding, "model")?.path().clone(),
        tokens_file_id: "tokens".to_owned(),
        tokens_path: required_file(tts_binding, "tokens")?.path().clone(),
        espeak_data_file_id: "espeak-ng-data".to_owned(),
        espeak_data_dir: required_file(tts_binding, "espeak-ng-data")?.path().clone(),
        lexicon_file_id: optional_file(tts_binding, "lexicon")
            .map(|file| file.file_id().to_owned()),
        lexicon_path: optional_file(tts_binding, "lexicon").map(|file| file.path().clone()),
    };
    let tts_backend = NativeTtsBackend::from_selected_vits_piper_model(&tts_task, tts_files)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let tts = SherpaTtsProvider::new(tts_task, tts_backend)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;

    let wake_config = WakeOrchestrationConfig::new(
        vad_task,
        kws_task,
        vad_config,
        KwsConfig::new(
            ["wake.main"],
            kws_binding.runtime_revision().to_owned(),
            0.5,
            2,
            1,
        )
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?,
        16_000 * 30,
        16_000 * 60,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;

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
    .and_then(|runtime| runtime.with_wake_providers(Box::new(vad), Box::new(kws), wake_config))
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)
}

#[cfg(not(feature = "ios-sherpa"))]
fn build_gateway_runtime(
    config: &IosVoiceSessionConfig,
    input: AuroraIosAudioInput,
    output: AuroraIosAudioOutput,
    sink: IosSessionSink,
) -> Result<RuntimeCore, IosVoiceSessionCommandError> {
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

#[cfg(feature = "ios-sherpa")]
fn build_gateway_runtime(
    _config: &IosVoiceSessionConfig,
    _input: AuroraIosAudioInput,
    _output: AuroraIosAudioOutput,
    _sink: IosSessionSink,
) -> Result<RuntimeCore, IosVoiceSessionCommandError> {
    Err(IosVoiceSessionCommandError::Unavailable)
}

fn verify_ios_pack_bindings(
    bindings: &IosVoicePackBindings,
) -> Result<BTreeMap<PackTask, IosVoicePackBinding>, IosVoiceSessionCommandError> {
    let mut verified = BTreeMap::new();
    for binding in bindings.iter() {
        verify_ios_pack_binding(binding)?;
        for file in binding.files() {
            verify_ios_pack_file_binding(file)?;
        }
        verified.insert(binding.task(), binding.clone());
    }
    if !verified.is_empty()
        && !(verified.contains_key(&PackTask::Vad)
            && (verified.contains_key(&PackTask::Kws)
                || verified.contains_key(&PackTask::Wakeword))
            && verified.contains_key(&PackTask::Stt)
            && verified.contains_key(&PackTask::Tts))
    {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    Ok(verified)
}

fn verify_ios_pack_binding(
    binding: &IosVoicePackBinding,
) -> Result<(), IosVoiceSessionCommandError> {
    let metadata = fs::symlink_metadata(binding.pack_path())
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() != binding.expected_size_bytes()
        || binding.runtime_revision().is_empty()
    {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let digest =
        sha256_path(binding.pack_path()).map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    if digest != binding.expected_sha256() {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    Ok(())
}

fn verify_ios_pack_file_binding(
    binding: &IosVoicePackFileBinding,
) -> Result<(), IosVoiceSessionCommandError> {
    let metadata = fs::symlink_metadata(binding.path())
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() != binding.expected_size_bytes()
    {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let digest =
        sha256_path(binding.path()).map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    if digest != binding.expected_sha256() {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    Ok(())
}

#[cfg(feature = "ios-sherpa")]
fn assistant_transport(
    config: &IosVoiceSessionConfig,
    policy: MicrophoneAudioPolicy,
) -> Result<NativeGatewayTransport, IosVoiceSessionCommandError> {
    let limits = TransportLimits {
        max_request_bytes: 2 * 1024 * 1024,
        max_response_bytes: 8 * 1024 * 1024,
        max_event_bytes: 2 * 1024 * 1024,
        request_timeout: REQUEST_TIMEOUT,
        stream_idle_timeout: STREAM_IDLE_TIMEOUT,
        allow_loopback_http: matches!(policy, MicrophoneAudioPolicy::LoopbackOnly),
        microphone_audio_policy: policy,
    };
    NativeGatewayTransport::new(config.gateway.clone(), config.auth.clone(), limits)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)
}

#[cfg(feature = "ios-sherpa")]
fn verified_binding(
    verified: &BTreeMap<PackTask, IosVoicePackBinding>,
    task: PackTask,
) -> Result<&IosVoicePackBinding, IosVoiceSessionCommandError> {
    verified
        .get(&task)
        .ok_or(IosVoiceSessionCommandError::Unavailable)
}

#[cfg(feature = "ios-sherpa")]
fn required_file<'a>(
    binding: &'a IosVoicePackBinding,
    file_id: &str,
) -> Result<&'a IosVoicePackFileBinding, IosVoiceSessionCommandError> {
    optional_file(binding, file_id).ok_or(IosVoiceSessionCommandError::Unavailable)
}

#[cfg(feature = "ios-sherpa")]
fn optional_file<'a>(
    binding: &'a IosVoicePackBinding,
    file_id: &str,
) -> Option<&'a IosVoicePackFileBinding> {
    binding
        .files()
        .iter()
        .find(|file| file.file_id() == file_id)
}

#[cfg(feature = "ios-sherpa")]
fn stt_decoder_file(
    binding: &IosVoicePackBinding,
) -> Result<&IosVoicePackFileBinding, IosVoiceSessionCommandError> {
    match (
        optional_file(binding, "decoder"),
        optional_file(binding, "decoder-merged"),
    ) {
        (Some(file), None) | (None, Some(file)) => Ok(file),
        _ => Err(IosVoiceSessionCommandError::Unavailable),
    }
}

#[cfg(feature = "ios-sherpa")]
fn task_pack_binding(
    binding: &IosVoicePackBinding,
    task: VoiceTask,
) -> Result<TaskPackBinding, IosVoiceSessionCommandError> {
    let installed_bytes = binding
        .files()
        .iter()
        .try_fold(0_u64, |total, file| {
            total.checked_add(file.expected_size_bytes())
        })
        .ok_or(IosVoiceSessionCommandError::Unavailable)?;
    TaskPackBinding::from_ios_cached_sherpa(
        task,
        binding.pack_id().to_owned(),
        binding.runtime_revision().to_owned(),
        binding.expected_sha256().to_owned(),
        binding.runtime_revision().to_owned(),
        binding
            .files()
            .iter()
            .map(|file| file.file_id().to_owned())
            .collect(),
        binding.language().to_owned(),
        binding.sample_rate_hz(),
        binding.frame_size(),
        installed_bytes,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)
}

fn sha256_path(path: &PathBuf) -> Result<String, std::io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 64];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(""))
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
        let file = IosVoicePackFileBinding::new(
            "encoder",
            "/private/model-pack/encoder.onnx",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            12,
        )
        .expect("file binding");
        let binding = IosVoicePackBinding::new(
            PackTask::Stt,
            "default",
            "stt.en",
            "/private/model-pack",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            12,
            "sherpa-onnx-1.13.4",
            "en-US",
            16_000,
            512,
            vec![file.clone()],
        )
        .expect("binding");
        assert_eq!(binding.task(), PackTask::Stt);
        assert_eq!(binding.slot_id(), "default");
        assert_eq!(binding.pack_id(), "stt.en");
        assert_eq!(binding.expected_size_bytes(), 12);
        assert_eq!(binding.runtime_revision(), "sherpa-onnx-1.13.4");
        assert_eq!(binding.language(), "en-US");
        assert_eq!(binding.sample_rate_hz(), 16_000);
        assert_eq!(binding.frame_size(), 512);
        assert_eq!(
            IosVoicePackBindings::new(vec![binding.clone()])
                .expect("bindings")
                .len(),
            1
        );
        assert!(IosVoicePackBindings::new(vec![binding.clone(), binding.clone()]).is_err());
        assert!(IosVoicePackBinding::new(
            PackTask::Stt,
            "default",
            "stt.en",
            "/private/model-pack",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            12,
            "sherpa-onnx-1.13.4",
            "en-US",
            16_000,
            512,
            vec![file.clone(), file]
        )
        .is_err());
        let debug = format!("{binding:?}");
        assert!(debug.contains("Stt"));
        assert!(!debug.contains("stt.en"));
        assert!(!debug.contains("/private/model-pack"));
    }

    #[test]
    fn ios_session_accepts_cached_exact_pack_binding_set_for_verification() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bindings = IosVoicePackBindings::new(vec![
            test_pack_binding(dir.path(), PackTask::Vad, "vad", &["model"]),
            test_pack_binding(
                dir.path(),
                PackTask::Kws,
                "kws",
                &["encoder-int8", "decoder", "joiner-int8", "tokens"],
            ),
            test_pack_binding(
                dir.path(),
                PackTask::Stt,
                "stt",
                &["encoder", "decoder", "tokens"],
            ),
            test_pack_binding(
                dir.path(),
                PackTask::Tts,
                "tts",
                &["model", "tokens", "espeak-ng-data"],
            ),
        ])
        .expect("bindings");
        let verified = verify_ios_pack_bindings(&bindings).expect("verified");
        assert_eq!(verified.len(), 4);
        assert!(verified.contains_key(&PackTask::Vad));
        assert!(verified.contains_key(&PackTask::Kws));
        assert!(verified.contains_key(&PackTask::Stt));
        assert!(verified.contains_key(&PackTask::Tts));
    }

    #[test]
    fn ios_session_rejects_incomplete_cached_pack_binding_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bindings = IosVoicePackBindings::new(vec![test_pack_binding(
            dir.path(),
            PackTask::Stt,
            "stt",
            &["encoder", "decoder", "tokens"],
        )])
        .expect("bindings");
        assert!(matches!(
            verify_ios_pack_bindings(&bindings),
            Err(IosVoiceSessionCommandError::Unavailable)
        ));
    }

    #[test]
    #[cfg(not(feature = "ios-sherpa"))]
    fn ios_runtime_fails_closed_for_native_pack_bindings_without_sherpa_feature() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bindings = IosVoicePackBindings::new(vec![
            test_pack_binding(dir.path(), PackTask::Vad, "vad", &["model"]),
            test_pack_binding(
                dir.path(),
                PackTask::Kws,
                "kws",
                &["encoder-int8", "decoder", "joiner-int8", "tokens"],
            ),
            test_pack_binding(
                dir.path(),
                PackTask::Stt,
                "stt",
                &["encoder", "decoder", "tokens"],
            ),
            test_pack_binding(
                dir.path(),
                PackTask::Tts,
                "tts",
                &["model", "tokens", "espeak-ng-data"],
            ),
        ])
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
    #[cfg(unix)]
    fn ios_session_rejects_symlinked_pack_bindings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("target.pack");
        let link = dir.path().join("link.pack");
        std::fs::write(&target, b"cached model").expect("write pack");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        let sha256 = sha256_path(&target).expect("hash");
        let binding = IosVoicePackBinding::new(
            PackTask::Stt,
            "default",
            "stt.en",
            link,
            sha256,
            12,
            "sherpa-onnx-1.13.4",
            "en-US",
            16_000,
            512,
            vec![IosVoicePackFileBinding::new(
                "encoder",
                target.clone(),
                sha256_path(&target).expect("hash file"),
                12,
            )
            .expect("file binding")],
        )
        .expect("binding");
        assert!(matches!(
            verify_ios_pack_binding(&binding),
            Err(IosVoiceSessionCommandError::Unavailable)
        ));
    }

    fn test_pack_binding(
        root: &std::path::Path,
        task: PackTask,
        slot: &str,
        file_ids: &[&str],
    ) -> IosVoicePackBinding {
        let pack = root.join(format!("{slot}.pack"));
        std::fs::write(&pack, format!("cached {slot} pack")).expect("write pack");
        let pack_sha256 = sha256_path(&pack).expect("hash pack");
        let files = file_ids
            .iter()
            .map(|file_id| {
                let file_path = root.join(format!("{slot}-{file_id}.bin"));
                std::fs::write(&file_path, format!("cached {slot} {file_id}")).expect("write file");
                let size = std::fs::metadata(&file_path).expect("metadata").len();
                IosVoicePackFileBinding::new(
                    *file_id,
                    file_path,
                    sha256_path(&root.join(format!("{slot}-{file_id}.bin"))).expect("hash file"),
                    size,
                )
                .expect("file binding")
            })
            .collect();
        IosVoicePackBinding::new(
            task,
            slot,
            format!("{slot}.en"),
            pack,
            pack_sha256,
            std::fs::metadata(root.join(format!("{slot}.pack")))
                .expect("metadata")
                .len(),
            "sherpa-onnx-1.13.4",
            "en-US",
            16_000,
            512,
            files,
        )
        .expect("binding")
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
