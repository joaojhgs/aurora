//! Deterministic test doubles for the Aurora voice runtime.

#![forbid(unsafe_code)]

pub mod model_store;

use async_trait::async_trait;
use aurora_voice_core::{
    AssistantTurnRequest, AssistantTurnResponse, AudioInput, AudioOutput, AudioPlaybackContext,
    AudioPlaybackReceipt, BoundFiniteSttRequest, BoundTaskRequest, BoundTtsSynthesisRequest,
    CancellationToken, CaptureStartReason, EngineError, FiniteSttAudio, FiniteSttResult,
    Generation, PcmFrame, RedactedSnapshot, ResourceReport, RouteRevision, RuntimeEvent,
    RuntimeEventSink, SpeechEngine, SpeechTransport, TaskCapability, TaskPackBinding, TaskProvider,
    TaskReadiness, TimestampMicros, TransitionReason, TtsSynthesisResult, VoiceCaptureLease,
    VoiceCoreError, VoiceTask,
};
use aurora_voice_engine::{
    select_verified_variant, verify_manifest, AbiRequirements, BrowserFeature, CapabilityFlags,
    Compatibility, CompressionKind, DeviceClass, EngineFaultCode, EngineKind, LanguageSupport,
    LicenseGrant, LicenseInfo, ManifestSignature, ModelPackError, ModelPackFile, ModelPackManifest,
    PackTask, ProcessingMetadata, Provenance, ResourceBudget, RuntimeGates, RuntimeSelection,
    RuntimeTarget, ShapeMetadata, SignatureVerifier, TargetArch, TargetOs, TrustPolicy,
    TtsAudioChunk, MONO_CHANNELS, VAD_SAMPLE_RATE_HZ,
};
use std::cell::RefCell;
use std::collections::{BTreeSet, VecDeque};
use std::fmt;
use std::rc::Rc;

pub use model_store::*;

const FAKE_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct FakeBindingVerifier;

impl SignatureVerifier for FakeBindingVerifier {
    fn verify(
        &self,
        _canonical_json: &str,
        signature: &ManifestSignature,
    ) -> Result<bool, ModelPackError> {
        Ok(signature.value == "signed")
    }
}

fn fake_bound_capability(task: VoiceTask, pack_task: PackTask, streaming: bool) -> TaskCapability {
    TaskCapability::new(fake_task_binding(task, pack_task)).streaming(streaming)
}

fn fake_task_binding(task: VoiceTask, pack_task: PackTask) -> TaskPackBinding {
    let manifest = fake_manifest(pack_task);
    let verified = verify_manifest(
        manifest,
        &TrustPolicy::default(),
        Some(&FakeBindingVerifier),
    )
    .expect("fake manifest verifies");
    let selection = select_verified_variant(
        &verified,
        &RuntimeSelection {
            target: RuntimeTarget::Desktop,
            os: TargetOs::Linux,
            arch: TargetArch::X86_64,
            browser_features: BTreeSet::<BrowserFeature>::new(),
            device_memory_mb: None,
            max_download_bytes: 1024,
            max_installed_bytes: 1024,
            max_memory_bytes: 1024,
            cpu_threads: 1,
            max_rtf_millis_per_second: 1_000,
            device_class: DeviceClass::Low,
            require_interoperable: true,
        },
    )
    .expect("fake variant selects");
    TaskPackBinding::from_selection(task, &verified, &selection).expect("fake binding")
}

fn fake_manifest(task: PackTask) -> ModelPackManifest {
    ModelPackManifest {
        schema_version: 1,
        pack_id: format!("fake-{}", task.as_str()),
        pack_version: "1.0.0".to_owned(),
        display_name: "Fake Pack".to_owned(),
        tasks: vec![task],
        license: LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: FAKE_HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        },
        languages: vec![LanguageSupport {
            language: "en".to_owned(),
            locale: Some("en-US".to_owned()),
            fixed_language: true,
            auto_detect: false,
        }],
        capabilities: CapabilityFlags {
            streaming: true,
            cancellation: true,
        },
        provenance: fake_provenance(),
        files: vec![ModelPackFile {
            file_id: "model".to_owned(),
            asset_id: "model".to_owned(),
            task,
            byte_size: 100,
            sha256: FAKE_HASH.to_owned(),
            url: "/models/model".to_owned(),
            compression: CompressionKind::None,
            installed_size: 100,
            install_order: 0,
            dependencies: Vec::new(),
            license: LicenseInfo {
                identifier: "Apache-2.0".to_owned(),
                text_url: "https://example.test/license".to_owned(),
                text_sha256: FAKE_HASH.to_owned(),
                commercial_use: true,
                redistribution: LicenseGrant::RedistributionAllowed,
                attribution: "Aurora".to_owned(),
            },
            provenance: fake_provenance(),
            processing: ProcessingMetadata {
                tokenizer_sha256: None,
                operator_inventory_sha256: FAKE_HASH.to_owned(),
                preprocessing_abi: "pre-v1".to_owned(),
                postprocessing_abi: "post-v1".to_owned(),
                shapes: ShapeMetadata {
                    sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                    channels: 1,
                    frame_size: 512,
                    window_size: 1024,
                    cache_state: vec!["hidden".to_owned()],
                },
            },
            raven: None,
            revocation: None,
        }],
        variants: vec![aurora_voice_engine::ModelPackVariant {
            variant_id: "linux".to_owned(),
            target: RuntimeTarget::Desktop,
            os: TargetOs::Linux,
            arch: TargetArch::X86_64,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Low,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: 1024,
                max_installed_bytes: 1024,
                max_memory_bytes: 1024,
            },
            compatibility: Compatibility {
                group_id: "fake-group".to_owned(),
                voice_state_group_id: "default".to_owned(),
                preprocessing_abi: "pre-v1".to_owned(),
                postprocessing_abi: "post-v1".to_owned(),
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: 1,
                frame_size: 512,
                interoperable: true,
            },
            file_ids: vec!["model".to_owned()],
            abi: AbiRequirements {
                min_aurora_version: "1.0.0".to_owned(),
                min_runtime_version: "1.0.0".to_owned(),
                min_engine_version: "1.0.0".to_owned(),
                engine_source_revision: "fake".to_owned(),
                build_flags: vec!["cpu".to_owned()],
            },
            revocation: None,
        }],
        rollback_from: None,
        supersedes_pack_id: None,
        revocation: None,
        signature: Some(ManifestSignature {
            key_id: "fake-key".to_owned(),
            algorithm: "ed25519".to_owned(),
            value: "signed".to_owned(),
        }),
    }
}

fn fake_provenance() -> Provenance {
    Provenance {
        upstream_source: "https://example.test/source".to_owned(),
        upstream_revision: "rev1".to_owned(),
        build_recipe_sha256: FAKE_HASH.to_owned(),
    }
}

#[derive(Debug, Clone, Default)]
pub struct FakeClock {
    now: u64,
}

impl FakeClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn now(&self) -> TimestampMicros {
        TimestampMicros(self.now)
    }

    pub fn advance(&mut self, micros: u64) -> TimestampMicros {
        self.now = self.now.saturating_add(micros);
        self.now()
    }
}

#[derive(Debug, Clone)]
pub struct FakeAudioInput {
    frames: Rc<RefCell<VecDeque<PcmFrame>>>,
    started: Vec<VoiceCaptureLease>,
    stopped: Vec<TransitionReason>,
    route_revision: RouteRevision,
    fail_start: bool,
    fail_next_frame: bool,
}

impl FakeAudioInput {
    pub fn new(frames: impl IntoIterator<Item = PcmFrame>) -> Self {
        Self {
            frames: Rc::new(RefCell::new(frames.into_iter().collect())),
            started: Vec::new(),
            stopped: Vec::new(),
            route_revision: RouteRevision(1),
            fail_start: false,
            fail_next_frame: false,
        }
    }

    pub fn with_start_failure(mut self) -> Self {
        self.fail_start = true;
        self
    }

    pub fn with_next_frame_failure(mut self) -> Self {
        self.fail_next_frame = true;
        self
    }

    pub fn started(&self) -> &[VoiceCaptureLease] {
        &self.started
    }

    pub fn stopped(&self) -> &[TransitionReason] {
        &self.stopped
    }

    pub fn push_frame(&self, frame: PcmFrame) {
        self.frames.borrow_mut().push_back(frame);
    }
}

#[async_trait(?Send)]
impl AudioInput for FakeAudioInput {
    async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
        if self.fail_start {
            return Err(VoiceCoreError::InvalidTransition);
        }
        self.route_revision = lease.route_revision;
        self.started.push(lease);
        Ok(())
    }

    async fn stop(&mut self, reason: TransitionReason) -> Result<(), VoiceCoreError> {
        self.stopped.push(reason);
        Ok(())
    }

    async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
        if self.fail_next_frame {
            return Err(VoiceCoreError::Backpressure);
        }
        Ok(self.frames.borrow_mut().pop_front())
    }

    fn current_route_revision(&self) -> RouteRevision {
        self.route_revision
    }
}

#[derive(Clone)]
pub struct FakeEngine {
    transcript: String,
    spoken: Vec<String>,
    cancelled: Vec<u64>,
    transcribed_audio: Vec<Vec<f32>>,
    report: ResourceReport,
    fail_transcribe: bool,
    fail_synthesize: bool,
    cancel_during_transcribe: Option<CancellationToken>,
    synthesized_chunks: Option<Vec<Vec<i16>>>,
}

impl fmt::Debug for FakeEngine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FakeEngine")
            .field("transcript_bytes", &self.transcript.len())
            .field("spoken_count", &self.spoken.len())
            .field("cancelled_count", &self.cancelled.len())
            .field("transcribed_audio_count", &self.transcribed_audio.len())
            .field(
                "transcribed_sample_counts",
                &self
                    .transcribed_audio
                    .iter()
                    .map(Vec::len)
                    .collect::<Vec<_>>(),
            )
            .field("report", &self.report)
            .field("fail_transcribe", &self.fail_transcribe)
            .field("fail_synthesize", &self.fail_synthesize)
            .field(
                "cancel_during_transcribe",
                &self.cancel_during_transcribe.is_some(),
            )
            .field(
                "synthesized_chunk_sample_counts",
                &self
                    .synthesized_chunks
                    .as_ref()
                    .map(|chunks| chunks.iter().map(Vec::len).collect::<Vec<_>>()),
            )
            .finish()
    }
}

impl FakeEngine {
    pub fn new(transcript: impl Into<String>) -> Self {
        Self {
            transcript: transcript.into(),
            spoken: Vec::new(),
            cancelled: Vec::new(),
            transcribed_audio: Vec::new(),
            report: ResourceReport {
                loaded_tasks: vec![VoiceTask::SpeechToText, VoiceTask::TextToSpeech],
                memory_bytes: 1024,
                active_streams: 0,
                readiness: TaskReadiness::Ready,
            },
            fail_transcribe: false,
            fail_synthesize: false,
            cancel_during_transcribe: None,
            synthesized_chunks: None,
        }
    }

    pub fn with_transcribe_failure(mut self) -> Self {
        self.fail_transcribe = true;
        self
    }

    pub fn with_synthesize_failure(mut self) -> Self {
        self.fail_synthesize = true;
        self
    }

    pub fn with_transcribe_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.cancel_during_transcribe = Some(cancellation);
        self
    }

    pub fn with_synthesized_chunks(mut self, chunks: Vec<Vec<i16>>) -> Self {
        self.synthesized_chunks = Some(chunks);
        self
    }

    pub fn spoken(&self) -> &[String] {
        &self.spoken
    }

    pub fn cancelled(&self) -> &[u64] {
        &self.cancelled
    }

    pub fn transcribed_audio(&self) -> &[Vec<f32>] {
        &self.transcribed_audio
    }
}

#[async_trait(?Send)]
impl TaskProvider for FakeEngine {
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![
            fake_bound_capability(VoiceTask::SpeechToText, PackTask::Stt, false),
            fake_bound_capability(VoiceTask::TextToSpeech, PackTask::Tts, true),
        ]
    }

    fn resource_report(&self) -> ResourceReport {
        self.report.clone()
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        if self
            .capabilities()
            .iter()
            .any(|capability| capability.binding() == request.binding())
        {
            Ok(())
        } else {
            Err(EngineError::TaskUnavailable)
        }
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.report
            .loaded_tasks
            .retain(|loaded| *loaded != binding.task());
        Ok(())
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        self.cancelled.push(generation);
        Ok(())
    }
}

#[async_trait(?Send)]
impl SpeechEngine for FakeEngine {
    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        if let Some(token) = &self.cancel_during_transcribe {
            token.cancel();
        }
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        if self.fail_transcribe {
            return Err(EngineError::ProviderFault {
                code: EngineFaultCode::Provider,
            });
        }
        if request.request().request().task != VoiceTask::SpeechToText || request.frames() == 0 {
            return Err(EngineError::InvalidRequest);
        }
        self.transcribed_audio.push(audio.samples().to_vec());
        FiniteSttResult::new(&request, &audio, self.transcript.clone())
    }

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        if self.fail_synthesize {
            return Err(EngineError::ProviderFault {
                code: EngineFaultCode::Provider,
            });
        }
        if request.request().request().task != VoiceTask::TextToSpeech {
            return Err(EngineError::InvalidRequest);
        }
        self.spoken.push(request.text().to_owned());
        let chunk_samples = request.config().chunk_samples();
        let mut samples = request.text().bytes().map(i16::from).collect::<Vec<_>>();
        if samples.is_empty() {
            samples.push(0);
        }
        let chunks = self
            .synthesized_chunks
            .clone()
            .unwrap_or_else(|| vec![samples.into_iter().take(chunk_samples).collect()]);
        let final_index = chunks.len().saturating_sub(1);
        let chunks = chunks
            .into_iter()
            .enumerate()
            .map(|(index, samples)| {
                TtsAudioChunk::new(
                    &request,
                    index.saturating_add(1) as u64,
                    request.config().sample_rate_hz(),
                    MONO_CHANNELS,
                    samples,
                    index == final_index,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        TtsSynthesisResult::new(&request, chunks, false)
    }
}

#[derive(Debug, Clone)]
pub struct FakeTransport {
    response_texts: VecDeque<String>,
    invoked: Vec<AssistantTurnRequest>,
    cancelled: Vec<Generation>,
    fail_invoke: bool,
    cancel_during_invoke: Option<CancellationToken>,
}

impl FakeTransport {
    pub fn new(response_text: impl Into<String>) -> Self {
        Self {
            response_texts: VecDeque::from([response_text.into()]),
            invoked: Vec::new(),
            cancelled: Vec::new(),
            fail_invoke: false,
            cancel_during_invoke: None,
        }
    }

    pub fn with_invoke_failure(mut self) -> Self {
        self.fail_invoke = true;
        self
    }

    pub fn with_invoke_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.cancel_during_invoke = Some(cancellation);
        self
    }

    pub fn with_response_sequence(mut self, responses: Vec<String>) -> Self {
        self.response_texts = responses.into();
        self
    }

    pub fn invoked(&self) -> &[AssistantTurnRequest] {
        &self.invoked
    }

    pub fn cancelled(&self) -> &[Generation] {
        &self.cancelled
    }
}

#[async_trait(?Send)]
impl SpeechTransport for FakeTransport {
    async fn assistant_turn(
        &mut self,
        request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, VoiceCoreError> {
        cancellation.check()?;
        if let Some(token) = &self.cancel_during_invoke {
            token.cancel();
        }
        cancellation.check()?;
        if self.fail_invoke {
            return Err(VoiceCoreError::InvalidTransition);
        }
        self.invoked.push(request.clone());
        let text = if self.response_texts.len() > 1 {
            self.response_texts.pop_front().unwrap_or_default()
        } else {
            self.response_texts.front().cloned().unwrap_or_default()
        };
        Ok(AssistantTurnResponse {
            text,
            session_id: Some(request.session_id),
            request_id: Some(request.request_id),
            correlation_id: Some(request.correlation_id),
        })
    }

    async fn cancel_session(&mut self, generation: Generation) -> Result<(), VoiceCoreError> {
        self.cancelled.push(generation);
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct FakeAudioOutput {
    played: Vec<AudioPlaybackReceipt>,
    played_samples: Vec<Vec<i16>>,
    stopped: Vec<(Generation, TransitionReason)>,
    fail_play: bool,
    fail_stop: bool,
    cancel_during_play: Option<CancellationToken>,
}

impl fmt::Debug for FakeAudioOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FakeAudioOutput")
            .field("played", &self.played)
            .field(
                "played_sample_counts",
                &self.played_samples.iter().map(Vec::len).collect::<Vec<_>>(),
            )
            .field("stopped", &self.stopped)
            .field("fail_play", &self.fail_play)
            .field("fail_stop", &self.fail_stop)
            .field("cancel_during_play", &self.cancel_during_play.is_some())
            .finish()
    }
}

impl FakeAudioOutput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_play_failure(mut self) -> Self {
        self.fail_play = true;
        self
    }

    pub fn with_stop_failure(mut self) -> Self {
        self.fail_stop = true;
        self
    }

    pub fn with_play_cancellation(mut self, cancellation: CancellationToken) -> Self {
        self.cancel_during_play = Some(cancellation);
        self
    }

    pub fn played(&self) -> &[AudioPlaybackReceipt] {
        &self.played
    }

    pub fn played_samples(&self) -> &[Vec<i16>] {
        &self.played_samples
    }

    pub fn stopped(&self) -> &[(Generation, TransitionReason)] {
        &self.stopped
    }
}

#[async_trait(?Send)]
impl AudioOutput for FakeAudioOutput {
    async fn play(
        &mut self,
        context: AudioPlaybackContext,
        audio: TtsSynthesisResult,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<AudioPlaybackReceipt, VoiceCoreError> {
        if cancellation() || audio.cancelled() {
            return Err(VoiceCoreError::Cancelled);
        }
        if let Some(token) = &self.cancel_during_play {
            token.cancel();
        }
        if cancellation() {
            return Err(VoiceCoreError::Cancelled);
        }
        if self.fail_play {
            return Err(VoiceCoreError::InvalidTransition);
        }

        let mut samples = Vec::new();
        for chunk in audio.chunks() {
            samples.extend_from_slice(chunk.samples());
        }
        let receipt = AudioPlaybackReceipt::new(
            context,
            audio.chunk_count(),
            samples.len() as u64,
            TimestampMicros(context.started_at.0.saturating_add(samples.len() as u64)),
        );
        self.played_samples.push(samples);
        self.played.push(receipt);
        Ok(receipt)
    }

    async fn stop(
        &mut self,
        generation: Generation,
        reason: TransitionReason,
    ) -> Result<(), VoiceCoreError> {
        self.stopped.push((generation, reason));
        if self.fail_stop {
            return Err(VoiceCoreError::InvalidTransition);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
pub struct FakeEventSink {
    snapshots: Vec<RedactedSnapshot>,
    events: Vec<RuntimeEvent>,
    fail_after_events: Option<usize>,
}

impl FakeEventSink {
    pub fn with_event_failure_after(fail_after_events: usize) -> Self {
        Self {
            snapshots: Vec::new(),
            events: Vec::new(),
            fail_after_events: Some(fail_after_events),
        }
    }

    pub fn events(&self) -> &[RuntimeEvent] {
        &self.events
    }
}

#[async_trait(?Send)]
impl RuntimeEventSink for FakeEventSink {
    async fn snapshot(&mut self, snapshot: RedactedSnapshot) -> Result<(), VoiceCoreError> {
        self.snapshots.push(snapshot);
        Ok(())
    }

    async fn event(&mut self, event: RuntimeEvent) -> Result<(), VoiceCoreError> {
        if self
            .fail_after_events
            .is_some_and(|limit| self.events.len() >= limit)
        {
            return Err(VoiceCoreError::InvalidTransition);
        }
        let encoded =
            serde_json::to_string(&event).map_err(|_| VoiceCoreError::InvalidTransition)?;
        if encoded.contains("pcm")
            || encoded.contains("sample")
            || encoded.contains("credential")
            || encoded.contains("token")
        {
            return Err(VoiceCoreError::InvalidTransition);
        }
        self.events.push(event);
        Ok(())
    }
}

pub fn fake_frame(sequence: u64, generation: Generation) -> Result<PcmFrame, VoiceCoreError> {
    fake_frame_with_samples(sequence, generation, vec![0.0, 0.25, -0.25], false)
}

pub fn fake_frame_with_samples(
    sequence: u64,
    generation: Generation,
    samples: Vec<f32>,
    discontinuity: bool,
) -> Result<PcmFrame, VoiceCoreError> {
    PcmFrame::new(
        samples,
        TimestampMicros(sequence),
        sequence,
        discontinuity,
        RouteRevision(1),
        generation,
    )
}

pub fn fake_lease(start_reason: CaptureStartReason) -> VoiceCaptureLease {
    VoiceCaptureLease {
        owner: aurora_voice_core::CaptureOwnerKind::Native,
        surface: "test".to_owned(),
        device_route: "default".to_owned(),
        start_reason,
        generation: Generation(0),
        created_at: TimestampMicros(10),
        route_revision: RouteRevision(1),
        background_eligible: false,
        consent_revision: 1,
        heartbeat_at: TimestampMicros(10),
        stop_deadline: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_core::{AssistantTurnNamespace, VoiceRuntime, VoiceState};
    use aurora_voice_engine::MAX_FINITE_STT_SAMPLES;

    #[tokio::test]
    async fn fake_ptt_turn_completes_without_ui_attachment() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?, fake_frame(2, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("hello aurora");
        let transport = FakeTransport::new("answer ready");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let response = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(20),
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(response, "answer ready");
        assert_eq!(runtime.state(), VoiceState::Idle);

        let (audio, engine, transport, output, sink) = runtime.into_parts();
        assert_eq!(audio.started().len(), 1);
        assert_eq!(audio.stopped(), &[TransitionReason::Stop]);
        assert_eq!(engine.spoken(), &["answer ready".to_owned()]);
        assert_eq!(
            engine.transcribed_audio(),
            &[vec![0.0, 0.25, -0.25, 0.0, 0.25, -0.25]]
        );
        assert_eq!(transport.invoked().len(), 1);
        assert_eq!(transport.invoked()[0].transcript, "hello aurora");
        let namespace = AssistantTurnNamespace::new("native-test")?;
        assert_eq!(
            transport.invoked()[0].session_id,
            format!("voice-session-{}-1", namespace.as_str())
        );
        assert_eq!(
            transport.invoked()[0].request_id,
            format!("voice-request-{}-1", namespace.as_str())
        );
        assert_eq!(
            transport.invoked()[0].correlation_id,
            format!("voice-correlation-{}-1", namespace.as_str())
        );
        assert!(!transport.invoked()[0].stream);
        assert_eq!(output.played().len(), 1);
        assert_eq!(
            output.played_samples(),
            &[b"answer ready"
                .iter()
                .map(|sample| i16::from(*sample))
                .collect::<Vec<_>>()]
        );
        assert!(output.stopped().is_empty());
        let playback_index = sink.events().iter().position(|event| {
            matches!(
                event,
                RuntimeEvent::State { transition }
                    if transition.reason == TransitionReason::PlaybackEnded
            )
        });
        assert_eq!(playback_index, Some(sink.events().len().saturating_sub(1)));
        assert!(sink.events().len() >= 7);
        Ok(())
    }

    #[tokio::test]
    async fn synthesized_chunks_reach_output_in_order_before_completion(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("ordered")
            .with_synthesized_chunks(vec![vec![11; 1024], vec![22, 33, 44]]);
        let transport = FakeTransport::new("ordered answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let response = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(21),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(response, "ordered answer");
        let (_audio, _engine, _transport, output, sink) = runtime.into_parts();
        assert_eq!(output.played().len(), 1);
        assert_eq!(output.played()[0].chunk_count, 2);
        assert_eq!(output.played()[0].sample_count, 1027);
        assert_eq!(output.played_samples()[0][0], 11);
        assert_eq!(output.played_samples()[0][1023], 11);
        assert_eq!(&output.played_samples()[0][1024..], &[22, 33, 44]);
        assert!(sink.events().iter().any(|event| matches!(
            event,
            RuntimeEvent::State { transition }
                if transition.reason == TransitionReason::PlaybackEnded
                    && transition.to == VoiceState::Idle
                    && transition.at == output.played()[0].completed_at
        )));
        Ok(())
    }

    #[tokio::test]
    async fn repeat_turn_synthesizes_new_audio_without_replaying_previous_output(
    ) -> Result<(), VoiceCoreError> {
        let audio = FakeAudioInput::new(vec![fake_frame_with_samples(
            1,
            Generation(1),
            vec![0.1],
            false,
        )?]);
        let audio_feed = audio.clone();
        let engine = FakeEngine::new("repeat transcript");
        let transport = FakeTransport::new("unused")
            .with_response_sequence(vec!["first answer".to_owned(), "second answer".to_owned()]);
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let first = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(23),
                CancellationToken::new(),
            )
            .await?;
        audio_feed.push_frame(fake_frame_with_samples(2, Generation(2), vec![0.2], false)?);
        let second = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(33),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(first, "first answer");
        assert_eq!(second, "second answer");
        let (_audio, engine, transport, output, sink) = runtime.into_parts();
        assert_eq!(
            engine.spoken(),
            &["first answer".to_owned(), "second answer".to_owned()]
        );
        assert_eq!(transport.invoked().len(), 2);
        assert_eq!(transport.invoked()[0].generation, Generation(1));
        assert_eq!(transport.invoked()[1].generation, Generation(2));
        assert_eq!(output.played().len(), 2);
        assert_eq!(output.played()[0].generation, Generation(1));
        assert_eq!(output.played()[1].generation, Generation(2));
        assert_eq!(
            output.played_samples()[0],
            b"first answer"
                .iter()
                .map(|sample| i16::from(*sample))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            output.played_samples()[1],
            b"second answer"
                .iter()
                .map(|sample| i16::from(*sample))
                .collect::<Vec<_>>()
        );
        assert_ne!(output.played_samples()[0], output.played_samples()[1]);
        assert_eq!(
            sink.events()
                .iter()
                .filter(|event| matches!(
                    event,
                    RuntimeEvent::State { transition }
                        if transition.reason == TransitionReason::PlaybackEnded
                ))
                .count(),
            2
        );
        Ok(())
    }

    #[tokio::test]
    async fn finite_stt_receives_only_current_generation_pcm() -> Result<(), VoiceCoreError> {
        let frames = vec![
            fake_frame_with_samples(1, Generation(0), vec![0.9], false)?,
            fake_frame_with_samples(2, Generation(1), vec![0.1, 0.2], false)?,
            fake_frame_with_samples(3, Generation(1), vec![-0.3], false)?,
        ];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("current only");
        let transport = FakeTransport::new("answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let response = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(22),
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(response, "answer");

        let (_audio, engine, _transport, output, _sink) = runtime.into_parts();
        assert_eq!(engine.transcribed_audio(), &[vec![0.1, 0.2, -0.3]]);
        assert_eq!(output.played().len(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn discontinuity_discards_buffered_pcm_before_transcribe() -> Result<(), VoiceCoreError> {
        let frames = vec![
            fake_frame_with_samples(1, Generation(1), vec![0.1], false)?,
            fake_frame_with_samples(2, Generation(1), vec![0.2], true)?,
        ];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("unused");
        let transport = FakeTransport::new("unused answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(24),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::InvalidTransition)));

        let (_audio, engine, transport, output, _sink) = runtime.into_parts();
        assert!(engine.transcribed_audio().is_empty());
        assert!(transport.invoked().is_empty());
        assert!(output.played().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn finite_stt_overflow_fails_before_eof_without_provider_call(
    ) -> Result<(), VoiceCoreError> {
        let frame_samples = MAX_FINITE_STT_SAMPLES / 5 + 1;
        let frames = (1..=5)
            .map(|sequence| {
                fake_frame_with_samples(sequence, Generation(1), vec![0.0; frame_samples], false)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("unused");
        let transport = FakeTransport::new("unused answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(26),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(
            result,
            Err(VoiceCoreError::Engine(EngineError::InvalidRequest))
        ));

        let (_audio, engine, transport, output, _sink) = runtime.into_parts();
        assert!(engine.transcribed_audio().is_empty());
        assert!(transport.invoked().is_empty());
        assert!(output.played().is_empty());
        Ok(())
    }

    #[test]
    fn fake_engine_debug_redacts_recorded_pcm() {
        let mut engine = FakeEngine::new("SECRET_FAKE_ENGINE_TRANSCRIPT");
        engine.spoken.push("SECRET_FAKE_ENGINE_SPOKEN".to_owned());
        engine.transcribed_audio.push(vec![0.123, -0.456]);
        let debug = format!("{engine:?}");
        assert!(debug.contains("transcript_bytes"));
        assert!(debug.contains("transcribed_sample_counts"));
        assert!(!debug.contains("SECRET_FAKE_ENGINE_TRANSCRIPT"));
        assert!(!debug.contains("SECRET_FAKE_ENGINE_SPOKEN"));
        assert!(!debug.contains("0.123"));
        assert!(!debug.contains("-0.456"));
    }

    #[tokio::test]
    async fn runtime_instance_id_not_surface_namespaces_assistant_requests(
    ) -> Result<(), VoiceCoreError> {
        async fn run_instance(
            runtime_instance_id: &str,
        ) -> Result<(AssistantTurnRequest, Vec<String>), VoiceCoreError> {
            let frames = vec![fake_frame(1, Generation(1))?, fake_frame(2, Generation(1))?];
            let audio = FakeAudioInput::new(frames);
            let engine = FakeEngine::new("hello aurora");
            let transport = FakeTransport::new("answer ready");
            let sink = FakeEventSink::default();
            let mut runtime = VoiceRuntime::new(
                audio,
                engine,
                transport,
                FakeAudioOutput::new(),
                sink,
                "desktop",
                runtime_instance_id,
            )?;

            let _response = runtime
                .run_push_to_talk_turn(
                    fake_lease(CaptureStartReason::PushToTalk),
                    TimestampMicros(20),
                    CancellationToken::new(),
                )
                .await?;
            let (_audio, _engine, transport, _output, sink) = runtime.into_parts();
            let request = transport.invoked()[0].clone();
            let surfaces = sink
                .events()
                .iter()
                .filter_map(|event| match event {
                    RuntimeEvent::State { transition } => Some(transition.surface.clone()),
                    _ => None,
                })
                .collect();
            Ok((request, surfaces))
        }

        let (first, first_surfaces) = run_instance("instance-one").await?;
        let (second, second_surfaces) = run_instance("instance-two").await?;

        assert_eq!(first.generation, second.generation);
        assert_ne!(first.session_id, second.session_id);
        assert_ne!(first.request_id, second.request_id);
        assert_ne!(first.correlation_id, second.correlation_id);
        assert!(first_surfaces.iter().all(|surface| surface == "desktop"));
        assert!(second_surfaces.iter().all(|surface| surface == "desktop"));
        assert!(!first.session_id.contains("desktop"));
        Ok(())
    }

    #[tokio::test]
    async fn fake_wake_turn_uses_same_runtime_path() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("wake phrase");
        let transport = FakeTransport::new("wake answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime =
            VoiceRuntime::new(audio, engine, transport, output, sink, "test", "web-test")?;

        let response = runtime
            .run_wake_turn(
                fake_lease(CaptureStartReason::ForegroundWake),
                TimestampMicros(30),
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(response, "wake answer");
        assert_eq!(runtime.state(), VoiceState::Idle);
        let (_audio, _engine, _transport, _output, sink) = runtime.into_parts();
        assert!(sink.events().iter().any(|event| matches!(
            event,
            RuntimeEvent::State { transition }
                if transition.to == VoiceState::ListeningForWake
        )));
        Ok(())
    }

    #[test]
    fn fake_clock_is_deterministic() {
        let mut clock = FakeClock::new();
        assert_eq!(clock.now(), TimestampMicros(0));
        assert_eq!(clock.advance(5), TimestampMicros(5));
        assert_eq!(clock.advance(7), TimestampMicros(12));
    }

    #[tokio::test]
    async fn cancelled_turn_propagates_to_engine_transport_and_cleans_capture(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("cancel me");
        let transport = FakeTransport::new("unused");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(40),
                cancellation,
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::Cancelled)));
        assert_eq!(runtime.state(), VoiceState::Disabled);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[]);
        assert_eq!(engine.cancelled(), &[1]);
        assert!(engine.transcribed_audio().is_empty());
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn audio_start_failure_releases_without_stop() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames).with_start_failure();
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(45),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::InvalidTransition)));
        assert_eq!(runtime.state(), VoiceState::Disabled);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn audio_frame_failure_stops_releases_and_allows_next_turn() -> Result<(), VoiceCoreError>
    {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames).with_next_frame_failure();
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(50),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::Backpressure)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (_audio, engine, transport, output, _sink) = runtime.into_parts();
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn provider_failure_runs_cleanup_and_releases_generation() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first").with_transcribe_failure();
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(60),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(
            result,
            Err(VoiceCoreError::Engine(EngineError::ProviderFault { .. }))
        ));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert!(engine.transcribed_audio().is_empty());
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn provider_cancellation_callback_runs_cleanup() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let cancellation = CancellationToken::new();
        let engine = FakeEngine::new("first").with_transcribe_cancellation(cancellation.clone());
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(65),
                cancellation,
            )
            .await;
        assert!(matches!(
            result,
            Err(VoiceCoreError::Engine(EngineError::Cancelled))
        ));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert!(engine.transcribed_audio().is_empty());
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn transport_failure_runs_cleanup_and_releases_generation() -> Result<(), VoiceCoreError>
    {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer").with_invoke_failure();
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(70),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::InvalidTransition)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn transport_cancellation_token_runs_cleanup() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let cancellation = CancellationToken::new();
        let engine = FakeEngine::new("first");
        let transport =
            FakeTransport::new("first answer").with_invoke_cancellation(cancellation.clone());
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(75),
                cancellation,
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::Cancelled)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn output_failure_does_not_emit_playback_completion_or_replay_stale_audio(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new().with_play_failure();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(77),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::InvalidTransition)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.spoken(), &["first answer".to_owned()]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        assert!(!sink.events().iter().any(|event| matches!(
            event,
            RuntimeEvent::State { transition }
                if transition.reason == TransitionReason::PlaybackEnded
        )));
        Ok(())
    }

    #[tokio::test]
    async fn output_stop_failure_after_play_failure_reports_cleanup_and_still_releases(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new()
            .with_play_failure()
            .with_stop_failure();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(77),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(
            result,
            Err(VoiceCoreError::TransportFault { code }) if code == "playback_cleanup_failed"
        ));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.spoken(), &["first answer".to_owned()]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        let error_text = VoiceCoreError::TransportFault {
            code: "playback_cleanup_failed".to_owned(),
        }
        .to_string();
        assert!(!error_text.contains("first answer"));
        assert!(!error_text.contains("sample"));
        assert!(!sink.events().iter().any(|event| matches!(
            event,
            RuntimeEvent::State { transition }
                if transition.reason == TransitionReason::PlaybackEnded
        )));
        Ok(())
    }

    #[tokio::test]
    async fn output_cancellation_stops_without_playback_completion() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let cancellation = CancellationToken::new();
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new().with_play_cancellation(cancellation.clone());
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(78),
                cancellation,
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::Cancelled)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        assert!(!sink.events().iter().any(|event| matches!(
            event,
            RuntimeEvent::State { transition }
                if transition.reason == TransitionReason::PlaybackEnded
        )));
        Ok(())
    }

    #[tokio::test]
    async fn output_stop_failure_after_playback_cancel_reports_cleanup_and_still_releases(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let cancellation = CancellationToken::new();
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new()
            .with_play_cancellation(cancellation.clone())
            .with_stop_failure();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(78),
                cancellation,
            )
            .await;
        assert!(matches!(
            result,
            Err(VoiceCoreError::TransportFault { code }) if code == "playback_cleanup_failed"
        ));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        assert!(!sink.events().iter().any(|event| matches!(
            event,
            RuntimeEvent::State { transition }
                if transition.reason == TransitionReason::PlaybackEnded
        )));
        Ok(())
    }

    #[tokio::test]
    async fn sink_transition_failure_runs_cleanup_and_resets_state() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let output = FakeAudioOutput::new();
        let sink = FakeEventSink::with_event_failure_after(1);
        let mut runtime = VoiceRuntime::new(
            audio,
            engine,
            transport,
            output,
            sink,
            "test",
            "native-test",
        )?;

        let result = runtime
            .run_wake_turn(
                fake_lease(CaptureStartReason::ForegroundWake),
                TimestampMicros(80),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::InvalidTransition)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(!runtime.has_active_capture());

        let (audio, engine, transport, output, sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert!(output.played().is_empty());
        assert_eq!(
            output.stopped(),
            &[(Generation(1), TransitionReason::Cancel)]
        );
        assert_eq!(sink.events().len(), 1);
        Ok(())
    }
}
