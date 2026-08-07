//! Deterministic test doubles for the Aurora voice runtime.

#![forbid(unsafe_code)]

pub mod model_store;

use async_trait::async_trait;
use aurora_voice_core::{
    AudioInput, CancellationToken, CaptureStartReason, EngineError, Generation, PcmFrame,
    RedactedSnapshot, ResourceReport, RouteRevision, RuntimeEvent, RuntimeEventSink, SpeechEngine,
    SpeechTransport, TaskCapability, TaskProvider, TaskReadiness, TaskRequest, TimestampMicros,
    TransitionReason, VoiceCaptureLease, VoiceCoreError, VoiceTask,
};
use serde_json::json;
use std::collections::VecDeque;

pub use model_store::*;

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
    frames: VecDeque<PcmFrame>,
    started: Vec<VoiceCaptureLease>,
    stopped: Vec<TransitionReason>,
    route_revision: RouteRevision,
    fail_start: bool,
    fail_next_frame: bool,
}

impl FakeAudioInput {
    pub fn new(frames: impl IntoIterator<Item = PcmFrame>) -> Self {
        Self {
            frames: frames.into_iter().collect(),
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
        Ok(self.frames.pop_front())
    }

    fn current_route_revision(&self) -> RouteRevision {
        self.route_revision
    }
}

#[derive(Debug, Clone)]
pub struct FakeEngine {
    transcript: String,
    spoken: Vec<String>,
    cancelled: Vec<u64>,
    report: ResourceReport,
    fail_transcribe: bool,
    fail_synthesize: bool,
    cancel_during_transcribe: Option<CancellationToken>,
}

impl FakeEngine {
    pub fn new(transcript: impl Into<String>) -> Self {
        Self {
            transcript: transcript.into(),
            spoken: Vec::new(),
            cancelled: Vec::new(),
            report: ResourceReport {
                loaded_tasks: vec![VoiceTask::SpeechToText, VoiceTask::TextToSpeech],
                memory_bytes: 1024,
                active_streams: 0,
                readiness: TaskReadiness::Ready,
            },
            fail_transcribe: false,
            fail_synthesize: false,
            cancel_during_transcribe: None,
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

    pub fn spoken(&self) -> &[String] {
        &self.spoken
    }

    pub fn cancelled(&self) -> &[u64] {
        &self.cancelled
    }
}

#[async_trait(?Send)]
impl TaskProvider for FakeEngine {
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![
            TaskCapability::new(VoiceTask::SpeechToText, 16_000)
                .with_languages(["en"])
                .streaming(false),
            TaskCapability::new(VoiceTask::TextToSpeech, 16_000)
                .with_languages(["en"])
                .streaming(true),
        ]
    }

    fn resource_report(&self) -> ResourceReport {
        self.report.clone()
    }

    async fn warm_task(&mut self, request: TaskRequest) -> Result<(), EngineError> {
        if self
            .capabilities()
            .iter()
            .any(|capability| capability.task == request.task)
        {
            Ok(())
        } else {
            Err(EngineError::TaskUnavailable)
        }
    }

    async fn unload_task(&mut self, task: VoiceTask) -> Result<(), EngineError> {
        self.report.loaded_tasks.retain(|loaded| *loaded != task);
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
        request: TaskRequest,
        frames: usize,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<String, EngineError> {
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
                code: "fake_transcribe".to_owned(),
            });
        }
        if request.task != VoiceTask::SpeechToText || frames == 0 {
            return Err(EngineError::InvalidRequest);
        }
        Ok(self.transcript.clone())
    }

    async fn synthesize_text(
        &mut self,
        request: TaskRequest,
        text: &str,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<i16>, EngineError> {
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        if self.fail_synthesize {
            return Err(EngineError::ProviderFault {
                code: "fake_synthesize".to_owned(),
            });
        }
        if request.task != VoiceTask::TextToSpeech {
            return Err(EngineError::InvalidRequest);
        }
        self.spoken.push(text.to_owned());
        Ok(vec![0; text.len().max(1)])
    }
}

#[derive(Debug, Clone)]
pub struct FakeTransport {
    response_text: String,
    invoked: Vec<String>,
    cancelled: Vec<Generation>,
    fail_invoke: bool,
    cancel_during_invoke: Option<CancellationToken>,
}

impl FakeTransport {
    pub fn new(response_text: impl Into<String>) -> Self {
        Self {
            response_text: response_text.into(),
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

    pub fn invoked(&self) -> &[String] {
        &self.invoked
    }

    pub fn cancelled(&self) -> &[Generation] {
        &self.cancelled
    }
}

#[async_trait(?Send)]
impl SpeechTransport for FakeTransport {
    async fn invoke_finite(
        &mut self,
        method: &str,
        payload: serde_json::Value,
        cancellation: CancellationToken,
    ) -> Result<serde_json::Value, VoiceCoreError> {
        cancellation.check()?;
        if let Some(token) = &self.cancel_during_invoke {
            token.cancel();
        }
        cancellation.check()?;
        if self.fail_invoke {
            return Err(VoiceCoreError::InvalidTransition);
        }
        self.invoked.push(format!("{method}:{payload}"));
        Ok(json!({ "text": self.response_text }))
    }

    async fn cancel_session(&mut self, generation: Generation) -> Result<(), VoiceCoreError> {
        self.cancelled.push(generation);
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
    PcmFrame::new(
        vec![0.0, 0.25, -0.25],
        TimestampMicros(sequence),
        sequence,
        false,
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
    use aurora_voice_core::{VoiceRuntime, VoiceState};

    #[tokio::test]
    async fn fake_ptt_turn_completes_without_ui_attachment() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?, fake_frame(2, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("hello aurora");
        let transport = FakeTransport::new("answer ready");
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

        let response = runtime
            .run_push_to_talk_turn(
                fake_lease(CaptureStartReason::PushToTalk),
                TimestampMicros(20),
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(response, "answer ready");
        assert_eq!(runtime.state(), VoiceState::Idle);

        let (audio, engine, transport, sink) = runtime.into_parts();
        assert_eq!(audio.started().len(), 1);
        assert_eq!(audio.stopped(), &[TransitionReason::Stop]);
        assert_eq!(engine.spoken(), &["answer ready".to_owned()]);
        assert_eq!(transport.invoked().len(), 1);
        assert!(sink.events().len() >= 7);
        Ok(())
    }

    #[tokio::test]
    async fn fake_wake_turn_uses_same_runtime_path() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("wake phrase");
        let transport = FakeTransport::new("wake answer");
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "web-test");

        let response = runtime
            .run_wake_turn(
                fake_lease(CaptureStartReason::ForegroundWake),
                TimestampMicros(30),
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(response, "wake answer");
        assert_eq!(runtime.state(), VoiceState::Idle);
        let (_audio, _engine, _transport, sink) = runtime.into_parts();
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
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");
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

        let (audio, engine, transport, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        Ok(())
    }

    #[tokio::test]
    async fn audio_start_failure_releases_without_stop() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames).with_start_failure();
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

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

        let (audio, engine, transport, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        Ok(())
    }

    #[tokio::test]
    async fn audio_frame_failure_stops_releases_and_allows_next_turn() -> Result<(), VoiceCoreError>
    {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames).with_next_frame_failure();
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

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

        let (_audio, engine, transport, _sink) = runtime.into_parts();
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        Ok(())
    }

    #[tokio::test]
    async fn provider_failure_runs_cleanup_and_releases_generation() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first").with_transcribe_failure();
        let transport = FakeTransport::new("first answer");
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

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

        let (audio, engine, transport, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        Ok(())
    }

    #[tokio::test]
    async fn provider_cancellation_callback_runs_cleanup() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let cancellation = CancellationToken::new();
        let engine = FakeEngine::new("first").with_transcribe_cancellation(cancellation.clone());
        let transport = FakeTransport::new("first answer");
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

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

        let (audio, engine, transport, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        Ok(())
    }

    #[tokio::test]
    async fn transport_failure_runs_cleanup_and_releases_generation() -> Result<(), VoiceCoreError>
    {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer").with_invoke_failure();
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

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

        let (audio, engine, transport, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
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
        let sink = FakeEventSink::default();
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

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

        let (audio, engine, transport, _sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        Ok(())
    }

    #[tokio::test]
    async fn sink_transition_failure_runs_cleanup_and_resets_state() -> Result<(), VoiceCoreError> {
        let frames = vec![fake_frame(1, Generation(1))?];
        let audio = FakeAudioInput::new(frames);
        let engine = FakeEngine::new("first");
        let transport = FakeTransport::new("first answer");
        let sink = FakeEventSink::with_event_failure_after(1);
        let mut runtime = VoiceRuntime::new(audio, engine, transport, sink, "native-test");

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

        let (audio, engine, transport, sink) = runtime.into_parts();
        assert_eq!(audio.stopped(), &[TransitionReason::Cancel]);
        assert_eq!(engine.cancelled(), &[1]);
        assert_eq!(transport.cancelled(), &[Generation(1)]);
        assert_eq!(sink.events().len(), 1);
        Ok(())
    }
}
