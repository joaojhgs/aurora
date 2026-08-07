//! Deterministic test doubles for the Aurora voice runtime.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use aurora_voice_core::{
    AudioInput, CancellationToken, CaptureStartReason, EngineError, Generation, PcmFrame,
    RedactedSnapshot, ResourceReport, RouteRevision, RuntimeEvent, RuntimeEventSink, SpeechEngine,
    SpeechTransport, TaskCapability, TaskProvider, TaskReadiness, TaskRequest, TimestampMicros,
    TransitionReason, VoiceCaptureLease, VoiceCoreError, VoiceTask,
};
use serde_json::json;
use std::collections::VecDeque;

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
}

impl FakeAudioInput {
    pub fn new(frames: impl IntoIterator<Item = PcmFrame>) -> Self {
        Self {
            frames: frames.into_iter().collect(),
            started: Vec::new(),
            stopped: Vec::new(),
            route_revision: RouteRevision(1),
        }
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
        self.route_revision = lease.route_revision;
        self.started.push(lease);
        Ok(())
    }

    async fn stop(&mut self, reason: TransitionReason) -> Result<(), VoiceCoreError> {
        self.stopped.push(reason);
        Ok(())
    }

    async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
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
        }
    }

    pub fn spoken(&self) -> &[String] {
        &self.spoken
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
    ) -> Result<String, EngineError> {
        if request.task != VoiceTask::SpeechToText || frames == 0 {
            return Err(EngineError::InvalidRequest);
        }
        Ok(self.transcript.clone())
    }

    async fn synthesize_text(
        &mut self,
        request: TaskRequest,
        text: &str,
    ) -> Result<Vec<i16>, EngineError> {
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
}

impl FakeTransport {
    pub fn new(response_text: impl Into<String>) -> Self {
        Self {
            response_text: response_text.into(),
            invoked: Vec::new(),
            cancelled: Vec::new(),
        }
    }

    pub fn invoked(&self) -> &[String] {
        &self.invoked
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
}

impl FakeEventSink {
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
}
