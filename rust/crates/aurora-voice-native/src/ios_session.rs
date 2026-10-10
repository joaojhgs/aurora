//! iOS-native voice session executor.
//!
//! Swift owns AVAudioSession/AVAudioEngine and drains the bounded playback
//! queue. This module owns the shared Rust voice runtime, typed Gateway
//! transport, generations, cancellation, and redacted lifecycle status.

use crate::mobile_session_close::{
    rollback_failed_join_driver, start_join_driver, MobileSessionCloseError, MobileSessionLifecycle,
};
use crate::{emit_native_speech_lifecycle, native_speech_lifecycle_observer_enabled};
use crate::{
    GatewayAuth, MicrophoneAudioPolicy, NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig,
    NativeGatewayTransport, NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer, TransportLimits,
};
use async_trait::async_trait;
#[cfg(feature = "ios-sherpa")]
use aurora_voice_core::WakeOrchestrationConfig;
use aurora_voice_core::{
    AudioInput, AudioOutput, CancellationToken, CaptureOwnerKind, CaptureStartReason, Generation,
    RedactedSnapshot, RouteRevision, RuntimeEvent, RuntimeEventSink, SpeechLifecycleEventV1,
    SpeechTransport, TimestampMicros, VoiceCaptureLease, VoiceCoreError, VoiceRuntime, VoiceState,
};
#[cfg(feature = "ios-sherpa")]
use aurora_voice_engine::{
    BoundFiniteSttRequest, BoundTtsSynthesisRequest, FiniteSttAudio, FiniteSttProviderBinding,
    FiniteSttResult, TtsSynthesisProviderBinding, TtsSynthesisResult,
};
#[cfg(feature = "ios-sherpa")]
use aurora_voice_engine::{
    BoundKwsRequest, BoundStreamSession, BoundTaskRequest, BoundVadRequest, EngineError,
    KwsFrameResult, KwsStreamProvider, ResourceReport, SpeechSegment, StreamResetReason,
    StreamingAudioFrame, TaskCapability, TaskProvider, TaskReadiness, VadAcceptResult,
    VadStreamProvider,
};
use aurora_voice_engine::{
    FiniteSttPort, FiniteSttRouteScope, ModelPackError, ModelStoreScope, PackTask,
    RouteFiniteSttBinding, RouteTtsBinding, TtsSynthesisPort, TtsVoiceCatalog,
    MAX_FINITE_STT_SAMPLES, VAD_SAMPLE_RATE_HZ,
};
#[cfg(feature = "ios-sherpa")]
use aurora_voice_engine::{KwsConfig, TaskPackBinding, VadConfig, VoiceTask};
use aurora_voice_ios_bridge::{
    AuroraIosAudioInput, AuroraIosAudioOutput, AuroraIosAudioState, AuroraIosCaptureControl,
};
#[cfg(feature = "ios-sherpa")]
use aurora_voice_sherpa::{
    NativeKwsBackend, NativeKwsModelFiles, NativeSttBackend, NativeSttModelFiles, NativeTtsBackend,
    NativeTtsPocketModelFiles, NativeTtsReferenceAudio, NativeTtsVitsPiperModelFiles,
    NativeVadBackend, SherpaFiniteSttEngine, SherpaKwsPhrase, SherpaKwsPhraseSet,
    SherpaKwsProvider, SherpaTtsProvider, SherpaVadProvider,
};
use sha2::{Digest, Sha256};
#[cfg(feature = "ios-sherpa")]
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::future::Future;
use std::io::Read;
use std::path::PathBuf;
use std::pin::Pin;
#[cfg(feature = "ios-sherpa")]
use std::sync::atomic::{AtomicU64, Ordering};
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
const MAX_IOS_REFERENCE_TEXT_BYTES: usize = 1024;
const MAX_IOS_REFERENCE_AUDIO_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(feature = "ios-sherpa")]
const MAX_IOS_REFERENCE_AUDIO_SAMPLES: usize = 48_000 * 30;

#[cfg(feature = "ios-sherpa")]
enum IosFiniteSttProvider {
    Local(SherpaFiniteSttEngine<NativeSttBackend>),
    Gateway(NativeGatewayFiniteStt),
}
#[cfg(not(feature = "ios-sherpa"))]
type IosFiniteSttProvider = NativeGatewayFiniteStt;
#[cfg(feature = "ios-sherpa")]
enum IosTtsProvider {
    Local(SherpaTtsProvider<NativeTtsBackend>),
    Gateway(NativeGatewayTtsSynthesizer),
}
#[cfg(not(feature = "ios-sherpa"))]
type IosTtsProvider = NativeGatewayTtsSynthesizer;

#[cfg(feature = "ios-sherpa")]
#[async_trait(?Send)]
impl FiniteSttPort for IosFiniteSttProvider {
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
        match self {
            Self::Local(provider) => provider.finite_stt_binding(),
            Self::Gateway(provider) => provider.finite_stt_binding(),
        }
    }

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError> {
        match self {
            Self::Local(provider) => provider.warm_finite_stt(binding).await,
            Self::Gateway(provider) => provider.warm_finite_stt(binding).await,
        }
    }

    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        match self {
            Self::Local(provider) => {
                provider
                    .transcribe_finite(request, audio, cancellation)
                    .await
            }
            Self::Gateway(provider) => {
                provider
                    .transcribe_finite(request, audio, cancellation)
                    .await
            }
        }
    }

    async fn cancel_finite_stt_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        match self {
            Self::Local(provider) => provider.cancel_finite_stt_generation(generation).await,
            Self::Gateway(provider) => provider.cancel_finite_stt_generation(generation).await,
        }
    }
}

#[cfg(feature = "ios-sherpa")]
#[async_trait(?Send)]
impl TtsSynthesisPort for IosTtsProvider {
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
        match self {
            Self::Local(provider) => provider.synthesis_binding(),
            Self::Gateway(provider) => provider.synthesis_binding(),
        }
    }

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError> {
        match self {
            Self::Local(provider) => provider.warm_synthesis(binding).await,
            Self::Gateway(provider) => provider.warm_synthesis(binding).await,
        }
    }

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        match self {
            Self::Local(provider) => provider.synthesize_text(request, cancellation).await,
            Self::Gateway(provider) => provider.synthesize_text(request, cancellation).await,
        }
    }

    async fn cancel_synthesis_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        match self {
            Self::Local(provider) => provider.cancel_synthesis_generation(generation).await,
            Self::Gateway(provider) => provider.cancel_synthesis_generation(generation).await,
        }
    }
}

type RuntimeCore = VoiceRuntime<
    AuroraIosAudioInput,
    IosFiniteSttProvider,
    IosTtsProvider,
    NativeGatewayTransport,
    AuroraIosAudioOutput,
    IosSessionSink,
>;

trait IosSessionRuntime {
    fn has_active_capture(&self) -> bool;
    fn next_capture_generation(&self) -> Result<Generation, VoiceCoreError>;
    fn invoke_turn<'a>(
        &'a mut self,
        mode: IosVoiceStartMode,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<String, VoiceCoreError>> + 'a>>;
    fn cleanup_report_for_generation(
        &self,
        generation: Generation,
    ) -> Option<aurora_voice_core::VoiceCleanupReport>;
}

impl<A, E, P, T, O, S> IosSessionRuntime for VoiceRuntime<A, E, P, T, O, S>
where
    A: AudioInput,
    E: FiniteSttPort,
    P: TtsSynthesisPort,
    T: SpeechTransport,
    O: AudioOutput,
    S: RuntimeEventSink,
{
    fn has_active_capture(&self) -> bool {
        VoiceRuntime::has_active_capture(self)
    }

    fn next_capture_generation(&self) -> Result<Generation, VoiceCoreError> {
        VoiceRuntime::next_capture_generation(self)
    }

    fn invoke_turn<'a>(
        &'a mut self,
        mode: IosVoiceStartMode,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<String, VoiceCoreError>> + 'a>> {
        match mode {
            IosVoiceStartMode::PushToTalk => {
                Box::pin(self.run_push_to_talk_transcription(lease, at, cancellation))
            }
            IosVoiceStartMode::BackgroundSession => {
                Box::pin(self.run_background_turn(lease, at, cancellation))
            }
        }
    }

    fn cleanup_report_for_generation(
        &self,
        generation: Generation,
    ) -> Option<aurora_voice_core::VoiceCleanupReport> {
        VoiceRuntime::cleanup_report_for_generation(self, generation)
    }
}

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
    model_family: String,
    tts_reference: Option<IosTtsReferenceBinding>,
    files: Vec<IosVoicePackFileBinding>,
}

impl IosVoicePackBinding {
    #[allow(clippy::too_many_arguments)]
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
        model_family: impl Into<String>,
        tts_reference: Option<IosTtsReferenceBinding>,
        files: Vec<IosVoicePackFileBinding>,
    ) -> Result<Self, ModelPackError> {
        let slot_id = slot_id.into();
        ModelStoreScope::new(task, slot_id.clone())?;
        let pack_id = pack_id.into();
        let pack_path = pack_path.into();
        let expected_sha256 = expected_sha256.into();
        let runtime_revision = runtime_revision.into();
        let language = language.into();
        let model_family = model_family.into();
        if pack_id.is_empty()
            || pack_path.as_os_str().is_empty()
            || pack_path.as_os_str().len() > MAX_IOS_PACK_PATH_BYTES
            || !is_hex_sha256(&expected_sha256)
            || expected_size_bytes == 0
            || runtime_revision.is_empty()
            || language.is_empty()
            || sample_rate_hz == 0
            || frame_size == 0
            || model_family.is_empty()
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
            model_family,
            tts_reference,
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

    pub fn model_family(&self) -> &str {
        &self.model_family
    }

    pub fn tts_reference(&self) -> Option<&IosTtsReferenceBinding> {
        self.tts_reference.as_ref()
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
            .field("model_family", &self.model_family)
            .field("tts_reference_present", &self.tts_reference.is_some())
            .field("file_count", &self.files.len())
            .finish()
    }
}

/// User-selected PocketTTS reference profile stored outside the app bundle.
#[derive(Clone, PartialEq, Eq)]
pub struct IosTtsReferenceBinding {
    audio_path: PathBuf,
    expected_sha256: String,
    expected_size_bytes: u64,
    sample_rate_hz: u32,
    reference_text: String,
    revision: String,
}

impl IosTtsReferenceBinding {
    pub fn new(
        audio_path: impl Into<PathBuf>,
        expected_sha256: impl Into<String>,
        expected_size_bytes: u64,
        sample_rate_hz: u32,
        reference_text: impl Into<String>,
        revision: impl Into<String>,
    ) -> Result<Self, ModelPackError> {
        let audio_path = audio_path.into();
        let expected_sha256 = expected_sha256.into();
        let reference_text = {
            let text = reference_text.into();
            if text.trim().is_empty() {
                String::new()
            } else {
                text
            }
        };
        let revision = revision.into();
        if audio_path.as_os_str().is_empty()
            || audio_path.as_os_str().len() > MAX_IOS_PACK_PATH_BYTES
            || !is_hex_sha256(&expected_sha256)
            || expected_size_bytes == 0
            || expected_size_bytes > MAX_IOS_REFERENCE_AUDIO_BYTES
            || sample_rate_hz == 0
            || reference_text.len() > MAX_IOS_REFERENCE_TEXT_BYTES
            || revision.is_empty()
        {
            return Err(ModelPackError::Store { code: "reference" });
        }
        Ok(Self {
            audio_path,
            expected_sha256,
            expected_size_bytes,
            sample_rate_hz,
            reference_text,
            revision,
        })
    }

    pub fn audio_path(&self) -> &PathBuf {
        &self.audio_path
    }

    pub fn expected_sha256(&self) -> &str {
        &self.expected_sha256
    }

    pub fn expected_size_bytes(&self) -> u64 {
        self.expected_size_bytes
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    pub fn reference_text(&self) -> &str {
        &self.reference_text
    }

    pub fn reference_text_for_sherpa(&self) -> Option<&str> {
        let trimmed = self.reference_text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(&self.reference_text)
        }
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

impl fmt::Debug for IosTtsReferenceBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IosTtsReferenceBinding")
            .field("audio_path", &"<redacted>")
            .field("expected_sha256_bytes", &self.expected_sha256.len())
            .field("expected_size_bytes", &self.expected_size_bytes)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("reference_text_bytes", &self.reference_text.len())
            .field("revision_bytes", &self.revision.len())
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
    FinishWithTranscript {
        generation: Generation,
        reply: mpsc::Sender<Result<String, IosVoiceSessionCommandError>>,
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
    lifecycle: MobileSessionLifecycle,
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
        Self::new_with_join_driver(
            config,
            input_capacity_chunks,
            max_input_chunk_samples,
            output_capacity_chunks,
            start_join_driver,
            || {},
        )
    }

    fn new_with_join_driver(
        config: IosVoiceSessionConfig,
        input_capacity_chunks: usize,
        max_input_chunk_samples: usize,
        output_capacity_chunks: usize,
        start_driver: impl FnOnce(
            &MobileSessionLifecycle,
            thread::JoinHandle<()>,
        ) -> Result<(), thread::JoinHandle<()>>,
        worker_exit: impl FnOnce() + Send + 'static,
    ) -> Result<Self, IosVoiceSessionCommandError> {
        let audio_state =
            AuroraIosAudioState::new(input_capacity_chunks.max(1), max_input_chunk_samples.max(1));
        let output = AuroraIosAudioOutput::new(output_capacity_chunks.max(1));
        let input = AuroraIosAudioInput::new(audio_state.clone());
        let capture_control = input.control();
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let lifecycle = MobileSessionLifecycle::new();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_status = Arc::clone(&status);
        let thread_control = capture_control.clone();
        let thread_output = output.clone();
        let thread_lifecycle = lifecycle.clone();
        let worker = thread::Builder::new()
            .name("aurora-ios-voice".to_owned())
            .spawn(move || {
                let sink = IosSessionSink {
                    status: Arc::clone(&thread_status),
                };
                run_session_thread(SessionThreadInputs {
                    config,
                    input,
                    output: thread_output,
                    sink,
                    commands: command_rx,
                    ready: ready_tx,
                    status: thread_status,
                    control: thread_control,
                    lifecycle: thread_lifecycle,
                });
                worker_exit();
            })
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
        if let Err(worker) = start_driver(&lifecycle, worker) {
            rollback_failed_join_driver(
                &lifecycle,
                worker,
                || commands.send(Command::Shutdown).is_ok(),
                |generation| capture_control.interrupt(generation),
                || {
                    audio_state.close();
                    output.close();
                },
            );
            return Err(IosVoiceSessionCommandError::Unavailable);
        }
        match ready_rx
            .recv()
            .unwrap_or(Err(IosVoiceSessionCommandError::Closed))
        {
            Ok(()) => {}
            Err(error) => {
                let generation =
                    lifecycle.request_retirement(|| commands.send(Command::Shutdown).is_ok());
                if let Some(generation) = generation {
                    capture_control.interrupt(generation);
                }
                audio_state.close();
                output.close();
                let _ = lifecycle.close_checked();
                return Err(error);
            }
        }
        Ok(Self {
            audio_state,
            output,
            capture_control,
            commands,
            status,
            lifecycle,
        })
    }

    pub fn audio_state(&self) -> AuroraIosAudioState {
        self.audio_state.clone()
    }

    pub fn output(&self) -> AuroraIosAudioOutput {
        self.output.clone()
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
        self.lifecycle
            .admit(|| self.commands.send(Command::Start { mode, reply }).is_ok())
            .map_err(map_close_command_error)?;
        response
            .recv()
            .unwrap_or(Err(IosVoiceSessionCommandError::Closed))
    }

    pub fn finish(&self, generation: u64) -> Result<(), IosVoiceSessionCommandError> {
        self.send_generation_command(generation, false)
    }

    /// Finishes the foreground turn and returns the transcript from that same
    /// generation after native transcription has completed.
    pub fn finish_with_transcript(
        &self,
        generation: u64,
    ) -> Result<String, IosVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        self.lifecycle
            .admit(|| {
                self.commands
                    .send(Command::FinishWithTranscript {
                        generation: Generation(generation),
                        reply,
                    })
                    .is_ok()
            })
            .map_err(map_close_command_error)?;
        response
            .recv()
            .unwrap_or(Err(IosVoiceSessionCommandError::Closed))
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
        self.lifecycle
            .admit(|| self.commands.send(command).is_ok())
            .map_err(map_close_command_error)?;
        response
            .recv()
            .unwrap_or(Err(IosVoiceSessionCommandError::Closed))
    }

    pub fn close(&self) {
        self.request_close();
        let _ = self.lifecycle.close_checked();
    }

    /// Requests terminal retirement without waiting for the native worker.
    pub fn request_close(&self) {
        let generation = self
            .lifecycle
            .request_retirement(|| self.commands.send(Command::Shutdown).is_ok());
        if let Some(generation) = generation {
            self.capture_control.interrupt(generation);
        }
        self.audio_state.close();
        self.output.close();
    }

    /// Waits for the shared terminal result without requiring a Tokio runtime.
    pub fn wait_closed(
        &self,
    ) -> impl Future<Output = Result<(), MobileSessionCloseError>> + 'static {
        self.lifecycle.wait_closed()
    }

    /// Requests closure and blocks until the worker thread has actually joined.
    ///
    /// Call this only from a thread that may block, never from UI or audio callbacks.
    pub fn close_checked(&self) -> Result<(), MobileSessionCloseError> {
        self.request_close();
        self.lifecycle.close_checked()
    }

    /// Requests closure and records a sticky failure if the join deadline expires.
    ///
    /// The worker and join driver continue after this observer returns on timeout.
    pub fn close_checked_timeout(&self, timeout: Duration) -> Result<(), MobileSessionCloseError> {
        self.request_close();
        self.lifecycle.close_checked_timeout(timeout)
    }
}

impl Drop for IosVoiceSession {
    fn drop(&mut self) {
        self.request_close();
    }
}

fn map_close_command_error(error: MobileSessionCloseError) -> IosVoiceSessionCommandError {
    match error {
        MobileSessionCloseError::ShutdownFailed => IosVoiceSessionCommandError::Closed,
        _ => IosVoiceSessionCommandError::Unavailable,
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
    let transport_for_assistant = assistant_transport(config, policy)?;
    let stt = match verified.get(&PackTask::Stt) {
        Some(binding) => build_local_ios_stt(binding)?,
        None => build_gateway_ios_stt(config, policy)?,
    };
    let tts = match verified.get(&PackTask::Tts) {
        Some(binding) => build_local_ios_tts(binding)?,
        None => build_gateway_ios_tts(config, policy)?,
    };
    let runtime = VoiceRuntime::new(
        input,
        stt,
        tts,
        transport_for_assistant,
        output,
        sink,
        IOS_SURFACE,
        IOS_RUNTIME_ID,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;

    let Some(vad_binding) = verified.get(&PackTask::Vad) else {
        return Ok(runtime);
    };
    let kws_binding = verified
        .get(&PackTask::Kws)
        .or_else(|| verified.get(&PackTask::Wakeword))
        .ok_or(IosVoiceSessionCommandError::Unavailable)?;
    let vad_task = task_pack_binding(vad_binding, VoiceTask::VoiceActivityDetection)?;
    let kws_task = task_pack_binding(kws_binding, VoiceTask::KeywordSpotting)?;
    let vad_config = VadConfig::default();
    let vad_model = required_file(vad_binding, "model")?;
    let vad = IosWakeVad::new(
        vad_task.clone(),
        vad_model.file_id().to_owned(),
        vad_model.path().clone(),
        vad_config.clone(),
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let kws_files = IosWakeKwsFiles {
        encoder_file_id: "encoder-int8".to_owned(),
        encoder_path: required_file(kws_binding, "encoder-int8")?.path().clone(),
        decoder_file_id: "decoder".to_owned(),
        decoder_path: required_file(kws_binding, "decoder")?.path().clone(),
        joiner_file_id: "joiner-int8".to_owned(),
        joiner_path: required_file(kws_binding, "joiner-int8")?.path().clone(),
        tokens_file_id: "tokens".to_owned(),
        tokens_path: required_file(kws_binding, "tokens")?.path().clone(),
    };
    let phrase_set = SherpaKwsPhraseSet::new(
        kws_binding.runtime_revision().to_owned(),
        [SherpaKwsPhrase::new("wake.main", "AURORA", "AURORA")
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?],
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let kws = IosWakeKws::new(kws_task.clone(), phrase_set, kws_files)
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
    runtime
        .with_wake_providers(Box::new(vad), Box::new(kws), wake_config)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)
}

#[cfg(feature = "ios-sherpa")]
fn build_local_ios_stt(
    binding: &IosVoicePackBinding,
) -> Result<IosFiniteSttProvider, IosVoiceSessionCommandError> {
    let task = task_pack_binding(binding, VoiceTask::SpeechToText)?;
    let decoder = stt_decoder_file(binding)?;
    let files = NativeSttModelFiles {
        encoder_file_id: "encoder".to_owned(),
        encoder_path: required_file(binding, "encoder")?.path().clone(),
        decoder_file_id: decoder.file_id().to_owned(),
        decoder_path: decoder.path().clone(),
        tokens_file_id: "tokens".to_owned(),
        tokens_path: required_file(binding, "tokens")?.path().clone(),
        language: Some(binding.language().to_owned()),
    };
    let backend = NativeSttBackend::from_selected_model_files(&task, files)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let provider = SherpaFiniteSttEngine::new(task, backend)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    Ok(IosFiniteSttProvider::Local(provider))
}

#[cfg(feature = "ios-sherpa")]
fn build_local_ios_tts(
    binding: &IosVoicePackBinding,
) -> Result<IosTtsProvider, IosVoiceSessionCommandError> {
    let task = task_pack_binding(binding, VoiceTask::TextToSpeech)?;
    let backend = match task.catalog_model_family() {
        Some("vits_piper") => {
            let files = NativeTtsVitsPiperModelFiles {
                model_file_id: "model".to_owned(),
                model_path: required_file(binding, "model")?.path().clone(),
                tokens_file_id: "tokens".to_owned(),
                tokens_path: required_file(binding, "tokens")?.path().clone(),
                espeak_data_file_id: "espeak-ng-data".to_owned(),
                espeak_data_dir: required_file(binding, "espeak-ng-data")?.path().clone(),
                lexicon_file_id: optional_file(binding, "lexicon")
                    .map(|file| file.file_id().to_owned()),
                lexicon_path: optional_file(binding, "lexicon").map(|file| file.path().clone()),
            };
            NativeTtsBackend::from_catalog_vits_piper_model(&task, files)
        }
        Some("pockettts") => {
            let reference_audio_required = ios_pockettts_requires_user_profile(binding);
            let (reference_audio, reference_text) = if reference_audio_required {
                let reference = binding
                    .tts_reference()
                    .ok_or(IosVoiceSessionCommandError::Unavailable)?;
                (
                    Some(load_ios_tts_reference_audio(reference)?),
                    reference.reference_text_for_sherpa().map(str::to_owned),
                )
            } else {
                (None, None)
            };
            let files = NativeTtsPocketModelFiles {
                lm_flow_file_id: "lm-flow".to_owned(),
                lm_flow_path: required_file(binding, "lm-flow")?.path().clone(),
                lm_main_file_id: "lm-main".to_owned(),
                lm_main_path: required_file(binding, "lm-main")?.path().clone(),
                encoder_file_id: "encoder".to_owned(),
                encoder_path: required_file(binding, "encoder")?.path().clone(),
                decoder_file_id: "decoder".to_owned(),
                decoder_path: required_file(binding, "decoder")?.path().clone(),
                text_conditioner_file_id: "text-conditioner".to_owned(),
                text_conditioner_path: required_file(binding, "text-conditioner")?.path().clone(),
                vocab_file_id: "vocab".to_owned(),
                vocab_path: required_file(binding, "vocab")?.path().clone(),
                token_scores_file_id: "token-scores".to_owned(),
                token_scores_path: required_file(binding, "token-scores")?.path().clone(),
                reference_audio,
                reference_text,
                reference_audio_required,
            };
            NativeTtsBackend::from_catalog_pockettts_model(&task, files)
        }
        _ => Err(EngineError::InvalidRequest),
    }
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let provider = SherpaTtsProvider::new(task, backend)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    Ok(IosTtsProvider::Local(provider))
}

#[cfg(feature = "ios-sherpa")]
static NEXT_IOS_WAKE_PROVIDER_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(feature = "ios-sherpa")]
thread_local! {
    static IOS_WAKE_VAD_PROVIDERS: RefCell<BTreeMap<u64, SherpaVadProvider<NativeVadBackend>>> =
        const { RefCell::new(BTreeMap::new()) };
    static IOS_WAKE_KWS_PROVIDERS: RefCell<BTreeMap<u64, SherpaKwsProvider<NativeKwsBackend>>> =
        const { RefCell::new(BTreeMap::new()) };
}

#[cfg(feature = "ios-sherpa")]
fn next_ios_wake_provider_id() -> u64 {
    NEXT_IOS_WAKE_PROVIDER_ID.fetch_add(1, Ordering::Relaxed)
}

#[cfg(feature = "ios-sherpa")]
struct IosWakeVad {
    id: u64,
    binding: TaskPackBinding,
    model_file_id: String,
    model_path: PathBuf,
    config: VadConfig,
}

#[cfg(feature = "ios-sherpa")]
impl IosWakeVad {
    fn new(
        binding: TaskPackBinding,
        model_file_id: String,
        model_path: PathBuf,
        config: VadConfig,
    ) -> Result<Self, EngineError> {
        config.validate_binding(&binding)?;
        Ok(Self {
            id: next_ios_wake_provider_id(),
            binding,
            model_file_id,
            model_path,
            config,
        })
    }

    fn build_provider(&self) -> Result<SherpaVadProvider<NativeVadBackend>, EngineError> {
        let backend = NativeVadBackend::from_selected_model(
            &self.binding,
            &self.model_file_id,
            self.model_path.clone(),
            &self.config,
        )?;
        SherpaVadProvider::new(self.binding.clone(), backend)
    }

    fn take_provider(&self) -> Result<SherpaVadProvider<NativeVadBackend>, EngineError> {
        IOS_WAKE_VAD_PROVIDERS.with(|providers| {
            providers
                .borrow_mut()
                .remove(&self.id)
                .map(Ok)
                .unwrap_or_else(|| self.build_provider())
        })
    }

    fn put_provider(&self, provider: SherpaVadProvider<NativeVadBackend>) {
        IOS_WAKE_VAD_PROVIDERS.with(|providers| {
            providers.borrow_mut().insert(self.id, provider);
        });
    }
}

#[cfg(feature = "ios-sherpa")]
impl Drop for IosWakeVad {
    fn drop(&mut self) {
        IOS_WAKE_VAD_PROVIDERS.with(|providers| {
            providers.borrow_mut().remove(&self.id);
        });
    }
}

#[cfg(feature = "ios-sherpa")]
#[async_trait(?Send)]
impl TaskProvider for IosWakeVad {
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![TaskCapability::new(self.binding.clone()).streaming(true)]
    }

    fn resource_report(&self) -> ResourceReport {
        ResourceReport {
            loaded_tasks: vec![VoiceTask::VoiceActivityDetection],
            memory_bytes: self.binding.resource_budget().max_memory_bytes,
            active_streams: 0,
            readiness: TaskReadiness::Ready,
        }
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.warm_task(request).await;
        self.put_provider(provider);
        result
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.unload_task(binding).await;
        self.put_provider(provider);
        result
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.cancel_generation(generation).await;
        self.put_provider(provider);
        result
    }
}

#[cfg(feature = "ios-sherpa")]
#[async_trait(?Send)]
impl VadStreamProvider for IosWakeVad {
    async fn start_vad_session(
        &mut self,
        request: BoundVadRequest,
    ) -> Result<BoundStreamSession, EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.start_vad_session(request).await;
        self.put_provider(provider);
        result
    }

    async fn push_vad_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<VadAcceptResult, EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.push_vad_frame(session, frame, cancellation).await;
        self.put_provider(provider);
        result
    }

    async fn flush_vad_session(
        &mut self,
        session: &BoundStreamSession,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<SpeechSegment>, EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.flush_vad_session(session, cancellation).await;
        self.put_provider(provider);
        result
    }

    async fn reset_vad_session(
        &mut self,
        session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.reset_vad_session(session, reason).await;
        self.put_provider(provider);
        result
    }
}

#[cfg(feature = "ios-sherpa")]
struct IosWakeKwsFiles {
    encoder_file_id: String,
    encoder_path: PathBuf,
    decoder_file_id: String,
    decoder_path: PathBuf,
    joiner_file_id: String,
    joiner_path: PathBuf,
    tokens_file_id: String,
    tokens_path: PathBuf,
}

#[cfg(feature = "ios-sherpa")]
struct IosWakeKws {
    id: u64,
    binding: TaskPackBinding,
    phrase_set: SherpaKwsPhraseSet,
    files: IosWakeKwsFiles,
}

#[cfg(feature = "ios-sherpa")]
impl IosWakeKws {
    fn new(
        binding: TaskPackBinding,
        phrase_set: SherpaKwsPhraseSet,
        files: IosWakeKwsFiles,
    ) -> Result<Self, EngineError> {
        phrase_set.validate_request(&KwsConfig::new(
            ["wake.main"],
            phrase_set.revision(),
            0.5,
            2,
            1,
        )?)?;
        Ok(Self {
            id: next_ios_wake_provider_id(),
            binding,
            phrase_set,
            files,
        })
    }

    fn build_provider(&self) -> Result<SherpaKwsProvider<NativeKwsBackend>, EngineError> {
        let backend = NativeKwsBackend::from_selected_model(
            &self.binding,
            NativeKwsModelFiles {
                encoder_file_id: self.files.encoder_file_id.clone(),
                encoder_path: self.files.encoder_path.clone(),
                decoder_file_id: self.files.decoder_file_id.clone(),
                decoder_path: self.files.decoder_path.clone(),
                joiner_file_id: self.files.joiner_file_id.clone(),
                joiner_path: self.files.joiner_path.clone(),
                tokens_file_id: self.files.tokens_file_id.clone(),
                tokens_path: self.files.tokens_path.clone(),
            },
        )?;
        SherpaKwsProvider::new(self.binding.clone(), self.phrase_set.clone(), backend)
    }

    fn take_provider(&self) -> Result<SherpaKwsProvider<NativeKwsBackend>, EngineError> {
        IOS_WAKE_KWS_PROVIDERS.with(|providers| {
            providers
                .borrow_mut()
                .remove(&self.id)
                .map(Ok)
                .unwrap_or_else(|| self.build_provider())
        })
    }

    fn put_provider(&self, provider: SherpaKwsProvider<NativeKwsBackend>) {
        IOS_WAKE_KWS_PROVIDERS.with(|providers| {
            providers.borrow_mut().insert(self.id, provider);
        });
    }
}

#[cfg(feature = "ios-sherpa")]
impl Drop for IosWakeKws {
    fn drop(&mut self) {
        IOS_WAKE_KWS_PROVIDERS.with(|providers| {
            providers.borrow_mut().remove(&self.id);
        });
    }
}

#[cfg(feature = "ios-sherpa")]
#[async_trait(?Send)]
impl TaskProvider for IosWakeKws {
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![TaskCapability::new(self.binding.clone()).streaming(true)]
    }

    fn resource_report(&self) -> ResourceReport {
        ResourceReport {
            loaded_tasks: vec![VoiceTask::KeywordSpotting],
            memory_bytes: self.binding.resource_budget().max_memory_bytes,
            active_streams: 0,
            readiness: TaskReadiness::Ready,
        }
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.warm_task(request).await;
        self.put_provider(provider);
        result
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.unload_task(binding).await;
        self.put_provider(provider);
        result
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.cancel_generation(generation).await;
        self.put_provider(provider);
        result
    }
}

#[cfg(feature = "ios-sherpa")]
#[async_trait(?Send)]
impl KwsStreamProvider for IosWakeKws {
    async fn start_kws_session(
        &mut self,
        request: BoundKwsRequest,
    ) -> Result<BoundStreamSession, EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.start_kws_session(request).await;
        self.put_provider(provider);
        result
    }

    async fn push_kws_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<KwsFrameResult, EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.push_kws_frame(session, frame, cancellation).await;
        self.put_provider(provider);
        result
    }

    async fn reset_kws_session(
        &mut self,
        session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        let mut provider = self.take_provider()?;
        let result = provider.reset_kws_session(session, reason).await;
        self.put_provider(provider);
        result
    }
}

fn gateway_limits(policy: MicrophoneAudioPolicy) -> TransportLimits {
    TransportLimits {
        max_request_bytes: 2 * 1024 * 1024,
        max_response_bytes: 8 * 1024 * 1024,
        max_event_bytes: 2 * 1024 * 1024,
        request_timeout: REQUEST_TIMEOUT,
        stream_idle_timeout: STREAM_IDLE_TIMEOUT,
        allow_loopback_http: matches!(policy, MicrophoneAudioPolicy::LoopbackOnly),
        microphone_audio_policy: policy,
    }
}

fn build_gateway_ios_stt(
    config: &IosVoiceSessionConfig,
    policy: MicrophoneAudioPolicy,
) -> Result<IosFiniteSttProvider, IosVoiceSessionCommandError> {
    let route = RouteFiniteSttBinding::new(
        "gateway.default",
        if matches!(policy, MicrophoneAudioPolicy::LoopbackOnly) {
            FiniteSttRouteScope::LoopbackSidecar
        } else {
            FiniteSttRouteScope::RemoteGateway
        },
        VAD_SAMPLE_RATE_HZ,
        MAX_FINITE_STT_SAMPLES.min(16_000 * 30),
        ROUTE_REVISION,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let transport = NativeGatewayTransport::new(
        config.gateway.clone(),
        config.auth.clone(),
        gateway_limits(policy),
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let provider = NativeGatewayFiniteStt::new(
        transport,
        NativeGatewayFiniteSttConfig::realtime(route, policy)
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    #[cfg(feature = "ios-sherpa")]
    return Ok(IosFiniteSttProvider::Gateway(provider));
    #[cfg(not(feature = "ios-sherpa"))]
    Ok(provider)
}

fn build_gateway_ios_tts(
    config: &IosVoiceSessionConfig,
    policy: MicrophoneAudioPolicy,
) -> Result<IosTtsProvider, IosVoiceSessionCommandError> {
    let route = RouteTtsBinding::new(
        "gateway.default",
        "voice.default",
        VAD_SAMPLE_RATE_HZ,
        ROUTE_REVISION,
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let transport = NativeGatewayTransport::new(
        config.gateway.clone(),
        config.auth.clone(),
        gateway_limits(policy),
    )
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let provider = NativeGatewayTtsSynthesizer::new(
        transport,
        NativeGatewayTtsConfig::new(route, None, 1.0, 16_000 * 30)
            .map_err(|_| IosVoiceSessionCommandError::Unavailable)?,
    );
    #[cfg(feature = "ios-sherpa")]
    return Ok(IosTtsProvider::Gateway(provider));
    #[cfg(not(feature = "ios-sherpa"))]
    Ok(provider)
}

fn build_gateway_runtime(
    config: &IosVoiceSessionConfig,
    input: AuroraIosAudioInput,
    output: AuroraIosAudioOutput,
    sink: IosSessionSink,
) -> Result<RuntimeCore, IosVoiceSessionCommandError> {
    let policy = microphone_policy(config)?;
    let stt = build_gateway_ios_stt(config, policy)?;
    let tts = build_gateway_ios_tts(config, policy)?;
    let transport_for_assistant = NativeGatewayTransport::new(
        config.gateway.clone(),
        config.auth.clone(),
        gateway_limits(policy),
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
    .map_err(|_| IosVoiceSessionCommandError::Unavailable)
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
    let has_vad = verified.contains_key(&PackTask::Vad);
    let has_kws =
        verified.contains_key(&PackTask::Kws) || verified.contains_key(&PackTask::Wakeword);
    if has_vad != has_kws {
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
    if binding.model_family() == "pockettts" {
        if ios_pockettts_requires_user_profile(binding) {
            verify_ios_tts_reference_binding(
                binding
                    .tts_reference()
                    .ok_or(IosVoiceSessionCommandError::Unavailable)?,
            )?;
        } else {
            for file_id in ["pocket-protocol", "bos-before-voice", "fixed-voice-state"] {
                verify_ios_pack_file_binding(required_file(binding, file_id)?)?;
            }
        }
    } else if binding.tts_reference().is_some() {
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

fn ios_pockettts_requires_user_profile(binding: &IosVoicePackBinding) -> bool {
    if let Ok(catalog) = TtsVoiceCatalog::runtime() {
        if let Some(entry) = catalog.voice(binding.pack_id()) {
            return entry.requires_reference_profile();
        }
    }
    !ios_pockettts_has_fixed_voice_state(binding)
}

fn ios_pockettts_has_fixed_voice_state(binding: &IosVoicePackBinding) -> bool {
    binding
        .files()
        .iter()
        .any(|file| file.file_id() == "fixed-voice-state")
}

#[cfg_attr(not(feature = "ios-sherpa"), allow(dead_code))]
fn required_file<'a>(
    binding: &'a IosVoicePackBinding,
    file_id: &str,
) -> Result<&'a IosVoicePackFileBinding, IosVoiceSessionCommandError> {
    optional_file(binding, file_id).ok_or(IosVoiceSessionCommandError::Unavailable)
}

#[cfg_attr(not(feature = "ios-sherpa"), allow(dead_code))]
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
        binding.model_family().to_owned(),
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

#[cfg(feature = "ios-sherpa")]
fn load_ios_tts_reference_audio(
    binding: &IosTtsReferenceBinding,
) -> Result<NativeTtsReferenceAudio, IosVoiceSessionCommandError> {
    verify_ios_tts_reference_binding(binding)?;
    let bytes =
        fs::read(binding.audio_path()).map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    let samples = parse_pcm16_mono_reference_wav(
        &bytes,
        binding.sample_rate_hz(),
        MAX_IOS_REFERENCE_AUDIO_SAMPLES,
    )?;
    NativeTtsReferenceAudio::new(binding.sample_rate_hz() as i32, samples)
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)
}

fn verify_ios_tts_reference_binding(
    binding: &IosTtsReferenceBinding,
) -> Result<(), IosVoiceSessionCommandError> {
    let metadata = fs::symlink_metadata(binding.audio_path())
        .map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() != binding.expected_size_bytes()
        || metadata.len() > MAX_IOS_REFERENCE_AUDIO_BYTES
        || binding.revision().is_empty()
    {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let digest =
        sha256_path(binding.audio_path()).map_err(|_| IosVoiceSessionCommandError::Unavailable)?;
    if digest != binding.expected_sha256() {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    Ok(())
}

#[cfg(feature = "ios-sherpa")]
fn parse_pcm16_mono_reference_wav(
    bytes: &[u8],
    sample_rate_hz: u32,
    max_samples: usize,
) -> Result<Vec<f32>, IosVoiceSessionCommandError> {
    if bytes.len() < 44 || bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let declared_len = read_u32_le(bytes, 4)? as usize;
    if declared_len.checked_add(8) != Some(bytes.len()) {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let mut cursor = 12_usize;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data_range = None;
    while cursor.checked_add(8).is_some_and(|end| end <= bytes.len()) {
        let chunk_id = &bytes[cursor..cursor + 4];
        let chunk_len = read_u32_le(bytes, cursor + 4)? as usize;
        let data_start = cursor
            .checked_add(8)
            .ok_or(IosVoiceSessionCommandError::Unavailable)?;
        let data_end = data_start
            .checked_add(chunk_len)
            .ok_or(IosVoiceSessionCommandError::Unavailable)?;
        if data_end > bytes.len() {
            return Err(IosVoiceSessionCommandError::Unavailable);
        }
        match chunk_id {
            b"fmt " => {
                if chunk_len < 16 || format.is_some() {
                    return Err(IosVoiceSessionCommandError::Unavailable);
                }
                format = Some((
                    read_u16_le(bytes, data_start)?,
                    read_u16_le(bytes, data_start + 2)?,
                    read_u32_le(bytes, data_start + 4)?,
                    read_u16_le(bytes, data_start + 14)?,
                ));
            }
            b"data" => {
                if data_range.is_some() || chunk_len == 0 || !chunk_len.is_multiple_of(2) {
                    return Err(IosVoiceSessionCommandError::Unavailable);
                }
                data_range = Some(data_start..data_end);
            }
            _ => {}
        }
        let padded_len = chunk_len
            .checked_add(chunk_len % 2)
            .ok_or(IosVoiceSessionCommandError::Unavailable)?;
        cursor = data_start
            .checked_add(padded_len)
            .ok_or(IosVoiceSessionCommandError::Unavailable)?;
    }
    let Some((format_tag, channels, declared_sample_rate, bits_per_sample)) = format else {
        return Err(IosVoiceSessionCommandError::Unavailable);
    };
    if format_tag != 1
        || channels != 1
        || declared_sample_rate != sample_rate_hz
        || bits_per_sample != 16
    {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    let Some(range) = data_range else {
        return Err(IosVoiceSessionCommandError::Unavailable);
    };
    let sample_count = range.len() / 2;
    if sample_count == 0 || sample_count > max_samples {
        return Err(IosVoiceSessionCommandError::Unavailable);
    }
    Ok(bytes[range]
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32)
        .collect())
}

#[cfg(feature = "ios-sherpa")]
fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16, IosVoiceSessionCommandError> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or(IosVoiceSessionCommandError::Unavailable)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

#[cfg(feature = "ios-sherpa")]
fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, IosVoiceSessionCommandError> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or(IosVoiceSessionCommandError::Unavailable)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
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

struct SessionThreadInputs {
    config: IosVoiceSessionConfig,
    input: AuroraIosAudioInput,
    output: AuroraIosAudioOutput,
    sink: IosSessionSink,
    commands: tokio_mpsc::UnboundedReceiver<Command>,
    ready: mpsc::Sender<Result<(), IosVoiceSessionCommandError>>,
    status: Arc<Mutex<IosVoiceSessionStatus>>,
    control: AuroraIosCaptureControl,
    lifecycle: MobileSessionLifecycle,
}

fn run_session_thread(inputs: SessionThreadInputs) {
    run_session_thread_with_builder(inputs, build_runtime);
}

fn run_session_thread_with_builder(
    inputs: SessionThreadInputs,
    build: impl FnOnce(
        &IosVoiceSessionConfig,
        AuroraIosAudioInput,
        AuroraIosAudioOutput,
        IosSessionSink,
    ) -> Result<RuntimeCore, IosVoiceSessionCommandError>,
) {
    let SessionThreadInputs {
        config,
        input,
        output,
        sink,
        commands,
        ready,
        status,
        control,
        lifecycle,
    } = inputs;
    let remote_audio_consent = config.remote_audio_consent;
    let tokio_runtime = match TokioRuntimeBuilder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            lifecycle.record_failure(MobileSessionCloseError::Unavailable);
            set_fault(&status, "runtime_unavailable");
            let _ = ready.send(Err(IosVoiceSessionCommandError::Unavailable));
            return;
        }
    };
    let voice_runtime = match build(&config, input, output, sink) {
        Ok(runtime) => runtime,
        Err(error) => {
            lifecycle.record_failure(MobileSessionCloseError::Unavailable);
            set_fault(&status, "runtime_unavailable");
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    tokio_runtime.block_on(run_session_loop(
        voice_runtime,
        commands,
        status,
        control,
        lifecycle,
        remote_audio_consent,
    ));
}

async fn run_session_loop<R: IosSessionRuntime>(
    mut voice_runtime: R,
    mut commands: tokio_mpsc::UnboundedReceiver<Command>,
    status: Arc<Mutex<IosVoiceSessionStatus>>,
    control: AuroraIosCaptureControl,
    lifecycle: MobileSessionLifecycle,
    remote_audio_consent: bool,
) {
    loop {
        if lifecycle.is_retired() {
            reject_queued_commands(&mut commands);
            break;
        }
        let Some(command) = commands.recv().await else {
            if let Some(generation) = lifecycle.unexpected_channel_close() {
                control.interrupt(generation);
            }
            break;
        };
        match command {
            Command::Start { mode, reply } => {
                if lifecycle.is_retired() {
                    let _ = reply.send(Err(IosVoiceSessionCommandError::Unavailable));
                    continue;
                }
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
                if lifecycle
                    .begin_generation(generation, cancellation.clone())
                    .is_err()
                {
                    let _ = reply.send(Err(IosVoiceSessionCommandError::Unavailable));
                    continue;
                }
                set_active(&status, generation);
                let _ = reply.send(Ok(generation));
                let mut transcript_reply = None;
                let result = run_turn(
                    &mut voice_runtime,
                    &mut commands,
                    &mut transcript_reply,
                    IosTurnContext {
                        mode,
                        lease,
                        at: now,
                        cancellation,
                        control: control.clone(),
                        lifecycle: lifecycle.clone(),
                    },
                )
                .await;
                lifecycle.record_cleanup(
                    generation,
                    voice_runtime.cleanup_report_for_generation(generation),
                );
                finish_status(&status, &result);
                if let Some(reply) = transcript_reply {
                    let transcript_result =
                        result.map_err(|_| IosVoiceSessionCommandError::Unavailable);
                    let _ = reply.send(transcript_result);
                }
                if lifecycle.is_retired() {
                    reject_queued_commands(&mut commands);
                    break;
                }
            }
            Command::Shutdown => {
                if let Some(generation) = lifecycle.worker_retire() {
                    control.interrupt(generation);
                }
                reject_queued_commands(&mut commands);
                break;
            }
            Command::Finish { reply, .. } | Command::Cancel { reply, .. } => {
                let _ = reply.send(Err(IosVoiceSessionCommandError::NotActive));
            }
            Command::FinishWithTranscript { reply, .. } => {
                let _ = reply.send(Err(IosVoiceSessionCommandError::NotActive));
            }
        }
    }
}

struct IosTurnContext {
    mode: IosVoiceStartMode,
    lease: VoiceCaptureLease,
    at: TimestampMicros,
    cancellation: CancellationToken,
    control: AuroraIosCaptureControl,
    lifecycle: MobileSessionLifecycle,
}

async fn run_turn<'a, R: IosSessionRuntime>(
    runtime: &'a mut R,
    commands: &'a mut tokio_mpsc::UnboundedReceiver<Command>,
    transcript_reply: &'a mut Option<mpsc::Sender<Result<String, IosVoiceSessionCommandError>>>,
    context: IosTurnContext,
) -> Result<String, VoiceCoreError> {
    let IosTurnContext {
        mode,
        lease,
        at,
        cancellation,
        control,
        lifecycle,
    } = context;
    let generation = lease.generation;
    let mut turn = runtime.invoke_turn(mode, lease, at, cancellation.clone());
    let mut retiring = false;
    loop {
        tokio::select! {
            result = &mut turn => return result,
            command = commands.recv(), if !retiring => {
                match command {
                    Some(Command::Finish { generation: requested, reply }) if requested == generation => {
                        control.finish(generation);
                        let _ = reply.send(Ok(()));
                    }
                    Some(Command::FinishWithTranscript { generation: requested, reply })
                        if requested == generation && mode == IosVoiceStartMode::PushToTalk =>
                    {
                        if transcript_reply.is_some() {
                            let _ = reply.send(Err(IosVoiceSessionCommandError::NotActive));
                        } else {
                            control.finish(generation);
                            *transcript_reply = Some(reply);
                        }
                    }
                    Some(Command::Cancel { generation: requested, reply }) if requested == generation => {
                        cancellation.cancel();
                        control.interrupt(generation);
                        let _ = reply.send(Ok(()));
                    }
                    Some(Command::Finish { reply, .. }) | Some(Command::Cancel { reply, .. }) => {
                        let _ = reply.send(Err(IosVoiceSessionCommandError::NotActive));
                    }
                    Some(Command::FinishWithTranscript { reply, .. }) => {
                        let _ = reply.send(Err(IosVoiceSessionCommandError::NotActive));
                    }
                    Some(Command::Start { reply, .. }) => {
                        let _ = reply.send(Err(IosVoiceSessionCommandError::AlreadyActive));
                    }
                    Some(Command::Shutdown) => {
                        lifecycle.worker_retire();
                        cancellation.cancel();
                        control.interrupt(generation);
                        retiring = true;
                    }
                    None => {
                        lifecycle.unexpected_channel_close();
                        cancellation.cancel();
                        control.interrupt(generation);
                        retiring = true;
                    }
                }
            }
        }
    }
}

fn reject_queued_commands(commands: &mut tokio_mpsc::UnboundedReceiver<Command>) {
    while let Ok(command) = commands.try_recv() {
        match command {
            Command::Start { reply, .. } => {
                let _ = reply.send(Err(IosVoiceSessionCommandError::Unavailable));
            }
            Command::Finish { reply, .. } | Command::Cancel { reply, .. } => {
                let _ = reply.send(Err(IosVoiceSessionCommandError::Closed));
            }
            Command::FinishWithTranscript { reply, .. } => {
                let _ = reply.send(Err(IosVoiceSessionCommandError::Closed));
            }
            Command::Shutdown => {}
        }
    }
}

#[derive(Clone)]
struct IosSessionSink {
    status: Arc<Mutex<IosVoiceSessionStatus>>,
}

#[async_trait(?Send)]
impl RuntimeEventSink for IosSessionSink {
    fn wants_speech_lifecycle(&self) -> bool {
        native_speech_lifecycle_observer_enabled()
    }

    fn speech_lifecycle_callback(
        &self,
    ) -> Option<Arc<dyn Fn(SpeechLifecycleEventV1) + Send + Sync>> {
        if !native_speech_lifecycle_observer_enabled() {
            return None;
        }
        let callback: Arc<dyn Fn(SpeechLifecycleEventV1) + Send + Sync> =
            Arc::new(emit_native_speech_lifecycle);
        Some(callback)
    }

    fn speech_lifecycle(&mut self, event: SpeechLifecycleEventV1) {
        emit_native_speech_lifecycle(event);
    }

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

fn finish_status(
    status: &Arc<Mutex<IosVoiceSessionStatus>>,
    result: &Result<String, VoiceCoreError>,
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
                status.last_error = Some(error_code(error).to_owned());
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
    use aurora_voice_core::{AudioPlaybackContext, AudioPlaybackReceipt};
    use aurora_voice_engine::{
        BoundFiniteSttRequest, BoundTtsSynthesisRequest, EngineError, FiniteSttAudio,
        FiniteSttResult, FiniteSttRouteScope, RouteFiniteSttBinding, RouteTtsBinding,
        TtsSynthesisResult, MAX_FINITE_STT_SAMPLES, VAD_SAMPLE_RATE_HZ,
    };
    use std::sync::mpsc;
    use std::task::{Context, Poll, Wake, Waker};

    struct CloseTestAudioInput {
        started: Option<mpsc::Sender<()>>,
        start_entered: Option<mpsc::Sender<()>>,
        release_start: Option<tokio::sync::oneshot::Receiver<()>>,
        stop_entered: Option<mpsc::Sender<()>>,
        release_stop: Option<tokio::sync::oneshot::Receiver<()>>,
    }

    struct ReportTestAudioInput {
        started: mpsc::Sender<Generation>,
        fail_first_stop: Arc<std::sync::atomic::AtomicBool>,
        generation: Option<Generation>,
        frame_pending: bool,
    }

    #[async_trait(?Send)]
    impl AudioInput for ReportTestAudioInput {
        async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
            self.generation = Some(lease.generation);
            self.frame_pending = true;
            let _ = self.started.send(lease.generation);
            Ok(())
        }

        async fn stop(
            &mut self,
            _reason: aurora_voice_core::TransitionReason,
        ) -> Result<(), VoiceCoreError> {
            if self
                .fail_first_stop
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                Err(VoiceCoreError::TransportFault {
                    code: "report_test_capture_stop_failed".to_owned(),
                })
            } else {
                Ok(())
            }
        }

        async fn next_frame(
            &mut self,
        ) -> Result<Option<aurora_voice_core::PcmFrame>, VoiceCoreError> {
            if !std::mem::take(&mut self.frame_pending) {
                return Ok(None);
            }
            let generation = self.generation.ok_or(VoiceCoreError::InvalidTransition)?;
            Ok(Some(
                aurora_voice_core::PcmFrame::new(
                    vec![0.1, -0.1],
                    TimestampMicros(generation.0),
                    1,
                    false,
                    RouteRevision(ROUTE_REVISION),
                    generation,
                )
                .map_err(|_| VoiceCoreError::InvalidTransition)?,
            ))
        }

        fn current_route_revision(&self) -> RouteRevision {
            RouteRevision(ROUTE_REVISION)
        }
    }

    struct SuccessfulReportTestStt;

    #[async_trait(?Send)]
    impl FiniteSttPort for SuccessfulReportTestStt {
        fn finite_stt_binding(
            &self,
        ) -> Result<aurora_voice_engine::FiniteSttProviderBinding, EngineError> {
            Ok(aurora_voice_engine::FiniteSttProviderBinding::Route(
                RouteFiniteSttBinding::new(
                    "route.stt.ios-cleanup-report-success",
                    FiniteSttRouteScope::LoopbackSidecar,
                    VAD_SAMPLE_RATE_HZ,
                    MAX_FINITE_STT_SAMPLES,
                    ROUTE_REVISION,
                )?,
            ))
        }

        async fn warm_finite_stt(
            &mut self,
            _binding: aurora_voice_engine::FiniteSttProviderBinding,
        ) -> Result<(), EngineError> {
            Ok(())
        }

        async fn transcribe_finite(
            &mut self,
            request: BoundFiniteSttRequest,
            audio: FiniteSttAudio,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<FiniteSttResult, EngineError> {
            FiniteSttResult::new(&request, &audio, "recognized")
        }

        async fn cancel_finite_stt_generation(
            &mut self,
            _generation: u64,
        ) -> Result<(), EngineError> {
            Ok(())
        }
    }

    struct SuccessfulReportTestTransport;

    #[async_trait(?Send)]
    impl SpeechTransport for SuccessfulReportTestTransport {
        async fn assistant_turn(
            &mut self,
            _request: aurora_voice_core::AssistantTurnRequest,
            cancellation: CancellationToken,
        ) -> Result<aurora_voice_core::AssistantTurnResponse, VoiceCoreError> {
            cancellation.check()?;
            Ok(aurora_voice_core::AssistantTurnResponse {
                text: "A controlled reply.".to_owned(),
                session_id: None,
                request_id: None,
                correlation_id: None,
            })
        }

        async fn cancel_session(&mut self, _generation: Generation) -> Result<(), VoiceCoreError> {
            Ok(())
        }
    }

    struct SuccessfulReportTestTts;

    #[async_trait(?Send)]
    impl TtsSynthesisPort for SuccessfulReportTestTts {
        fn synthesis_binding(
            &self,
        ) -> Result<aurora_voice_engine::TtsSynthesisProviderBinding, EngineError> {
            Ok(aurora_voice_engine::TtsSynthesisProviderBinding::Route(
                RouteTtsBinding::new(
                    "route.tts.ios-cleanup-report-success",
                    "voice.ios-cleanup-report-success",
                    VAD_SAMPLE_RATE_HZ,
                    ROUTE_REVISION,
                )?,
            ))
        }

        async fn warm_synthesis(
            &mut self,
            _binding: aurora_voice_engine::TtsSynthesisProviderBinding,
        ) -> Result<(), EngineError> {
            Ok(())
        }

        async fn synthesize_text(
            &mut self,
            request: BoundTtsSynthesisRequest,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<TtsSynthesisResult, EngineError> {
            let chunk = aurora_voice_engine::TtsAudioChunk::new(
                &request,
                1,
                VAD_SAMPLE_RATE_HZ,
                1,
                vec![0; 64],
                true,
            )?;
            TtsSynthesisResult::new(&request, vec![chunk], false)
        }

        async fn cancel_synthesis_generation(
            &mut self,
            _generation: u64,
        ) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[async_trait(?Send)]
    impl AudioInput for CloseTestAudioInput {
        async fn start(&mut self, _lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
            if let Some(started) = self.started.as_ref() {
                let _ = started.send(());
            }
            if let Some(entered) = self.start_entered.take() {
                let _ = entered.send(());
            }
            if let Some(release) = self.release_start.take() {
                let _ = release.await;
            }
            Ok(())
        }

        async fn stop(
            &mut self,
            _reason: aurora_voice_core::TransitionReason,
        ) -> Result<(), VoiceCoreError> {
            if let Some(entered) = self.stop_entered.take() {
                let _ = entered.send(());
            }
            if let Some(release) = self.release_stop.take() {
                let _ = release.await;
            }
            Err(VoiceCoreError::TransportFault {
                code: "private_cleanup_failure".to_owned(),
            })
        }

        async fn next_frame(
            &mut self,
        ) -> Result<Option<aurora_voice_core::PcmFrame>, VoiceCoreError> {
            Ok(None)
        }

        fn current_route_revision(&self) -> RouteRevision {
            RouteRevision(ROUTE_REVISION)
        }
    }

    struct GatedIosAudioInput {
        inner: AuroraIosAudioInput,
        start_entered: Option<mpsc::Sender<()>>,
        release_start: Option<tokio::sync::oneshot::Receiver<()>>,
        stop_entered: Option<mpsc::Sender<()>>,
        release_stop: Option<tokio::sync::oneshot::Receiver<()>>,
    }

    #[async_trait(?Send)]
    impl AudioInput for GatedIosAudioInput {
        async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
            if let Some(entered) = self.start_entered.take() {
                let _ = entered.send(());
            }
            if let Some(release) = self.release_start.take() {
                let _ = release.await;
            }
            self.inner.start(lease).await
        }

        async fn stop(
            &mut self,
            reason: aurora_voice_core::TransitionReason,
        ) -> Result<(), VoiceCoreError> {
            if let Some(entered) = self.stop_entered.take() {
                let _ = entered.send(());
            }
            if let Some(release) = self.release_stop.take() {
                let _ = release.await;
            }
            self.inner.stop(reason).await
        }

        async fn next_frame(
            &mut self,
        ) -> Result<Option<aurora_voice_core::PcmFrame>, VoiceCoreError> {
            self.inner.next_frame().await
        }

        fn current_route_revision(&self) -> RouteRevision {
            self.inner.current_route_revision()
        }
    }

    struct CloseTestEngine;

    #[async_trait(?Send)]
    impl FiniteSttPort for CloseTestEngine {
        fn finite_stt_binding(
            &self,
        ) -> Result<aurora_voice_engine::FiniteSttProviderBinding, EngineError> {
            Ok(aurora_voice_engine::FiniteSttProviderBinding::Route(
                RouteFiniteSttBinding::new(
                    "route.stt.close-test",
                    FiniteSttRouteScope::LoopbackSidecar,
                    VAD_SAMPLE_RATE_HZ,
                    MAX_FINITE_STT_SAMPLES,
                    ROUTE_REVISION,
                )?,
            ))
        }

        async fn warm_finite_stt(
            &mut self,
            _binding: aurora_voice_engine::FiniteSttProviderBinding,
        ) -> Result<(), EngineError> {
            Ok(())
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
            _generation: u64,
        ) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[async_trait(?Send)]
    impl TtsSynthesisPort for CloseTestEngine {
        fn synthesis_binding(
            &self,
        ) -> Result<aurora_voice_engine::TtsSynthesisProviderBinding, EngineError> {
            Ok(aurora_voice_engine::TtsSynthesisProviderBinding::Route(
                RouteTtsBinding::new(
                    "route.tts.close-test",
                    "voice.close-test",
                    VAD_SAMPLE_RATE_HZ,
                    ROUTE_REVISION,
                )?,
            ))
        }

        async fn warm_synthesis(
            &mut self,
            _binding: aurora_voice_engine::TtsSynthesisProviderBinding,
        ) -> Result<(), EngineError> {
            Ok(())
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

    struct CloseTestTransport;

    #[async_trait(?Send)]
    impl SpeechTransport for CloseTestTransport {
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

    struct CloseTestOutput;

    #[async_trait(?Send)]
    impl AudioOutput for CloseTestOutput {
        async fn play(
            &mut self,
            context: AudioPlaybackContext,
            _audio: TtsSynthesisResult,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<AudioPlaybackReceipt, VoiceCoreError> {
            Ok(AudioPlaybackReceipt::new(context, 0, 0, context.started_at))
        }

        async fn stop(
            &mut self,
            _generation: Generation,
            _reason: aurora_voice_core::TransitionReason,
        ) -> Result<(), VoiceCoreError> {
            Ok(())
        }
    }

    struct CloseTestSink;

    #[async_trait(?Send)]
    impl RuntimeEventSink for CloseTestSink {
        async fn snapshot(&mut self, _snapshot: RedactedSnapshot) -> Result<(), VoiceCoreError> {
            Ok(())
        }

        async fn event(&mut self, _event: RuntimeEvent) -> Result<(), VoiceCoreError> {
            Ok(())
        }
    }

    fn close_test_runtime(
        started: mpsc::Sender<()>,
        stop_entered: mpsc::Sender<()>,
        release_stop: tokio::sync::oneshot::Receiver<()>,
    ) -> VoiceRuntime<
        CloseTestAudioInput,
        CloseTestEngine,
        CloseTestEngine,
        CloseTestTransport,
        CloseTestOutput,
        CloseTestSink,
    > {
        VoiceRuntime::new(
            CloseTestAudioInput {
                started: Some(started),
                start_entered: None,
                release_start: None,
                stop_entered: Some(stop_entered),
                release_stop: Some(release_stop),
            },
            CloseTestEngine,
            CloseTestEngine,
            CloseTestTransport,
            CloseTestOutput,
            CloseTestSink,
            IOS_SURFACE,
            IOS_RUNTIME_ID,
        )
        .expect("real core runtime")
    }

    struct ReportTestSession {
        lifecycle: MobileSessionLifecycle,
        commands: tokio_mpsc::UnboundedSender<Command>,
        reports: mpsc::Receiver<(Generation, Option<aurora_voice_core::VoiceCleanupReport>)>,
        started: mpsc::Receiver<Generation>,
        status: Arc<Mutex<IosVoiceSessionStatus>>,
    }

    fn start_report_test_session(fail_first_stop: bool) -> ReportTestSession {
        let lifecycle = MobileSessionLifecycle::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (reports_tx, reports_rx) = mpsc::channel();
        lifecycle.set_after_cleanup_hook(move |generation, report| {
            reports_tx
                .send((generation, report))
                .expect("actual iOS loop reports cleanup");
        });
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let control = AuroraIosCaptureControl::default();
        let worker_status = Arc::clone(&status);
        let worker_control = control.clone();
        let worker_lifecycle = lifecycle.clone();
        let fail_first_stop = Arc::new(std::sync::atomic::AtomicBool::new(fail_first_stop));
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker = thread::spawn(move || {
            let core = VoiceRuntime::new(
                ReportTestAudioInput {
                    started: started_tx,
                    fail_first_stop,
                    generation: None,
                    frame_pending: false,
                },
                SuccessfulReportTestStt,
                SuccessfulReportTestTts,
                SuccessfulReportTestTransport,
                CloseTestOutput,
                CloseTestSink,
                IOS_SURFACE,
                IOS_RUNTIME_ID,
            )
            .expect("actual iOS core runtime");
            let tokio_runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            tokio_runtime.block_on(run_session_loop(
                core,
                command_rx,
                worker_status,
                worker_control,
                worker_lifecycle,
                false,
            ));
        });
        start_join_driver(&lifecycle, worker).expect("actual iOS worker join driver");
        ReportTestSession {
            lifecycle,
            commands,
            reports: reports_rx,
            started: started_rx,
            status,
        }
    }

    fn start_report_test_generation(session: &mut ReportTestSession) -> Generation {
        let (reply, response) = mpsc::channel();
        session
            .lifecycle
            .admit(|| {
                session
                    .commands
                    .send(Command::Start {
                        mode: IosVoiceStartMode::PushToTalk,
                        reply,
                    })
                    .is_ok()
            })
            .expect("actual iOS production start admitted");
        let generation = response
            .recv_timeout(Duration::from_secs(5))
            .expect("start response")
            .expect("generation");
        assert_eq!(
            session.started.recv_timeout(Duration::from_secs(5)),
            Ok(generation),
            "actual AudioInput::start ran for this generation"
        );
        generation
    }

    fn retire_report_test_session(
        session: &ReportTestSession,
    ) -> Result<(), MobileSessionCloseError> {
        assert_eq!(
            session
                .lifecycle
                .request_retirement(|| session.commands.send(Command::Shutdown).is_ok()),
            None,
            "the completed generation released its active binding"
        );
        session
            .lifecycle
            .close_checked_timeout(Duration::from_secs(5))
    }

    #[test]
    fn ios_cleanup_failure_stays_sticky_after_a_later_clean_generation() {
        let mut session = start_report_test_session(true);
        for (expected, expected_stop) in [
            (
                Generation(1),
                aurora_voice_core::CleanupCallbackOutcome::ReturnedError,
            ),
            (
                Generation(2),
                aurora_voice_core::CleanupCallbackOutcome::ReturnedOk,
            ),
        ] {
            assert_eq!(start_report_test_generation(&mut session), expected);
            let (reported, report) = session
                .reports
                .recv_timeout(Duration::from_secs(5))
                .expect("iOS production loop cleanup report");
            let report = report.expect("actual core cleanup report");
            assert_eq!(reported, expected);
            assert_eq!(report.generation(), expected);
            assert_eq!(report.capture_stop(), expected_stop);
            assert_eq!(
                report.state_reset(),
                aurora_voice_core::CleanupCallbackOutcome::NotAttempted
            );
        }
        assert_eq!(
            retire_report_test_session(&session),
            Err(MobileSessionCloseError::CleanupFailed),
            "the first actual cleanup failure remains sticky after generation two"
        );
    }

    #[test]
    fn ios_successful_primary_cleanup_accepts_unattempted_state_reset() {
        let mut session = start_report_test_session(false);
        assert_eq!(start_report_test_generation(&mut session), Generation(1));
        let (reported, report) = session
            .reports
            .recv_timeout(Duration::from_secs(5))
            .expect("successful iOS production loop cleanup report");
        let report = report.expect("actual core cleanup report");
        assert_eq!(reported, Generation(1));
        assert_eq!(report.generation(), Generation(1));
        assert_eq!(
            report.capture_stop(),
            aurora_voice_core::CleanupCallbackOutcome::ReturnedOk
        );
        assert_eq!(
            report.state_reset(),
            aurora_voice_core::CleanupCallbackOutcome::NotAttempted
        );
        assert_eq!(retire_report_test_session(&session), Ok(()));
        let status = session.status.lock().expect("iOS status after worker join");
        assert_eq!(status.completed_turns, 1);
        assert_eq!(status.failed_turns, 0);
    }

    #[test]
    fn ios_cleanup_created_final_error_retains_failure_with_unattempted_reset() {
        let mut session = start_report_test_session(true);
        assert_eq!(start_report_test_generation(&mut session), Generation(1));
        let (reported, report) = session
            .reports
            .recv_timeout(Duration::from_secs(5))
            .expect("failed iOS production loop cleanup report");
        let report = report.expect("actual core cleanup report");
        assert_eq!(reported, Generation(1));
        assert_eq!(
            report.capture_stop(),
            aurora_voice_core::CleanupCallbackOutcome::ReturnedError
        );
        assert_eq!(
            report.state_reset(),
            aurora_voice_core::CleanupCallbackOutcome::NotAttempted
        );
        assert_eq!(
            retire_report_test_session(&session),
            Err(MobileSessionCloseError::CleanupFailed)
        );
        assert_eq!(
            session
                .status
                .lock()
                .expect("iOS status after worker join")
                .failed_turns,
            1,
            "capture-stop failure becomes the final core error"
        );
    }

    struct CloseTestWake;

    impl Wake for CloseTestWake {
        fn wake(self: Arc<Self>) {}
    }

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
            "sherpa-onnx-1.13.5",
            "en-US",
            16_000,
            512,
            "whisper",
            None,
            vec![file.clone()],
        )
        .expect("binding");
        assert_eq!(binding.task(), PackTask::Stt);
        assert_eq!(binding.slot_id(), "default");
        assert_eq!(binding.pack_id(), "stt.en");
        assert_eq!(binding.expected_size_bytes(), 12);
        assert_eq!(binding.runtime_revision(), "sherpa-onnx-1.13.5");
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
            "sherpa-onnx-1.13.5",
            "en-US",
            16_000,
            512,
            "whisper",
            None,
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
    fn ios_session_accepts_pockettts_fixed_voice_state_without_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let binding = test_pack_binding_with_family(
            dir.path(),
            PackTask::Tts,
            "tts",
            &[
                "lm-flow",
                "lm-main",
                "encoder",
                "decoder",
                "text-conditioner",
                "vocab",
                "token-scores",
                "pocket-protocol",
                "bos-before-voice",
                "fixed-voice-state",
            ],
            "pockettts",
            None,
        );

        assert!(verify_ios_pack_binding(&binding).is_ok());
    }

    #[test]
    fn ios_session_honors_catalog_reference_mode_for_overlay_and_official() {
        let dir = tempfile::tempdir().expect("tempdir");
        let overlay = test_pack_binding_with_pack_id(
            dir.path(),
            "standard:pockettts:aurora-pockettts-en-2026-04",
            &[
                "lm-flow",
                "lm-main",
                "encoder",
                "decoder",
                "text-conditioner",
                "vocab",
                "token-scores",
                "pocket-protocol",
                "bos-before-voice",
                "fixed-voice-state",
            ],
            None,
        );
        let french = test_pack_binding_with_pack_id(
            dir.path(),
            "standard:pockettts:aurora-pockettts-fr-24l",
            &[
                "lm-flow",
                "lm-main",
                "encoder",
                "decoder",
                "text-conditioner",
                "vocab",
                "token-scores",
                "pocket-protocol",
                "bos-before-voice",
                "fixed-voice-state",
            ],
            None,
        );
        let official = test_pack_binding_with_pack_id(
            dir.path(),
            "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26",
            &[
                "lm-flow",
                "lm-main",
                "encoder",
                "decoder",
                "text-conditioner",
                "vocab",
                "token-scores",
            ],
            None,
        );
        assert!(verify_ios_pack_binding(&overlay).is_ok());
        assert!(verify_ios_pack_binding(&french).is_ok());
        assert!(matches!(
            verify_ios_pack_binding(&official),
            Err(IosVoiceSessionCommandError::Unavailable)
        ));
    }

    fn test_reference_sha256() -> String {
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned()
    }

    #[test]
    fn ios_tts_reference_binding_allows_empty_text() {
        let binding = IosTtsReferenceBinding::new(
            "/tmp/ref.wav",
            test_reference_sha256(),
            12,
            16_000,
            "",
            "rev-1",
        )
        .expect("audio-only binding");
        assert_eq!(binding.reference_text(), "");
        assert_eq!(binding.reference_text_for_sherpa(), None);

        let legacy = IosTtsReferenceBinding::new(
            "/tmp/ref.wav",
            test_reference_sha256(),
            12,
            16_000,
            "Hello Aurora",
            "rev-1",
        )
        .expect("legacy text binding");
        assert_eq!(legacy.reference_text(), "Hello Aurora");
        assert_eq!(legacy.reference_text_for_sherpa(), Some("Hello Aurora"));

        assert!(
            IosTtsReferenceBinding::new("", test_reference_sha256(), 12, 16_000, "", "rev-1",)
                .is_err()
        );
        assert!(IosTtsReferenceBinding::new(
            "/tmp/ref.wav",
            test_reference_sha256(),
            12,
            16_000,
            "",
            "",
        )
        .is_err());
        assert!(IosTtsReferenceBinding::new(
            "/tmp/ref.wav",
            test_reference_sha256(),
            0,
            16_000,
            "",
            "rev-1",
        )
        .is_err());
    }

    #[test]
    fn ios_session_accepts_official_pockettts_with_audio_only_reference() {
        let dir = tempfile::tempdir().expect("tempdir");
        let audio = dir.path().join("reference.wav");
        std::fs::write(&audio, b"fake-wav-bytes").expect("write reference");
        let sha = sha256_path(&audio).expect("hash reference");
        let size = std::fs::metadata(&audio).expect("metadata").len();
        let reference = IosTtsReferenceBinding::new(audio, sha, size, 16_000, "", "rev-1")
            .expect("audio-only reference");
        assert!(verify_ios_tts_reference_binding(&reference).is_ok());
        let official = test_pack_binding_with_pack_id(
            dir.path(),
            "standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26",
            &[
                "lm-flow",
                "lm-main",
                "encoder",
                "decoder",
                "text-conditioner",
                "vocab",
                "token-scores",
            ],
            Some(reference),
        );
        assert!(verify_ios_pack_binding(&official).is_ok());
    }

    #[test]
    fn ios_session_rejects_pockettts_binding_without_reference_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let binding = test_pack_binding_with_family(
            dir.path(),
            PackTask::Tts,
            "tts",
            &["model", "tokens", "espeak-ng-data"],
            "pockettts",
            None,
        );

        assert!(matches!(
            verify_ios_pack_binding(&binding),
            Err(IosVoiceSessionCommandError::Unavailable)
        ));
    }

    #[test]
    fn ios_session_rejects_reference_profile_for_piper_binding() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reference = IosTtsReferenceBinding::new(
            dir.path().join("reference.wav"),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            12,
            16_000,
            "Reference voice.",
            "rev-1",
        )
        .expect("reference binding");
        let binding = test_pack_binding_with_family(
            dir.path(),
            PackTask::Tts,
            "tts",
            &["model", "tokens", "espeak-ng-data"],
            "vits_piper",
            Some(reference),
        );

        assert!(matches!(
            verify_ios_pack_binding(&binding),
            Err(IosVoiceSessionCommandError::Unavailable)
        ));
    }

    #[test]
    fn ios_session_accepts_independent_speech_stage_bindings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let stt_only = IosVoicePackBindings::new(vec![test_pack_binding(
            dir.path(),
            PackTask::Stt,
            "stt",
            &["encoder", "decoder", "tokens"],
        )])
        .expect("bindings");
        assert!(verify_ios_pack_bindings(&stt_only)
            .expect("independent STT binding")
            .contains_key(&PackTask::Stt));

        let tts_only = IosVoicePackBindings::new(vec![test_pack_binding(
            dir.path(),
            PackTask::Tts,
            "tts",
            &["model", "tokens", "espeak-ng-data"],
        )])
        .expect("bindings");
        assert!(verify_ios_pack_bindings(&tts_only)
            .expect("independent TTS binding")
            .contains_key(&PackTask::Tts));

        let incomplete_wake = IosVoicePackBindings::new(vec![test_pack_binding(
            dir.path(),
            PackTask::Vad,
            "vad",
            &["model"],
        )])
        .expect("bindings");
        assert!(matches!(
            verify_ios_pack_bindings(&incomplete_wake),
            Err(IosVoiceSessionCommandError::Unavailable)
        ));
    }

    #[cfg(feature = "ios-sherpa")]
    #[test]
    fn ios_gateway_stage_ports_construct_without_network_access() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("https://gateway.example.test").expect("gateway URL"),
            GatewayAuth::None,
            true,
        );
        let policy = microphone_policy(&config).expect("consented remote route");

        assert!(build_gateway_ios_stt(&config, policy).is_ok());
        assert!(build_gateway_ios_tts(&config, policy).is_ok());
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
            "sherpa-onnx-1.13.5",
            "en-US",
            16_000,
            512,
            "whisper",
            None,
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
        test_pack_binding_with_family(
            root,
            task,
            slot,
            file_ids,
            match task {
                PackTask::Vad => "silero_vad",
                PackTask::Kws | PackTask::Wakeword => "zipformer",
                PackTask::Stt => "whisper",
                PackTask::Tts => "vits_piper",
                _ => "unknown",
            },
            None,
        )
    }

    fn test_pack_binding_with_family(
        root: &std::path::Path,
        task: PackTask,
        slot: &str,
        file_ids: &[&str],
        model_family: &str,
        tts_reference: Option<IosTtsReferenceBinding>,
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
            "sherpa-onnx-1.13.5",
            "en-US",
            16_000,
            512,
            model_family,
            tts_reference,
            files,
        )
        .expect("binding")
    }

    fn test_pack_binding_with_pack_id(
        root: &std::path::Path,
        pack_id: impl Into<String>,
        file_ids: &[&str],
        tts_reference: Option<IosTtsReferenceBinding>,
    ) -> IosVoicePackBinding {
        let pack_id = pack_id.into();
        let slot = "tts";
        let pack = root.join(format!("{}.pack", pack_id.replace(':', "_")));
        std::fs::write(&pack, format!("cached {pack_id} pack")).expect("write pack");
        let pack_sha256 = sha256_path(&pack).expect("hash pack");
        let files = file_ids
            .iter()
            .map(|file_id| {
                let file_path = root.join(format!("{}-{file_id}.bin", pack_id.replace(':', "_")));
                std::fs::write(&file_path, format!("cached {pack_id} {file_id}"))
                    .expect("write file");
                let size = std::fs::metadata(&file_path).expect("metadata").len();
                IosVoicePackFileBinding::new(
                    *file_id,
                    file_path.clone(),
                    sha256_path(&file_path).expect("hash file"),
                    size,
                )
                .expect("file binding")
            })
            .collect();
        IosVoicePackBinding::new(
            PackTask::Tts,
            slot,
            pack_id,
            pack.clone(),
            pack_sha256,
            std::fs::metadata(&pack).expect("metadata").len(),
            "sherpa-onnx-1.13.5",
            "en-US",
            16_000,
            512,
            "pockettts",
            tts_reference,
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
        // The loopback Gateway has no active assistant request to interrupt. Keep
        // this strict cleanup failure visible rather than treating local turn
        // cancellation as proof that transport cleanup succeeded.
        assert_eq!(
            session.close_checked(),
            Err(MobileSessionCloseError::CleanupFailed)
        );
    }

    #[test]
    fn production_command_loop_waits_for_actual_core_cleanup_before_worker_join() {
        let (started_tx, started_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (loop_exited_tx, loop_exited_rx) = mpsc::channel();
        let (allow_worker_exit_tx, allow_worker_exit_rx) = mpsc::channel();
        let lifecycle = MobileSessionLifecycle::new();
        let control = AuroraIosCaptureControl::default();
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let thread_status = Arc::clone(&status);
        let thread_lifecycle = lifecycle.clone();
        let thread_control = control.clone();
        let worker = thread::spawn(move || {
            let core = close_test_runtime(started_tx, stop_tx, release_rx);
            let runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(run_session_loop(
                core,
                command_rx,
                thread_status,
                thread_control,
                thread_lifecycle,
                false,
            ));
            loop_exited_tx.send(()).expect("loop exited after report");
            allow_worker_exit_rx
                .recv()
                .expect("release worker after retained report");
        });
        start_join_driver(&lifecycle, worker).expect("join driver");

        let (reply, response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: IosVoiceStartMode::PushToTalk,
                        reply,
                    })
                    .is_ok()
            })
            .expect("start admitted");
        assert_eq!(
            response.recv().expect("start reply").expect("generation"),
            Generation(1)
        );
        started_rx.recv().expect("core capture started");
        stop_rx.recv().expect("core cleanup entered audio stop");

        assert_eq!(
            lifecycle.request_retirement(|| commands.send(Command::Shutdown).is_ok()),
            Some(Generation(1))
        );
        control.interrupt(Generation(1));
        let waker = Waker::from(Arc::new(CloseTestWake));
        let mut context = Context::from_waker(&waker);
        let mut wait = Box::pin(lifecycle.wait_closed());
        assert!(matches!(wait.as_mut().poll(&mut context), Poll::Pending));
        assert_eq!(
            lifecycle.admit(|| commands.send(Command::Shutdown).is_ok()),
            Err(MobileSessionCloseError::ShutdownFailed)
        );
        release_tx.send(()).expect("release actual core cleanup");
        loop_exited_rx
            .recv()
            .expect("production loop recorded cleanup and returned");
        assert!(matches!(wait.as_mut().poll(&mut context), Poll::Pending));
        allow_worker_exit_tx
            .send(())
            .expect("allow actual worker exit");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(5)),
            Err(MobileSessionCloseError::CleanupFailed)
        );
        assert!(matches!(
            wait.as_mut().poll(&mut context),
            Poll::Ready(Err(MobileSessionCloseError::CleanupFailed))
        ));
        assert!(!status.lock().expect("status lock").active);
    }

    #[test]
    fn terminal_close_preserves_missing_transport_cleanup_as_failure() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let session = IosVoiceSession::new_default(config).expect("session");
        let generation = session.start().expect("start");
        session.request_close();
        assert_eq!(session.start(), Err(IosVoiceSessionCommandError::Closed));
        assert_eq!(
            session.close_checked_timeout(Duration::from_secs(5)),
            Err(MobileSessionCloseError::CleanupFailed)
        );
        assert!(!session.status().active);
        assert_eq!(generation.0, 1);
    }

    #[test]
    fn production_worker_startup_failure_is_retained_until_join() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let audio_state = AuroraIosAudioState::new(1, 128);
        let output = AuroraIosAudioOutput::new(1);
        let input = AuroraIosAudioInput::new(audio_state.clone());
        let control = input.control();
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let lifecycle = MobileSessionLifecycle::new();
        let (ready, ready_rx) = mpsc::channel();
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker_lifecycle = lifecycle.clone();
        let inputs = SessionThreadInputs {
            config,
            input,
            output: output.clone(),
            sink: IosSessionSink {
                status: Arc::clone(&status),
            },
            commands: command_rx,
            ready,
            status: Arc::clone(&status),
            control: control.clone(),
            lifecycle: worker_lifecycle,
        };
        let worker = thread::spawn(move || {
            run_session_thread_with_builder(inputs, |_config, _input, _output, _sink| {
                Err(IosVoiceSessionCommandError::Unavailable)
            });
        });
        start_join_driver(&lifecycle, worker).expect("join driver");
        assert_eq!(
            ready_rx.recv().expect("startup reply"),
            Err(IosVoiceSessionCommandError::Unavailable)
        );
        lifecycle.request_retirement(|| commands.send(Command::Shutdown).is_ok());
        audio_state.close();
        output.close();
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Err(MobileSessionCloseError::Unavailable)
        );
        assert_eq!(
            status.lock().expect("startup status").phase,
            IosVoiceSessionPhase::Faulted
        );
    }

    #[test]
    fn constructor_driver_spawn_failure_joins_the_actual_ios_worker() {
        let config = IosVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let worker_exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed_exit = Arc::clone(&worker_exited);
        assert_eq!(
            IosVoiceSession::new_with_join_driver(
                config,
                1,
                128,
                1,
                |_lifecycle, worker| Err(worker),
                move || observed_exit.store(true, std::sync::atomic::Ordering::SeqCst),
            )
            .map(|_| ()),
            Err(IosVoiceSessionCommandError::Unavailable)
        );
        assert!(worker_exited.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn retirement_before_real_input_control_reset_cannot_admit_another_capture() {
        let (start_entered_tx, start_entered_rx) = mpsc::channel();
        let (release_start_tx, release_start_rx) = tokio::sync::oneshot::channel();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (release_stop_tx, release_stop_rx) = tokio::sync::oneshot::channel();
        let lifecycle = MobileSessionLifecycle::new();
        let audio_state = AuroraIosAudioState::new(1, 128);
        let inner = AuroraIosAudioInput::new(audio_state);
        let control = inner.control();
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker_status = Arc::clone(&status);
        let worker_control = control.clone();
        let worker_lifecycle = lifecycle.clone();
        let worker = thread::spawn(move || {
            let core = VoiceRuntime::new(
                GatedIosAudioInput {
                    inner,
                    start_entered: Some(start_entered_tx),
                    release_start: Some(release_start_rx),
                    stop_entered: Some(stop_tx),
                    release_stop: Some(release_stop_rx),
                },
                CloseTestEngine,
                CloseTestEngine,
                CloseTestTransport,
                CloseTestOutput,
                CloseTestSink,
                IOS_SURFACE,
                IOS_RUNTIME_ID,
            )
            .expect("real core runtime");
            let runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(run_session_loop(
                core,
                command_rx,
                worker_status,
                worker_control,
                worker_lifecycle,
                false,
            ));
        });
        start_join_driver(&lifecycle, worker).expect("join driver");

        let (reply, response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: IosVoiceStartMode::PushToTalk,
                        reply,
                    })
                    .is_ok()
            })
            .expect("first start admitted");
        assert_eq!(
            response.recv().expect("start reply").expect("generation"),
            Generation(1)
        );
        start_entered_rx.recv().expect("before inner input reset");

        let (queued_reply, queued_response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: IosVoiceStartMode::PushToTalk,
                        reply: queued_reply,
                    })
                    .is_ok()
            })
            .expect("active-loop start enqueued for rejection");
        assert_eq!(
            queued_response.recv().expect("queued start reply"),
            Err(IosVoiceSessionCommandError::AlreadyActive)
        );

        assert_eq!(
            lifecycle.request_retirement(|| commands.send(Command::Shutdown).is_ok()),
            Some(Generation(1))
        );
        control.interrupt(Generation(1));
        let mut enqueue_ran = false;
        assert_eq!(
            lifecycle.admit(|| {
                enqueue_ran = true;
                true
            }),
            Err(MobileSessionCloseError::ShutdownFailed)
        );
        assert!(!enqueue_ran);

        release_start_tx
            .send(())
            .expect("release actual input start");
        stop_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("cancelled capture entered cleanup");
        release_stop_tx.send(()).expect("finish actual cleanup");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(5)),
            Ok(())
        );
    }

    #[test]
    fn queued_start_loses_to_retirement_after_cleanup_and_finish_cancel_match_generation() {
        let lifecycle = MobileSessionLifecycle::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (stop_entered_tx, stop_entered_rx) = mpsc::channel();
        let (release_stop_tx, release_stop_rx) = tokio::sync::oneshot::channel();
        let (cleanup_boundary_tx, cleanup_boundary_rx) = mpsc::channel();
        let (release_boundary_tx, release_boundary_rx) = mpsc::channel();
        lifecycle.set_after_cleanup_hook(move |generation, _report| {
            if generation == Generation(1) {
                cleanup_boundary_tx
                    .send(())
                    .expect("actual cleanup reached loop boundary");
                let _ = release_boundary_rx.recv_timeout(Duration::from_secs(5));
            }
        });
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let control = AuroraIosCaptureControl::default();
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker_status = Arc::clone(&status);
        let worker_control = control.clone();
        let worker_lifecycle = lifecycle.clone();
        let worker = thread::spawn(move || {
            let core = close_test_runtime(started_tx, stop_entered_tx, release_stop_rx);
            TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime")
                .block_on(run_session_loop(
                    core,
                    command_rx,
                    worker_status,
                    worker_control,
                    worker_lifecycle,
                    false,
                ));
        });
        start_join_driver(&lifecycle, worker).expect("actual worker join driver");

        let (start_reply, start_response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: IosVoiceStartMode::PushToTalk,
                        reply: start_reply,
                    })
                    .is_ok()
            })
            .expect("first start admitted");
        assert_eq!(
            start_response
                .recv()
                .expect("start response")
                .expect("generation"),
            Generation(1)
        );
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("first actual capture started");
        stop_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("core is blocked in cleanup");

        for (generation, matching) in [(Generation(9), false), (Generation(1), true)] {
            let (reply, response) = mpsc::channel();
            lifecycle
                .admit(|| commands.send(Command::Finish { generation, reply }).is_ok())
                .expect("finish command admitted");
            assert_eq!(
                response.recv_timeout(Duration::from_secs(2)),
                if matching {
                    Ok(Ok(()))
                } else {
                    Ok(Err(IosVoiceSessionCommandError::NotActive))
                }
            );
        }
        for (generation, matching) in [(Generation(9), false), (Generation(1), true)] {
            let (reply, response) = mpsc::channel();
            lifecycle
                .admit(|| commands.send(Command::Cancel { generation, reply }).is_ok())
                .expect("cancel command admitted");
            assert_eq!(
                response.recv_timeout(Duration::from_secs(2)),
                if matching {
                    Ok(Ok(()))
                } else {
                    Ok(Err(IosVoiceSessionCommandError::NotActive))
                }
            );
        }

        release_stop_tx.send(()).expect("release core cleanup");
        cleanup_boundary_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("generation cleanup finished before next command");
        let (queued_reply, queued_response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: IosVoiceStartMode::PushToTalk,
                        reply: queued_reply,
                    })
                    .is_ok()
            })
            .expect("start queued before retirement wins");
        assert_eq!(
            lifecycle.request_retirement(|| commands.send(Command::Shutdown).is_ok()),
            None,
            "generation cleanup already released the active binding"
        );
        release_boundary_tx
            .send(())
            .expect("resume production command loop");
        assert_eq!(
            queued_response.recv_timeout(Duration::from_secs(2)),
            Ok(Err(IosVoiceSessionCommandError::Unavailable))
        );
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(5)),
            Err(MobileSessionCloseError::CleanupFailed)
        );
        assert_eq!(
            started_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected),
            "no second capture was admitted"
        );
        assert!(!status.lock().expect("final status").active);
    }

    #[test]
    fn production_command_loop_drains_on_channel_close_and_fails_closed() {
        let (started_tx, started_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let lifecycle = MobileSessionLifecycle::new();
        let (channel_closed_tx, channel_closed_rx) = mpsc::channel();
        lifecycle.set_unexpected_channel_close_hook(channel_closed_tx);
        let control = AuroraIosCaptureControl::default();
        let status = Arc::new(Mutex::new(IosVoiceSessionStatus::default()));
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker_status = Arc::clone(&status);
        let worker_control = control.clone();
        let worker_lifecycle = lifecycle.clone();
        let worker = thread::spawn(move || {
            let core = close_test_runtime(started_tx, stop_tx, release_rx);
            let runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(run_session_loop(
                core,
                command_rx,
                worker_status,
                worker_control,
                worker_lifecycle,
                false,
            ));
        });
        start_join_driver(&lifecycle, worker).expect("join driver");

        let (reply, response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: IosVoiceStartMode::PushToTalk,
                        reply,
                    })
                    .is_ok()
            })
            .expect("start admitted");
        assert_eq!(
            response.recv().expect("start reply").expect("generation"),
            Generation(1)
        );
        started_rx.recv().expect("core capture started");
        drop(commands);
        stop_rx.recv().expect("core cleanup entered audio stop");
        channel_closed_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("production loop retained ShutdownFailed after channel close");

        let waker = Waker::from(Arc::new(CloseTestWake));
        let mut context = Context::from_waker(&waker);
        let mut wait = Box::pin(lifecycle.wait_closed());
        assert!(matches!(wait.as_mut().poll(&mut context), Poll::Pending));
        release_tx.send(()).expect("release actual core cleanup");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(5)),
            Err(MobileSessionCloseError::ShutdownFailed)
        );
        assert!(matches!(
            wait.as_mut().poll(&mut context),
            Poll::Ready(Err(MobileSessionCloseError::ShutdownFailed))
        ));
        assert!(!status.lock().expect("status lock").active);
    }
}
