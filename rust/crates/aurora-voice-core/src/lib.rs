//! Shared Aurora voice orchestration, ownership, and state.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use thiserror::Error;

pub use aurora_voice_engine::{
    BoundFiniteSttRequest, BoundTaskRequest, BoundTtsSynthesisRequest, EngineError, FiniteSttAudio,
    FiniteSttAudioBuilder, FiniteSttResult, ResourceReport, SpeechEngine, TaskCapability,
    TaskPackBinding, TaskProvider, TaskReadiness, TaskRequest, TtsSynthesisConfig,
    TtsSynthesisResult, VoiceTask,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Generation(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct RouteRevision(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TimestampMicros(pub u64);

#[derive(Debug, Clone, Error, PartialEq)]
pub enum VoiceCoreError {
    #[error("empty audio frame")]
    EmptyFrame,
    #[error("frame sample count mismatch")]
    SampleCountMismatch,
    #[error("audio sample outside normalized range")]
    SampleOutOfRange,
    #[error("audio sample is not finite")]
    SampleNotFinite,
    #[error("stale generation")]
    StaleGeneration,
    #[error("buffer closed")]
    BufferClosed,
    #[error("buffer is full")]
    Backpressure,
    #[error("capture owner already active")]
    OwnerAlreadyActive,
    #[error("no capture owner active")]
    NoOwnerActive,
    #[error("capture owner mismatch")]
    OwnerMismatch,
    #[error("invalid state transition")]
    InvalidTransition,
    #[error("cancelled")]
    Cancelled,
    #[error("transport fault: {code}")]
    TransportFault { code: String },
    #[error("invalid identifier")]
    InvalidIdentifier,
    #[error("internal state lock poisoned")]
    LockPoisoned,
    #[error("engine error: {0}")]
    Engine(#[from] EngineError),
}

#[derive(Debug, Clone, PartialEq)]
pub struct PcmFrame {
    samples: Vec<f32>,
    timestamp: TimestampMicros,
    sample_count: usize,
    sequence: u64,
    discontinuity: bool,
    route_revision: RouteRevision,
    generation: Generation,
}

impl PcmFrame {
    pub fn new(
        samples: Vec<f32>,
        timestamp: TimestampMicros,
        sequence: u64,
        discontinuity: bool,
        route_revision: RouteRevision,
        generation: Generation,
    ) -> Result<Self, VoiceCoreError> {
        Self::with_sample_count(
            samples.len(),
            samples,
            timestamp,
            sequence,
            discontinuity,
            route_revision,
            generation,
        )
    }

    pub fn with_sample_count(
        sample_count: usize,
        samples: Vec<f32>,
        timestamp: TimestampMicros,
        sequence: u64,
        discontinuity: bool,
        route_revision: RouteRevision,
        generation: Generation,
    ) -> Result<Self, VoiceCoreError> {
        if sample_count == 0 || samples.is_empty() {
            return Err(VoiceCoreError::EmptyFrame);
        }
        if sample_count != samples.len() {
            return Err(VoiceCoreError::SampleCountMismatch);
        }
        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err(VoiceCoreError::SampleNotFinite);
        }
        if samples
            .iter()
            .any(|sample| *sample < -1.0_f32 || *sample > 1.0_f32)
        {
            return Err(VoiceCoreError::SampleOutOfRange);
        }

        Ok(Self {
            samples,
            timestamp,
            sample_count,
            sequence,
            discontinuity,
            route_revision,
            generation,
        })
    }

    pub fn from_i16(
        samples: &[i16],
        timestamp: TimestampMicros,
        sequence: u64,
        discontinuity: bool,
        route_revision: RouteRevision,
        generation: Generation,
    ) -> Result<Self, VoiceCoreError> {
        let normalized = samples
            .iter()
            .map(|sample| {
                if *sample == i16::MIN {
                    -1.0
                } else {
                    f32::from(*sample) / f32::from(i16::MAX)
                }
            })
            .collect();
        Self::new(
            normalized,
            timestamp,
            sequence,
            discontinuity,
            route_revision,
            generation,
        )
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    pub fn timestamp(&self) -> TimestampMicros {
        self.timestamp
    }

    pub fn sample_count(&self) -> usize {
        self.sample_count
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn discontinuity(&self) -> bool {
        self.discontinuity
    }

    pub fn route_revision(&self) -> RouteRevision {
        self.route_revision
    }

    pub fn generation(&self) -> Generation {
        self.generation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferPush {
    Accepted,
    DroppedOldest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BufferStats {
    pub frames: usize,
    pub samples: usize,
    pub dropped_frames: u64,
    pub discontinuities: u64,
    pub closed: bool,
}

#[derive(Debug)]
struct BufferInner {
    frames: VecDeque<PcmFrame>,
    samples: usize,
    dropped_frames: u64,
    discontinuities: u64,
    closed: bool,
}

#[derive(Debug)]
pub struct BoundedPcmBuffer {
    max_frames: usize,
    max_samples: usize,
    generation: Generation,
    drop_oldest: bool,
    inner: Mutex<BufferInner>,
}

impl BoundedPcmBuffer {
    pub fn nonblocking_queue(
        max_frames: usize,
        max_samples: usize,
        generation: Generation,
    ) -> Self {
        Self::new(max_frames, max_samples, generation, false)
    }

    pub fn pre_roll(max_frames: usize, max_samples: usize, generation: Generation) -> Self {
        Self::new(max_frames, max_samples, generation, true)
    }

    fn new(
        max_frames: usize,
        max_samples: usize,
        generation: Generation,
        drop_oldest: bool,
    ) -> Self {
        Self {
            max_frames: max_frames.max(1),
            max_samples: max_samples.max(1),
            generation,
            drop_oldest,
            inner: Mutex::new(BufferInner {
                frames: VecDeque::new(),
                samples: 0,
                dropped_frames: 0,
                discontinuities: 0,
                closed: false,
            }),
        }
    }

    pub fn push(&self, frame: PcmFrame) -> Result<BufferPush, VoiceCoreError> {
        if frame.generation() != self.generation {
            return Err(VoiceCoreError::StaleGeneration);
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCoreError::LockPoisoned)?;
        if inner.closed {
            return Err(VoiceCoreError::BufferClosed);
        }
        if frame.discontinuity() {
            inner.discontinuities = inner.discontinuities.saturating_add(1);
        }
        if frame.sample_count() > self.max_samples {
            inner.dropped_frames = inner.dropped_frames.saturating_add(1);
            return Err(VoiceCoreError::Backpressure);
        }

        let mut dropped_oldest = false;
        while inner.frames.len() >= self.max_frames
            || inner.samples.saturating_add(frame.sample_count()) > self.max_samples
        {
            if !self.drop_oldest {
                inner.dropped_frames = inner.dropped_frames.saturating_add(1);
                return Err(VoiceCoreError::Backpressure);
            }
            if let Some(dropped) = inner.frames.pop_front() {
                inner.samples = inner.samples.saturating_sub(dropped.sample_count());
                inner.dropped_frames = inner.dropped_frames.saturating_add(1);
                dropped_oldest = true;
            } else {
                break;
            }
        }

        inner.samples = inner.samples.saturating_add(frame.sample_count());
        inner.frames.push_back(frame);
        Ok(if dropped_oldest {
            BufferPush::DroppedOldest
        } else {
            BufferPush::Accepted
        })
    }

    pub fn pop(&self) -> Result<Option<PcmFrame>, VoiceCoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCoreError::LockPoisoned)?;
        let frame = inner.frames.pop_front();
        if let Some(frame) = &frame {
            inner.samples = inner.samples.saturating_sub(frame.sample_count());
        }
        Ok(frame)
    }

    pub fn clear(&self) -> Result<(), VoiceCoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCoreError::LockPoisoned)?;
        inner.frames.clear();
        inner.samples = 0;
        Ok(())
    }

    pub fn close(&self) -> Result<(), VoiceCoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCoreError::LockPoisoned)?;
        inner.closed = true;
        inner.frames.clear();
        inner.samples = 0;
        Ok(())
    }

    pub fn stats(&self) -> Result<BufferStats, VoiceCoreError> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| VoiceCoreError::LockPoisoned)?;
        Ok(BufferStats {
            frames: inner.frames.len(),
            samples: inner.samples,
            dropped_frames: inner.dropped_frames,
            discontinuities: inner.discontinuities,
            closed: inner.closed,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), VoiceCoreError> {
        if self.is_cancelled() {
            Err(VoiceCoreError::Cancelled)
        } else {
            Ok(())
        }
    }
}

const MAX_ASSISTANT_NAMESPACE_LEN: usize = 64;

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AssistantTurnNamespace(String);

impl AssistantTurnNamespace {
    pub fn new(value: impl Into<String>) -> Result<Self, VoiceCoreError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_ASSISTANT_NAMESPACE_LEN
            || !value.bytes().all(
                |byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.'),
            )
        {
            return Err(VoiceCoreError::InvalidIdentifier);
        }
        let digest = Sha256::digest(value.as_bytes());
        Ok(Self(format!(
            "{:016x}",
            u64::from_be_bytes([
                digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6],
                digest[7],
            ])
        )))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AssistantTurnNamespace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AssistantTurnNamespace([redacted])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantTurnRequest {
    pub generation: Generation,
    pub transcript: String,
    pub session_id: String,
    pub request_id: String,
    pub correlation_id: String,
    pub stream: bool,
}

impl AssistantTurnRequest {
    pub fn from_generation(
        namespace: &AssistantTurnNamespace,
        generation: Generation,
        transcript: impl Into<String>,
    ) -> Self {
        let suffix = generation.0;
        Self {
            generation,
            transcript: transcript.into(),
            session_id: format!("voice-session-{}-{suffix}", namespace.as_str()),
            request_id: format!("voice-request-{}-{suffix}", namespace.as_str()),
            correlation_id: format!("voice-correlation-{}-{suffix}", namespace.as_str()),
            stream: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantTurnResponse {
    pub text: String,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureOwnerKind {
    Python,
    Native,
    Web,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureStartReason {
    PushToTalk,
    ForegroundWake,
    BackgroundSession,
    AssistantRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceCaptureLease {
    pub owner: CaptureOwnerKind,
    pub surface: String,
    pub device_route: String,
    pub start_reason: CaptureStartReason,
    pub generation: Generation,
    pub created_at: TimestampMicros,
    pub route_revision: RouteRevision,
    pub background_eligible: bool,
    pub consent_revision: u64,
    pub heartbeat_at: TimestampMicros,
    pub stop_deadline: Option<TimestampMicros>,
}

#[derive(Debug, Default)]
pub struct CaptureLeaseManager {
    active: Option<VoiceCaptureLease>,
    generation: u64,
}

impl CaptureLeaseManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request_start(
        &mut self,
        mut lease: VoiceCaptureLease,
    ) -> Result<VoiceCaptureLease, VoiceCoreError> {
        if self.active.is_some() {
            return Err(VoiceCoreError::OwnerAlreadyActive);
        }
        self.generation = self.generation.saturating_add(1);
        lease.generation = Generation(self.generation);
        lease.heartbeat_at = lease.created_at;
        self.active = Some(lease.clone());
        Ok(lease)
    }

    pub fn release(
        &mut self,
        owner: &CaptureOwnerKind,
        generation: Generation,
    ) -> Result<(), VoiceCoreError> {
        let active = self.active.as_ref().ok_or(VoiceCoreError::NoOwnerActive)?;
        if active.owner != *owner || active.generation != generation {
            return Err(VoiceCoreError::OwnerMismatch);
        }
        self.active = None;
        Ok(())
    }

    pub fn accepts_generation(&self, generation: Generation) -> bool {
        self.active
            .as_ref()
            .is_some_and(|lease| lease.generation == generation)
    }

    pub fn active(&self) -> Option<&VoiceCaptureLease> {
        self.active.as_ref()
    }

    pub fn has_active(&self) -> bool {
        self.active.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceState {
    Disabled,
    Provisioning,
    Unavailable,
    Idle,
    Arming,
    ListeningForWake,
    WakeDetected,
    CapturingUtterance,
    Transcribing,
    Dispatching,
    AwaitingResponse,
    Speaking,
    Interrupted,
    Suspended,
    Recovering,
    Stopping,
    Faulted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionReason {
    Enable,
    Provisioned,
    Unavailable,
    PushToTalk,
    WakeArm,
    WakeDetected,
    SpeechStarted,
    SpeechEnded,
    Transcribed,
    Dispatched,
    ResponseReady,
    PlaybackStarted,
    PlaybackEnded,
    Interrupted,
    Suspend,
    Recover,
    Stop,
    Cancel,
    Fault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceTransition {
    pub from: VoiceState,
    pub to: VoiceState,
    pub reason: TransitionReason,
    pub generation: Generation,
    pub surface: String,
    pub route_revision: RouteRevision,
    pub at: TimestampMicros,
}

#[derive(Debug, Clone)]
pub struct VoiceStateMachine {
    state: VoiceState,
    generation: Generation,
    surface: String,
    route_revision: RouteRevision,
    transitions: Vec<VoiceTransition>,
}

impl VoiceStateMachine {
    pub fn new(surface: impl Into<String>) -> Self {
        Self {
            state: VoiceState::Disabled,
            generation: Generation(0),
            surface: surface.into(),
            route_revision: RouteRevision(0),
            transitions: Vec::new(),
        }
    }

    pub fn state(&self) -> VoiceState {
        self.state
    }

    pub fn generation(&self) -> Generation {
        self.generation
    }

    pub fn transitions(&self) -> &[VoiceTransition] {
        &self.transitions
    }

    pub fn transition(
        &mut self,
        to: VoiceState,
        reason: TransitionReason,
        generation: Generation,
        route_revision: RouteRevision,
        at: TimestampMicros,
    ) -> Result<VoiceTransition, VoiceCoreError> {
        if !Self::transition_allowed(self.state, to, reason) {
            return Err(VoiceCoreError::InvalidTransition);
        }
        if generation.0 < self.generation.0 {
            return Err(VoiceCoreError::StaleGeneration);
        }
        self.generation = generation;
        self.route_revision = route_revision;
        let transition = VoiceTransition {
            from: self.state,
            to,
            reason,
            generation,
            surface: self.surface.clone(),
            route_revision,
            at,
        };
        self.state = to;
        self.transitions.push(transition.clone());
        Ok(transition)
    }

    pub fn cancel(
        &mut self,
        generation: Generation,
        route_revision: RouteRevision,
        at: TimestampMicros,
    ) -> Result<VoiceTransition, VoiceCoreError> {
        self.transition(
            VoiceState::Stopping,
            TransitionReason::Cancel,
            generation,
            route_revision,
            at,
        )
    }

    pub fn transition_allowed(from: VoiceState, to: VoiceState, reason: TransitionReason) -> bool {
        if matches!(reason, TransitionReason::Cancel | TransitionReason::Fault) {
            return !matches!(from, VoiceState::Disabled);
        }
        matches!(
            (from, to, reason),
            (
                VoiceState::Disabled,
                VoiceState::Provisioning,
                TransitionReason::Enable
            ) | (
                VoiceState::Disabled,
                VoiceState::Idle,
                TransitionReason::Enable
            ) | (
                VoiceState::Provisioning,
                VoiceState::Idle,
                TransitionReason::Provisioned
            ) | (
                VoiceState::Provisioning,
                VoiceState::Unavailable,
                TransitionReason::Unavailable
            ) | (
                VoiceState::Unavailable,
                VoiceState::Recovering,
                TransitionReason::Recover
            ) | (
                VoiceState::Recovering,
                VoiceState::Idle,
                TransitionReason::Provisioned
            ) | (
                VoiceState::Idle,
                VoiceState::Arming,
                TransitionReason::PushToTalk
            ) | (
                VoiceState::Idle,
                VoiceState::ListeningForWake,
                TransitionReason::WakeArm
            ) | (
                VoiceState::ListeningForWake,
                VoiceState::WakeDetected,
                TransitionReason::WakeDetected
            ) | (
                VoiceState::WakeDetected,
                VoiceState::CapturingUtterance,
                TransitionReason::SpeechStarted
            ) | (
                VoiceState::Arming,
                VoiceState::CapturingUtterance,
                TransitionReason::SpeechStarted
            ) | (
                VoiceState::CapturingUtterance,
                VoiceState::Transcribing,
                TransitionReason::SpeechEnded
            ) | (
                VoiceState::Transcribing,
                VoiceState::Dispatching,
                TransitionReason::Transcribed
            ) | (
                VoiceState::Dispatching,
                VoiceState::AwaitingResponse,
                TransitionReason::Dispatched
            ) | (
                VoiceState::AwaitingResponse,
                VoiceState::Speaking,
                TransitionReason::ResponseReady
            ) | (
                VoiceState::Speaking,
                VoiceState::Idle,
                TransitionReason::PlaybackEnded
            ) | (
                VoiceState::Speaking,
                VoiceState::Interrupted,
                TransitionReason::Interrupted
            ) | (
                VoiceState::Interrupted,
                VoiceState::Idle,
                TransitionReason::Stop
            ) | (_, VoiceState::Suspended, TransitionReason::Suspend)
                | (
                    VoiceState::Suspended,
                    VoiceState::Recovering,
                    TransitionReason::Recover
                )
                | (
                    VoiceState::Stopping,
                    VoiceState::Idle,
                    TransitionReason::Stop
                )
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedactedSnapshot {
    pub state: VoiceState,
    pub generation: Generation,
    pub surface: String,
    pub route_revision: RouteRevision,
    pub capability: ResourceReport,
    pub at: TimestampMicros,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    State {
        transition: VoiceTransition,
    },
    Level {
        generation: Generation,
        route_revision: RouteRevision,
        level: u8,
        at: TimestampMicros,
    },
    Transcript {
        generation: Generation,
        partial: bool,
        text: String,
        at: TimestampMicros,
    },
    Fault {
        generation: Generation,
        code: String,
        at: TimestampMicros,
    },
}

impl RuntimeEvent {
    pub fn redacted_json(&self) -> Result<String, VoiceCoreError> {
        serde_json::to_string(self).map_err(|_| VoiceCoreError::InvalidTransition)
    }
}

#[async_trait(?Send)]
pub trait SpeechTransport {
    async fn assistant_turn(
        &mut self,
        request: AssistantTurnRequest,
        cancellation: CancellationToken,
    ) -> Result<AssistantTurnResponse, VoiceCoreError>;

    async fn cancel_session(&mut self, generation: Generation) -> Result<(), VoiceCoreError>;
}

#[async_trait(?Send)]
pub trait RuntimeEventSink {
    async fn snapshot(&mut self, snapshot: RedactedSnapshot) -> Result<(), VoiceCoreError>;

    async fn event(&mut self, event: RuntimeEvent) -> Result<(), VoiceCoreError>;
}

#[async_trait(?Send)]
pub trait AudioInput {
    async fn start(&mut self, lease: VoiceCaptureLease) -> Result<(), VoiceCoreError>;

    async fn stop(&mut self, reason: TransitionReason) -> Result<(), VoiceCoreError>;

    async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError>;

    fn current_route_revision(&self) -> RouteRevision;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioPlaybackContext {
    pub generation: Generation,
    pub route_revision: RouteRevision,
    pub started_at: TimestampMicros,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioPlaybackReceipt {
    pub generation: Generation,
    pub route_revision: RouteRevision,
    pub chunk_count: u64,
    pub sample_count: u64,
    pub completed_at: TimestampMicros,
}

impl AudioPlaybackReceipt {
    pub fn new(
        context: AudioPlaybackContext,
        chunk_count: u64,
        sample_count: u64,
        completed_at: TimestampMicros,
    ) -> Self {
        Self {
            generation: context.generation,
            route_revision: context.route_revision,
            chunk_count,
            sample_count,
            completed_at,
        }
    }
}

#[async_trait(?Send)]
pub trait AudioOutput {
    async fn play(
        &mut self,
        context: AudioPlaybackContext,
        audio: TtsSynthesisResult,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<AudioPlaybackReceipt, VoiceCoreError>;

    async fn stop(
        &mut self,
        generation: Generation,
        reason: TransitionReason,
    ) -> Result<(), VoiceCoreError>;
}

pub struct VoiceRuntime<A, E, T, O, S> {
    audio: A,
    engine: E,
    transport: T,
    output: O,
    sink: S,
    leases: CaptureLeaseManager,
    state: VoiceStateMachine,
    route_revision: RouteRevision,
    assistant_namespace: AssistantTurnNamespace,
}

impl<A, E, T, O, S> VoiceRuntime<A, E, T, O, S>
where
    A: AudioInput,
    E: SpeechEngine,
    T: SpeechTransport,
    O: AudioOutput,
    S: RuntimeEventSink,
{
    pub fn new(
        audio: A,
        engine: E,
        transport: T,
        output: O,
        sink: S,
        surface: impl Into<String>,
        runtime_instance_id: impl Into<String>,
    ) -> Result<Self, VoiceCoreError> {
        let assistant_namespace = AssistantTurnNamespace::new(runtime_instance_id)?;
        Ok(Self {
            audio,
            engine,
            transport,
            output,
            sink,
            leases: CaptureLeaseManager::new(),
            state: VoiceStateMachine::new(surface),
            route_revision: RouteRevision(0),
            assistant_namespace,
        })
    }

    pub fn state(&self) -> VoiceState {
        self.state.state()
    }

    pub fn has_active_capture(&self) -> bool {
        self.leases.has_active()
    }

    pub fn into_parts(self) -> (A, E, T, O, S) {
        (
            self.audio,
            self.engine,
            self.transport,
            self.output,
            self.sink,
        )
    }

    pub async fn run_push_to_talk_turn(
        &mut self,
        mut lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        lease.start_reason = CaptureStartReason::PushToTalk;
        let lease = self.leases.request_start(lease)?;
        let mut capture_started = false;
        let result = match cancellation.check() {
            Ok(()) => match self.audio.start(lease.clone()).await {
                Ok(()) => {
                    capture_started = true;
                    self.run_push_to_talk_turn_after_start(lease.clone(), at, cancellation.clone())
                        .await
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        self.finish_with_cleanup(result, lease, cancellation, capture_started)
            .await
    }

    pub async fn run_wake_turn(
        &mut self,
        mut lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        lease.start_reason = CaptureStartReason::ForegroundWake;
        let lease = self.leases.request_start(lease)?;
        let mut capture_started = false;
        let result = match cancellation.check() {
            Ok(()) => match self.audio.start(lease.clone()).await {
                Ok(()) => {
                    capture_started = true;
                    self.run_wake_turn_after_start(lease.clone(), at, cancellation.clone())
                        .await
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        self.finish_with_cleanup(result, lease, cancellation, capture_started)
            .await
    }

    async fn run_push_to_talk_turn_after_start(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        cancellation.check()?;
        self.ensure_idle(lease.generation, lease.route_revision, at)
            .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::Arming,
            TransitionReason::PushToTalk,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(1)),
        )
        .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::CapturingUtterance,
            TransitionReason::SpeechStarted,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(2)),
        )
        .await?;
        self.finish_voice_turn(lease, TimestampMicros(at.0.saturating_add(3)), cancellation)
            .await
    }

    async fn run_wake_turn_after_start(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        cancellation.check()?;
        self.ensure_idle(lease.generation, lease.route_revision, at)
            .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::ListeningForWake,
            TransitionReason::WakeArm,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(1)),
        )
        .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::WakeDetected,
            TransitionReason::WakeDetected,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(2)),
        )
        .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::CapturingUtterance,
            TransitionReason::SpeechStarted,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(3)),
        )
        .await?;
        self.finish_voice_turn(lease, TimestampMicros(at.0.saturating_add(4)), cancellation)
            .await
    }

    async fn ensure_idle(
        &mut self,
        generation: Generation,
        route_revision: RouteRevision,
        at: TimestampMicros,
    ) -> Result<(), VoiceCoreError> {
        match self.state.state() {
            VoiceState::Disabled => {
                self.transition_emit(
                    VoiceState::Idle,
                    TransitionReason::Enable,
                    generation,
                    route_revision,
                    at,
                )
                .await
            }
            VoiceState::Idle => Ok(()),
            _ => Err(VoiceCoreError::InvalidTransition),
        }
    }

    async fn finish_voice_turn(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        let stt_task_request =
            self.bound_engine_request(VoiceTask::SpeechToText, None, lease.generation)?;
        let mut stt_audio = FiniteSttAudioBuilder::new(stt_task_request)?;
        cancellation.check()?;
        while let Some(frame) = self.audio.next_frame().await? {
            if cancellation.is_cancelled() {
                stt_audio.clear();
                return Err(VoiceCoreError::Cancelled);
            }
            if frame.generation() != lease.generation {
                continue;
            }
            if frame.route_revision() != lease.route_revision || frame.discontinuity() {
                stt_audio.clear();
                self.route_revision = RouteRevision(self.route_revision.0.saturating_add(1));
                return Err(VoiceCoreError::InvalidTransition);
            }
            stt_audio.push_frame(frame.samples())?;
        }
        if cancellation.is_cancelled() {
            stt_audio.clear();
            return Err(VoiceCoreError::Cancelled);
        }
        self.transition_emit(
            VoiceState::Transcribing,
            TransitionReason::SpeechEnded,
            lease.generation,
            lease.route_revision,
            at,
        )
        .await?;
        cancellation.check()?;
        self.engine.warm_task(stt_audio.request().clone()).await?;
        let (stt_request, stt_audio) = stt_audio.finish()?;
        let transcript = self
            .engine
            .transcribe_finite(stt_request, stt_audio, &|| cancellation.is_cancelled())
            .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::Dispatching,
            TransitionReason::Transcribed,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(1)),
        )
        .await?;
        cancellation.check()?;
        let request = AssistantTurnRequest::from_generation(
            &self.assistant_namespace,
            lease.generation,
            transcript.transcript().to_owned(),
        );
        let response = self
            .transport
            .assistant_turn(request, cancellation.clone())
            .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::AwaitingResponse,
            TransitionReason::Dispatched,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(2)),
        )
        .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::Speaking,
            TransitionReason::ResponseReady,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(3)),
        )
        .await?;
        let tts_request =
            self.bound_engine_request(VoiceTask::TextToSpeech, None, lease.generation)?;
        self.engine.warm_task(tts_request.clone()).await?;
        let tts_config = TtsSynthesisConfig::new(
            "default",
            tts_request
                .binding()
                .voice_state_compatibility_group_id()
                .to_owned(),
            tts_request.binding().sample_rate_hz(),
            1024,
            None,
        )?;
        let tts_request =
            BoundTtsSynthesisRequest::new(tts_request, response.text.clone(), tts_config)?;
        let audio = self
            .engine
            .synthesize_text(tts_request, &|| cancellation.is_cancelled())
            .await?;
        cancellation.check()?;
        let playback_context = AudioPlaybackContext {
            generation: lease.generation,
            route_revision: lease.route_revision,
            started_at: TimestampMicros(at.0.saturating_add(4)),
        };
        let receipt = self
            .output
            .play(playback_context, audio, &|| cancellation.is_cancelled())
            .await?;
        cancellation.check()?;
        if receipt.generation != lease.generation || receipt.route_revision != lease.route_revision
        {
            return Err(VoiceCoreError::StaleGeneration);
        }
        self.transition_emit(
            VoiceState::Idle,
            TransitionReason::PlaybackEnded,
            lease.generation,
            lease.route_revision,
            receipt.completed_at,
        )
        .await?;
        Ok(response.text)
    }

    fn bound_engine_request(
        &self,
        task: VoiceTask,
        language: Option<String>,
        generation: Generation,
    ) -> Result<BoundTaskRequest, VoiceCoreError> {
        let request = TaskRequest {
            task,
            language,
            generation: generation.0,
        };
        let mut saw_task = false;
        for capability in self.engine.capabilities() {
            if capability.task() != task {
                continue;
            }
            saw_task = true;
            if let Ok(bound) = BoundTaskRequest::new(request.clone(), capability.binding().clone())
            {
                return Ok(bound);
            }
        }
        if saw_task {
            Err(VoiceCoreError::Engine(EngineError::InvalidRequest))
        } else {
            Err(VoiceCoreError::Engine(EngineError::TaskUnavailable))
        }
    }

    async fn finish_with_cleanup(
        &mut self,
        result: Result<String, VoiceCoreError>,
        lease: VoiceCaptureLease,
        cancellation: CancellationToken,
        capture_started: bool,
    ) -> Result<String, VoiceCoreError> {
        let result = match result {
            Ok(_) if cancellation.is_cancelled() => Err(VoiceCoreError::Cancelled),
            other => other,
        };
        if result.is_err() || cancellation.is_cancelled() {
            let _ = self.engine.cancel_generation(lease.generation.0).await;
            let _ = self.transport.cancel_session(lease.generation).await;
        }
        let output_stop_result = if result.is_err() || cancellation.is_cancelled() {
            self.output
                .stop(lease.generation, TransitionReason::Cancel)
                .await
        } else {
            Ok(())
        };

        let stop_reason = if result.is_ok() {
            TransitionReason::Stop
        } else {
            TransitionReason::Cancel
        };
        let stop_result = if capture_started {
            self.audio.stop(stop_reason).await
        } else {
            Ok(())
        };
        let release_result = self.leases.release(&lease.owner, lease.generation);

        if result.is_err() {
            self.reset_state_after_cleanup(lease.generation, lease.route_revision);
        }

        match result {
            Ok(value) => {
                output_stop_result?;
                stop_result?;
                release_result?;
                Ok(value)
            }
            Err(error) => {
                let _ = stop_result;
                let _ = release_result;
                match output_stop_result {
                    Ok(()) => Err(error),
                    Err(stop_error) => Err(Self::playback_cleanup_failed(stop_error)),
                }
            }
        }
    }

    fn playback_cleanup_failed(error: VoiceCoreError) -> VoiceCoreError {
        let code = match error {
            VoiceCoreError::TransportFault { code } if code.starts_with("playback_cleanup_") => {
                code
            }
            VoiceCoreError::Cancelled => "playback_cleanup_cancelled".to_owned(),
            VoiceCoreError::TransportFault { .. } => "playback_cleanup_transport_fault".to_owned(),
            VoiceCoreError::Engine(_) => "playback_cleanup_engine_fault".to_owned(),
            VoiceCoreError::LockPoisoned => "playback_cleanup_lock_poisoned".to_owned(),
            _ => "playback_cleanup_failed".to_owned(),
        };
        VoiceCoreError::TransportFault { code }
    }

    fn reset_state_after_cleanup(&mut self, generation: Generation, route_revision: RouteRevision) {
        if matches!(self.state.state(), VoiceState::Disabled) {
            return;
        }
        let _ = self.state.transition(
            VoiceState::Stopping,
            TransitionReason::Cancel,
            generation,
            route_revision,
            TimestampMicros(0),
        );
        let _ = self.state.transition(
            VoiceState::Idle,
            TransitionReason::Stop,
            generation,
            route_revision,
            TimestampMicros(0),
        );
    }

    async fn transition_emit(
        &mut self,
        to: VoiceState,
        reason: TransitionReason,
        generation: Generation,
        route_revision: RouteRevision,
        at: TimestampMicros,
    ) -> Result<(), VoiceCoreError> {
        let transition = self
            .state
            .transition(to, reason, generation, route_revision, at)?;
        self.sink.event(RuntimeEvent::State { transition }).await
    }
}

pub fn default_test_lease(owner: CaptureOwnerKind, at: TimestampMicros) -> VoiceCaptureLease {
    VoiceCaptureLease {
        owner,
        surface: "test".to_owned(),
        device_route: "default".to_owned(),
        start_reason: CaptureStartReason::PushToTalk,
        generation: Generation(0),
        created_at: at,
        route_revision: RouteRevision(1),
        background_eligible: false,
        consent_revision: 1,
        heartbeat_at: at,
        stop_deadline: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn frame(sequence: u64, generation: Generation) -> Result<PcmFrame, VoiceCoreError> {
        PcmFrame::new(
            vec![0.0, 0.5, -0.5],
            TimestampMicros(sequence),
            sequence,
            false,
            RouteRevision(1),
            generation,
        )
    }

    #[test]
    fn pcm_frame_validates_metadata_and_i16_conversion() -> Result<(), VoiceCoreError> {
        let converted = PcmFrame::from_i16(
            &[i16::MIN, 0, i16::MAX],
            TimestampMicros(7),
            9,
            true,
            RouteRevision(2),
            Generation(3),
        )?;
        assert_eq!(converted.sample_count(), 3);
        assert_eq!(converted.samples()[0], -1.0);
        assert_eq!(converted.samples()[1], 0.0);
        assert_eq!(converted.samples()[2], 1.0);
        assert!(converted.discontinuity());
        assert_eq!(converted.generation(), Generation(3));
        assert!(matches!(
            PcmFrame::with_sample_count(
                99,
                vec![0.0],
                TimestampMicros(0),
                0,
                false,
                RouteRevision(0),
                Generation(0)
            ),
            Err(VoiceCoreError::SampleCountMismatch)
        ));
        assert!(matches!(
            PcmFrame::new(
                vec![1.5],
                TimestampMicros(0),
                0,
                false,
                RouteRevision(0),
                Generation(0)
            ),
            Err(VoiceCoreError::SampleOutOfRange)
        ));
        Ok(())
    }

    #[test]
    fn bounded_queue_rejects_backpressure_and_stale_generations() -> Result<(), VoiceCoreError> {
        let buffer = BoundedPcmBuffer::nonblocking_queue(1, 8, Generation(1));
        assert_eq!(buffer.push(frame(1, Generation(1))?)?, BufferPush::Accepted);
        assert!(matches!(
            buffer.push(frame(2, Generation(1))?),
            Err(VoiceCoreError::Backpressure)
        ));
        assert!(matches!(
            buffer.push(frame(3, Generation(2))?),
            Err(VoiceCoreError::StaleGeneration)
        ));
        let stats = buffer.stats()?;
        assert_eq!(stats.frames, 1);
        assert_eq!(stats.dropped_frames, 1);
        Ok(())
    }

    #[test]
    fn pre_roll_drops_oldest_and_erases_on_close() -> Result<(), VoiceCoreError> {
        let buffer = BoundedPcmBuffer::pre_roll(2, 6, Generation(1));
        assert_eq!(buffer.push(frame(1, Generation(1))?)?, BufferPush::Accepted);
        assert_eq!(buffer.push(frame(2, Generation(1))?)?, BufferPush::Accepted);
        assert_eq!(
            buffer.push(frame(3, Generation(1))?)?,
            BufferPush::DroppedOldest
        );
        let popped = buffer.pop()?.ok_or(VoiceCoreError::BufferClosed)?;
        assert_eq!(popped.sequence(), 2);
        buffer.close()?;
        let stats = buffer.stats()?;
        assert!(stats.closed);
        assert_eq!(stats.samples, 0);
        Ok(())
    }

    #[test]
    fn capture_lease_prevents_overlapping_owner_and_filters_generation(
    ) -> Result<(), VoiceCoreError> {
        let mut manager = CaptureLeaseManager::new();
        let first = manager.request_start(default_test_lease(
            CaptureOwnerKind::Native,
            TimestampMicros(1),
        ))?;
        assert_eq!(first.generation, Generation(1));
        assert!(manager.accepts_generation(Generation(1)));
        assert!(matches!(
            manager.request_start(default_test_lease(
                CaptureOwnerKind::Web,
                TimestampMicros(2)
            )),
            Err(VoiceCoreError::OwnerAlreadyActive)
        ));
        manager.release(&CaptureOwnerKind::Native, first.generation)?;
        assert!(!manager.accepts_generation(first.generation));
        let second = manager.request_start(default_test_lease(
            CaptureOwnerKind::Web,
            TimestampMicros(3),
        ))?;
        assert_eq!(second.generation, Generation(2));
        Ok(())
    }

    #[test]
    fn state_machine_guards_turn_sequence_and_stale_generation() -> Result<(), VoiceCoreError> {
        let mut machine = VoiceStateMachine::new("desktop");
        machine.transition(
            VoiceState::Idle,
            TransitionReason::Enable,
            Generation(1),
            RouteRevision(1),
            TimestampMicros(1),
        )?;
        assert!(matches!(
            machine.transition(
                VoiceState::Speaking,
                TransitionReason::PlaybackStarted,
                Generation(1),
                RouteRevision(1),
                TimestampMicros(2)
            ),
            Err(VoiceCoreError::InvalidTransition)
        ));
        assert!(matches!(
            machine.transition(
                VoiceState::Arming,
                TransitionReason::PushToTalk,
                Generation(0),
                RouteRevision(1),
                TimestampMicros(3)
            ),
            Err(VoiceCoreError::StaleGeneration)
        ));
        machine.transition(
            VoiceState::Arming,
            TransitionReason::PushToTalk,
            Generation(1),
            RouteRevision(1),
            TimestampMicros(4),
        )?;
        assert_eq!(machine.state(), VoiceState::Arming);
        Ok(())
    }

    #[test]
    fn assistant_turn_ids_include_validated_runtime_namespace() -> Result<(), VoiceCoreError> {
        let native = AssistantTurnNamespace::new("native-runtime")?;
        let web = AssistantTurnNamespace::new("web.runtime")?;
        let native_request = AssistantTurnRequest::from_generation(&native, Generation(1), "hello");
        let web_request = AssistantTurnRequest::from_generation(&web, Generation(1), "hello");

        assert_eq!(
            native_request.session_id,
            format!("voice-session-{}-1", native.as_str())
        );
        assert_eq!(
            native_request.request_id,
            format!("voice-request-{}-1", native.as_str())
        );
        assert_eq!(
            native_request.correlation_id,
            format!("voice-correlation-{}-1", native.as_str())
        );
        assert!(!native_request.session_id.contains("native-runtime"));
        assert_eq!(format!("{native:?}"), "AssistantTurnNamespace([redacted])");
        assert_ne!(native_request.session_id, web_request.session_id);
        assert_ne!(native_request.request_id, web_request.request_id);
        assert_ne!(native_request.correlation_id, web_request.correlation_id);
        assert!(AssistantTurnNamespace::new("").is_err());
        assert!(AssistantTurnNamespace::new("native/runtime").is_err());
        assert!(AssistantTurnNamespace::new("native runtime").is_err());
        Ok(())
    }

    #[test]
    fn redacted_events_do_not_serialize_audio_or_credentials() -> Result<(), VoiceCoreError> {
        let event = RuntimeEvent::Level {
            generation: Generation(7),
            route_revision: RouteRevision(8),
            level: 42,
            at: TimestampMicros(9),
        };
        let json = event.redacted_json()?;
        assert!(!json.contains("sample"));
        assert!(!json.contains("pcm"));
        assert!(!json.contains("token"));
        assert!(!json.contains("credential"));
        Ok(())
    }

    proptest! {
        #[test]
        fn transition_table_never_accepts_direct_speaking_from_idle(reason in any::<u8>()) {
            let reason = match reason % 4 {
                0 => TransitionReason::PushToTalk,
                1 => TransitionReason::WakeArm,
                2 => TransitionReason::ResponseReady,
                _ => TransitionReason::PlaybackStarted,
            };
            prop_assert!(!VoiceStateMachine::transition_allowed(
                VoiceState::Idle,
                VoiceState::Speaking,
                reason
            ));
        }

        #[test]
        fn owner_generation_is_monotonic(releases in proptest::collection::vec(any::<bool>(), 1..32)) {
            let mut manager = CaptureLeaseManager::new();
            let mut last_generation = 0;
            for release_first in releases {
                let lease = manager.request_start(default_test_lease(CaptureOwnerKind::Native, TimestampMicros(last_generation + 1)));
                prop_assert!(lease.is_ok());
                let lease = match lease {
                    Ok(lease) => lease,
                    Err(err) => return Err(TestCaseError::fail(format!("{err:?}"))),
                };
                prop_assert!(lease.generation.0 > last_generation);
                last_generation = lease.generation.0;
                if release_first {
                    prop_assert!(manager.release(&CaptureOwnerKind::Native, lease.generation).is_ok());
                } else {
                    prop_assert!(manager.request_start(default_test_lease(CaptureOwnerKind::Web, TimestampMicros(last_generation + 1))).is_err());
                    prop_assert!(manager.release(&CaptureOwnerKind::Native, lease.generation).is_ok());
                }
            }
        }
    }
}
