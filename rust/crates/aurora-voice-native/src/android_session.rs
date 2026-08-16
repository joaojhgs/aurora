//! Android-native voice session executor.
//!
//! This module owns the shared Rust [`VoiceRuntime`] for an Android turn. Kotlin
//! owns the platform capture/playback threads, but it never owns voice state,
//! generations, transport calls, or cancellation semantics.

#[cfg(feature = "native-sherpa")]
use crate::{
    build_installed_kws_provider_from_phrases, build_installed_stt_provider,
    build_installed_vad_provider, SpeechPackManager, SpeechPackManagerConfig,
    NATIVE_WAKE_KWS_THRESHOLD,
};
#[cfg(feature = "native-sherpa-tts")]
use crate::{build_installed_tts_provider, build_installed_tts_provider_with_reference};
use crate::{
    AndroidAudioInput, AndroidAudioOutput, AndroidCaptureControl, AndroidPcmIngress, GatewayAuth,
    MicrophoneAudioPolicy, NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig,
    NativeGatewayTransport, NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer, TransportLimits,
};
use async_trait::async_trait;
#[cfg(any(test, all(feature = "native-sherpa", feature = "native-sherpa-tts")))]
use aurora_voice_core::EngineError;
#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
use aurora_voice_core::WakeOrchestrationConfig;
use aurora_voice_core::{
    CancellationToken, CaptureOwnerKind, CaptureStartReason, Generation, RedactedSnapshot,
    RouteRevision, RuntimeEvent, RuntimeEventSink, TimestampMicros, VoiceCaptureLease,
    VoiceCoreError, VoiceRuntime, VoiceState,
};
#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
use aurora_voice_engine::{
    BoundFiniteSttRequest, BoundTtsSynthesisRequest, FiniteSttAudio, FiniteSttPort,
    FiniteSttProviderBinding, FiniteSttResult, KwsConfig, TtsSynthesisPort,
    TtsSynthesisProviderBinding, TtsSynthesisResult, VadConfig,
};
use aurora_voice_engine::{
    FiniteSttRouteScope, RouteFiniteSttBinding, RouteTtsBinding, MAX_FINITE_STT_SAMPLES,
    VAD_SAMPLE_RATE_HZ,
};
#[cfg(feature = "native-sherpa")]
use aurora_voice_sherpa::{
    NativeKwsBackend, NativeSttBackend, NativeVadBackend, SherpaFiniteSttEngine,
    SherpaKwsPhraseInput, SherpaKwsProvider, SherpaVadProvider,
};
#[cfg(feature = "native-sherpa-tts")]
use aurora_voice_sherpa::{NativeTtsBackend, NativeTtsReferenceAudio, SherpaTtsProvider};
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
const ANDROID_SURFACE: &str = "android";
const ANDROID_RUNTIME_ID: &str = "android-native-voice";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(45);

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
type RuntimeCore = VoiceRuntime<
    AndroidAudioInput,
    AndroidFiniteSttProvider,
    AndroidTtsProvider,
    NativeGatewayTransport,
    AndroidAudioOutput,
    AndroidSessionSink,
>;

#[cfg(not(all(feature = "native-sherpa", feature = "native-sherpa-tts")))]
type RuntimeCore = VoiceRuntime<
    AndroidAudioInput,
    NativeGatewayFiniteStt,
    NativeGatewayTtsSynthesizer,
    NativeGatewayTransport,
    AndroidAudioOutput,
    AndroidSessionSink,
>;

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
enum AndroidFiniteSttProvider {
    Local(Box<SherpaFiniteSttEngine<NativeSttBackend>>),
    Gateway(Box<NativeGatewayFiniteStt>),
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
#[async_trait(?Send)]
impl FiniteSttPort for AndroidFiniteSttProvider {
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

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
enum AndroidTtsProvider {
    Local(Box<SherpaTtsProvider<NativeTtsBackend>>),
    Gateway(Box<NativeGatewayTtsSynthesizer>),
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
type AndroidWakeRuntimeParts = (
    SherpaVadProvider<NativeVadBackend>,
    SherpaKwsProvider<NativeKwsBackend>,
    WakeOrchestrationConfig,
);

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
#[async_trait(?Send)]
impl TtsSynthesisPort for AndroidTtsProvider {
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

#[derive(Clone, Debug)]
#[cfg_attr(
    not(all(feature = "native-sherpa", feature = "native-sherpa-tts")),
    allow(dead_code)
)]
pub struct AndroidVoiceSessionConfig {
    gateway: Url,
    auth: GatewayAuth,
    remote_audio_consent: bool,
    pack_store_root: Option<PathBuf>,
    stt_model_id: Option<String>,
    vad_model_id: Option<String>,
    kws_model_id: Option<String>,
    tts_voice_id: Option<String>,
    wake_phrase_id: Option<String>,
    wake_phrase_text: Option<String>,
    wake_phrase_revision: Option<String>,
    #[cfg(feature = "native-sherpa-tts")]
    tts_reference_profile: Option<AndroidTtsReferenceProfile>,
}

#[cfg(feature = "native-sherpa-tts")]
fn optional_sherpa_reference_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

#[cfg(feature = "native-sherpa-tts")]
#[derive(Clone, Debug)]
pub struct AndroidTtsReferenceProfile {
    sample_rate_hz: i32,
    samples: Vec<f32>,
    reference_text: Option<String>,
    revision: Option<String>,
}

#[cfg(feature = "native-sherpa-tts")]
impl AndroidTtsReferenceProfile {
    pub fn new(
        sample_rate_hz: i32,
        samples: Vec<f32>,
        reference_text: Option<String>,
        revision: Option<String>,
    ) -> Result<Self, AndroidVoiceSessionCommandError> {
        NativeTtsReferenceAudio::new(sample_rate_hz, samples.clone())
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        Ok(Self {
            sample_rate_hz,
            samples,
            reference_text: optional_sherpa_reference_text(reference_text),
            revision,
        })
    }

    fn to_native(&self) -> Result<NativeTtsReferenceAudio, AndroidVoiceSessionCommandError> {
        NativeTtsReferenceAudio::new(self.sample_rate_hz, self.samples.clone())
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)
    }

    fn reference_text(&self) -> Option<String> {
        optional_sherpa_reference_text(self.reference_text.clone())
    }

    fn revision(&self) -> Option<String> {
        self.revision.clone()
    }
}

impl AndroidVoiceSessionConfig {
    pub fn new(gateway: Url, auth: GatewayAuth, remote_audio_consent: bool) -> Self {
        Self {
            gateway,
            auth,
            remote_audio_consent,
            pack_store_root: None,
            stt_model_id: None,
            vad_model_id: None,
            kws_model_id: None,
            tts_voice_id: None,
            wake_phrase_id: None,
            wake_phrase_text: None,
            wake_phrase_revision: None,
            #[cfg(feature = "native-sherpa-tts")]
            tts_reference_profile: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_local_pack_selection(
        gateway: Url,
        auth: GatewayAuth,
        remote_audio_consent: bool,
        pack_store_root: impl Into<PathBuf>,
        stt_model_id: impl Into<String>,
        tts_voice_id: impl Into<String>,
        vad_model_id: Option<String>,
        kws_model_id: Option<String>,
        wake_phrase_id: Option<String>,
        wake_phrase_text: Option<String>,
        wake_phrase_revision: Option<String>,
    ) -> Self {
        Self {
            gateway,
            auth,
            remote_audio_consent,
            pack_store_root: Some(pack_store_root.into()),
            stt_model_id: Some(stt_model_id.into()),
            vad_model_id,
            kws_model_id,
            tts_voice_id: Some(tts_voice_id.into()),
            wake_phrase_id,
            wake_phrase_text,
            wake_phrase_revision,
            #[cfg(feature = "native-sherpa-tts")]
            tts_reference_profile: None,
        }
    }

    #[cfg(feature = "native-sherpa-tts")]
    pub fn with_tts_reference_profile(mut self, profile: AndroidTtsReferenceProfile) -> Self {
        self.tts_reference_profile = Some(profile);
        self
    }

    #[cfg(all(test, feature = "native-sherpa-tts"))]
    fn tts_reference_profile(&self) -> Option<&AndroidTtsReferenceProfile> {
        self.tts_reference_profile.as_ref()
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
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let thread_status = Arc::clone(&status);
        let thread_control = control.clone();
        let thread_output = output.clone();
        let join = thread::Builder::new()
            .name("aurora-android-voice".to_owned())
            .spawn(move || {
                run_session_thread(
                    config,
                    input,
                    thread_output,
                    sink,
                    command_rx,
                    thread_status,
                    thread_control,
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

    pub fn clear_ingress(&self) -> bool {
        self.ingress.clear_pending()
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
    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    {
        if has_complete_local_pack_selection(config) {
            build_local_runtime(config, input, output, sink)
        } else {
            build_gateway_runtime(config, input, output, sink)
        }
    }
    #[cfg(not(all(feature = "native-sherpa", feature = "native-sherpa-tts")))]
    {
        build_gateway_runtime(config, input, output, sink)
    }
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn has_complete_local_pack_selection(config: &AndroidVoiceSessionConfig) -> bool {
    config.pack_store_root.is_some()
        && config
            .stt_model_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        && config
            .tts_voice_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn build_local_runtime(
    config: &AndroidVoiceSessionConfig,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
) -> Result<RuntimeCore, AndroidVoiceSessionCommandError> {
    let store_root = config
        .pack_store_root
        .clone()
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let stt_model_id = config
        .stt_model_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let tts_voice_id = config
        .tts_voice_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let manager = SpeechPackManager::open(
        SpeechPackManagerConfig::new(store_root, None)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let stt = build_installed_stt_provider(&manager, stt_model_id)
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let tts = if let Some(reference_profile) = &config.tts_reference_profile {
        let _reference_revision = reference_profile.revision();
        build_installed_tts_provider_with_reference(
            &manager,
            tts_voice_id,
            Some(reference_profile.to_native()?),
            reference_profile.reference_text(),
        )
    } else {
        build_installed_tts_provider(&manager, tts_voice_id)
    }
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let policy = microphone_policy(config)?;
    let limits = transport_limits(policy);
    let transport_for_assistant =
        NativeGatewayTransport::new(config.gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let mut runtime = VoiceRuntime::new(
        input,
        AndroidFiniteSttProvider::Local(Box::new(stt)),
        AndroidTtsProvider::Local(Box::new(tts)),
        transport_for_assistant,
        output,
        sink,
        ANDROID_SURFACE,
        ANDROID_RUNTIME_ID,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    if let Some((vad, kws, wake_config)) = build_wake_runtime_parts(&manager, config)? {
        runtime = runtime
            .with_wake_providers(Box::new(vad), Box::new(kws), wake_config)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    }
    Ok(runtime)
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn build_wake_runtime_parts(
    manager: &SpeechPackManager,
    config: &AndroidVoiceSessionConfig,
) -> Result<Option<AndroidWakeRuntimeParts>, AndroidVoiceSessionCommandError> {
    let Some(vad_model_id) = config
        .vad_model_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let Some(kws_model_id) = config
        .kws_model_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let phrase_id = config
        .wake_phrase_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let phrase_text = config
        .wake_phrase_text
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let phrase_revision = config
        .wake_phrase_revision
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let vad_config = VadConfig::default();
    let vad = build_installed_vad_provider(manager, vad_model_id, &vad_config)
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let kws = build_installed_kws_provider_from_phrases(
        manager,
        kws_model_id,
        phrase_revision,
        [SherpaKwsPhraseInput::new(phrase_id, phrase_text)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?],
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let vad_binding = vad.binding().clone();
    let kws_binding = kws.binding().clone();
    let kws_config = KwsConfig::new(
        [phrase_id],
        phrase_revision,
        NATIVE_WAKE_KWS_THRESHOLD,
        0,
        1,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let wake_config =
        WakeOrchestrationConfig::new(vad_binding, kws_binding, vad_config, kws_config, 800, 1600)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    Ok(Some((vad, kws, wake_config)))
}

fn build_gateway_runtime(
    config: &AndroidVoiceSessionConfig,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
) -> Result<RuntimeCore, AndroidVoiceSessionCommandError> {
    #[cfg(not(all(feature = "native-sherpa", feature = "native-sherpa-tts")))]
    if config.pack_store_root.is_some()
        || config.stt_model_id.is_some()
        || config.tts_voice_id.is_some()
        || config.vad_model_id.is_some()
        || config.kws_model_id.is_some()
    {
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }
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
    let limits = transport_limits(policy);
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
    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    let stt = AndroidFiniteSttProvider::Gateway(Box::new(stt));
    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    let tts = AndroidTtsProvider::Gateway(Box::new(tts));
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

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn microphone_policy(
    config: &AndroidVoiceSessionConfig,
) -> Result<MicrophoneAudioPolicy, AndroidVoiceSessionCommandError> {
    if is_loopback(&config.gateway) {
        Ok(MicrophoneAudioPolicy::LoopbackOnly)
    } else if config.remote_audio_consent {
        Ok(MicrophoneAudioPolicy::ExplicitRemoteConsent)
    } else {
        Err(AndroidVoiceSessionCommandError::Unavailable)
    }
}

fn transport_limits(policy: MicrophoneAudioPolicy) -> TransportLimits {
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
    config: AndroidVoiceSessionConfig,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
    mut commands: tokio_mpsc::UnboundedReceiver<Command>,
    status: Arc<Mutex<AndroidVoiceSessionStatus>>,
    control: AndroidCaptureControl,
) {
    let remote_audio_consent = config.remote_audio_consent;
    let mut voice_runtime = match build_runtime(&config, input, output, sink) {
        Ok(runtime) => runtime,
        Err(_) => {
            set_fault(&status, "runtime_unavailable");
            return;
        }
    };
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
        VoiceState::Arming => AndroidVoiceSessionPhase::Starting,
        VoiceState::ListeningForWake
        | VoiceState::WakeDetected
        | VoiceState::CapturingUtterance => AndroidVoiceSessionPhase::Listening,
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
        status.phase = AndroidVoiceSessionPhase::Idle;
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
        let terminal_phase = status.phase;
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
                let code = error_code(&error, terminal_phase);
                eprintln!(
                    "aurora_android_voice_turn_failed phase={terminal_phase:?} reason={code}"
                );
                status.last_error = Some(code.to_owned());
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

fn error_code(error: &VoiceCoreError, terminal_phase: AndroidVoiceSessionPhase) -> &'static str {
    match error {
        VoiceCoreError::Cancelled => "cancelled",
        VoiceCoreError::TransportFault { .. }
            if terminal_phase == AndroidVoiceSessionPhase::Speaking =>
        {
            "playback_failed"
        }
        VoiceCoreError::Engine(_) if terminal_phase == AndroidVoiceSessionPhase::Speaking => {
            "tts_failed"
        }
        VoiceCoreError::TransportFault { .. } => "assistant_unavailable",
        VoiceCoreError::Engine(_) => "transcription_failed",
        VoiceCoreError::Backpressure => "audio_overloaded",
        VoiceCoreError::InvalidTransition => "voice_state_invalid",
        VoiceCoreError::WakeNotDetected => "wake_not_detected",
        VoiceCoreError::SpeechNotDetected => "speech_not_detected",
        VoiceCoreError::SpeechTimeout => "speech_timeout",
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
            phase_for_state(VoiceState::Arming),
            AndroidVoiceSessionPhase::Starting
        );
        assert_eq!(
            phase_for_state(VoiceState::ListeningForWake),
            AndroidVoiceSessionPhase::Listening
        );
        assert_eq!(
            phase_for_state(VoiceState::WakeDetected),
            AndroidVoiceSessionPhase::Listening
        );
        assert_eq!(
            phase_for_state(VoiceState::CapturingUtterance),
            AndroidVoiceSessionPhase::Listening
        );
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
    fn accepted_start_waits_for_runtime_capture_before_advertising_a_capture_phase() {
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus::default()));
        let generation = Generation(7);

        set_active(&status, generation);

        let status = status.lock().expect("status");
        assert!(status.active);
        assert_eq!(status.phase, AndroidVoiceSessionPhase::Idle);
        assert_eq!(status.generation, Some(generation));
    }

    #[test]
    fn terminal_errors_identify_the_failed_voice_stage() {
        assert_eq!(
            error_code(
                &VoiceCoreError::Engine(EngineError::InvalidRequest),
                AndroidVoiceSessionPhase::Speaking,
            ),
            "tts_failed",
        );
        assert_eq!(
            error_code(
                &VoiceCoreError::TransportFault {
                    code: "output-stream-error".to_owned(),
                },
                AndroidVoiceSessionPhase::Speaking,
            ),
            "playback_failed",
        );
        assert_eq!(
            error_code(
                &VoiceCoreError::TransportFault {
                    code: "request_failed".to_owned(),
                },
                AndroidVoiceSessionPhase::Processing,
            ),
            "assistant_unavailable",
        );
        assert_eq!(
            error_code(
                &VoiceCoreError::WakeNotDetected,
                AndroidVoiceSessionPhase::Starting,
            ),
            "wake_not_detected",
        );
        assert_eq!(
            error_code(
                &VoiceCoreError::SpeechNotDetected,
                AndroidVoiceSessionPhase::Listening,
            ),
            "speech_not_detected",
        );
        assert_eq!(
            error_code(
                &VoiceCoreError::SpeechTimeout,
                AndroidVoiceSessionPhase::Listening,
            ),
            "speech_timeout",
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

    #[cfg(feature = "native-sherpa-tts")]
    #[test]
    fn android_internal_overlay_voices_do_not_require_reference_profile() {
        let catalog = aurora_voice_engine::TtsVoiceCatalog::runtime().expect("runtime catalog");
        let english = catalog
            .voice("standard:pockettts:aurora-pockettts-en-2026-04")
            .expect("english overlay");
        let french = catalog
            .voice("standard:pockettts:aurora-pockettts-fr-24l")
            .expect("french overlay");
        let official = catalog
            .voice("standard:pockettts:sherpa-onnx-pocket-tts-int8-2026-01-26")
            .expect("clone-capable english");
        assert!(!english.requires_reference_profile());
        assert!(!french.requires_reference_profile());
        assert!(official.requires_reference_profile());
        assert_eq!(
            english.reference_audio_mode(),
            aurora_voice_engine::TtsReferenceAudioMode::Internal
        );
        assert_eq!(
            official.reference_audio_mode(),
            aurora_voice_engine::TtsReferenceAudioMode::Profile
        );
    }

    #[cfg(feature = "native-sherpa-tts")]
    #[test]
    fn android_tts_reference_profile_requires_explicit_audio() {
        let invalid = AndroidTtsReferenceProfile::new(
            16_000,
            Vec::new(),
            Some("reference text".to_owned()),
            Some("rev-1".to_owned()),
        );
        assert!(invalid.is_err());
    }

    #[cfg(feature = "native-sherpa-tts")]
    #[test]
    fn local_pack_config_carries_explicit_tts_reference_profile() {
        let profile = AndroidTtsReferenceProfile::new(
            16_000,
            vec![0.0, 0.1, -0.1, 0.0],
            Some("reference text".to_owned()),
            Some("rev-1".to_owned()),
        )
        .expect("profile");
        let config = AndroidVoiceSessionConfig::with_local_pack_selection(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
            "/tmp/aurora-packs",
            "stt-model",
            "standard:pockettts:voice",
            None,
            None,
            None,
            None,
            None,
        )
        .with_tts_reference_profile(profile);
        let stored = config.tts_reference_profile().expect("reference");
        assert_eq!(stored.reference_text().as_deref(), Some("reference text"));
        assert_eq!(stored.revision().as_deref(), Some("rev-1"));
        assert!(stored.to_native().is_ok());
    }

    #[cfg(feature = "native-sherpa-tts")]
    #[test]
    fn local_pack_config_accepts_audio_only_tts_reference_profile() {
        let profile = AndroidTtsReferenceProfile::new(
            16_000,
            vec![0.0, 0.1, -0.1, 0.0],
            None,
            Some("rev-1".to_owned()),
        )
        .expect("audio-only profile");
        assert_eq!(profile.reference_text(), None);
        assert_eq!(profile.revision().as_deref(), Some("rev-1"));
        assert!(profile.to_native().is_ok());

        let blank = AndroidTtsReferenceProfile::new(
            16_000,
            vec![0.0, 0.1, -0.1, 0.0],
            Some("   ".to_owned()),
            Some("rev-1".to_owned()),
        )
        .expect("blank text profile");
        assert_eq!(blank.reference_text(), None);
    }
}
