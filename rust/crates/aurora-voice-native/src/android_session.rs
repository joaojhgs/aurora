//! Android-native voice session executor.
//!
//! This module owns the shared Rust [`VoiceRuntime`] for an Android turn. Kotlin
//! owns the platform capture/playback threads, but it never owns voice state,
//! generations, transport calls, or cancellation semantics.

use crate::mobile_session_close::{
    rollback_failed_join_driver, start_join_driver, MobileSessionCloseError, MobileSessionLifecycle,
};
use crate::native_event_observer::{
    begin_native_voice_observation_producer, observe_native_voice, NativeVoiceObservation,
    NativeVoiceObservationToken, NativeVoiceTurnIds, NativeVoiceTurnSnapshot,
};
#[cfg(feature = "native-sherpa")]
use crate::{
    build_installed_kws_provider_from_phrases, build_installed_stt_provider,
    build_installed_vad_provider, SpeechPackManager, SpeechPackManagerConfig,
    NATIVE_WAKE_KWS_THRESHOLD,
};
#[cfg(feature = "native-sherpa-tts")]
use crate::{build_installed_tts_provider, build_installed_tts_provider_with_reference};
use crate::{emit_native_speech_lifecycle, native_speech_lifecycle_observer_enabled};
use crate::{
    AndroidAudioInput, AndroidAudioOutput, AndroidCaptureControl, AndroidPcmIngress, GatewayAuth,
    MicrophoneAudioPolicy, NativeGatewayFiniteStt, NativeGatewayFiniteSttConfig,
    NativeGatewayTransport, NativeGatewayTtsConfig, NativeGatewayTtsSynthesizer,
    NativeMeshAssistantRoute, NativeMeshAssistantSpeechTransport, NativeMeshFiniteStt,
    NativeMeshFiniteSttConfig, NativeMeshTtsConfig, NativeMeshTtsSynthesizer, TransportLimits,
};
use async_trait::async_trait;
use aurora_voice_core::node_policy::SpeechStages;
use aurora_voice_core::EngineError;
#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
use aurora_voice_core::WakeOrchestrationConfig;
use aurora_voice_core::{
    AudioInput, AudioOutput, CancellationToken, CaptureOwnerKind, CaptureStartReason, Generation,
    RedactedSnapshot, RouteRevision, RuntimeEvent, RuntimeEventSink, SpeechLifecycleEventV1,
    SpeechTransport, TimestampMicros, TransitionReason, VoiceCaptureLease, VoiceCoreError,
    VoiceRuntime, VoiceState,
};
use aurora_voice_engine::{
    BoundFiniteSttRequest, BoundTtsSynthesisRequest, FiniteSttAudio, FiniteSttResult,
    TtsSynthesisProviderBinding, TtsSynthesisResult,
};
use aurora_voice_engine::{
    BoundTaskRequest, FiniteSttAudioBuilder, FiniteSttPort, FiniteSttProviderBinding,
    FiniteSttRouteScope, RouteFiniteSttBinding, RouteFiniteSttRequest, RouteTtsBinding,
    TaskRequest, TtsSynthesisPort, VoiceTask, MAX_FINITE_STT_SAMPLES, VAD_SAMPLE_RATE_HZ,
};
#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
use aurora_voice_engine::{KwsConfig, TaskPackBinding, VadConfig};
#[cfg(feature = "native-sherpa")]
use aurora_voice_sherpa::{
    NativeKwsBackend, NativeSttBackend, NativeVadBackend, SherpaFiniteSttEngine,
    SherpaKwsPhraseInput, SherpaKwsProvider, SherpaVadProvider,
};
#[cfg(feature = "native-sherpa-tts")]
use aurora_voice_sherpa::{NativeTtsBackend, NativeTtsReferenceAudio, SherpaTtsProvider};
use serde::Serialize;
use std::collections::HashMap;
use std::collections::VecDeque;
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
const REQUEST_TIMEOUT: Duration = Duration::from_secs(75);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(75);

type RuntimeCore = VoiceRuntime<
    AndroidAudioInput,
    AndroidFiniteSttProvider,
    AndroidTtsProvider,
    AndroidAssistantTransport,
    AndroidAudioOutput,
    AndroidSessionSink,
>;

trait AndroidSessionRuntime {
    fn has_active_capture(&self) -> bool;
    fn next_capture_generation(&self) -> Result<Generation, VoiceCoreError>;
    fn invoke_turn<'a>(
        &'a mut self,
        mode: AndroidVoiceStartMode,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<String, VoiceCoreError>> + 'a>>;
    fn cleanup_report_for_generation(
        &self,
        generation: Generation,
    ) -> Option<aurora_voice_core::VoiceCleanupReport>;
}

impl<A, E, P, T, O, S> AndroidSessionRuntime for VoiceRuntime<A, E, P, T, O, S>
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
        mode: AndroidVoiceStartMode,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<String, VoiceCoreError>> + 'a>> {
        match mode {
            AndroidVoiceStartMode::PushToTalk => {
                Box::pin(self.run_push_to_talk_transcription(lease, at, cancellation))
            }
            AndroidVoiceStartMode::BackgroundSession => {
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

enum AndroidFiniteSttProvider {
    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    Local(Box<LazyInstalledSttProvider>),
    Gateway(Box<NativeGatewayFiniteStt>),
    Mesh(Box<NativeMeshFiniteStt>),
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
struct LazyInstalledSttProvider {
    manager: Arc<SpeechPackManager>,
    model_id: String,
    binding: TaskPackBinding,
    provider: Option<SherpaFiniteSttEngine<NativeSttBackend>>,
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
impl LazyInstalledSttProvider {
    fn new(
        manager: Arc<SpeechPackManager>,
        model_id: impl Into<String>,
    ) -> Result<Self, EngineError> {
        let model_id = model_id.into();
        let binding = manager
            .recorded_model_task_binding(&model_id)
            .map_err(|_| EngineError::TaskUnavailable)?;
        if binding.task() != VoiceTask::SpeechToText {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            manager,
            model_id,
            binding,
            provider: None,
        })
    }

    fn ensure_loaded(
        &mut self,
    ) -> Result<&mut SherpaFiniteSttEngine<NativeSttBackend>, EngineError> {
        if self.provider.is_none() {
            self.provider = Some(build_installed_stt_provider(
                self.manager.as_ref(),
                &self.model_id,
            )?);
        }
        self.provider.as_mut().ok_or(EngineError::TaskUnavailable)
    }

    fn preload(&mut self) -> Result<(), EngineError> {
        self.ensure_loaded().map(|_| ())
    }

    fn accepts_binding(&self, binding: &FiniteSttProviderBinding) -> bool {
        matches!(
            binding,
            FiniteSttProviderBinding::LocalTask(requested) if requested.as_ref() == &self.binding
        )
    }
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
#[async_trait(?Send)]
impl FiniteSttPort for LazyInstalledSttProvider {
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
        Ok(FiniteSttProviderBinding::LocalTask(Box::new(
            self.binding.clone(),
        )))
    }

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError> {
        if !self.accepts_binding(&binding) {
            return Err(EngineError::InvalidRequest);
        }
        self.ensure_loaded()?.warm_finite_stt(binding).await
    }

    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        if request
            .local_request()
            .is_none_or(|local| local.binding() != &self.binding)
        {
            return Err(EngineError::InvalidRequest);
        }
        self.ensure_loaded()?
            .transcribe_finite(request, audio, cancellation)
            .await
    }

    async fn cancel_finite_stt_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        match self.provider.as_mut() {
            Some(provider) => provider.cancel_finite_stt_generation(generation).await,
            None => Ok(()),
        }
    }
}

#[async_trait(?Send)]
impl FiniteSttPort for AndroidFiniteSttProvider {
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
            Self::Local(provider) => provider.finite_stt_binding(),
            Self::Gateway(provider) => provider.finite_stt_binding(),
            Self::Mesh(provider) => provider.finite_stt_binding(),
        }
    }

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
            Self::Local(provider) => provider.warm_finite_stt(binding).await,
            Self::Gateway(provider) => provider.warm_finite_stt(binding).await,
            Self::Mesh(provider) => provider.warm_finite_stt(binding).await,
        }
    }

    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
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
            Self::Mesh(provider) => {
                provider
                    .transcribe_finite(request, audio, cancellation)
                    .await
            }
        }
    }

    async fn cancel_finite_stt_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
            Self::Local(provider) => provider.cancel_finite_stt_generation(generation).await,
            Self::Gateway(provider) => provider.cancel_finite_stt_generation(generation).await,
            Self::Mesh(provider) => provider.cancel_finite_stt_generation(generation).await,
        }
    }
}

enum AndroidTtsProvider {
    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    Local(Box<LazyInstalledTtsProvider>),
    Gateway(Box<NativeGatewayTtsSynthesizer>),
    Mesh(Box<NativeMeshTtsSynthesizer>),
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
struct LazyInstalledTtsProvider {
    manager: Arc<SpeechPackManager>,
    voice_id: String,
    binding: TaskPackBinding,
    reference_profile: Option<AndroidTtsReferenceProfile>,
    provider: Option<SherpaTtsProvider<NativeTtsBackend>>,
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
impl LazyInstalledTtsProvider {
    fn new(
        manager: Arc<SpeechPackManager>,
        voice_id: impl Into<String>,
        reference_profile: Option<AndroidTtsReferenceProfile>,
    ) -> Result<Self, EngineError> {
        let voice_id = voice_id.into();
        let binding = manager
            .recorded_voice_task_binding(&voice_id)
            .map_err(|_| EngineError::TaskUnavailable)?;
        if binding.task() != VoiceTask::TextToSpeech {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            manager,
            voice_id,
            binding,
            reference_profile,
            provider: None,
        })
    }

    fn ensure_loaded(&mut self) -> Result<&mut SherpaTtsProvider<NativeTtsBackend>, EngineError> {
        if self.provider.is_none() {
            let provider = if let Some(reference_profile) = self.reference_profile.as_ref() {
                let _reference_revision = reference_profile.revision();
                build_installed_tts_provider_with_reference(
                    self.manager.as_ref(),
                    &self.voice_id,
                    Some(
                        reference_profile
                            .to_native()
                            .map_err(|_| EngineError::TaskUnavailable)?,
                    ),
                    reference_profile.reference_text(),
                )
            } else {
                build_installed_tts_provider(self.manager.as_ref(), &self.voice_id)
            }?;
            self.provider = Some(provider);
        }
        self.provider.as_mut().ok_or(EngineError::TaskUnavailable)
    }

    fn preload(&mut self) -> Result<(), EngineError> {
        self.ensure_loaded().map(|_| ())
    }

    fn accepts_binding(&self, binding: &TtsSynthesisProviderBinding) -> bool {
        matches!(
            binding,
            TtsSynthesisProviderBinding::LocalTask(requested) if requested.as_ref() == &self.binding
        )
    }
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
#[async_trait(?Send)]
impl TtsSynthesisPort for LazyInstalledTtsProvider {
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
        Ok(TtsSynthesisProviderBinding::LocalTask(Box::new(
            self.binding.clone(),
        )))
    }

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError> {
        if !self.accepts_binding(&binding) {
            return Err(EngineError::InvalidRequest);
        }
        self.ensure_loaded()?.warm_synthesis(binding).await
    }

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        if request
            .local_request()
            .is_none_or(|local| local.binding() != &self.binding)
        {
            return Err(EngineError::InvalidRequest);
        }
        self.ensure_loaded()?
            .synthesize_text(request, cancellation)
            .await
    }

    async fn cancel_synthesis_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        match self.provider.as_mut() {
            Some(provider) => provider.cancel_synthesis_generation(generation).await,
            None => Ok(()),
        }
    }
}

enum AndroidAssistantTransport {
    Gateway(NativeGatewayTransport),
    Mesh(NativeMeshAssistantSpeechTransport),
    Unavailable,
}

#[async_trait(?Send)]
impl SpeechTransport for AndroidAssistantTransport {
    async fn assistant_turn(
        &mut self,
        request: aurora_voice_core::AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<aurora_voice_core::AssistantTurnResponse, VoiceCoreError> {
        match self {
            Self::Gateway(transport) => transport.assistant_turn(request, cancellation).await,
            Self::Mesh(transport) => transport.assistant_turn(request, cancellation).await,
            Self::Unavailable => Err(VoiceCoreError::TransportFault {
                code: "assistant-unavailable".to_owned(),
            }),
        }
    }

    async fn cancel_session(&mut self, generation: Generation) -> Result<(), VoiceCoreError> {
        match self {
            Self::Gateway(transport) => transport.cancel_session(generation).await,
            Self::Mesh(transport) => transport.cancel_session(generation).await,
            Self::Unavailable => Ok(()),
        }
    }
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
type AndroidWakeRuntimeParts = (
    SherpaVadProvider<NativeVadBackend>,
    SherpaKwsProvider<NativeKwsBackend>,
    WakeOrchestrationConfig,
);

#[async_trait(?Send)]
impl TtsSynthesisPort for AndroidTtsProvider {
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
            Self::Local(provider) => provider.synthesis_binding(),
            Self::Gateway(provider) => provider.synthesis_binding(),
            Self::Mesh(provider) => provider.synthesis_binding(),
        }
    }

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
            Self::Local(provider) => provider.warm_synthesis(binding).await,
            Self::Gateway(provider) => provider.warm_synthesis(binding).await,
            Self::Mesh(provider) => provider.warm_synthesis(binding).await,
        }
    }

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
            Self::Local(provider) => provider.synthesize_text(request, cancellation).await,
            Self::Gateway(provider) => provider.synthesize_text(request, cancellation).await,
            Self::Mesh(provider) => provider.synthesize_text(request, cancellation).await,
        }
    }

    async fn cancel_synthesis_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        match self {
            #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
            Self::Local(provider) => provider.cancel_synthesis_generation(generation).await,
            Self::Gateway(provider) => provider.cancel_synthesis_generation(generation).await,
            Self::Mesh(provider) => provider.cancel_synthesis_generation(generation).await,
        }
    }
}

#[derive(Clone, Debug)]
#[cfg_attr(
    not(all(feature = "native-sherpa", feature = "native-sherpa-tts")),
    allow(dead_code)
)]
pub struct AndroidVoiceSessionConfig {
    gateway: Option<Url>,
    auth: GatewayAuth,
    remote_audio_consent: bool,
    assistant_route_mode: AndroidAssistantRouteMode,
    preferred_stable_peer_id: Option<String>,
    pack_store_root: Option<PathBuf>,
    stt_model_id: Option<String>,
    vad_model_id: Option<String>,
    kws_model_id: Option<String>,
    tts_voice_id: Option<String>,
    wake_phrase_id: Option<String>,
    wake_phrase_text: Option<String>,
    wake_phrase_revision: Option<String>,
    speech_stages: Option<SpeechStages>,
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
            gateway: Some(gateway),
            auth,
            remote_audio_consent,
            assistant_route_mode: AndroidAssistantRouteMode::HttpOnly,
            preferred_stable_peer_id: None,
            pack_store_root: None,
            stt_model_id: None,
            vad_model_id: None,
            kws_model_id: None,
            tts_voice_id: None,
            wake_phrase_id: None,
            wake_phrase_text: None,
            wake_phrase_revision: None,
            speech_stages: None,
            #[cfg(feature = "native-sherpa-tts")]
            tts_reference_profile: None,
        }
    }

    pub fn with_assistant_route(
        mut self,
        mode: AndroidAssistantRouteMode,
        preferred_stable_peer_id: Option<String>,
    ) -> Result<Self, AndroidVoiceSessionCommandError> {
        if !matches!(
            mode,
            AndroidAssistantRouteMode::WebRtcOnly | AndroidAssistantRouteMode::LocalOnly
        ) && self.gateway.is_none()
        {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
        if matches!(mode, AndroidAssistantRouteMode::WebRtcOnly)
            && preferred_stable_peer_id
                .as_deref()
                .is_none_or(|peer_id| peer_id.trim().is_empty())
        {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
        if let Some(peer_id) = preferred_stable_peer_id.as_deref() {
            NativeMeshAssistantRoute::new(Some(peer_id.to_owned()))
                .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        }
        self.assistant_route_mode = mode;
        self.preferred_stable_peer_id = preferred_stable_peer_id;
        Ok(self)
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
        Self::with_local_pack_selection_for_route(
            Some(gateway),
            auth,
            remote_audio_consent,
            pack_store_root,
            stt_model_id,
            tts_voice_id,
            vad_model_id,
            kws_model_id,
            wake_phrase_id,
            wake_phrase_text,
            wake_phrase_revision,
        )
    }

    pub fn with_speech_stages(mut self, stages: SpeechStages) -> Self {
        self.speech_stages = Some(stages);
        self
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_local_pack_selection_for_route(
        gateway: Option<Url>,
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
        Self::with_pack_selection_for_route(
            gateway,
            auth,
            remote_audio_consent,
            Some(pack_store_root.into()),
            Some(stt_model_id.into()),
            Some(tts_voice_id.into()),
            vad_model_id,
            kws_model_id,
            wake_phrase_id,
            wake_phrase_text,
            wake_phrase_revision,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_pack_selection_for_route(
        gateway: Option<Url>,
        auth: GatewayAuth,
        remote_audio_consent: bool,
        pack_store_root: Option<PathBuf>,
        stt_model_id: Option<String>,
        tts_voice_id: Option<String>,
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
            assistant_route_mode: AndroidAssistantRouteMode::HttpOnly,
            preferred_stable_peer_id: None,
            pack_store_root,
            stt_model_id,
            vad_model_id,
            kws_model_id,
            tts_voice_id,
            wake_phrase_id,
            wake_phrase_text,
            wake_phrase_revision,
            speech_stages: None,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndroidAssistantRouteMode {
    HttpOnly,
    WebRtcPreferred,
    WebRtcOnly,
    LocalOnly,
}

impl AndroidAssistantRouteMode {
    pub fn parse(value: &str) -> Result<Self, AndroidVoiceSessionCommandError> {
        match value {
            "" | "http-only" => Ok(Self::HttpOnly),
            "webrtc-preferred" => Ok(Self::WebRtcPreferred),
            "webrtc-only" => Ok(Self::WebRtcOnly),
            "local-only" => Ok(Self::LocalOnly),
            _ => Err(AndroidVoiceSessionCommandError::Unavailable),
        }
    }
}

#[repr(i64)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndroidVoiceSessionPhase {
    Idle = 0,
    Starting = 1,
    Listening = 2,
    Processing = 3,
    Speaking = 4,
    Stopping = 5,
    Faulted = 6,
    WaitingForWake = 7,
    Transcribing = 8,
    WaitingForResponse = 9,
    PreparingSpeech = 10,
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

const MAX_BACKGROUND_TURN_RESULTS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidBackgroundVoiceTurnResult {
    pub generation: Generation,
    pub observation_token: String,
    pub transcript: String,
    pub assistant_text: Option<String>,
    pub error_code: Option<String>,
}

/// Native Android voice runtime handle shared by JNI capture, playback, and
/// foreground-service controls.
pub struct AndroidVoiceSession {
    ingress: AndroidPcmIngress,
    output: AndroidAudioOutput,
    control: AndroidCaptureControl,
    commands: tokio_mpsc::UnboundedSender<Command>,
    status: Arc<Mutex<AndroidVoiceSessionStatus>>,
    focused_transcript: Arc<Mutex<Option<String>>>,
    background_results: Arc<Mutex<VecDeque<AndroidBackgroundVoiceTurnResult>>>,
    lifecycle: MobileSessionLifecycle,
}

impl AndroidVoiceSession {
    pub fn new(
        config: AndroidVoiceSessionConfig,
        ingress_capacity_chunks: usize,
        max_chunk_samples: usize,
        output_capacity_chunks: usize,
    ) -> Result<Self, AndroidVoiceSessionCommandError> {
        Self::new_with_join_driver(
            config,
            ingress_capacity_chunks,
            max_chunk_samples,
            output_capacity_chunks,
            start_join_driver,
            || {},
        )
    }

    fn new_with_join_driver(
        config: AndroidVoiceSessionConfig,
        ingress_capacity_chunks: usize,
        max_chunk_samples: usize,
        output_capacity_chunks: usize,
        start_driver: impl FnOnce(
            &MobileSessionLifecycle,
            thread::JoinHandle<()>,
        ) -> Result<(), thread::JoinHandle<()>>,
        worker_exit: impl FnOnce() + Send + 'static,
    ) -> Result<Self, AndroidVoiceSessionCommandError> {
        let ingress = AndroidPcmIngress::new(ingress_capacity_chunks, max_chunk_samples);
        let output = AndroidAudioOutput::new(output_capacity_chunks);
        let input = AndroidAudioInput::new(ingress.clone());
        let control = input.control();
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus::default()));
        let focused_transcript = Arc::new(Mutex::new(None));
        let turn_transcript = Arc::new(Mutex::new(None));
        let background_results = Arc::new(Mutex::new(VecDeque::new()));
        let observation_tokens = Arc::new(Mutex::new(HashMap::new()));
        let sink = AndroidSessionSink {
            status: Arc::clone(&status),
            turn_transcript: Arc::clone(&turn_transcript),
            observation_tokens: Arc::clone(&observation_tokens),
        };
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let lifecycle = MobileSessionLifecycle::new();
        let thread_state = AndroidSessionThreadState {
            status: Arc::clone(&status),
            focused_transcript: Arc::clone(&focused_transcript),
            turn_transcript: Arc::clone(&turn_transcript),
            background_results: Arc::clone(&background_results),
            observation_tokens: Arc::clone(&observation_tokens),
            control: control.clone(),
            lifecycle: lifecycle.clone(),
        };
        let thread_output = output.clone();
        let worker = thread::Builder::new()
            .name("aurora-android-voice".to_owned())
            .spawn(move || {
                run_session_thread(config, input, thread_output, sink, command_rx, thread_state);
                worker_exit();
            })
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        if let Err(worker) = start_driver(&lifecycle, worker) {
            rollback_failed_join_driver(
                &lifecycle,
                worker,
                || commands.send(Command::Shutdown).is_ok(),
                |generation| control.interrupt(generation),
                || {
                    ingress.close();
                    output.close();
                },
            );
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
        Ok(Self {
            ingress,
            output,
            control,
            commands,
            status,
            focused_transcript,
            background_results,
            lifecycle,
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

    /// Consumes the final transcript from the most recently completed focused
    /// push-to-talk turn. Background turns never populate this one-shot result.
    pub fn take_focused_transcript(&self) -> Option<String> {
        self.focused_transcript
            .lock()
            .ok()
            .and_then(|mut transcript| transcript.take())
    }

    pub fn take_background_result(&self) -> Option<AndroidBackgroundVoiceTurnResult> {
        self.background_results
            .lock()
            .ok()
            .and_then(|mut results| results.pop_front())
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
        self.lifecycle
            .admit(|| self.commands.send(Command::Start { mode, reply }).is_ok())
            .map_err(map_close_command_error)?;
        response
            .recv()
            .unwrap_or(Err(AndroidVoiceSessionCommandError::Closed))
    }

    pub fn finish(&self, generation: u64) -> Result<(), AndroidVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        self.lifecycle
            .admit(|| {
                self.commands
                    .send(Command::Finish {
                        generation: Generation(generation),
                        reply,
                    })
                    .is_ok()
            })
            .map_err(map_close_command_error)?;
        response
            .recv()
            .unwrap_or(Err(AndroidVoiceSessionCommandError::Closed))
    }

    pub fn cancel(&self, generation: u64) -> Result<(), AndroidVoiceSessionCommandError> {
        let (reply, response) = mpsc::channel();
        self.lifecycle
            .admit(|| {
                self.commands
                    .send(Command::Cancel {
                        generation: Generation(generation),
                        reply,
                    })
                    .is_ok()
            })
            .map_err(map_close_command_error)?;
        response
            .recv()
            .unwrap_or(Err(AndroidVoiceSessionCommandError::Closed))
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
            self.control.interrupt(generation);
        }
        self.ingress.close();
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

impl Drop for AndroidVoiceSession {
    fn drop(&mut self) {
        self.request_close();
    }
}

fn map_close_command_error(error: MobileSessionCloseError) -> AndroidVoiceSessionCommandError {
    match error {
        MobileSessionCloseError::ShutdownFailed => AndroidVoiceSessionCommandError::Closed,
        _ => AndroidVoiceSessionCommandError::Unavailable,
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
        if let Some(stages) = config.speech_stages.as_ref() {
            return build_runtime_for_stages(config, stages, input, output, sink);
        }
        if has_complete_local_pack_selection(config) {
            build_local_runtime(config, input, output, sink)
        } else {
            build_gateway_runtime(config, input, output, sink)
        }
    }
    #[cfg(not(all(feature = "native-sherpa", feature = "native-sherpa-tts")))]
    {
        if let Some(stages) = config.speech_stages.as_ref() {
            validate_android_wake_stages(config, stages)?;
            return build_runtime_for_remote_stages(config, stages, input, output, sink);
        }
        build_gateway_runtime(config, input, output, sink)
    }
}

fn stage_uses_android_local(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
    local_available: bool,
    gateway_available: bool,
    optional_local_absence: bool,
) -> Result<bool, AndroidVoiceSessionCommandError> {
    use aurora_voice_core::node_policy::{RoutingFallback, RoutingPreference};

    match stage.routing.prefer {
        RoutingPreference::LocalOnly => {
            if local_available {
                Ok(true)
            } else if optional_local_absence {
                Ok(false)
            } else {
                Err(AndroidVoiceSessionCommandError::Unavailable)
            }
        }
        RoutingPreference::Local => {
            if local_available {
                Ok(true)
            } else if stage.routing.fallback == RoutingFallback::Network && gateway_available {
                Ok(false)
            } else {
                Err(AndroidVoiceSessionCommandError::Unavailable)
            }
        }
        RoutingPreference::NetworkOnly => {
            if gateway_available {
                Ok(false)
            } else {
                Err(AndroidVoiceSessionCommandError::Unavailable)
            }
        }
        RoutingPreference::Network => {
            if gateway_available {
                Ok(false)
            } else if stage.routing.fallback == RoutingFallback::Local && local_available {
                Ok(true)
            } else {
                Err(AndroidVoiceSessionCommandError::Unavailable)
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AndroidSpeechNetworkBackend {
    Gateway,
    Mesh,
}

fn android_selected_speech_network_backend(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
    local_available: bool,
) -> Result<Option<AndroidSpeechNetworkBackend>, AndroidVoiceSessionCommandError> {
    use aurora_voice_core::node_policy::{
        Omitted, RoutingFallback, RoutingPreference, SpeechNetworkKind,
    };
    let network_selected = match stage.routing.prefer {
        RoutingPreference::LocalOnly => false,
        RoutingPreference::Local if local_available => false,
        RoutingPreference::Local => stage.routing.fallback == RoutingFallback::Network,
        RoutingPreference::Network | RoutingPreference::NetworkOnly => true,
    };
    if !network_selected {
        return Ok(None);
    }
    Ok(Some(match &stage.network_kind {
        Omitted::Value(SpeechNetworkKind::Mesh) => AndroidSpeechNetworkBackend::Mesh,
        Omitted::Missing | Omitted::Value(SpeechNetworkKind::Gateway) => {
            AndroidSpeechNetworkBackend::Gateway
        }
    }))
}

#[derive(Clone)]
struct AndroidMeshSpeechStage {
    peer_id: String,
    resource_id: String,
    model_id: Option<String>,
    language: Option<String>,
}

fn android_mesh_stage_route(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
    local_available: bool,
) -> Result<Option<AndroidMeshSpeechStage>, AndroidVoiceSessionCommandError> {
    use aurora_voice_core::node_policy::NullableField;
    if android_selected_speech_network_backend(stage, local_available)?
        != Some(AndroidSpeechNetworkBackend::Mesh)
    {
        return Ok(None);
    }
    let target = match &stage.target {
        NullableField::Value(v) => v,
        _ => return Err(AndroidVoiceSessionCommandError::Unavailable),
    };
    let resource_id = match &target.resource_id {
        NullableField::Value(v) if !v.trim().is_empty() => v.clone(),
        _ => return Err(AndroidVoiceSessionCommandError::Unavailable),
    };
    if target.peer_id.trim().is_empty() {
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }
    let target_model = match &target.model_id {
        NullableField::Value(v) if !v.trim().is_empty() => Some(v.clone()),
        NullableField::Value(_) => return Err(AndroidVoiceSessionCommandError::Unavailable),
        _ => None,
    };
    let stage_model = match &stage.model_id {
        NullableField::Value(v) if !v.trim().is_empty() => Some(v.clone()),
        NullableField::Value(_) => return Err(AndroidVoiceSessionCommandError::Unavailable),
        _ => None,
    };
    if target_model.is_some() && stage_model.is_some() && target_model != stage_model {
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }
    let language = match &stage.language {
        NullableField::Value(v) if !v.trim().is_empty() => Some(v.clone()),
        NullableField::Value(_) => return Err(AndroidVoiceSessionCommandError::Unavailable),
        _ => None,
    };
    Ok(Some(AndroidMeshSpeechStage {
        peer_id: target.peer_id.clone(),
        resource_id,
        model_id: stage_model.or(target_model),
        language,
    }))
}

fn build_android_mesh_stt(
    config: &AndroidVoiceSessionConfig,
    selected: &AndroidMeshSpeechStage,
) -> Result<AndroidFiniteSttProvider, AndroidVoiceSessionCommandError> {
    if !config.remote_audio_consent {
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }
    let route = RouteFiniteSttBinding::new(
        "mesh.stt",
        FiniteSttRouteScope::RemoteGateway,
        VAD_SAMPLE_RATE_HZ,
        MAX_FINITE_STT_SAMPLES.min(16_000 * 30),
        ROUTE_REVISION,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let provider = NativeMeshFiniteStt::new(
        NativeMeshFiniteSttConfig::new(
            route,
            selected.peer_id.clone(),
            selected.resource_id.clone(),
            selected.model_id.clone(),
            selected.language.clone(),
            true,
            transport_limits(MicrophoneAudioPolicy::ExplicitRemoteConsent),
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    Ok(AndroidFiniteSttProvider::Mesh(Box::new(provider)))
}

fn build_android_mesh_tts(
    selected: &AndroidMeshSpeechStage,
) -> Result<AndroidTtsProvider, AndroidVoiceSessionCommandError> {
    let route = RouteTtsBinding::new(
        "mesh.tts",
        "mesh.default",
        VAD_SAMPLE_RATE_HZ,
        ROUTE_REVISION,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let provider = NativeMeshTtsSynthesizer::new(
        NativeMeshTtsConfig::new(
            route,
            selected.peer_id.clone(),
            selected.resource_id.clone(),
            selected.model_id.clone(),
            None,
            selected.language.clone(),
            TransportLimits::default(),
            16_000 * 30,
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    Ok(AndroidTtsProvider::Mesh(Box::new(provider)))
}

fn validate_android_gateway_stage(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
) -> Result<(), AndroidVoiceSessionCommandError> {
    use aurora_voice_core::node_policy::{NullableField, Omitted, SpeechNetworkKind};

    if matches!(&stage.network_kind, Omitted::Value(SpeechNetworkKind::Mesh))
        || matches!(&stage.target, NullableField::Value(_))
    {
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }
    Ok(())
}

fn validate_android_local_stage(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
) -> Result<(), AndroidVoiceSessionCommandError> {
    use aurora_voice_core::node_policy::{
        NullableField, Omitted, RoutingFallback, RoutingPreference, SpeechNetworkKind,
    };

    if matches!(&stage.network_kind, Omitted::Missing)
        && !matches!(&stage.target, NullableField::Value(_))
    {
        return Ok(());
    }
    // A configured network alternative is dormant when the Local preference is available.
    // Validate its shape without binding this operation to the target or comparing its model
    // against the selected local pack; the fallback selector is resolved only if Local fails.
    if stage.routing.prefer == RoutingPreference::Local
        && stage.routing.fallback == RoutingFallback::Network
    {
        return match (&stage.network_kind, &stage.target) {
            (Omitted::Value(SpeechNetworkKind::Mesh), NullableField::Value(target))
                if !target.peer_id.trim().is_empty()
                    && matches!(&target.resource_id, NullableField::Value(resource) if !resource.trim().is_empty()) =>
            {
                Ok(())
            }
            (
                Omitted::Missing | Omitted::Value(SpeechNetworkKind::Gateway),
                NullableField::Missing | NullableField::Null,
            ) => Ok(()),
            _ => Err(AndroidVoiceSessionCommandError::Unavailable),
        };
    }
    Err(AndroidVoiceSessionCommandError::Unavailable)
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn validate_android_local_model_selector(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
    selected_model_id: &str,
) -> Result<(), AndroidVoiceSessionCommandError> {
    if let aurora_voice_core::node_policy::NullableField::Value(model_id) = &stage.model_id {
        if model_id != selected_model_id {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
    }
    Ok(())
}

fn android_stage_language(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
) -> Option<&str> {
    match &stage.language {
        aurora_voice_core::node_policy::NullableField::Value(language) => Some(language),
        aurora_voice_core::node_policy::NullableField::Missing
        | aurora_voice_core::node_policy::NullableField::Null => None,
    }
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn android_gateway_fallback_allowed(
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
) -> bool {
    use aurora_voice_core::node_policy::{RoutingFallback, RoutingPreference};

    stage.routing.prefer == RoutingPreference::Local
        && stage.routing.fallback == RoutingFallback::Network
}

fn validate_android_stage_provider(
    config: &AndroidVoiceSessionConfig,
    stage: &aurora_voice_core::node_policy::SpeechStageConfig,
    local_available: bool,
    optional_local_absence: bool,
) -> Result<bool, AndroidVoiceSessionCommandError> {
    let local = stage_uses_android_local(
        stage,
        local_available,
        config.gateway.is_some(),
        optional_local_absence,
    )?;
    if local {
        validate_android_local_stage(stage)?;
    } else {
        validate_android_gateway_stage(stage)?;
    }
    Ok(local)
}

fn validate_android_wake_stages(
    config: &AndroidVoiceSessionConfig,
    stages: &SpeechStages,
) -> Result<(), AndroidVoiceSessionCommandError> {
    use aurora_voice_core::node_policy::{Omitted, RoutingFallback, RoutingPreference};

    for (stage, configured) in [
        (&stages.kws, config.kws_model_id.is_some()),
        (&stages.vad, config.vad_model_id.is_some()),
    ] {
        let local = validate_android_stage_provider(config, stage, configured, true)?;
        let routes_to_gateway = matches!(
            stage.routing.prefer,
            RoutingPreference::Network | RoutingPreference::NetworkOnly
        ) || (stage.routing.prefer == RoutingPreference::Local
            && stage.routing.fallback == RoutingFallback::Network);
        if !local
            && (configured || routes_to_gateway || !matches!(&stage.network_kind, Omitted::Missing))
        {
            // Android currently has no Gateway KWS or VAD provider.
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
    }
    Ok(())
}

fn build_runtime_for_remote_stages(
    config: &AndroidVoiceSessionConfig,
    stages: &SpeechStages,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
) -> Result<RuntimeCore, AndroidVoiceSessionCommandError> {
    use aurora_voice_core::node_policy::{NullableField, RoutingFallback, RoutingPreference};
    for stage in [&stages.stt, &stages.tts] {
        if stage.routing.prefer == RoutingPreference::LocalOnly
            || (stage.routing.prefer == RoutingPreference::Local
                && stage.routing.fallback != RoutingFallback::Network)
        {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
    }
    let mesh_stt = android_mesh_stage_route(&stages.stt, false)?;
    let mesh_tts = android_mesh_stage_route(&stages.tts, false)?;
    let gateway_stt = if mesh_stt.is_none() {
        validate_android_gateway_stage(&stages.stt)?;
        let policy = android_gateway_audio_policy(config)?;
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
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let model = match &stages.stt.model_id {
            NullableField::Value(v) => v.clone(),
            _ => "realtime".to_owned(),
        };
        let transport = NativeGatewayTransport::new(
            config
                .gateway
                .clone()
                .ok_or(AndroidVoiceSessionCommandError::Unavailable)?,
            config.auth.clone(),
            transport_limits(policy),
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        Some(AndroidFiniteSttProvider::Gateway(Box::new(
            NativeGatewayFiniteStt::new(
                transport,
                NativeGatewayFiniteSttConfig::new(route, model, policy)
                    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
            )
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
        )))
    } else {
        None
    };
    let gateway_tts = if mesh_tts.is_none() {
        validate_android_gateway_stage(&stages.tts)?;
        if matches!(&stages.tts.model_id, NullableField::Value(_)) {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
        let policy = android_gateway_audio_policy(config)?;
        let route = RouteTtsBinding::new(
            "gateway.default",
            "voice.default",
            VAD_SAMPLE_RATE_HZ,
            ROUTE_REVISION,
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let transport = NativeGatewayTransport::new(
            config
                .gateway
                .clone()
                .ok_or(AndroidVoiceSessionCommandError::Unavailable)?,
            config.auth.clone(),
            transport_limits(policy),
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        Some(AndroidTtsProvider::Gateway(Box::new(
            NativeGatewayTtsSynthesizer::new(
                transport,
                NativeGatewayTtsConfig::new(route, None, 1.0, 16_000 * 30)
                    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
            ),
        )))
    } else {
        None
    };
    let stt = match mesh_stt {
        Some(route) => build_android_mesh_stt(config, &route)?,
        None => gateway_stt.ok_or(AndroidVoiceSessionCommandError::Unavailable)?,
    };
    let tts = match mesh_tts {
        Some(route) => build_android_mesh_tts(&route)?,
        None => gateway_tts.ok_or(AndroidVoiceSessionCommandError::Unavailable)?,
    };
    let policy = if config.gateway.is_some() {
        android_gateway_audio_policy(config)?
    } else if config.remote_audio_consent {
        MicrophoneAudioPolicy::ExplicitRemoteConsent
    } else {
        MicrophoneAudioPolicy::Blocked
    };
    let assistant = build_assistant_transport(config, transport_limits(policy))?;
    VoiceRuntime::new(
        input,
        stt,
        tts,
        assistant,
        output,
        sink,
        ANDROID_SURFACE,
        ANDROID_RUNTIME_ID,
    )
    .map(|runtime| {
        runtime.with_speech_languages(
            android_stage_language(&stages.stt).map(str::to_owned),
            android_stage_language(&stages.tts).map(str::to_owned),
        )
    })
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn build_runtime_for_stages(
    config: &AndroidVoiceSessionConfig,
    stages: &SpeechStages,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
) -> Result<RuntimeCore, AndroidVoiceSessionCommandError> {
    let local_stt_available = config.pack_store_root.is_some()
        && config
            .stt_model_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    let local_tts_available = config.pack_store_root.is_some()
        && config
            .tts_voice_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    let initial_mesh_stt = android_mesh_stage_route(&stages.stt, local_stt_available)?;
    let initial_mesh_tts = android_mesh_stage_route(&stages.tts, local_tts_available)?;
    let mut local_stt = if initial_mesh_stt.is_some() {
        false
    } else {
        validate_android_stage_provider(config, &stages.stt, local_stt_available, false)?
    };
    let mut local_tts = if initial_mesh_tts.is_some() {
        false
    } else {
        validate_android_stage_provider(config, &stages.tts, local_tts_available, false)?
    };
    validate_android_wake_stages(config, stages)?;

    if local_stt {
        validate_android_local_model_selector(
            &stages.stt,
            config
                .stt_model_id
                .as_deref()
                .ok_or(AndroidVoiceSessionCommandError::Unavailable)?,
        )?;
    }
    if local_tts {
        validate_android_local_model_selector(
            &stages.tts,
            config
                .tts_voice_id
                .as_deref()
                .ok_or(AndroidVoiceSessionCommandError::Unavailable)?,
        )?;
    }
    let wake_selected = config.vad_model_id.is_some() || config.kws_model_id.is_some();
    let manager = if local_stt || local_tts || wake_selected {
        let opened = config
            .pack_store_root
            .clone()
            .and_then(|store_root| SpeechPackManagerConfig::new(store_root, None).ok())
            .and_then(|manager_config| SpeechPackManager::open(manager_config).ok())
            .map(Arc::new);
        match opened {
            Some(manager) => Some(manager),
            None => {
                if wake_selected
                    || (local_stt && !android_gateway_fallback_allowed(&stages.stt))
                    || (local_tts && !android_gateway_fallback_allowed(&stages.tts))
                {
                    return Err(AndroidVoiceSessionCommandError::Unavailable);
                }
                local_stt = false;
                local_tts = false;
                None
            }
        }
    } else {
        None
    };

    let mut local_stt_provider = None;
    if local_stt {
        let manager = manager
            .as_ref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        let model_id = config
            .stt_model_id
            .as_deref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        match LazyInstalledSttProvider::new(Arc::clone(manager), model_id) {
            Ok(mut provider) => {
                provider
                    .binding
                    .validate_language(android_stage_language(&stages.stt))
                    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
                if provider.preload().is_ok() {
                    local_stt_provider = Some(AndroidFiniteSttProvider::Local(Box::new(provider)));
                } else if android_gateway_fallback_allowed(&stages.stt) {
                    local_stt = false;
                } else {
                    return Err(AndroidVoiceSessionCommandError::Unavailable);
                }
            }
            Err(_) if android_gateway_fallback_allowed(&stages.stt) => local_stt = false,
            Err(_) => return Err(AndroidVoiceSessionCommandError::Unavailable),
        }
    }

    let mut local_tts_provider = None;
    if local_tts {
        let manager = manager
            .as_ref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        let voice_id = config
            .tts_voice_id
            .as_deref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        match LazyInstalledTtsProvider::new(
            Arc::clone(manager),
            voice_id,
            config.tts_reference_profile.clone(),
        ) {
            Ok(mut provider) => {
                provider
                    .binding
                    .validate_language(android_stage_language(&stages.tts))
                    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
                if provider.preload().is_ok() {
                    local_tts_provider = Some(AndroidTtsProvider::Local(Box::new(provider)));
                } else if android_gateway_fallback_allowed(&stages.tts) {
                    local_tts = false;
                } else {
                    return Err(AndroidVoiceSessionCommandError::Unavailable);
                }
            }
            Err(_) if android_gateway_fallback_allowed(&stages.tts) => local_tts = false,
            Err(_) => return Err(AndroidVoiceSessionCommandError::Unavailable),
        }
    }

    let mesh_stt_selected = !local_stt && android_mesh_stage_route(&stages.stt, false)?.is_some();
    let mesh_tts_selected = !local_tts && android_mesh_stage_route(&stages.tts, false)?.is_some();
    if !local_tts
        && !mesh_tts_selected
        && matches!(
            &stages.tts.model_id,
            aurora_voice_core::node_policy::NullableField::Value(_)
        )
    {
        // The existing Gateway TTS port accepts a route and voice identifier, not a model id.
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }

    let gateway_stt_model = if local_stt {
        None
    } else {
        match &stages.stt.model_id {
            aurora_voice_core::node_policy::NullableField::Value(model) => Some(model.clone()),
            aurora_voice_core::node_policy::NullableField::Missing
            | aurora_voice_core::node_policy::NullableField::Null => None,
        }
    };
    let gateway_policy = if (!local_stt && !mesh_stt_selected) || (!local_tts && !mesh_tts_selected)
    {
        Some(android_gateway_audio_policy(config)?)
    } else {
        None
    };
    let gateway_limits = gateway_policy.map(transport_limits);

    let stt = if local_stt {
        local_stt_provider.ok_or(AndroidVoiceSessionCommandError::Unavailable)?
    } else if let Some(route) = android_mesh_stage_route(&stages.stt, false)? {
        build_android_mesh_stt(config, &route)?
    } else {
        let gateway = config
            .gateway
            .as_ref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        let limits = gateway_limits.ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        let route = RouteFiniteSttBinding::new(
            "gateway.default",
            if matches!(gateway_policy, Some(MicrophoneAudioPolicy::LoopbackOnly)) {
                FiniteSttRouteScope::LoopbackSidecar
            } else {
                FiniteSttRouteScope::RemoteGateway
            },
            VAD_SAMPLE_RATE_HZ,
            MAX_FINITE_STT_SAMPLES.min(16_000 * 30),
            ROUTE_REVISION,
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let transport = NativeGatewayTransport::new(gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let provider = NativeGatewayFiniteStt::new(
            transport,
            NativeGatewayFiniteSttConfig::new(
                route,
                gateway_stt_model.unwrap_or_else(|| "realtime".to_owned()),
                gateway_policy.ok_or(AndroidVoiceSessionCommandError::Unavailable)?,
            )
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        AndroidFiniteSttProvider::Gateway(Box::new(provider))
    };

    let tts = if local_tts {
        local_tts_provider.ok_or(AndroidVoiceSessionCommandError::Unavailable)?
    } else if let Some(route) = android_mesh_stage_route(&stages.tts, false)? {
        build_android_mesh_tts(&route)?
    } else {
        let gateway = config
            .gateway
            .as_ref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        let limits = gateway_limits.ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        let route = RouteTtsBinding::new(
            "gateway.default",
            "voice.default",
            VAD_SAMPLE_RATE_HZ,
            ROUTE_REVISION,
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let transport = NativeGatewayTransport::new(gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let provider = NativeGatewayTtsSynthesizer::new(
            transport,
            NativeGatewayTtsConfig::new(route, None, 1.0, 16_000 * 30)
                .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
        );
        AndroidTtsProvider::Gateway(Box::new(provider))
    };

    let assistant_policy = match gateway_policy {
        Some(policy) => policy,
        None => microphone_policy(config)?,
    };
    let assistant_limits = gateway_limits.unwrap_or_else(|| transport_limits(assistant_policy));
    let assistant_transport = build_assistant_transport(config, assistant_limits)?;
    let mut runtime = VoiceRuntime::new(
        input,
        stt,
        tts,
        assistant_transport,
        output,
        sink,
        ANDROID_SURFACE,
        ANDROID_RUNTIME_ID,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?
    .with_speech_languages(
        android_stage_language(&stages.stt).map(str::to_owned),
        android_stage_language(&stages.tts).map(str::to_owned),
    );
    if let Some(manager) = manager.as_ref() {
        if let Some((vad, kws, wake_config)) = build_wake_runtime_parts(manager.as_ref(), config)? {
            runtime = runtime
                .with_wake_providers(Box::new(vad), Box::new(kws), wake_config)
                .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        }
    }
    Ok(runtime)
}

fn android_gateway_audio_policy(
    config: &AndroidVoiceSessionConfig,
) -> Result<MicrophoneAudioPolicy, AndroidVoiceSessionCommandError> {
    let gateway = config
        .gateway
        .as_ref()
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    if gateway.scheme() == "http" && is_loopback(gateway) {
        Ok(MicrophoneAudioPolicy::LoopbackOnly)
    } else if config.remote_audio_consent {
        Ok(MicrophoneAudioPolicy::ExplicitRemoteConsent)
    } else {
        Err(AndroidVoiceSessionCommandError::Unavailable)
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
    let manager = Arc::new(
        SpeechPackManager::open(
            SpeechPackManagerConfig::new(store_root, None)
                .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    );
    let mut stt = LazyInstalledSttProvider::new(Arc::clone(&manager), stt_model_id)
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    stt.preload()
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let mut tts = LazyInstalledTtsProvider::new(
        Arc::clone(&manager),
        tts_voice_id,
        config.tts_reference_profile.clone(),
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    tts.preload()
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let policy = microphone_policy(config)?;
    let limits = transport_limits(policy);
    let transport_for_assistant = build_assistant_transport(config, limits)?;
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
    if let Some((vad, kws, wake_config)) = build_wake_runtime_parts(manager.as_ref(), config)? {
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
    let phrase_input = SherpaKwsPhraseInput::new(phrase_id, phrase_text)
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let kws = build_installed_kws_provider_from_phrases(
        manager,
        kws_model_id,
        phrase_revision,
        [phrase_input],
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let vad_binding = vad.binding().clone();
    let kws_binding = kws.binding().clone();
    let kws_config = KwsConfig::new(
        [phrase_id.to_owned()],
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
    if config.speech_stages.is_none()
        && (config.pack_store_root.is_some()
            || config.stt_model_id.is_some()
            || config.tts_voice_id.is_some()
            || config.vad_model_id.is_some()
            || config.kws_model_id.is_some())
    {
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }
    if let Some(stages) = config.speech_stages.as_ref() {
        if matches!(
            &stages.tts.model_id,
            aurora_voice_core::node_policy::NullableField::Value(_)
        ) {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
    }
    let gateway = config
        .gateway
        .as_ref()
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let policy = if gateway.scheme() == "http" && is_loopback(gateway) {
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
        NativeGatewayTransport::new(gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let transport_for_tts =
        NativeGatewayTransport::new(gateway.clone(), config.auth.clone(), limits)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let transport_for_assistant = build_assistant_transport(config, limits)?;
    let stt_model_id = config
        .speech_stages
        .as_ref()
        .and_then(|stages| match &stages.stt.model_id {
            aurora_voice_core::node_policy::NullableField::Value(model) => Some(model.clone()),
            aurora_voice_core::node_policy::NullableField::Missing
            | aurora_voice_core::node_policy::NullableField::Null => None,
        })
        .unwrap_or_else(|| "realtime".to_owned());
    let stt = NativeGatewayFiniteStt::new(
        transport_for_stt,
        NativeGatewayFiniteSttConfig::new(stt_route, stt_model_id, policy)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let tts = NativeGatewayTtsSynthesizer::new(
        transport_for_tts,
        NativeGatewayTtsConfig::new(tts_route, None, 1.0, 16_000 * 30)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    );
    let stt = AndroidFiniteSttProvider::Gateway(Box::new(stt));
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
    .map(|runtime| {
        runtime.with_speech_languages(
            config
                .speech_stages
                .as_ref()
                .and_then(|stages| android_stage_language(&stages.stt).map(str::to_owned)),
            config
                .speech_stages
                .as_ref()
                .and_then(|stages| android_stage_language(&stages.tts).map(str::to_owned)),
        )
    })
}

fn build_assistant_transport(
    config: &AndroidVoiceSessionConfig,
    limits: TransportLimits,
) -> Result<AndroidAssistantTransport, AndroidVoiceSessionCommandError> {
    match config.assistant_route_mode {
        AndroidAssistantRouteMode::HttpOnly => {
            let gateway = config
                .gateway
                .clone()
                .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
            NativeGatewayTransport::new(gateway, config.auth.clone(), limits)
                .map(AndroidAssistantTransport::Gateway)
                .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)
        }
        AndroidAssistantRouteMode::WebRtcPreferred | AndroidAssistantRouteMode::WebRtcOnly => {
            NativeMeshAssistantSpeechTransport::new(
                NativeMeshAssistantRoute::new(config.preferred_stable_peer_id.clone())
                    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
                limits,
            )
            .map(AndroidAssistantTransport::Mesh)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)
        }
        AndroidAssistantRouteMode::LocalOnly => Ok(AndroidAssistantTransport::Unavailable),
    }
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn microphone_policy(
    config: &AndroidVoiceSessionConfig,
) -> Result<MicrophoneAudioPolicy, AndroidVoiceSessionCommandError> {
    if matches!(
        config.assistant_route_mode,
        AndroidAssistantRouteMode::WebRtcOnly | AndroidAssistantRouteMode::LocalOnly
    ) {
        // The local providers consume microphone PCM on-device. The mesh
        // assistant receives only the resulting text request.
        Ok(MicrophoneAudioPolicy::LoopbackOnly)
    } else if config.gateway.as_ref().is_some_and(is_loopback) {
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

struct AndroidSessionThreadState {
    status: Arc<Mutex<AndroidVoiceSessionStatus>>,
    focused_transcript: Arc<Mutex<Option<String>>>,
    turn_transcript: Arc<Mutex<Option<(Generation, String, NativeVoiceObservationToken)>>>,
    background_results: Arc<Mutex<VecDeque<AndroidBackgroundVoiceTurnResult>>>,
    observation_tokens: Arc<Mutex<HashMap<Generation, NativeVoiceObservationToken>>>,
    control: AndroidCaptureControl,
    lifecycle: MobileSessionLifecycle,
}

fn run_session_thread(
    config: AndroidVoiceSessionConfig,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
    commands: tokio_mpsc::UnboundedReceiver<Command>,
    state: AndroidSessionThreadState,
) {
    run_session_thread_with_builder(config, input, output, sink, commands, state, build_runtime);
}

fn run_session_thread_with_builder(
    config: AndroidVoiceSessionConfig,
    input: AndroidAudioInput,
    output: AndroidAudioOutput,
    sink: AndroidSessionSink,
    commands: tokio_mpsc::UnboundedReceiver<Command>,
    state: AndroidSessionThreadState,
    build: impl FnOnce(
        &AndroidVoiceSessionConfig,
        AndroidAudioInput,
        AndroidAudioOutput,
        AndroidSessionSink,
    ) -> Result<RuntimeCore, AndroidVoiceSessionCommandError>,
) {
    let lifecycle = state.lifecycle.clone();
    let remote_audio_consent = config.remote_audio_consent;
    let voice_runtime = match build(&config, input, output, sink) {
        Ok(runtime) => runtime,
        Err(_) => {
            lifecycle.record_failure(MobileSessionCloseError::Unavailable);
            set_fault(&state.status, "runtime_unavailable");
            return;
        }
    };
    let tokio_runtime = match TokioRuntimeBuilder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            lifecycle.record_failure(MobileSessionCloseError::Unavailable);
            set_fault(&state.status, "runtime_unavailable");
            return;
        }
    };
    tokio_runtime.block_on(run_session_loop(
        voice_runtime,
        commands,
        state,
        remote_audio_consent,
    ));
}

async fn run_session_loop<R: AndroidSessionRuntime>(
    mut voice_runtime: R,
    mut commands: tokio_mpsc::UnboundedReceiver<Command>,
    state: AndroidSessionThreadState,
    remote_audio_consent: bool,
) {
    let lifecycle = state.lifecycle.clone();
    loop {
        if lifecycle.is_retired() {
            reject_queued_commands(&mut commands);
            break;
        }
        let Some(command) = commands.recv().await else {
            if let Some(generation) = lifecycle.unexpected_channel_close() {
                state.control.interrupt(generation);
            }
            break;
        };
        match command {
            Command::Start { mode, reply } => {
                if lifecycle.is_retired() {
                    let _ = reply.send(Err(AndroidVoiceSessionCommandError::Unavailable));
                    continue;
                }
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
                if lifecycle
                    .begin_generation(generation, cancellation.clone())
                    .is_err()
                {
                    let _ = reply.send(Err(AndroidVoiceSessionCommandError::Unavailable));
                    continue;
                }
                let observation_token = begin_native_voice_observation_producer();
                if let Some(token) = observation_token {
                    if let Ok(mut tokens) = state.observation_tokens.lock() {
                        tokens.clear();
                        tokens.insert(generation, token);
                    }
                }
                if matches!(mode, AndroidVoiceStartMode::PushToTalk) {
                    if let Ok(mut transcript) = state.focused_transcript.lock() {
                        *transcript = None;
                    }
                }
                if let Ok(mut transcript) = state.turn_transcript.lock() {
                    *transcript = None;
                }
                set_active(&state.status, generation);
                if let Some(token) = observation_token {
                    observe_android_turn_snapshot(token, generation, "started", None, None, false);
                }
                let _ = reply.send(Ok(generation));
                let result = run_turn(
                    &mut voice_runtime,
                    &mut commands,
                    AndroidTurnContext {
                        mode,
                        lease,
                        at: now,
                        cancellation,
                        control: state.control.clone(),
                        lifecycle: lifecycle.clone(),
                    },
                )
                .await;
                lifecycle.record_cleanup(
                    generation,
                    voice_runtime.cleanup_report_for_generation(generation),
                );
                finish_status(&state, generation, mode, result);
                if lifecycle.is_retired() {
                    reject_queued_commands(&mut commands);
                    break;
                }
            }
            Command::Shutdown => {
                if let Some(generation) = lifecycle.worker_retire() {
                    state.control.interrupt(generation);
                }
                reject_queued_commands(&mut commands);
                break;
            }
            Command::Finish { reply, .. } | Command::Cancel { reply, .. } => {
                let _ = reply.send(Err(AndroidVoiceSessionCommandError::NotActive));
            }
        }
    }
}

struct AndroidTurnContext {
    mode: AndroidVoiceStartMode,
    lease: VoiceCaptureLease,
    at: TimestampMicros,
    cancellation: CancellationToken,
    control: AndroidCaptureControl,
    lifecycle: MobileSessionLifecycle,
}

async fn run_turn<'a, R: AndroidSessionRuntime>(
    runtime: &'a mut R,
    commands: &'a mut tokio_mpsc::UnboundedReceiver<Command>,
    context: AndroidTurnContext,
) -> Result<String, VoiceCoreError> {
    let AndroidTurnContext {
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
                let _ = reply.send(Err(AndroidVoiceSessionCommandError::Unavailable));
            }
            Command::Finish { reply, .. } | Command::Cancel { reply, .. } => {
                let _ = reply.send(Err(AndroidVoiceSessionCommandError::Closed));
            }
            Command::Shutdown => {}
        }
    }
}

#[derive(Clone)]
struct AndroidSessionSink {
    status: Arc<Mutex<AndroidVoiceSessionStatus>>,
    turn_transcript: Arc<Mutex<Option<(Generation, String, NativeVoiceObservationToken)>>>,
    observation_tokens: Arc<Mutex<HashMap<Generation, NativeVoiceObservationToken>>>,
}

#[async_trait(?Send)]
impl RuntimeEventSink for AndroidSessionSink {
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
        let phase = phase_for_state(snapshot.state);
        if let Ok(mut status) = self.status.lock() {
            update_session_phase(&mut status, snapshot.state, snapshot.generation);
        }
        if let Some(token) = token_for_generation(&self.observation_tokens, snapshot.generation) {
            observe_android_turn_snapshot(
                token,
                snapshot.generation,
                observation_status_for_phase(phase),
                None,
                None,
                false,
            );
        }
        Ok(())
    }

    async fn event(&mut self, event: RuntimeEvent) -> Result<(), VoiceCoreError> {
        match event {
            RuntimeEvent::State { transition } => {
                let phase = phase_for_state(transition.to);
                if let Ok(mut status) = self.status.lock() {
                    update_session_phase(&mut status, transition.to, transition.generation);
                }
                if let Some(token) =
                    token_for_generation(&self.observation_tokens, transition.generation)
                {
                    observe_android_turn_snapshot(
                        token,
                        transition.generation,
                        observation_status_for_phase(phase),
                        None,
                        None,
                        false,
                    );
                }
            }
            RuntimeEvent::Transcript {
                generation,
                partial: false,
                text,
                ..
            } => {
                let text = text.trim();
                if !text.is_empty() {
                    let Some(token) = token_for_generation(&self.observation_tokens, generation)
                    else {
                        return Ok(());
                    };
                    if let Ok(mut transcript) = self.turn_transcript.lock() {
                        *transcript = Some((generation, text.to_owned(), token));
                    }
                    observe_android_turn_snapshot(
                        token,
                        generation,
                        "transcribed",
                        Some(text),
                        None,
                        false,
                    );
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn token_for_generation(
    observation_tokens: &Arc<Mutex<HashMap<Generation, NativeVoiceObservationToken>>>,
    generation: Generation,
) -> Option<NativeVoiceObservationToken> {
    observation_tokens
        .lock()
        .ok()
        .and_then(|tokens| tokens.get(&generation).copied())
}

fn observe_android_turn_snapshot(
    token: NativeVoiceObservationToken,
    generation: Generation,
    status: &str,
    transcript: Option<&str>,
    accumulated_text: Option<&str>,
    terminal: bool,
) {
    let mut snapshot = NativeVoiceTurnSnapshot::new(
        NativeVoiceTurnIds::from_generation(generation),
        status.to_owned(),
    )
    .terminal(terminal);
    if let Some(transcript) = transcript {
        snapshot = snapshot.with_transcript(transcript);
    }
    if let Some(text) = accumulated_text {
        snapshot = snapshot.with_text(text);
    }
    observe_native_voice(token, NativeVoiceObservation::TurnSnapshot { snapshot });
}

fn observation_status_for_phase(phase: AndroidVoiceSessionPhase) -> &'static str {
    match phase {
        AndroidVoiceSessionPhase::Idle => "idle",
        AndroidVoiceSessionPhase::Starting => "started",
        AndroidVoiceSessionPhase::Listening
        | AndroidVoiceSessionPhase::WaitingForWake
        | AndroidVoiceSessionPhase::Transcribing => "listening",
        AndroidVoiceSessionPhase::Processing
        | AndroidVoiceSessionPhase::WaitingForResponse
        | AndroidVoiceSessionPhase::PreparingSpeech => "processing",
        AndroidVoiceSessionPhase::Speaking => "speaking",
        AndroidVoiceSessionPhase::Stopping => "stopping",
        AndroidVoiceSessionPhase::Faulted => "failed",
    }
}

fn update_session_phase(
    status: &mut AndroidVoiceSessionStatus,
    state: VoiceState,
    generation: Generation,
) {
    let phase = phase_for_state(state);
    // Runtime cleanup always emits Stopping -> Idle before returning an error.
    // Keep the last active work phase until finish_status classifies the result;
    // otherwise a TTS/playback failure is incorrectly reported as an STT failure.
    if !status.active
        || !matches!(
            phase,
            AndroidVoiceSessionPhase::Stopping | AndroidVoiceSessionPhase::Idle
        )
    {
        status.phase = phase;
    }
    status.generation = Some(generation);
}

fn phase_for_state(state: VoiceState) -> AndroidVoiceSessionPhase {
    match state {
        VoiceState::Arming => AndroidVoiceSessionPhase::Starting,
        VoiceState::ListeningForWake => AndroidVoiceSessionPhase::WaitingForWake,
        VoiceState::WakeDetected | VoiceState::CapturingUtterance => {
            AndroidVoiceSessionPhase::Listening
        }
        VoiceState::Transcribing => AndroidVoiceSessionPhase::Transcribing,
        VoiceState::Dispatching => AndroidVoiceSessionPhase::WaitingForResponse,
        VoiceState::AwaitingResponse => AndroidVoiceSessionPhase::PreparingSpeech,
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

fn finish_status(
    state: &AndroidSessionThreadState,
    active_generation: Generation,
    mode: AndroidVoiceStartMode,
    result: Result<String, VoiceCoreError>,
) {
    let AndroidSessionThreadState {
        status,
        focused_transcript,
        turn_transcript,
        background_results,
        observation_tokens,
        ..
    } = state;
    let captured_transcript = turn_transcript
        .lock()
        .ok()
        .and_then(|mut transcript| transcript.take());
    if let Ok(mut tokens) = observation_tokens.lock() {
        tokens.remove(&active_generation);
    }
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
            Ok(transcript) => {
                status.completed_turns = status.completed_turns.saturating_add(1);
                if matches!(mode, AndroidVoiceStartMode::PushToTalk) {
                    if let Ok(mut result) = focused_transcript.lock() {
                        *result = Some(transcript);
                    }
                } else if let Some((generation, captured, token)) = captured_transcript {
                    push_background_result(
                        background_results,
                        AndroidBackgroundVoiceTurnResult {
                            generation,
                            observation_token: token.to_wire(),
                            transcript: captured.clone(),
                            assistant_text: Some(transcript.clone()),
                            error_code: None,
                        },
                    );
                    observe_android_turn_snapshot(
                        token,
                        generation,
                        "background_completed",
                        Some(&captured),
                        Some(&transcript),
                        true,
                    );
                }
            }
            Err(error) => {
                status.failed_turns = status.failed_turns.saturating_add(1);
                let code = error_code(&error, terminal_phase);
                eprintln!(
                    "aurora_android_voice_turn_failed phase={terminal_phase:?} reason={code} error={error}"
                );
                status.last_error = Some(code.to_owned());
                if matches!(mode, AndroidVoiceStartMode::BackgroundSession) {
                    if let Some((generation, captured, token)) = captured_transcript {
                        push_background_result(
                            background_results,
                            AndroidBackgroundVoiceTurnResult {
                                generation,
                                observation_token: token.to_wire(),
                                transcript: captured.clone(),
                                assistant_text: None,
                                error_code: Some(code.to_owned()),
                            },
                        );
                        observe_native_voice(
                            token,
                            NativeVoiceObservation::AssistantFailed {
                                ids: NativeVoiceTurnIds::from_generation(generation),
                                reason_code: code.to_owned(),
                            },
                        );
                        observe_android_turn_snapshot(
                            token,
                            generation,
                            "background_failed",
                            Some(&captured),
                            None,
                            true,
                        );
                    }
                }
            }
        }
    }
}

fn push_background_result(
    background_results: &Arc<Mutex<VecDeque<AndroidBackgroundVoiceTurnResult>>>,
    result: AndroidBackgroundVoiceTurnResult,
) {
    if let Ok(mut results) = background_results.lock() {
        while results.len() >= MAX_BACKGROUND_TURN_RESULTS {
            results.pop_front();
        }
        results.push_back(result);
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
        VoiceCoreError::Engine(_)
            if matches!(
                terminal_phase,
                AndroidVoiceSessionPhase::PreparingSpeech | AndroidVoiceSessionPhase::Speaking
            ) =>
        {
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

/// A capture-only Android session used by background transcript recording.
/// It constructs only the selected finite STT provider and Android PCM input;
/// assistant transport, TTS, playback, KWS, and VAD are deliberately absent.
pub struct AndroidTranscriptionSession {
    ingress: AndroidPcmIngress,
    control: AndroidCaptureControl,
    commands: mpsc::Sender<TranscriptionCommand>,
    status: Arc<Mutex<AndroidTranscriptionStatus>>,
    active_cancellation: Arc<Mutex<Option<(Generation, CancellationToken)>>>,
    transcript: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AndroidTranscriptionPhase {
    Idle = 0,
    Starting = 1,
    Listening = 2,
    Transcribing = 3,
    Completed = 4,
    Failed = 5,
}

#[derive(Debug, Clone)]
pub struct AndroidTranscriptionStatus {
    pub phase: AndroidTranscriptionPhase,
    pub generation: u64,
    pub accepted_chunks: u64,
    pub accepted_samples: u64,
    pub dropped_chunks: u64,
    pub queued_chunks: u32,
    pub capture_started_at_ms: i64,
    pub capture_ended_at_ms: i64,
    pub error: Option<&'static str>,
}

impl Default for AndroidTranscriptionStatus {
    fn default() -> Self {
        Self {
            phase: AndroidTranscriptionPhase::Idle,
            generation: 0,
            accepted_chunks: 0,
            accepted_samples: 0,
            dropped_chunks: 0,
            queued_chunks: 0,
            capture_started_at_ms: 0,
            capture_ended_at_ms: 0,
            error: None,
        }
    }
}

enum TranscriptionCommand {
    Start {
        generation: Generation,
        background_eligible: bool,
        reply: mpsc::Sender<Result<(), AndroidVoiceSessionCommandError>>,
    },
    Shutdown,
}

type AndroidTranscriptionStt = AndroidFiniteSttProvider;

impl AndroidTranscriptionSession {
    pub fn new(
        config: AndroidVoiceSessionConfig,
        ingress_capacity_chunks: usize,
        max_chunk_samples: usize,
    ) -> Result<Self, AndroidVoiceSessionCommandError> {
        let language =
            config
                .speech_stages
                .as_ref()
                .and_then(|stages| match &stages.stt.language {
                    aurora_voice_core::node_policy::NullableField::Value(value) => {
                        Some(value.clone())
                    }
                    aurora_voice_core::node_policy::NullableField::Missing
                    | aurora_voice_core::node_policy::NullableField::Null => None,
                });
        let ingress = AndroidPcmIngress::new(ingress_capacity_chunks, max_chunk_samples);
        let input = AndroidAudioInput::new(ingress.clone());
        let control = input.control();
        let status = Arc::new(Mutex::new(AndroidTranscriptionStatus::default()));
        let active_cancellation = Arc::new(Mutex::new(None));
        let transcript = Arc::new(Mutex::new(None));
        let (commands, command_rx) = mpsc::channel();
        let worker_status = Arc::clone(&status);
        let worker_cancellation = Arc::clone(&active_cancellation);
        let worker_ingress = ingress.clone();
        let worker_transcript = Arc::clone(&transcript);
        let worker = thread::Builder::new()
            .name("aurora-android-transcription".to_owned())
            .spawn(move || {
                let Ok(runtime) = TokioRuntimeBuilder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    set_transcription_status(
                        &worker_status,
                        AndroidTranscriptionPhase::Failed,
                        0,
                        Some("runtime_unavailable"),
                    );
                    return;
                };
                let mut input = input;
                // Native recognizers are confined to their owning worker.
                let mut stt = match build_transcription_stt(&config) {
                    Ok(provider) => provider,
                    Err(_) => {
                        set_transcription_status(
                            &worker_status,
                            AndroidTranscriptionPhase::Failed,
                            0,
                            Some("stt_unavailable"),
                        );
                        return;
                    }
                };
                while let Ok(command) = command_rx.recv() {
                    match command {
                        TranscriptionCommand::Start {
                            generation,
                            background_eligible,
                            reply,
                        } => {
                            if matches!(
                                worker_status.lock().map(|state| state.phase),
                                Ok(AndroidTranscriptionPhase::Starting
                                    | AndroidTranscriptionPhase::Listening
                                    | AndroidTranscriptionPhase::Transcribing)
                            ) {
                                let _ =
                                    reply.send(Err(AndroidVoiceSessionCommandError::AlreadyActive));
                                continue;
                            }
                            let now = now_micros();
                            let lease = VoiceCaptureLease {
                                owner: CaptureOwnerKind::Native,
                                surface: ANDROID_SURFACE.to_owned(),
                                device_route: "default".to_owned(),
                                start_reason: CaptureStartReason::BackgroundSession,
                                generation,
                                created_at: now,
                                route_revision: RouteRevision(ROUTE_REVISION),
                                background_eligible,
                                consent_revision: if config.remote_audio_consent { 1 } else { 0 },
                                heartbeat_at: now,
                                stop_deadline: None,
                            };
                            let cancellation = CancellationToken::new();
                            if let Ok(mut active) = worker_cancellation.lock() {
                                *active = Some((generation, cancellation.clone()));
                            }
                            set_transcription_status(
                                &worker_status,
                                AndroidTranscriptionPhase::Starting,
                                generation.0,
                                None,
                            );
                            if runtime.block_on(input.start(lease.clone())).is_err() {
                                set_transcription_status(
                                    &worker_status,
                                    AndroidTranscriptionPhase::Failed,
                                    generation.0,
                                    Some("capture_unavailable"),
                                );
                                let _ =
                                    reply.send(Err(AndroidVoiceSessionCommandError::Unavailable));
                                continue;
                            }
                            if let Ok(mut state) = worker_status.lock() {
                                state.capture_started_at_ms = wall_clock_ms();
                                state.capture_ended_at_ms = 0;
                            }
                            set_transcription_status(
                                &worker_status,
                                AndroidTranscriptionPhase::Listening,
                                generation.0,
                                None,
                            );
                            let _ = reply.send(Ok(()));
                            let result = runtime.block_on(run_transcription_capture(
                                &mut input,
                                &mut stt,
                                &lease,
                                cancellation,
                                &worker_status,
                                language.as_deref(),
                            ));
                            let _ = runtime.block_on(input.stop(TransitionReason::Stop));
                            let (phase, error) = match result {
                                Ok(text) => {
                                    if let Ok(mut state) = worker_status.lock() {
                                        state.error = None;
                                    }
                                    if let Ok(mut transcript) = worker_transcript.lock() {
                                        *transcript = Some(text);
                                    }
                                    (AndroidTranscriptionPhase::Completed, None)
                                }
                                Err(VoiceCoreError::Cancelled) => {
                                    (AndroidTranscriptionPhase::Failed, Some("cancelled"))
                                }
                                Err(_) => (
                                    AndroidTranscriptionPhase::Failed,
                                    Some("transcription_failed"),
                                ),
                            };
                            worker_ingress.clear_pending();
                            set_transcription_status(&worker_status, phase, generation.0, error);
                            if let Ok(mut active) = worker_cancellation.lock() {
                                *active = None;
                            }
                        }
                        TranscriptionCommand::Shutdown => break,
                    }
                }
                let _ = runtime.block_on(input.stop(TransitionReason::Stop));
            })
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        Ok(Self {
            ingress,
            control,
            commands,
            status,
            active_cancellation,
            transcript,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn ingress(&self) -> AndroidPcmIngress {
        self.ingress.clone()
    }

    pub fn start(
        &self,
        generation: u64,
        background_eligible: bool,
    ) -> Result<(), AndroidVoiceSessionCommandError> {
        let (reply, result) = mpsc::channel();
        self.commands
            .send(TranscriptionCommand::Start {
                generation: Generation(generation),
                background_eligible,
                reply,
            })
            .map_err(|_| AndroidVoiceSessionCommandError::Closed)?;
        result
            .recv()
            .unwrap_or(Err(AndroidVoiceSessionCommandError::Closed))
    }

    pub fn finish(&self, generation: u64) -> Result<(), AndroidVoiceSessionCommandError> {
        let active = self.status.lock().ok().map(|state| state.generation);
        if active != Some(generation) {
            return Err(AndroidVoiceSessionCommandError::NotActive);
        }
        self.control.finish(Generation(generation));
        Ok(())
    }

    pub fn cancel(&self, generation: u64) -> Result<(), AndroidVoiceSessionCommandError> {
        let active = self.status.lock().ok().map(|state| state.generation);
        if active != Some(generation) {
            return Err(AndroidVoiceSessionCommandError::NotActive);
        }
        if let Ok(active) = self.active_cancellation.lock() {
            if let Some((active_generation, cancellation)) = active.as_ref() {
                if *active_generation == Generation(generation) {
                    cancellation.cancel();
                    self.control.interrupt(*active_generation);
                }
            }
        }
        Ok(())
    }

    pub fn take_transcript(&self) -> Option<String> {
        self.transcript.lock().ok()?.take()
    }

    pub fn status(&self) -> AndroidTranscriptionStatus {
        let mut status = self
            .status
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        let ingress = self.ingress.stats();
        status.accepted_chunks = ingress.accepted_chunks;
        status.accepted_samples = ingress.accepted_samples;
        status.dropped_chunks = ingress.dropped_chunks;
        status.queued_chunks = ingress.queued_chunks;
        status
    }

    pub fn close(&self) {
        if let Ok(active) = self.active_cancellation.lock() {
            if let Some((generation, cancellation)) = active.as_ref() {
                cancellation.cancel();
                self.control.interrupt(*generation);
            }
        }
        let _ = self.commands.send(TranscriptionCommand::Shutdown);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                if worker.thread().id() != thread::current().id() {
                    let _ = worker.join();
                }
            }
        }
    }
}

impl Drop for AndroidTranscriptionSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn set_transcription_status(
    status: &Arc<Mutex<AndroidTranscriptionStatus>>,
    phase: AndroidTranscriptionPhase,
    generation: u64,
    error: Option<&'static str>,
) {
    if let Ok(mut status) = status.lock() {
        status.phase = phase;
        status.generation = generation;
        status.error = error;
    }
}

fn wall_clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
fn build_transcription_stt(
    config: &AndroidVoiceSessionConfig,
) -> Result<AndroidTranscriptionStt, AndroidVoiceSessionCommandError> {
    let stages = config
        .speech_stages
        .as_ref()
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let local_available = config.pack_store_root.is_some()
        && config
            .stt_model_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    if let Some(route) = android_mesh_stage_route(&stages.stt, local_available)? {
        return build_android_mesh_stt(config, &route);
    }
    let local = validate_android_stage_provider(config, &stages.stt, local_available, false)?;
    if local {
        let model_id = config
            .stt_model_id
            .as_deref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        validate_android_local_model_selector(&stages.stt, model_id)?;
        let manager = config
            .pack_store_root
            .clone()
            .and_then(|root| SpeechPackManagerConfig::new(root, None).ok())
            .and_then(|manager_config| SpeechPackManager::open(manager_config).ok())
            .map(Arc::new);
        if let Some(manager) = manager {
            match LazyInstalledSttProvider::new(manager, model_id) {
                Ok(mut provider) => {
                    provider
                        .binding
                        .validate_language(android_stage_language(&stages.stt))
                        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
                    if provider.preload().is_ok() {
                        return Ok(AndroidFiniteSttProvider::Local(Box::new(provider)));
                    }
                }
                Err(_) => {}
            }
        }
        if !android_gateway_fallback_allowed(&stages.stt) {
            return Err(AndroidVoiceSessionCommandError::Unavailable);
        }
    }
    if let Some(backend) = android_selected_speech_network_backend(&stages.stt, false)? {
        if backend == AndroidSpeechNetworkBackend::Mesh {
            let route = android_mesh_stage_route(&stages.stt, false)?
                .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
            return build_android_mesh_stt(config, &route);
        }
    } else {
        return Err(AndroidVoiceSessionCommandError::Unavailable);
    }
    {
        use aurora_voice_core::node_policy::NullableField;
        let gateway = config
            .gateway
            .as_ref()
            .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
        let policy = android_gateway_audio_policy(config)?;
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
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let model = match &stages.stt.model_id {
            NullableField::Value(value) => value.clone(),
            NullableField::Missing | NullableField::Null => "realtime".to_owned(),
        };
        let transport = NativeGatewayTransport::new(
            gateway.clone(),
            config.auth.clone(),
            transport_limits(policy),
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        let provider = NativeGatewayFiniteStt::new(
            transport,
            NativeGatewayFiniteSttConfig::new(route, model, policy)
                .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
        )
        .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
        Ok(AndroidFiniteSttProvider::Gateway(Box::new(provider)))
    }
}

#[cfg(not(all(feature = "native-sherpa", feature = "native-sherpa-tts")))]
fn build_transcription_stt(
    config: &AndroidVoiceSessionConfig,
) -> Result<AndroidTranscriptionStt, AndroidVoiceSessionCommandError> {
    let stages = config
        .speech_stages
        .as_ref()
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    match android_selected_speech_network_backend(&stages.stt, false)?
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?
    {
        AndroidSpeechNetworkBackend::Mesh => {
            let route = android_mesh_stage_route(&stages.stt, false)?
                .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
            return build_android_mesh_stt(config, &route);
        }
        AndroidSpeechNetworkBackend::Gateway => validate_android_gateway_stage(&stages.stt)?,
    }
    let gateway = config
        .gateway
        .as_ref()
        .ok_or(AndroidVoiceSessionCommandError::Unavailable)?;
    let policy = android_gateway_audio_policy(config)?;
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
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let transport = NativeGatewayTransport::new(
        gateway.clone(),
        config.auth.clone(),
        transport_limits(policy),
    )
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?;
    let model_id = match &stages.stt.model_id {
        aurora_voice_core::node_policy::NullableField::Value(model) => model.clone(),
        aurora_voice_core::node_policy::NullableField::Missing
        | aurora_voice_core::node_policy::NullableField::Null => "realtime".to_owned(),
    };
    NativeGatewayFiniteStt::new(
        transport,
        NativeGatewayFiniteSttConfig::new(route, model_id, policy)
            .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)?,
    )
    .map(|provider| AndroidFiniteSttProvider::Gateway(Box::new(provider)))
    .map_err(|_| AndroidVoiceSessionCommandError::Unavailable)
}

async fn run_transcription_capture<S: FiniteSttPort>(
    input: &mut AndroidAudioInput,
    stt: &mut S,
    lease: &VoiceCaptureLease,
    cancellation: CancellationToken,
    status: &Arc<Mutex<AndroidTranscriptionStatus>>,
    language: Option<&str>,
) -> Result<String, VoiceCoreError> {
    let binding = stt.finite_stt_binding()?;
    if binding.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
        || binding.channels() != aurora_voice_engine::MONO_CHANNELS
    {
        return Err(VoiceCoreError::InvalidTransition);
    }
    let language = language.map(str::to_owned);
    let mut audio = match binding {
        FiniteSttProviderBinding::LocalTask(binding) => {
            FiniteSttAudioBuilder::new(BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::SpeechToText,
                    language,
                    generation: lease.generation.0,
                },
                *binding,
            )?)?
        }
        FiniteSttProviderBinding::Route(route) => FiniteSttAudioBuilder::new_route(
            RouteFiniteSttRequest::new(route, language, lease.generation.0)?,
        )?,
    };
    let mut captured = false;
    while let Some(frame) = input.next_frame().await? {
        cancellation.check()?;
        if frame.generation() != lease.generation
            || frame.route_revision() != lease.route_revision
            || frame.discontinuity()
        {
            audio.clear();
            return Err(VoiceCoreError::InvalidTransition);
        }
        audio.push_frame(frame.samples())?;
        captured = true;
    }
    cancellation.check()?;
    if let Ok(mut state) = status.lock() {
        state.phase = AndroidTranscriptionPhase::Transcribing;
        state.capture_ended_at_ms = wall_clock_ms();
    }
    if !captured {
        return Ok(String::new());
    }
    let stt_binding = stt.finite_stt_binding()?;
    stt.warm_finite_stt(stt_binding).await?;
    let (request, audio) = audio.finish()?;
    let transcript = stt
        .transcribe_finite(request, audio, &|| cancellation.is_cancelled())
        .await?;
    cancellation.check()?;
    Ok(transcript.transcript().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AndroidPcmPushResult;
    use aurora_voice_core::{AssistantTurnRequest, AudioPlaybackContext, AudioPlaybackReceipt};
    use aurora_voice_engine::{
        BoundFiniteSttRequest, BoundTtsSynthesisRequest, FiniteSttAudio, FiniteSttProviderBinding,
        FiniteSttResult, TtsSynthesisResult,
    };
    use std::task::{Context, Poll, Wake, Waker};

    struct TranscriptionFlowTestStt {
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait(?Send)]
    impl FiniteSttPort for TranscriptionFlowTestStt {
        fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
            Ok(FiniteSttProviderBinding::Route(RouteFiniteSttBinding::new(
                "route.stt.transcription-flow",
                FiniteSttRouteScope::LoopbackSidecar,
                VAD_SAMPLE_RATE_HZ,
                MAX_FINITE_STT_SAMPLES,
                ROUTE_REVISION,
            )?))
        }

        async fn warm_finite_stt(
            &mut self,
            _binding: FiniteSttProviderBinding,
        ) -> Result<(), EngineError> {
            Ok(())
        }

        async fn transcribe_finite(
            &mut self,
            request: BoundFiniteSttRequest,
            audio: FiniteSttAudio,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<FiniteSttResult, EngineError> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            FiniteSttResult::new(&request, &audio, format!("transcript-{call}"))
        }

        async fn cancel_finite_stt_generation(
            &mut self,
            _generation: u64,
        ) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[test]
    fn finite_transcription_rearms_across_two_finished_native_capture_generations() {
        let ingress = AndroidPcmIngress::new(2, 128);
        let mut input = AndroidAudioInput::new(ingress.clone());
        let control = input.control();
        let mut stt = TranscriptionFlowTestStt {
            calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let status = Arc::new(Mutex::new(AndroidTranscriptionStatus::default()));
        let runtime = TokioRuntimeBuilder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");

        for generation in [1_u64, 2_u64] {
            runtime.block_on(async {
                let at = TimestampMicros(generation.saturating_mul(1_000_000));
                let lease = VoiceCaptureLease {
                    owner: CaptureOwnerKind::Native,
                    surface: ANDROID_SURFACE.to_owned(),
                    device_route: "default".to_owned(),
                    start_reason: CaptureStartReason::BackgroundSession,
                    generation: Generation(generation),
                    created_at: at,
                    route_revision: RouteRevision(ROUTE_REVISION),
                    background_eligible: true,
                    consent_revision: 1,
                    heartbeat_at: at,
                    stop_deadline: None,
                };
                input.start(lease.clone()).await.expect("capture start");
                assert_eq!(ingress.push(&[100; 64], 0), AndroidPcmPushResult::Accepted);
                control.finish(lease.generation);
                let transcript = run_transcription_capture(
                    &mut input,
                    &mut stt,
                    &lease,
                    CancellationToken::new(),
                    &status,
                    None,
                )
                .await
                .expect("finite transcription");
                assert_eq!(transcript, format!("transcript-{generation}"));
                input
                    .stop(TransitionReason::Stop)
                    .await
                    .expect("capture stop");
            });
        }
        runtime.block_on(async {
            let at = TimestampMicros(3_000_000);
            let lease = VoiceCaptureLease {
                owner: CaptureOwnerKind::Native,
                surface: ANDROID_SURFACE.to_owned(),
                device_route: "default".to_owned(),
                start_reason: CaptureStartReason::BackgroundSession,
                generation: Generation(3),
                created_at: at,
                route_revision: RouteRevision(ROUTE_REVISION),
                background_eligible: true,
                consent_revision: 1,
                heartbeat_at: at,
                stop_deadline: None,
            };
            input
                .start(lease.clone())
                .await
                .expect("empty capture start");
            control.finish(lease.generation);
            assert_eq!(
                run_transcription_capture(
                    &mut input,
                    &mut stt,
                    &lease,
                    CancellationToken::new(),
                    &status,
                    None,
                )
                .await
                .expect("empty capture settles"),
                "",
            );
            input
                .stop(TransitionReason::Stop)
                .await
                .expect("empty capture stop");
        });
        assert_eq!(stt.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn android_mesh_stage_resolution_keeps_exact_selector_and_rejects_mismatch() {
        let mesh: aurora_voice_core::node_policy::SpeechStageConfig = serde_json::from_value(serde_json::json!({
            "routing": { "prefer": "network_only", "fallback": "error" },
            "networkKind": "mesh",
            "target": { "peerId": "peer-a", "resourceId": "remote:peer-a:STT", "modelId": "stt:model-a" },
            "modelId": "stt:model-a", "language": "en", "experimentalRemote": false
        })).expect("valid mesh stage");
        let selected = android_mesh_stage_route(&mesh, false)
            .expect("valid selected route")
            .expect("mesh selected");
        assert_eq!(selected.peer_id, "peer-a");
        assert_eq!(selected.resource_id, "remote:peer-a:STT");
        assert_eq!(selected.model_id.as_deref(), Some("stt:model-a"));
        assert_eq!(selected.language.as_deref(), Some("en"));
        let mismatch: aurora_voice_core::node_policy::SpeechStageConfig = serde_json::from_value(serde_json::json!({
            "routing": { "prefer": "network_only", "fallback": "error" }, "networkKind": "mesh",
            "target": { "peerId": "peer-a", "resourceId": "remote:peer-a:STT", "modelId": "stt:model-a" },
            "modelId": "stt:model-b", "experimentalRemote": false
        })).expect("valid selector shape");
        assert!(android_mesh_stage_route(&mismatch, false).is_err());
        let local_preferred = serde_json::from_value(serde_json::json!({
            "routing": { "prefer": "local", "fallback": "network" }, "networkKind": "mesh",
            "target": { "peerId": "peer-a", "resourceId": "remote:peer-a:STT", "modelId": "stt:model-a" },
            "experimentalRemote": false
        })).expect("valid fallback stage");
        assert!(android_mesh_stage_route(&local_preferred, true)
            .expect("local remains preferred")
            .is_none());
        assert!(
            validate_android_local_stage(&local_preferred).is_ok(),
            "dormant Mesh fallback must not block an available Local binding"
        );
    }

    #[test]
    fn confirmed_speech_stages_select_each_android_port_and_reject_remote_wake() {
        let stages: SpeechStages = serde_json::from_value(serde_json::json!({
            "stt": { "routing": { "prefer": "local", "fallback": "network" }, "experimentalRemote": false },
            "tts": { "routing": { "prefer": "network_only", "fallback": "error" }, "experimentalRemote": false },
            "kws": { "routing": { "prefer": "local_only", "fallback": "error" }, "experimentalRemote": false },
            "vad": { "routing": { "prefer": "local_only", "fallback": "error" }, "experimentalRemote": false }
        }))
        .expect("valid speech-stage policy");
        let config = AndroidVoiceSessionConfig::new(
            Url::parse("https://gateway.example").expect("gateway URL"),
            GatewayAuth::None,
            true,
        )
        .with_speech_stages(stages.clone());

        assert!(
            validate_android_stage_provider(&config, &stages.stt, true, false)
                .expect("available local STT")
        );
        assert!(
            !validate_android_stage_provider(&config, &stages.stt, false, false)
                .expect("network fallback STT")
        );
        assert!(
            !validate_android_stage_provider(&config, &stages.tts, true, false)
                .expect("network-only TTS")
        );

        let selected_local: aurora_voice_core::node_policy::SpeechStageConfig =
            serde_json::from_value(serde_json::json!({
                "routing": { "prefer": "local_only", "fallback": "error" },
                "modelId": "stt:whisper:base",
                "language": "en",
                "experimentalRemote": false
            }))
            .expect("valid local stage selectors");
        assert!(validate_android_local_stage(&selected_local).is_ok());
        #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
        {
            assert!(
                validate_android_local_model_selector(&selected_local, "stt:whisper:base").is_ok()
            );
            assert!(validate_android_local_model_selector(&selected_local, "other-model").is_err());
        }

        let selected_gateway: aurora_voice_core::node_policy::SpeechStageConfig =
            serde_json::from_value(serde_json::json!({
                "routing": { "prefer": "network_only", "fallback": "error" },
                "modelId": "realtime",
                "language": "en",
                "experimentalRemote": false
            }))
            .expect("valid Gateway stage selectors");
        assert!(validate_android_gateway_stage(&selected_gateway).is_ok());

        let remote_wake_stages: SpeechStages = serde_json::from_value(serde_json::json!({
            "stt": { "routing": { "prefer": "local", "fallback": "network" }, "experimentalRemote": false },
            "tts": { "routing": { "prefer": "local", "fallback": "network" }, "experimentalRemote": false },
            "kws": { "routing": { "prefer": "network_only", "fallback": "error" }, "experimentalRemote": false },
            "vad": { "routing": { "prefer": "local_only", "fallback": "error" }, "experimentalRemote": false }
        }))
        .expect("valid unsupported wake policy");
        assert!(validate_android_wake_stages(&config, &remote_wake_stages).is_err());
    }

    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    #[test]
    fn transcription_uses_only_configured_gateway_fallback_when_local_pack_is_unavailable() {
        use aurora_voice_core::node_policy::SpeechStages;

        let root = tempfile::tempdir().expect("temp dir");
        let stages = |prefer: &str, fallback: &str, model_id: &str| {
            serde_json::from_value::<SpeechStages>(serde_json::json!({
                "stt": {
                    "routing": { "prefer": prefer, "fallback": fallback },
                    "modelId": model_id,
                    "experimentalRemote": false
                },
                "tts": { "routing": { "prefer": "local", "fallback": "network" }, "experimentalRemote": false },
                "kws": { "routing": { "prefer": "local_only", "fallback": "error" }, "experimentalRemote": false },
                "vad": { "routing": { "prefer": "local_only", "fallback": "error" }, "experimentalRemote": false }
            }))
            .expect("valid stage policy")
        };
        let config_for = |remote_audio_consent, stages| {
            let mut config = AndroidVoiceSessionConfig::new(
                Url::parse("https://gateway.example.test").expect("gateway URL"),
                GatewayAuth::None,
                remote_audio_consent,
            );
            config.pack_store_root = Some(root.path().to_owned());
            config.stt_model_id = Some("stt:whisper:base".to_owned());
            config.speech_stages = Some(stages);
            config
        };

        let configured_fallback = config_for(true, stages("local", "network", "stt:whisper:base"));
        assert!(matches!(
            build_transcription_stt(&configured_fallback),
            Ok(AndroidFiniteSttProvider::Gateway(_))
        ));

        let local_only = config_for(true, stages("local_only", "error", "stt:whisper:base"));
        assert!(build_transcription_stt(&local_only).is_err());

        let missing_consent = config_for(false, stages("local", "network", "stt:whisper:base"));
        assert!(build_transcription_stt(&missing_consent).is_err());

        let mismatched_model = config_for(true, stages("local", "network", "other-model"));
        assert!(build_transcription_stt(&mismatched_model).is_err());
    }

    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    #[test]
    fn failed_local_tts_load_does_not_ignore_pinned_gateway_voice() {
        let root = tempfile::tempdir().expect("temp dir");
        let pinned_voice = "standard:piper:en_us-lessac-high";
        let stages: SpeechStages = serde_json::from_value(serde_json::json!({
            "stt": {
                "routing": { "prefer": "network_only", "fallback": "error" },
                "experimentalRemote": false
            },
            "tts": {
                "routing": { "prefer": "local", "fallback": "network" },
                "modelId": pinned_voice,
                "experimentalRemote": false
            },
            "kws": { "routing": { "prefer": "local_only", "fallback": "error" }, "experimentalRemote": false },
            "vad": { "routing": { "prefer": "local_only", "fallback": "error" }, "experimentalRemote": false }
        }))
        .expect("valid pinned speech-stage policy");
        let config = AndroidVoiceSessionConfig::with_local_pack_selection_for_route(
            Some(Url::parse("https://gateway.example.test").expect("gateway URL")),
            GatewayAuth::None,
            true,
            root.path(),
            "stt:whisper:base",
            pinned_voice,
            None,
            None,
            None,
            None,
            None,
        )
        .with_speech_stages(stages.clone());
        let input = AndroidAudioInput::new(AndroidPcmIngress::new(1, 128));
        let output = AndroidAudioOutput::new(1);
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus::default()));
        let sink = AndroidSessionSink {
            status,
            turn_transcript: Arc::new(Mutex::new(None)),
            observation_tokens: Arc::new(Mutex::new(HashMap::new())),
        };

        // The pack store exists but has no installed voice, so local preload fails. Gateway TTS
        // cannot honor the pinned model id and runtime construction must stay unavailable.
        assert!(matches!(
            build_runtime_for_stages(&config, &stages, input, output, sink),
            Err(AndroidVoiceSessionCommandError::Unavailable)
        ));
    }

    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    #[test]
    fn local_provider_bindings_are_available_before_heavy_engines_load() {
        use aurora_voice_engine::{
            RuntimeTarget, SpeechModelCatalog, TargetArch, TargetOs, TtsVoiceCatalog,
        };

        let root = tempfile::tempdir().expect("temp dir");
        let manager = Arc::new(
            SpeechPackManager::open(
                SpeechPackManagerConfig::new(root.path(), None).expect("manager config"),
            )
            .expect("manager"),
        );

        let speech_catalog = SpeechModelCatalog::embedded().expect("speech catalog");
        let stt_entry = speech_catalog.model("stt:whisper:base").expect("STT entry");
        let stt_binding = TaskPackBinding::from_speech_catalog_entry(
            speech_catalog,
            stt_entry,
            RuntimeTarget::Android,
            TargetOs::Android,
            TargetArch::Aarch64,
        )
        .expect("STT binding");
        let stt = LazyInstalledSttProvider {
            manager: Arc::clone(&manager),
            model_id: stt_entry.model_id.clone(),
            binding: stt_binding.clone(),
            provider: None,
        };
        assert_eq!(
            stt.finite_stt_binding().expect("advertised STT binding"),
            FiniteSttProviderBinding::LocalTask(Box::new(stt_binding)),
        );
        assert!(stt.provider.is_none());

        let tts_catalog = TtsVoiceCatalog::runtime().expect("TTS catalog");
        let tts_entry = tts_catalog
            .voice("standard:piper:en_us-lessac-high")
            .expect("TTS entry");
        let tts_binding = TaskPackBinding::from_tts_catalog_entry(
            tts_catalog,
            tts_entry,
            RuntimeTarget::Android,
            TargetOs::Android,
            TargetArch::Aarch64,
            22_050,
        )
        .expect("TTS binding");
        let tts = LazyInstalledTtsProvider {
            manager,
            voice_id: tts_entry.voice_id.clone(),
            binding: tts_binding.clone(),
            reference_profile: None,
            provider: None,
        };
        assert_eq!(
            tts.synthesis_binding().expect("advertised TTS binding"),
            TtsSynthesisProviderBinding::LocalTask(Box::new(tts_binding)),
        );
        assert!(tts.provider.is_none());
    }

    #[test]
    fn loopback_policy_is_selected_without_exposing_credentials() {
        let url = Url::parse("http://127.0.0.1:8000").expect("url");
        assert!(is_loopback(&url));
        let remote = Url::parse("https://gateway.example.test").expect("url");
        assert!(!is_loopback(&remote));
    }

    #[test]
    fn assistant_limits_outlive_the_python_inference_window() {
        let limits = transport_limits(MicrophoneAudioPolicy::LoopbackOnly);

        assert_eq!(limits.request_timeout, Duration::from_secs(75));
        assert_eq!(limits.stream_idle_timeout, Duration::from_secs(75));
        assert!(limits.request_timeout > Duration::from_secs(60));
    }

    #[test]
    fn state_mapping_is_product_safe() {
        assert_eq!(
            phase_for_state(VoiceState::Arming),
            AndroidVoiceSessionPhase::Starting
        );
        assert_eq!(
            phase_for_state(VoiceState::ListeningForWake),
            AndroidVoiceSessionPhase::WaitingForWake
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
            phase_for_state(VoiceState::Transcribing),
            AndroidVoiceSessionPhase::Transcribing
        );
        assert_eq!(
            phase_for_state(VoiceState::Dispatching),
            AndroidVoiceSessionPhase::WaitingForResponse
        );
        assert_eq!(
            phase_for_state(VoiceState::AwaitingResponse),
            AndroidVoiceSessionPhase::PreparingSpeech
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
    fn cleanup_transitions_preserve_the_failed_work_stage_until_result_classification() {
        let generation = Generation(7);
        let mut status = AndroidVoiceSessionStatus {
            active: true,
            ..AndroidVoiceSessionStatus::default()
        };

        update_session_phase(&mut status, VoiceState::Speaking, generation);
        update_session_phase(&mut status, VoiceState::Stopping, generation);
        update_session_phase(&mut status, VoiceState::Idle, generation);

        assert_eq!(status.phase, AndroidVoiceSessionPhase::Speaking);
        assert_eq!(status.generation, Some(generation));

        status.active = false;
        update_session_phase(&mut status, VoiceState::Idle, generation);
        assert_eq!(status.phase, AndroidVoiceSessionPhase::Idle);
    }

    #[test]
    fn terminal_errors_identify_the_failed_voice_stage() {
        assert_eq!(
            error_code(
                &VoiceCoreError::Engine(EngineError::InvalidRequest),
                AndroidVoiceSessionPhase::PreparingSpeech,
            ),
            "tts_failed",
        );
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
    fn focused_transcript_is_retained_once_without_exposing_background_results() {
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus {
            active: true,
            phase: AndroidVoiceSessionPhase::Processing,
            ..AndroidVoiceSessionStatus::default()
        }));
        let focused_transcript = Arc::new(Mutex::new(None));
        let turn_transcript = Arc::new(Mutex::new(None));
        let background_results = Arc::new(Mutex::new(VecDeque::new()));
        let observation_tokens = Arc::new(Mutex::new(HashMap::new()));
        let state = AndroidSessionThreadState {
            status: Arc::clone(&status),
            focused_transcript: Arc::clone(&focused_transcript),
            turn_transcript,
            background_results: Arc::clone(&background_results),
            observation_tokens,
            control: AndroidAudioInput::new(AndroidPcmIngress::new(1, 1)).control(),
            lifecycle: MobileSessionLifecycle::new(),
        };

        finish_status(
            &state,
            Generation(0),
            AndroidVoiceStartMode::PushToTalk,
            Ok("focused transcript".to_owned()),
        );

        assert_eq!(status.lock().expect("status").completed_turns, 1);
        assert_eq!(
            focused_transcript.lock().expect("transcript").take(),
            Some("focused transcript".to_owned()),
        );

        finish_status(
            &state,
            Generation(0),
            AndroidVoiceStartMode::BackgroundSession,
            Ok("background response".to_owned()),
        );
        assert!(focused_transcript.lock().expect("transcript").is_none());
    }

    #[test]
    fn background_result_is_retained_when_assistant_transport_is_unavailable() {
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus {
            active: true,
            phase: AndroidVoiceSessionPhase::Processing,
            ..AndroidVoiceSessionStatus::default()
        }));
        let focused_transcript = Arc::new(Mutex::new(None));
        let turn_transcript = Arc::new(Mutex::new(Some((
            Generation(7),
            "what is the meaning of life".to_owned(),
            NativeVoiceObservationToken::from_wire("1:1").expect("token"),
        ))));
        let background_results = Arc::new(Mutex::new(VecDeque::new()));
        let observation_tokens = Arc::new(Mutex::new(HashMap::new()));
        let state = AndroidSessionThreadState {
            status: Arc::clone(&status),
            focused_transcript: Arc::clone(&focused_transcript),
            turn_transcript,
            background_results: Arc::clone(&background_results),
            observation_tokens,
            control: AndroidAudioInput::new(AndroidPcmIngress::new(1, 1)).control(),
            lifecycle: MobileSessionLifecycle::new(),
        };

        finish_status(
            &state,
            Generation(7),
            AndroidVoiceStartMode::BackgroundSession,
            Err(VoiceCoreError::TransportFault {
                code: "assistant_unavailable".to_owned(),
            }),
        );

        assert!(focused_transcript.lock().expect("transcript").is_none());
        let retained = background_results
            .lock()
            .expect("background result")
            .pop_front();
        assert_eq!(
            retained,
            Some(AndroidBackgroundVoiceTurnResult {
                generation: Generation(7),
                observation_token: "1:1".to_owned(),
                transcript: "what is the meaning of life".to_owned(),
                assistant_text: None,
                error_code: Some("assistant_unavailable".to_owned()),
            }),
        );
    }

    #[test]
    fn webrtc_only_route_requires_a_peer_and_accepts_no_gateway() {
        assert_eq!(
            AndroidAssistantRouteMode::parse("webrtc-only").expect("mode"),
            AndroidAssistantRouteMode::WebRtcOnly,
        );
        let config = AndroidVoiceSessionConfig::with_local_pack_selection_for_route(
            None,
            GatewayAuth::None,
            false,
            "/tmp/aurora-packs",
            "stt-model",
            "tts-voice",
            None,
            None,
            None,
            None,
            None,
        );
        assert!(config
            .clone()
            .with_assistant_route(AndroidAssistantRouteMode::WebRtcOnly, None)
            .is_err());
        let configured = config
            .with_assistant_route(
                AndroidAssistantRouteMode::WebRtcOnly,
                Some("home-peer".to_owned()),
            )
            .expect("native mesh route");
        assert!(configured.gateway.is_none());
    }

    #[test]
    fn local_voice_accepts_no_assistant_route() {
        let config = AndroidVoiceSessionConfig::with_local_pack_selection_for_route(
            None,
            GatewayAuth::None,
            false,
            "/tmp/aurora-packs",
            "stt-model",
            "tts-voice",
            None,
            None,
            None,
            None,
            None,
        )
        .with_assistant_route(AndroidAssistantRouteMode::LocalOnly, None)
        .expect("local voice config");
        assert!(config.gateway.is_none());
    }

    #[cfg(all(feature = "native-sherpa", feature = "native-sherpa-tts"))]
    #[test]
    fn webrtc_only_local_voice_never_requires_remote_microphone_consent() {
        let config = AndroidVoiceSessionConfig::with_local_pack_selection_for_route(
            None,
            GatewayAuth::None,
            false,
            "/tmp/aurora-packs",
            "stt-model",
            "tts-voice",
            None,
            None,
            None,
            None,
            None,
        )
        .with_assistant_route(
            AndroidAssistantRouteMode::WebRtcOnly,
            Some("home-peer".to_owned()),
        )
        .expect("native mesh route");
        assert_eq!(
            microphone_policy(&config).expect("local policy"),
            MicrophoneAudioPolicy::LoopbackOnly,
        );
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
        // The loopback Gateway has no active assistant request to interrupt. Keep
        // this strict cleanup failure visible rather than treating local turn
        // cancellation as proof that transport cleanup succeeded.
        assert_eq!(
            session.close_checked(),
            Err(MobileSessionCloseError::CleanupFailed)
        );
    }

    struct CloseTestAudioInput {
        started: Option<mpsc::Sender<()>>,
        start_entered: Option<mpsc::Sender<()>>,
        release_start: Option<tokio::sync::oneshot::Receiver<()>>,
        stop_entered: Option<mpsc::Sender<()>>,
        release_stop: Option<tokio::sync::oneshot::Receiver<()>>,
        fail_stop: bool,
        fail_stop_once: Option<Arc<std::sync::atomic::AtomicBool>>,
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
            if let Some(entered) = self.stop_entered.as_ref() {
                let _ = entered.send(());
            }
            if let Some(release) = self.release_stop.take() {
                let _ = release.await;
            }
            let fail_stop_once = self.fail_stop_once.as_ref().is_some_and(|remaining| {
                remaining.swap(false, std::sync::atomic::Ordering::SeqCst)
            });
            if self.fail_stop || fail_stop_once {
                Err(VoiceCoreError::TransportFault {
                    code: "private_cleanup_failure".to_owned(),
                })
            } else {
                Ok(())
            }
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

    struct GatedAndroidAudioInput {
        inner: AndroidAudioInput,
        start_entered: Option<mpsc::Sender<()>>,
        release_start: Option<tokio::sync::oneshot::Receiver<()>>,
        stop_entered: Option<mpsc::Sender<()>>,
        release_stop: Option<tokio::sync::oneshot::Receiver<()>>,
    }

    #[async_trait(?Send)]
    impl AudioInput for GatedAndroidAudioInput {
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
            _request: AssistantTurnRequest,
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

    struct ReportTestAudioInput {
        frame: Option<aurora_voice_core::PcmFrame>,
        started: Option<mpsc::Sender<Generation>>,
        stop_entered: Option<mpsc::Sender<()>>,
        release_stop: Option<tokio::sync::oneshot::Receiver<()>>,
        fail_stop: bool,
    }

    #[async_trait(?Send)]
    impl AudioInput for ReportTestAudioInput {
        async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
            if let Some(started) = self.started.as_ref() {
                let _ = started.send(lease.generation);
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
            if self.fail_stop {
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
            Ok(self.frame.take())
        }

        fn current_route_revision(&self) -> RouteRevision {
            RouteRevision(ROUTE_REVISION)
        }
    }

    struct SuccessfulReportTestStt;

    #[async_trait(?Send)]
    impl FiniteSttPort for SuccessfulReportTestStt {
        fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
            Ok(FiniteSttProviderBinding::Route(RouteFiniteSttBinding::new(
                "route.stt.cleanup-report-success",
                FiniteSttRouteScope::LoopbackSidecar,
                VAD_SAMPLE_RATE_HZ,
                MAX_FINITE_STT_SAMPLES,
                ROUTE_REVISION,
            )?))
        }

        async fn warm_finite_stt(
            &mut self,
            _binding: FiniteSttProviderBinding,
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
        fail_stop: bool,
    ) -> VoiceRuntime<
        CloseTestAudioInput,
        CloseTestEngine,
        CloseTestEngine,
        CloseTestTransport,
        CloseTestOutput,
        CloseTestSink,
    > {
        close_test_runtime_inner(started, stop_entered, release_stop, fail_stop, None)
    }

    fn close_test_runtime_inner(
        started: mpsc::Sender<()>,
        stop_entered: mpsc::Sender<()>,
        release_stop: tokio::sync::oneshot::Receiver<()>,
        fail_stop: bool,
        fail_stop_once: Option<Arc<std::sync::atomic::AtomicBool>>,
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
                fail_stop,
                fail_stop_once,
            },
            CloseTestEngine,
            CloseTestEngine,
            CloseTestTransport,
            CloseTestOutput,
            CloseTestSink,
            ANDROID_SURFACE,
            ANDROID_RUNTIME_ID,
        )
        .expect("real core runtime")
    }

    fn close_test_runtime_with_one_failed_stop(
        started: mpsc::Sender<()>,
        stop_entered: mpsc::Sender<()>,
        release_stop: tokio::sync::oneshot::Receiver<()>,
        fail_stop_once: Arc<std::sync::atomic::AtomicBool>,
    ) -> VoiceRuntime<
        CloseTestAudioInput,
        CloseTestEngine,
        CloseTestEngine,
        CloseTestTransport,
        CloseTestOutput,
        CloseTestSink,
    > {
        close_test_runtime_inner(
            started,
            stop_entered,
            release_stop,
            false,
            Some(fail_stop_once),
        )
    }

    struct CloseTestWake;

    impl Wake for CloseTestWake {
        fn wake(self: Arc<Self>) {}
    }

    #[test]
    fn production_command_loop_waits_for_actual_core_cleanup_before_worker_join() {
        let (started_tx, started_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (loop_exited_tx, loop_exited_rx) = mpsc::channel();
        let (allow_worker_exit_tx, allow_worker_exit_rx) = mpsc::channel();
        let lifecycle = MobileSessionLifecycle::new();
        let ingress = AndroidPcmIngress::new(1, 128);
        let control = AndroidAudioInput::new(ingress).control();
        let state = AndroidSessionThreadState {
            status: Arc::new(Mutex::new(AndroidVoiceSessionStatus::default())),
            focused_transcript: Arc::new(Mutex::new(None)),
            turn_transcript: Arc::new(Mutex::new(None)),
            background_results: Arc::new(Mutex::new(VecDeque::new())),
            observation_tokens: Arc::new(Mutex::new(HashMap::new())),
            control: control.clone(),
            lifecycle: lifecycle.clone(),
        };
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker = thread::spawn(move || {
            let core = close_test_runtime(started_tx, stop_tx, release_rx, true);
            let runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(run_session_loop(core, command_rx, state, false));
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
                        mode: AndroidVoiceStartMode::PushToTalk,
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
    }

    #[test]
    fn production_command_loop_drains_on_channel_close_and_fails_closed() {
        let (started_tx, started_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let lifecycle = MobileSessionLifecycle::new();
        let (channel_closed_tx, channel_closed_rx) = mpsc::channel();
        lifecycle.set_unexpected_channel_close_hook(channel_closed_tx);
        let ingress = AndroidPcmIngress::new(1, 128);
        let control = AndroidAudioInput::new(ingress).control();
        let state = AndroidSessionThreadState {
            status: Arc::new(Mutex::new(AndroidVoiceSessionStatus::default())),
            focused_transcript: Arc::new(Mutex::new(None)),
            turn_transcript: Arc::new(Mutex::new(None)),
            background_results: Arc::new(Mutex::new(VecDeque::new())),
            observation_tokens: Arc::new(Mutex::new(HashMap::new())),
            control,
            lifecycle: lifecycle.clone(),
        };
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker = thread::spawn(move || {
            let core = close_test_runtime(started_tx, stop_tx, release_rx, false);
            let runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(run_session_loop(core, command_rx, state, false));
        });
        start_join_driver(&lifecycle, worker).expect("join driver");

        let (reply, response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: AndroidVoiceStartMode::PushToTalk,
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
    }

    #[test]
    fn cleanup_failure_stays_sticky_after_a_later_clean_generation() {
        let (started_tx, started_rx) = mpsc::channel();
        let (stop_tx, stop_rx) = mpsc::channel();
        let (release_stop_tx, release_stop_rx) = tokio::sync::oneshot::channel();
        drop(release_stop_tx);
        let fail_first_stop = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let lifecycle = MobileSessionLifecycle::new();
        let ingress = AndroidPcmIngress::new(1, 128);
        let control = AndroidAudioInput::new(ingress).control();
        let state = AndroidSessionThreadState {
            status: Arc::new(Mutex::new(AndroidVoiceSessionStatus::default())),
            focused_transcript: Arc::new(Mutex::new(None)),
            turn_transcript: Arc::new(Mutex::new(None)),
            background_results: Arc::new(Mutex::new(VecDeque::new())),
            observation_tokens: Arc::new(Mutex::new(HashMap::new())),
            control,
            lifecycle: lifecycle.clone(),
        };
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker = thread::spawn(move || {
            let core = close_test_runtime_with_one_failed_stop(
                started_tx,
                stop_tx,
                release_stop_rx,
                fail_first_stop,
            );
            let runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(run_session_loop(core, command_rx, state, false));
        });
        start_join_driver(&lifecycle, worker).expect("join driver");

        for expected_generation in [Generation(1), Generation(2)] {
            let (reply, response) = mpsc::channel();
            lifecycle
                .admit(|| {
                    commands
                        .send(Command::Start {
                            mode: AndroidVoiceStartMode::PushToTalk,
                            reply,
                        })
                        .is_ok()
                })
                .expect("generation admitted before retirement");
            assert_eq!(
                response
                    .recv()
                    .expect("start response")
                    .expect("generation"),
                expected_generation
            );
            if expected_generation == Generation(1) {
                started_rx.recv().expect("first actual capture started");
            }
            stop_rx
                .recv()
                .expect("actual core cleanup reached audio stop");
            assert!(lifecycle.wait_for_cleanup_count(expected_generation.0));
        }

        lifecycle.request_retirement(|| commands.send(Command::Shutdown).is_ok());
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(5)),
            Err(MobileSessionCloseError::CleanupFailed)
        );
    }

    #[test]
    fn successful_core_report_with_unattempted_state_reset_is_accepted() {
        for fail_capture_stop in [false, true] {
            let lifecycle = MobileSessionLifecycle::new();
            let (started_tx, started_rx) = mpsc::channel();
            let (stop_entered_tx, stop_entered_rx) = mpsc::channel();
            let (release_stop_tx, release_stop_rx) = tokio::sync::oneshot::channel();
            let (report_tx, report_rx) = mpsc::channel();
            lifecycle.set_after_cleanup_hook(move |generation, report| {
                report_tx
                    .send((generation, report))
                    .expect("production loop recorded cleanup report");
            });
            let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus::default()));
            let state = AndroidSessionThreadState {
                status: Arc::clone(&status),
                focused_transcript: Arc::new(Mutex::new(None)),
                turn_transcript: Arc::new(Mutex::new(None)),
                background_results: Arc::new(Mutex::new(VecDeque::new())),
                observation_tokens: Arc::new(Mutex::new(HashMap::new())),
                control: AndroidAudioInput::new(AndroidPcmIngress::new(1, 128)).control(),
                lifecycle: lifecycle.clone(),
            };
            let (commands, command_rx) = tokio_mpsc::unbounded_channel();
            let worker = thread::spawn(move || {
                let generation = Generation(1);
                let audio = ReportTestAudioInput {
                    frame: Some(
                        aurora_voice_core::PcmFrame::new(
                            vec![0.1, -0.1],
                            TimestampMicros(1),
                            1,
                            false,
                            RouteRevision(ROUTE_REVISION),
                            generation,
                        )
                        .expect("valid audio frame"),
                    ),
                    started: Some(started_tx),
                    stop_entered: Some(stop_entered_tx),
                    release_stop: Some(release_stop_rx),
                    fail_stop: fail_capture_stop,
                };
                let runtime = VoiceRuntime::new(
                    audio,
                    SuccessfulReportTestStt,
                    CloseTestEngine,
                    CloseTestTransport,
                    CloseTestOutput,
                    CloseTestSink,
                    ANDROID_SURFACE,
                    "cleanup-report-production-loop-test",
                )
                .expect("actual core runtime");
                TokioRuntimeBuilder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("test runtime")
                    .block_on(run_session_loop(runtime, command_rx, state, false));
            });
            start_join_driver(&lifecycle, worker).expect("actual worker join driver");

            let (reply, response) = mpsc::channel();
            lifecycle
                .admit(|| {
                    commands
                        .send(Command::Start {
                            mode: AndroidVoiceStartMode::PushToTalk,
                            reply,
                        })
                        .is_ok()
                })
                .expect("primary start admitted");
            assert_eq!(
                response.recv().expect("start reply").expect("generation"),
                Generation(1)
            );
            assert_eq!(
                started_rx.recv_timeout(Duration::from_secs(5)),
                Ok(Generation(1))
            );
            stop_entered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("actual core cleanup entered capture stop");
            release_stop_tx.send(()).expect("release capture stop");

            let (reported_generation, report) = report_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("production loop cleanup report");
            let report = report.expect("actual core report");
            assert_eq!(reported_generation, Generation(1));
            assert_eq!(report.generation(), Generation(1));
            assert_eq!(
                report.state_reset(),
                aurora_voice_core::CleanupCallbackOutcome::NotAttempted
            );
            assert_eq!(
                report.capture_stop(),
                if fail_capture_stop {
                    aurora_voice_core::CleanupCallbackOutcome::ReturnedError
                } else {
                    aurora_voice_core::CleanupCallbackOutcome::ReturnedOk
                }
            );

            lifecycle.request_retirement(|| commands.send(Command::Shutdown).is_ok());
            assert_eq!(
                lifecycle.close_checked_timeout(Duration::from_secs(5)),
                if fail_capture_stop {
                    Err(MobileSessionCloseError::CleanupFailed)
                } else {
                    Ok(())
                }
            );
            assert!(!status.lock().expect("final status").active);
        }
    }

    #[test]
    fn terminal_close_preserves_missing_transport_cleanup_as_failure() {
        let config = AndroidVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let session = AndroidVoiceSession::new(config, 2, 128, 2).expect("session");
        let generation = session.start().expect("start");
        session.request_close();
        assert_eq!(
            session.start(),
            Err(AndroidVoiceSessionCommandError::Closed)
        );
        assert_eq!(
            session.close_checked_timeout(Duration::from_secs(5)),
            Err(MobileSessionCloseError::CleanupFailed)
        );
        assert!(!session.status().active);
        assert_eq!(generation.0, 1);
    }

    #[test]
    fn production_worker_startup_failure_is_retained_until_join() {
        let config = AndroidVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let ingress = AndroidPcmIngress::new(1, 128);
        let input = AndroidAudioInput::new(ingress);
        let control = input.control();
        let output = AndroidAudioOutput::new(1);
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus::default()));
        let turn_transcript = Arc::new(Mutex::new(None));
        let observation_tokens = Arc::new(Mutex::new(HashMap::new()));
        let lifecycle = MobileSessionLifecycle::new();
        let state = AndroidSessionThreadState {
            status: Arc::clone(&status),
            focused_transcript: Arc::new(Mutex::new(None)),
            turn_transcript: Arc::clone(&turn_transcript),
            background_results: Arc::new(Mutex::new(VecDeque::new())),
            observation_tokens: Arc::clone(&observation_tokens),
            control,
            lifecycle: lifecycle.clone(),
        };
        let sink = AndroidSessionSink {
            status: Arc::clone(&status),
            turn_transcript,
            observation_tokens,
        };
        let (_commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker = thread::spawn(move || {
            run_session_thread_with_builder(
                config,
                input,
                output,
                sink,
                command_rx,
                state,
                |_config, _input, _output, _sink| Err(AndroidVoiceSessionCommandError::Unavailable),
            );
        });
        start_join_driver(&lifecycle, worker).expect("join driver");
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(2)),
            Err(MobileSessionCloseError::Unavailable)
        );
        assert_eq!(
            status.lock().expect("startup status").phase,
            AndroidVoiceSessionPhase::Faulted
        );
    }

    #[test]
    fn constructor_driver_spawn_failure_joins_the_actual_android_worker() {
        let config = AndroidVoiceSessionConfig::new(
            Url::parse("http://127.0.0.1:8000").expect("url"),
            GatewayAuth::None,
            false,
        );
        let worker_exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed_exit = Arc::clone(&worker_exited);
        assert_eq!(
            AndroidVoiceSession::new_with_join_driver(
                config,
                1,
                128,
                1,
                |_lifecycle, worker| Err(worker),
                move || observed_exit.store(true, std::sync::atomic::Ordering::SeqCst),
            )
            .map(|_| ()),
            Err(AndroidVoiceSessionCommandError::Unavailable)
        );
        assert!(worker_exited.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn retirement_before_real_input_control_reset_cannot_admit_another_capture() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_start_tx, release_start_rx) = tokio::sync::oneshot::channel();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (release_stop_tx, release_stop_rx) = tokio::sync::oneshot::channel();
        let lifecycle = MobileSessionLifecycle::new();
        let inner = AndroidAudioInput::new(AndroidPcmIngress::new(1, 128));
        let control = inner.control();
        let state = AndroidSessionThreadState {
            status: Arc::new(Mutex::new(AndroidVoiceSessionStatus::default())),
            focused_transcript: Arc::new(Mutex::new(None)),
            turn_transcript: Arc::new(Mutex::new(None)),
            background_results: Arc::new(Mutex::new(VecDeque::new())),
            observation_tokens: Arc::new(Mutex::new(HashMap::new())),
            control: control.clone(),
            lifecycle: lifecycle.clone(),
        };
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker = thread::spawn(move || {
            let core = VoiceRuntime::new(
                GatedAndroidAudioInput {
                    inner,
                    start_entered: Some(started_tx),
                    release_start: Some(release_start_rx),
                    stop_entered: Some(stop_tx),
                    release_stop: Some(release_stop_rx),
                },
                CloseTestEngine,
                CloseTestEngine,
                CloseTestTransport,
                CloseTestOutput,
                CloseTestSink,
                ANDROID_SURFACE,
                ANDROID_RUNTIME_ID,
            )
            .expect("real core runtime");
            let runtime = TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            runtime.block_on(run_session_loop(core, command_rx, state, false));
        });
        start_join_driver(&lifecycle, worker).expect("join driver");

        let (reply, response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: AndroidVoiceStartMode::PushToTalk,
                        reply,
                    })
                    .is_ok()
            })
            .expect("first start admitted");
        assert_eq!(
            response.recv().expect("start reply").expect("generation"),
            Generation(1)
        );
        started_rx.recv().expect("before inner input reset");

        let (queued_reply, queued_response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: AndroidVoiceStartMode::PushToTalk,
                        reply: queued_reply,
                    })
                    .is_ok()
            })
            .expect("active-loop start enqueued for rejection");
        assert_eq!(
            queued_response.recv().expect("queued start reply"),
            Err(AndroidVoiceSessionCommandError::AlreadyActive)
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
        let status = Arc::new(Mutex::new(AndroidVoiceSessionStatus::default()));
        let state = AndroidSessionThreadState {
            status: Arc::clone(&status),
            focused_transcript: Arc::new(Mutex::new(None)),
            turn_transcript: Arc::new(Mutex::new(None)),
            background_results: Arc::new(Mutex::new(VecDeque::new())),
            observation_tokens: Arc::new(Mutex::new(HashMap::new())),
            control: AndroidAudioInput::new(AndroidPcmIngress::new(1, 128)).control(),
            lifecycle: lifecycle.clone(),
        };
        let (commands, command_rx) = tokio_mpsc::unbounded_channel();
        let worker = thread::spawn(move || {
            let core = close_test_runtime(started_tx, stop_entered_tx, release_stop_rx, false);
            TokioRuntimeBuilder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime")
                .block_on(run_session_loop(core, command_rx, state, false));
        });
        start_join_driver(&lifecycle, worker).expect("actual worker join driver");

        let (start_reply, start_response) = mpsc::channel();
        lifecycle
            .admit(|| {
                commands
                    .send(Command::Start {
                        mode: AndroidVoiceStartMode::PushToTalk,
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
                    Ok(Err(AndroidVoiceSessionCommandError::NotActive))
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
                    Ok(Err(AndroidVoiceSessionCommandError::NotActive))
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
                        mode: AndroidVoiceStartMode::PushToTalk,
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
            Ok(Err(AndroidVoiceSessionCommandError::Unavailable))
        );
        assert_eq!(
            lifecycle.close_checked_timeout(Duration::from_secs(5)),
            Ok(())
        );
        assert_eq!(
            started_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected),
            "no second capture was admitted"
        );
        assert!(!status.lock().expect("final status").active);
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
