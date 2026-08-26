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

const MAX_TTS_RECOVERY_SEGMENTS: usize = 32;

pub use aurora_voice_engine::{
    BoundFiniteSttRequest, BoundKwsRequest, BoundStreamSession, BoundTaskRequest,
    BoundTtsSynthesisRequest, BoundVadRequest, EngineError, FiniteSttAudio, FiniteSttAudioBuilder,
    FiniteSttPort, FiniteSttProviderBinding, FiniteSttResult, FiniteSttRouteScope, KwsConfig,
    KwsStreamProvider, ResourceReport, RouteFiniteSttBinding, RouteFiniteSttRequest,
    RouteTtsBinding, RouteTtsSynthesisRequest, StreamResetReason, StreamingAudioFrame,
    TaskCapability, TaskPackBinding, TaskProvider, TaskReadiness, TaskRequest, TtsSynthesisConfig,
    TtsSynthesisPort, TtsSynthesisProviderBinding, TtsSynthesisResult, VadConfig,
    VadStreamProvider, VoiceTask, MONO_CHANNELS, TTS_MAX_TEXT_BYTES, VAD_SAMPLE_RATE_HZ,
    VAD_WINDOW_SIZE_SAMPLES,
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
    #[error("capture generation exhausted")]
    GenerationExhausted,
    #[error("invalid state transition")]
    InvalidTransition,
    #[error("cancelled")]
    Cancelled,
    #[error("wake provider unavailable")]
    WakeUnavailable,
    #[error("wake word not detected")]
    WakeNotDetected,
    #[error("speech was not detected after wake")]
    SpeechNotDetected,
    #[error("speech capture timed out")]
    SpeechTimeout,
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

fn project_spoken_text(text: &str) -> Result<String, EngineError> {
    let mut spoken = String::with_capacity(text.len().min(TTS_MAX_TEXT_BYTES));
    let mut pending_space = false;

    for character in text.trim().chars() {
        if character.is_control() || character.is_whitespace() {
            pending_space = !spoken.is_empty();
            continue;
        }

        if pending_space {
            if spoken.len() == TTS_MAX_TEXT_BYTES {
                break;
            }
            spoken.push(' ');
            pending_space = false;
        }

        if spoken.len().saturating_add(character.len_utf8()) > TTS_MAX_TEXT_BYTES {
            break;
        }
        spoken.push(character);
    }

    if spoken.is_empty() {
        return Err(EngineError::InvalidRequest);
    }
    Ok(spoken)
}

fn split_spoken_segment(text: &str) -> Option<(String, String)> {
    if text.chars().count() < 2 {
        return None;
    }

    let midpoint = text.len() / 2;
    let lower_bound = text.len() / 4;
    let upper_bound = text.len().saturating_mul(3) / 4;
    let mut sentence_boundary = None;
    let mut whitespace_boundary = None;

    for (index, character) in text.char_indices() {
        let boundary = if matches!(character, '.' | '!' | '?' | ';' | ':') {
            index.saturating_add(character.len_utf8())
        } else if character.is_whitespace() {
            index
        } else {
            continue;
        };
        if boundary <= lower_bound || boundary >= upper_bound {
            continue;
        }
        let distance = boundary.abs_diff(midpoint);
        let candidate = (distance, boundary);
        if matches!(character, '.' | '!' | '?' | ';' | ':') {
            if sentence_boundary.is_none_or(|current| candidate < current) {
                sentence_boundary = Some(candidate);
            }
        } else if whitespace_boundary.is_none_or(|current| candidate < current) {
            whitespace_boundary = Some(candidate);
        }
    }

    let split_at = sentence_boundary
        .or(whitespace_boundary)
        .map(|(_, boundary)| boundary)
        .or_else(|| {
            text.char_indices()
                .map(|(index, _)| index)
                .filter(|index| *index > 0)
                .min_by_key(|index| index.abs_diff(midpoint))
        })?;
    let left = text[..split_at].trim().to_owned();
    let right = text[split_at..].trim().to_owned();
    (!left.is_empty() && !right.is_empty()).then_some((left, right))
}

fn bound_tts_synthesis_request(
    binding: &TtsSynthesisProviderBinding,
    text: String,
    config: &TtsSynthesisConfig,
    generation: Generation,
) -> Result<BoundTtsSynthesisRequest, EngineError> {
    match binding {
        TtsSynthesisProviderBinding::LocalTask(binding) => {
            let task_request = BoundTaskRequest::new(
                TaskRequest {
                    task: VoiceTask::TextToSpeech,
                    language: None,
                    generation: generation.0,
                },
                binding.as_ref().clone(),
            )?;
            BoundTtsSynthesisRequest::new(task_request, text, config.clone())
        }
        TtsSynthesisProviderBinding::Route(route) => BoundTtsSynthesisRequest::new_route(
            RouteTtsSynthesisRequest::new(route.clone(), None, generation.0)?,
            text,
            config.clone(),
        ),
    }
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

    /// Returns the generation that the next accepted capture start will receive.
    ///
    /// This is a preview contract for single-owner actors that need to prepare
    /// capture-scoped work before calling [`Self::request_start`]. It does not
    /// reserve or mutate the counter; callers must treat any intervening
    /// accepted start as invalidating the preview.
    pub fn next_generation(&self) -> Result<Generation, VoiceCoreError> {
        if self.active.is_some() {
            return Err(VoiceCoreError::OwnerAlreadyActive);
        }
        self.generation
            .checked_add(1)
            .map(Generation)
            .ok_or(VoiceCoreError::GenerationExhausted)
    }

    pub fn request_start(
        &mut self,
        mut lease: VoiceCaptureLease,
    ) -> Result<VoiceCaptureLease, VoiceCoreError> {
        let generation = self.next_generation()?;
        self.generation = generation.0;
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
                VoiceState::Transcribing,
                VoiceState::Idle,
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

#[derive(Debug, Clone, PartialEq)]
pub struct WakeOrchestrationConfig {
    vad_binding: TaskPackBinding,
    kws_binding: TaskPackBinding,
    vad_config: VadConfig,
    kws_config: KwsConfig,
    max_wake_frames: u64,
    max_utterance_frames: u64,
}

impl WakeOrchestrationConfig {
    pub fn new(
        vad_binding: TaskPackBinding,
        kws_binding: TaskPackBinding,
        vad_config: VadConfig,
        kws_config: KwsConfig,
        max_wake_frames: u64,
        max_utterance_frames: u64,
    ) -> Result<Self, VoiceCoreError> {
        let config = Self {
            vad_binding,
            kws_binding,
            vad_config,
            kws_config,
            max_wake_frames,
            max_utterance_frames,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), VoiceCoreError> {
        self.vad_config.validate_binding(&self.vad_binding)?;
        self.kws_config.validate_binding(&self.kws_binding)?;
        if self.max_wake_frames == 0 || self.max_utterance_frames == 0 {
            return Err(VoiceCoreError::Engine(EngineError::InvalidRequest));
        }
        Ok(())
    }

    pub fn vad_binding(&self) -> &TaskPackBinding {
        &self.vad_binding
    }

    pub fn kws_binding(&self) -> &TaskPackBinding {
        &self.kws_binding
    }

    pub fn vad_config(&self) -> &VadConfig {
        &self.vad_config
    }

    pub fn kws_config(&self) -> &KwsConfig {
        &self.kws_config
    }
}

/// Type-erased VAD provider accepted by the shared wake runtime.
///
/// Native wake providers are constructed and driven on one local runtime
/// thread. The wake runtime must not require their thread-affine inference
/// handles to implement `Send`.
pub type WakeVadProvider = Box<dyn VadStreamProvider>;

/// Type-erased KWS provider accepted by the shared wake runtime.
pub type WakeKwsProvider = Box<dyn KwsStreamProvider>;

struct WakeRuntime {
    vad: WakeVadProvider,
    kws: WakeKwsProvider,
    config: WakeOrchestrationConfig,
}

struct WakeSessions {
    vad: BoundStreamSession,
    kws: BoundStreamSession,
}

#[derive(Debug)]
struct BufferedVadFrame {
    sequence: u64,
    samples: Vec<f32>,
    end_tail: bool,
}

#[derive(Debug, Default)]
struct VadFrameBuffer {
    samples: VecDeque<f32>,
    next_sequence: Option<u64>,
    last_source_sequence: Option<u64>,
}

impl VadFrameBuffer {
    fn push(&mut self, source_sequence: u64, samples: &[f32]) -> Vec<BufferedVadFrame> {
        if self.samples.is_empty() {
            self.next_sequence = Some(
                self.next_sequence
                    .map_or(source_sequence, |next| next.max(source_sequence)),
            );
        }
        self.last_source_sequence = Some(source_sequence);
        self.samples.extend(samples.iter().copied());

        let mut frames = Vec::new();
        while self.samples.len() >= VAD_WINDOW_SIZE_SAMPLES {
            let sequence = self.next_sequence.unwrap_or(source_sequence);
            frames.push(BufferedVadFrame {
                sequence,
                samples: self.samples.drain(..VAD_WINDOW_SIZE_SAMPLES).collect(),
                end_tail: false,
            });
            self.next_sequence = Some(sequence.saturating_add(1));
        }
        frames
    }

    fn take_tail(&mut self) -> Option<BufferedVadFrame> {
        if self.samples.is_empty() {
            return None;
        }
        let sequence = self
            .next_sequence
            .unwrap_or_default()
            .max(self.last_source_sequence.unwrap_or_default());
        self.next_sequence = Some(sequence.saturating_add(1));
        Some(BufferedVadFrame {
            sequence,
            samples: self.samples.drain(..).collect(),
            end_tail: true,
        })
    }

    fn clear(&mut self) {
        self.samples.clear();
        self.next_sequence = None;
        self.last_source_sequence = None;
    }
}

impl WakeRuntime {
    fn new(
        vad: WakeVadProvider,
        kws: WakeKwsProvider,
        config: WakeOrchestrationConfig,
    ) -> Result<Self, VoiceCoreError> {
        config.validate()?;
        Ok(Self { vad, kws, config })
    }

    fn ready(&self) -> bool {
        provider_ready_for(&*self.vad, self.config.vad_binding())
            && provider_ready_for(&*self.kws, self.config.kws_binding())
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        let vad_result = self.vad.cancel_generation(generation).await;
        let kws_result = self.kws.cancel_generation(generation).await;
        match (vad_result, kws_result) {
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    async fn push_vad_frame(
        &mut self,
        vad_session: &BoundStreamSession,
        kws_session: &BoundStreamSession,
        frame: &BufferedVadFrame,
        cancellation: &CancellationToken,
    ) -> Result<aurora_voice_engine::VadAcceptResult, EngineError> {
        let stream_frame = if frame.end_tail {
            StreamingAudioFrame::end_tail(
                frame.sequence,
                VAD_SAMPLE_RATE_HZ,
                MONO_CHANNELS,
                &frame.samples,
                false,
            )?
        } else {
            StreamingAudioFrame::new(
                frame.sequence,
                VAD_SAMPLE_RATE_HZ,
                MONO_CHANNELS,
                &frame.samples,
                false,
            )?
        };
        let result = self
            .vad
            .push_vad_frame(vad_session, stream_frame, &|| cancellation.is_cancelled())
            .await?;
        if result.reset().is_some() {
            self.kws
                .reset_kws_session(kws_session, StreamResetReason::NewGeneration)
                .await?;
        }
        Ok(result)
    }
}

fn provider_ready_for(provider: &dyn TaskProvider, binding: &TaskPackBinding) -> bool {
    provider.resource_report().readiness == TaskReadiness::Ready
        && provider.capabilities().iter().any(|capability| {
            capability.streaming_enabled()
                && capability.task() == binding.task()
                && capability.binding() == binding
        })
}

async fn apply_vad_result<S: RuntimeEventSink>(
    state: &mut VoiceStateMachine,
    sink: &mut S,
    result: &aurora_voice_engine::VadAcceptResult,
    lease: &VoiceCaptureLease,
    at: TimestampMicros,
    speech_started: &mut bool,
    segmented_samples: &mut Vec<Vec<f32>>,
) -> Result<bool, VoiceCoreError> {
    if result.detected() && !*speech_started {
        *speech_started = true;
        let transition = state.transition(
            VoiceState::CapturingUtterance,
            TransitionReason::SpeechStarted,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(1)),
        )?;
        sink.event(RuntimeEvent::State { transition }).await?;
    }
    segmented_samples.extend(
        result
            .segments()
            .iter()
            .filter(|segment| !segment.samples().is_empty())
            .map(|segment| segment.samples().to_vec()),
    );
    Ok(*speech_started && !segmented_samples.is_empty())
}

pub struct VoiceRuntime<A, E, P, T, O, S> {
    audio: A,
    stt: E,
    tts: P,
    transport: T,
    output: O,
    sink: S,
    wake: Option<WakeRuntime>,
    leases: CaptureLeaseManager,
    state: VoiceStateMachine,
    route_revision: RouteRevision,
    assistant_namespace: AssistantTurnNamespace,
}

impl<A, E, P, T, O, S> VoiceRuntime<A, E, P, T, O, S>
where
    A: AudioInput,
    E: FiniteSttPort,
    P: TtsSynthesisPort,
    T: SpeechTransport,
    O: AudioOutput,
    S: RuntimeEventSink,
{
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        audio: A,
        stt: E,
        tts: P,
        transport: T,
        output: O,
        sink: S,
        surface: impl Into<String>,
        runtime_instance_id: impl Into<String>,
    ) -> Result<Self, VoiceCoreError> {
        let assistant_namespace = AssistantTurnNamespace::new(runtime_instance_id)?;
        Ok(Self {
            audio,
            stt,
            tts,
            transport,
            output,
            sink,
            wake: None,
            leases: CaptureLeaseManager::new(),
            state: VoiceStateMachine::new(surface),
            route_revision: RouteRevision(0),
            assistant_namespace,
        })
    }

    pub fn with_wake_providers(
        mut self,
        vad: WakeVadProvider,
        kws: WakeKwsProvider,
        config: WakeOrchestrationConfig,
    ) -> Result<Self, VoiceCoreError> {
        self.wake = Some(WakeRuntime::new(vad, kws, config)?);
        Ok(self)
    }

    pub fn state(&self) -> VoiceState {
        self.state.state()
    }

    pub fn wake_background_ready(&self) -> bool {
        self.wake.as_ref().is_some_and(WakeRuntime::ready)
    }

    pub fn has_active_capture(&self) -> bool {
        self.leases.has_active()
    }

    /// Returns the generation that the next accepted runtime capture will use.
    ///
    /// The value is exact for callers that serialize access to this runtime:
    /// the next successful push-to-talk or wake capture start assigns this same
    /// generation. The method fails while a capture is active and at counter
    /// exhaustion instead of exposing or reusing the private counter.
    pub fn next_capture_generation(&self) -> Result<Generation, VoiceCoreError> {
        self.leases.next_generation()
    }

    pub fn into_parts(self) -> (A, E, P, T, O, S) {
        (
            self.audio,
            self.stt,
            self.tts,
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

    /// Captures and transcribes one focused push-to-talk utterance without
    /// dispatching it to an assistant transport or synthesizing playback.
    ///
    /// Platform shells use this boundary when the foreground UI owns assistant
    /// orchestration. Local microphone capture and STT therefore remain native,
    /// while the final transcript reaches the same assistant path as typed text
    /// without requiring HTTP or WebRTC.
    pub async fn run_push_to_talk_transcription(
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
                    self.run_push_to_talk_transcription_after_start(
                        lease.clone(),
                        at,
                        cancellation.clone(),
                    )
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
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        self.run_wake_turn_with_reason(lease, at, cancellation, CaptureStartReason::ForegroundWake)
            .await
    }

    /// Runs a native background session through the same wake/turn path while
    /// preserving the background start reason on the accepted capture lease.
    pub async fn run_background_turn(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        self.run_wake_turn_with_reason(
            lease,
            at,
            cancellation,
            CaptureStartReason::BackgroundSession,
        )
        .await
    }

    async fn run_wake_turn_with_reason(
        &mut self,
        mut lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
        start_reason: CaptureStartReason,
    ) -> Result<String, VoiceCoreError> {
        lease.start_reason = start_reason;
        if matches!(lease.start_reason, CaptureStartReason::BackgroundSession)
            && !lease.background_eligible
        {
            return Err(VoiceCoreError::WakeUnavailable);
        }
        if !self.wake_background_ready() {
            return Err(VoiceCoreError::WakeUnavailable);
        }
        let lease = self.leases.request_start(lease)?;
        let mut capture_started = false;
        let prepared = match cancellation.check() {
            Ok(()) => self.prepare_wake_sessions(&lease).await,
            Err(error) => Err(error),
        };
        let result = match prepared {
            Ok(sessions) => match cancellation.check() {
                Ok(()) => match self.audio.start(lease.clone()).await {
                    Ok(()) => {
                        capture_started = true;
                        self.run_wake_turn_after_start(
                            lease.clone(),
                            at,
                            cancellation.clone(),
                            sessions,
                        )
                        .await
                    }
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        self.finish_with_cleanup(result, lease, cancellation, capture_started)
            .await
    }

    async fn prepare_wake_sessions(
        &mut self,
        lease: &VoiceCaptureLease,
    ) -> Result<WakeSessions, VoiceCoreError> {
        let wake = self.wake.as_mut().ok_or(VoiceCoreError::WakeUnavailable)?;
        if !wake.ready() {
            return Err(VoiceCoreError::WakeUnavailable);
        }
        wake.config.validate()?;
        let vad_request = BoundTaskRequest::new(
            TaskRequest {
                task: VoiceTask::VoiceActivityDetection,
                language: None,
                generation: lease.generation.0,
            },
            wake.config.vad_binding.clone(),
        )?;
        let kws_request = BoundTaskRequest::new(
            TaskRequest {
                task: VoiceTask::KeywordSpotting,
                language: None,
                generation: lease.generation.0,
            },
            wake.config.kws_binding.clone(),
        )?;
        wake.vad.warm_task(vad_request.clone()).await?;
        wake.kws.warm_task(kws_request.clone()).await?;
        let vad = wake
            .vad
            .start_vad_session(BoundVadRequest::new(
                vad_request,
                wake.config.vad_config.clone(),
            )?)
            .await?;
        let kws = wake
            .kws
            .start_kws_session(BoundKwsRequest::new(
                kws_request,
                wake.config.kws_config.clone(),
            )?)
            .await?;
        Ok(WakeSessions { vad, kws })
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

    async fn run_push_to_talk_transcription_after_start(
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
        self.finish_voice_transcription(
            lease,
            TimestampMicros(at.0.saturating_add(3)),
            cancellation,
        )
        .await
    }

    async fn run_wake_turn_after_start(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
        sessions: WakeSessions,
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
        let utterance_frames = self
            .capture_wake_utterance(
                &lease,
                TimestampMicros(at.0.saturating_add(2)),
                &cancellation,
                sessions,
            )
            .await?;
        cancellation.check()?;
        self.finish_voice_turn_with_sample_frames(
            lease,
            TimestampMicros(at.0.saturating_add(4)),
            cancellation,
            utterance_frames,
        )
        .await
    }

    async fn capture_wake_utterance(
        &mut self,
        lease: &VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: &CancellationToken,
        sessions: WakeSessions,
    ) -> Result<Vec<Vec<f32>>, VoiceCoreError> {
        let wake = self.wake.as_mut().ok_or(VoiceCoreError::WakeUnavailable)?;
        let vad_session = sessions.vad;
        let kws_session = sessions.kws;

        let mut wake_frames = 0_u64;
        let mut utterance_frames = 0_u64;
        let mut wake_detected = false;
        let mut speech_started = false;
        let mut segmented_samples = Vec::<Vec<f32>>::new();
        let mut vad_frames = VadFrameBuffer::default();
        let mut utterance_timed_out = false;

        'capture: loop {
            cancellation.check()?;
            let Some(frame) = self.audio.next_frame().await? else {
                break;
            };
            if frame.generation() != lease.generation {
                continue;
            }
            if frame.route_revision() != lease.route_revision {
                Self::finish_wake_sessions(
                    wake,
                    &vad_session,
                    &kws_session,
                    lease.generation,
                    StreamResetReason::RouteChanged,
                )
                .await?;
                self.route_revision = RouteRevision(self.route_revision.0.saturating_add(1));
                return Err(VoiceCoreError::InvalidTransition);
            }
            if frame.discontinuity() {
                if wake_detected {
                    Self::finish_wake_sessions(
                        wake,
                        &vad_session,
                        &kws_session,
                        lease.generation,
                        StreamResetReason::Discontinuity,
                    )
                    .await?;
                    return Err(VoiceCoreError::SpeechNotDetected);
                }
                Self::reset_wake_sessions(
                    wake,
                    &vad_session,
                    &kws_session,
                    StreamResetReason::Discontinuity,
                )
                .await?;
                wake_frames = 0;
                utterance_frames = 0;
                speech_started = false;
                segmented_samples.clear();
                vad_frames.clear();
                continue;
            }

            let stream_frame = StreamingAudioFrame::new(
                frame.sequence(),
                VAD_SAMPLE_RATE_HZ,
                MONO_CHANNELS,
                frame.samples(),
                false,
            )?;
            if !wake_detected {
                wake_frames = wake_frames.saturating_add(1);
                if wake_frames > wake.config.max_wake_frames {
                    Self::finish_wake_sessions(
                        wake,
                        &vad_session,
                        &kws_session,
                        lease.generation,
                        StreamResetReason::Manual,
                    )
                    .await?;
                    return Err(VoiceCoreError::WakeNotDetected);
                }
                let kws_result = wake
                    .kws
                    .push_kws_frame(&kws_session, stream_frame, &|| cancellation.is_cancelled())
                    .await?;
                if kws_result.reset().is_some() {
                    wake.vad
                        .reset_vad_session(&vad_session, StreamResetReason::NewGeneration)
                        .await?;
                }
                if kws_result.matches().is_empty() {
                    continue;
                }
                wake_detected = true;
                let transition = self.state.transition(
                    VoiceState::WakeDetected,
                    TransitionReason::WakeDetected,
                    lease.generation,
                    lease.route_revision,
                    at,
                )?;
                self.sink.event(RuntimeEvent::State { transition }).await?;
                // The matching KWS frame still contains the wake phrase. Keep it
                // out of VAD so STT receives only the user's post-wake utterance.
                continue;
            }

            utterance_frames = utterance_frames.saturating_add(1);
            if utterance_frames > wake.config.max_utterance_frames {
                utterance_timed_out = true;
                break;
            }
            for vad_frame in vad_frames.push(frame.sequence(), frame.samples()) {
                let vad_result = wake
                    .push_vad_frame(&vad_session, &kws_session, &vad_frame, cancellation)
                    .await?;
                if apply_vad_result(
                    &mut self.state,
                    &mut self.sink,
                    &vad_result,
                    lease,
                    at,
                    &mut speech_started,
                    &mut segmented_samples,
                )
                .await?
                {
                    break 'capture;
                }
            }
        }

        if wake_detected && segmented_samples.is_empty() {
            if let Some(tail) = vad_frames.take_tail() {
                let vad_result = wake
                    .push_vad_frame(&vad_session, &kws_session, &tail, cancellation)
                    .await?;
                apply_vad_result(
                    &mut self.state,
                    &mut self.sink,
                    &vad_result,
                    lease,
                    at,
                    &mut speech_started,
                    &mut segmented_samples,
                )
                .await?;
            }
        }
        if wake_detected && speech_started && segmented_samples.is_empty() {
            let flushed = wake
                .vad
                .flush_vad_session(&vad_session, &|| cancellation.is_cancelled())
                .await?;
            Self::push_segments(&mut segmented_samples, &flushed);
        }
        Self::finish_wake_sessions(
            wake,
            &vad_session,
            &kws_session,
            lease.generation,
            StreamResetReason::Manual,
        )
        .await?;
        if !wake_detected {
            return Err(VoiceCoreError::WakeNotDetected);
        }
        if !speech_started || segmented_samples.is_empty() {
            return Err(if utterance_timed_out {
                VoiceCoreError::SpeechTimeout
            } else {
                VoiceCoreError::SpeechNotDetected
            });
        }
        Ok(segmented_samples)
    }

    fn push_segments(target: &mut Vec<Vec<f32>>, segments: &[aurora_voice_engine::SpeechSegment]) {
        target.extend(
            segments
                .iter()
                .filter(|segment| !segment.samples().is_empty())
                .map(|segment| segment.samples().to_vec()),
        );
    }

    async fn finish_wake_sessions(
        wake: &mut WakeRuntime,
        vad_session: &BoundStreamSession,
        kws_session: &BoundStreamSession,
        generation: Generation,
        reason: StreamResetReason,
    ) -> Result<(), VoiceCoreError> {
        let reset_result = Self::reset_wake_sessions(wake, vad_session, kws_session, reason).await;
        let cancel_result = wake.cancel_generation(generation.0).await;
        match (reset_result, cancel_result) {
            (Err(error), _) | (Ok(()), Err(error)) => Err(Self::wake_cleanup_failed(error)),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    async fn reset_wake_sessions(
        wake: &mut WakeRuntime,
        vad_session: &BoundStreamSession,
        kws_session: &BoundStreamSession,
        reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        let vad_result = wake.vad.reset_vad_session(vad_session, reason).await;
        let kws_result = wake.kws.reset_kws_session(kws_session, reason).await;
        match (vad_result, kws_result) {
            (Err(error), _) | (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
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
        let stt_binding = self.stt.finite_stt_binding()?;
        if stt_binding.sample_rate_hz() != aurora_voice_engine::VAD_SAMPLE_RATE_HZ
            || stt_binding.channels() != aurora_voice_engine::MONO_CHANNELS
        {
            return Err(VoiceCoreError::Engine(EngineError::InvalidRequest));
        }
        let mut stt_audio = match stt_binding.clone() {
            FiniteSttProviderBinding::LocalTask(binding) => {
                let task_request = BoundTaskRequest::new(
                    TaskRequest {
                        task: VoiceTask::SpeechToText,
                        language: None,
                        generation: lease.generation.0,
                    },
                    *binding,
                )?;
                FiniteSttAudioBuilder::new(task_request)?
            }
            FiniteSttProviderBinding::Route(route) => FiniteSttAudioBuilder::new_route(
                RouteFiniteSttRequest::new(route, None, lease.generation.0)?,
            )?,
        };
        let mut sample_frames = Vec::<Vec<f32>>::new();
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
            sample_frames.push(frame.samples().to_vec());
        }
        self.finish_voice_turn_with_builder(
            lease,
            at,
            cancellation,
            stt_binding,
            stt_audio,
            sample_frames,
        )
        .await
    }

    async fn finish_voice_transcription(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
    ) -> Result<String, VoiceCoreError> {
        let stt_binding = self.stt.finite_stt_binding()?;
        if stt_binding.sample_rate_hz() != aurora_voice_engine::VAD_SAMPLE_RATE_HZ
            || stt_binding.channels() != aurora_voice_engine::MONO_CHANNELS
        {
            return Err(VoiceCoreError::Engine(EngineError::InvalidRequest));
        }
        let mut stt_audio = match stt_binding.clone() {
            FiniteSttProviderBinding::LocalTask(binding) => {
                let task_request = BoundTaskRequest::new(
                    TaskRequest {
                        task: VoiceTask::SpeechToText,
                        language: None,
                        generation: lease.generation.0,
                    },
                    *binding,
                )?;
                FiniteSttAudioBuilder::new(task_request)?
            }
            FiniteSttProviderBinding::Route(route) => FiniteSttAudioBuilder::new_route(
                RouteFiniteSttRequest::new(route, None, lease.generation.0)?,
            )?,
        };
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
        self.transition_emit(
            VoiceState::Transcribing,
            TransitionReason::SpeechEnded,
            lease.generation,
            lease.route_revision,
            at,
        )
        .await?;
        cancellation.check()?;
        self.stt.warm_finite_stt(stt_binding).await?;
        let (stt_request, stt_audio) = stt_audio.finish()?;
        let transcript = self
            .stt
            .transcribe_finite(stt_request, stt_audio, &|| cancellation.is_cancelled())
            .await?;
        cancellation.check()?;
        self.sink
            .event(RuntimeEvent::Transcript {
                generation: lease.generation,
                partial: false,
                text: transcript.transcript().to_owned(),
                at,
            })
            .await?;
        cancellation.check()?;
        self.transition_emit(
            VoiceState::Idle,
            TransitionReason::Transcribed,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(1)),
        )
        .await?;
        Ok(transcript.transcript().to_owned())
    }

    async fn finish_voice_turn_with_sample_frames(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
        sample_frames: Vec<Vec<f32>>,
    ) -> Result<String, VoiceCoreError> {
        let stt_binding = self.stt.finite_stt_binding()?;
        if stt_binding.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
            || stt_binding.channels() != MONO_CHANNELS
        {
            return Err(VoiceCoreError::Engine(EngineError::InvalidRequest));
        }
        let stt_audio = match stt_binding.clone() {
            FiniteSttProviderBinding::LocalTask(binding) => {
                let task_request = BoundTaskRequest::new(
                    TaskRequest {
                        task: VoiceTask::SpeechToText,
                        language: None,
                        generation: lease.generation.0,
                    },
                    *binding,
                )?;
                FiniteSttAudioBuilder::new(task_request)?
            }
            FiniteSttProviderBinding::Route(route) => FiniteSttAudioBuilder::new_route(
                RouteFiniteSttRequest::new(route, None, lease.generation.0)?,
            )?,
        };
        self.finish_voice_turn_with_builder(
            lease,
            at,
            cancellation,
            stt_binding,
            stt_audio,
            sample_frames,
        )
        .await
    }

    async fn finish_voice_turn_with_builder(
        &mut self,
        lease: VoiceCaptureLease,
        at: TimestampMicros,
        cancellation: CancellationToken,
        stt_binding: FiniteSttProviderBinding,
        mut stt_audio: FiniteSttAudioBuilder,
        sample_frames: Vec<Vec<f32>>,
    ) -> Result<String, VoiceCoreError> {
        for samples in sample_frames {
            cancellation.check()?;
            stt_audio.push_frame(&samples)?;
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
        self.stt.warm_finite_stt(stt_binding).await?;
        let (stt_request, stt_audio) = stt_audio.finish()?;
        let transcript = self
            .stt
            .transcribe_finite(stt_request, stt_audio, &|| cancellation.is_cancelled())
            .await?;
        cancellation.check()?;
        self.sink
            .event(RuntimeEvent::Transcript {
                generation: lease.generation,
                partial: false,
                text: transcript.transcript().to_owned(),
                at,
            })
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
        // Assistant results are retained at transport fidelity. Local synthesis has a finite,
        // stricter input contract, so only the spoken rendition is normalized and bounded.
        let spoken_text = project_spoken_text(&response.text)?;
        let tts_binding = self.tts.synthesis_binding()?;
        let tts_config = TtsSynthesisConfig::new(
            "default",
            tts_binding.voice_state_compatibility_group_id().to_owned(),
            tts_binding.sample_rate_hz(),
            1024,
            None,
        )?;
        self.tts.warm_synthesis(tts_binding.clone()).await?;
        let mut pending_segments = VecDeque::from([spoken_text]);
        let mut synthesized_segments = Vec::new();
        while let Some(segment) = pending_segments.pop_front() {
            cancellation.check()?;
            let request = bound_tts_synthesis_request(
                &tts_binding,
                segment.clone(),
                &tts_config,
                lease.generation,
            )?;
            match self
                .tts
                .synthesize_text(request, &|| cancellation.is_cancelled())
                .await
            {
                Ok(audio) => synthesized_segments.push(audio),
                Err(EngineError::ResourceLimit) => {
                    cancellation.check()?;
                    let Some((left, right)) = split_spoken_segment(&segment) else {
                        return Err(VoiceCoreError::Engine(EngineError::ResourceLimit));
                    };
                    if synthesized_segments
                        .len()
                        .saturating_add(pending_segments.len())
                        .saturating_add(2)
                        > MAX_TTS_RECOVERY_SEGMENTS
                    {
                        return Err(VoiceCoreError::Engine(EngineError::ResourceLimit));
                    }
                    pending_segments.push_front(right);
                    pending_segments.push_front(left);
                }
                Err(error) => return Err(VoiceCoreError::Engine(error)),
            }
        }

        // Do not advertise playback while the local speech engine is still loading or
        // synthesizing. Keeping the runtime in AwaitingResponse until audio is ready lets
        // platform status surfaces distinguish preparation from actual speech playback.
        self.transition_emit(
            VoiceState::Speaking,
            TransitionReason::ResponseReady,
            lease.generation,
            lease.route_revision,
            TimestampMicros(at.0.saturating_add(3)),
        )
        .await?;

        let mut completed_at = TimestampMicros(at.0.saturating_add(4));
        for audio in synthesized_segments {
            cancellation.check()?;
            let playback_context = AudioPlaybackContext {
                generation: lease.generation,
                route_revision: lease.route_revision,
                started_at: completed_at,
            };
            let receipt = self
                .output
                .play(playback_context, audio, &|| cancellation.is_cancelled())
                .await?;
            cancellation.check()?;
            if receipt.generation != lease.generation
                || receipt.route_revision != lease.route_revision
            {
                return Err(VoiceCoreError::StaleGeneration);
            }
            completed_at = receipt.completed_at;
        }
        self.transition_emit(
            VoiceState::Idle,
            TransitionReason::PlaybackEnded,
            lease.generation,
            lease.route_revision,
            completed_at,
        )
        .await?;
        Ok(response.text)
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
        let (wake_cancel_result, stt_cancel_result, tts_cancel_result) =
            if result.is_err() || cancellation.is_cancelled() {
                let wake_result = match self.wake.as_mut() {
                    Some(wake) => wake.cancel_generation(lease.generation.0).await,
                    None => Ok(()),
                };
                let stt_result = self
                    .stt
                    .cancel_finite_stt_generation(lease.generation.0)
                    .await;
                let tts_result = self
                    .tts
                    .cancel_synthesis_generation(lease.generation.0)
                    .await;
                let _ = self.transport.cancel_session(lease.generation).await;
                (wake_result, stt_result, tts_result)
            } else {
                (Ok(()), Ok(()), Ok(()))
            };
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

        let state_reset_result = if result.is_err() {
            self.emit_state_after_cleanup(lease.generation, lease.route_revision)
                .await
        } else {
            Ok(())
        };

        match result {
            Ok(value) => {
                output_stop_result?;
                stop_result?;
                release_result?;
                wake_cancel_result?;
                stt_cancel_result?;
                tts_cancel_result?;
                Ok(value)
            }
            Err(error) => {
                let _ = stop_result;
                let _ = release_result;
                let state_reset_result = if matches!(error, VoiceCoreError::InvalidTransition) {
                    let _ = state_reset_result;
                    Ok(())
                } else {
                    state_reset_result
                };
                match (
                    output_stop_result,
                    wake_cancel_result,
                    stt_cancel_result,
                    tts_cancel_result,
                    state_reset_result,
                ) {
                    (Err(stop_error), _, _, _, _) => Err(Self::playback_cleanup_failed(stop_error)),
                    (_, Err(wake_error), _, _, _) => Err(Self::wake_cleanup_failed(wake_error)),
                    (_, _, Err(stt_error), _, _) => Err(Self::stt_cleanup_failed(stt_error)),
                    (_, _, _, Err(tts_error), _) => Err(Self::tts_cleanup_failed(tts_error)),
                    (_, _, _, _, Err(state_error)) => Err(Self::state_cleanup_failed(state_error)),
                    (Ok(()), Ok(()), Ok(()), Ok(()), Ok(())) => Err(error),
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

    fn tts_cleanup_failed(error: EngineError) -> VoiceCoreError {
        let code = match error {
            EngineError::Cancelled => "tts_cleanup_cancelled".to_owned(),
            EngineError::ProviderFault { .. } => "tts_cleanup_provider_fault".to_owned(),
            EngineError::TaskUnavailable => "tts_cleanup_task_unavailable".to_owned(),
            EngineError::ResourceLimit => "tts_cleanup_resource_limit".to_owned(),
            EngineError::InvalidRequest => "tts_cleanup_invalid_request".to_owned(),
        };
        VoiceCoreError::TransportFault { code }
    }

    fn wake_cleanup_failed(error: EngineError) -> VoiceCoreError {
        let code = match error {
            EngineError::Cancelled => "wake_cleanup_cancelled".to_owned(),
            EngineError::ProviderFault { .. } => "wake_cleanup_provider_fault".to_owned(),
            EngineError::TaskUnavailable => "wake_cleanup_task_unavailable".to_owned(),
            EngineError::ResourceLimit => "wake_cleanup_resource_limit".to_owned(),
            EngineError::InvalidRequest => "wake_cleanup_invalid_request".to_owned(),
        };
        VoiceCoreError::TransportFault { code }
    }

    fn stt_cleanup_failed(error: EngineError) -> VoiceCoreError {
        let code = match error {
            EngineError::Cancelled => "stt_cleanup_cancelled".to_owned(),
            EngineError::ProviderFault { .. } => "stt_cleanup_provider_fault".to_owned(),
            EngineError::TaskUnavailable => "stt_cleanup_task_unavailable".to_owned(),
            EngineError::ResourceLimit => "stt_cleanup_resource_limit".to_owned(),
            EngineError::InvalidRequest => "stt_cleanup_invalid_request".to_owned(),
        };
        VoiceCoreError::TransportFault { code }
    }

    fn state_cleanup_failed(error: VoiceCoreError) -> VoiceCoreError {
        let code = match error {
            VoiceCoreError::TransportFault { code } if code.starts_with("state_cleanup_") => code,
            VoiceCoreError::TransportFault { .. } => "state_cleanup_transport_fault".to_owned(),
            VoiceCoreError::Cancelled => "state_cleanup_cancelled".to_owned(),
            VoiceCoreError::InvalidTransition => "state_cleanup_invalid_transition".to_owned(),
            VoiceCoreError::StaleGeneration => "state_cleanup_stale_generation".to_owned(),
            VoiceCoreError::LockPoisoned => "state_cleanup_lock_poisoned".to_owned(),
            VoiceCoreError::Engine(_) => "state_cleanup_engine_fault".to_owned(),
            _ => "state_cleanup_failed".to_owned(),
        };
        VoiceCoreError::TransportFault { code }
    }

    async fn emit_state_after_cleanup(
        &mut self,
        generation: Generation,
        route_revision: RouteRevision,
    ) -> Result<(), VoiceCoreError> {
        if matches!(self.state.state(), VoiceState::Disabled) {
            return Ok(());
        }
        let mut first_error = None;
        if !matches!(self.state.state(), VoiceState::Stopping) {
            if let Err(error) = self
                .transition_cleanup_emit(
                    VoiceState::Stopping,
                    TransitionReason::Cancel,
                    generation,
                    route_revision,
                    TimestampMicros(0),
                )
                .await
            {
                first_error = Some(error);
            }
        }
        if !matches!(self.state.state(), VoiceState::Idle) {
            if let Err(error) = self
                .transition_cleanup_emit(
                    VoiceState::Idle,
                    TransitionReason::Stop,
                    generation,
                    route_revision,
                    TimestampMicros(0),
                )
                .await
            {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn transition_cleanup_emit(
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
    use async_trait::async_trait;
    use aurora_voice_engine::{
        select_verified_variant, verify_manifest, AbiRequirements, BrowserFeature, CapabilityFlags,
        Compatibility, CompressionKind, DeviceClass, EngineFaultCode, EngineKind, KwsCooldownState,
        LanguageSupport, LicenseGrant, LicenseInfo, ManifestSignature, ModelPackError,
        ModelPackFile, ModelPackManifest, ModelPackVariant, PackTask, Provenance, ResourceBudget,
        RuntimeGates, RuntimeSelection, RuntimeTarget, SelectedVariant, ShapeMetadata,
        SignatureVerifier, TargetArch, TargetOs, TrustPolicy, TtsAudioChunk, VerifiedManifest,
        VAD_WINDOW_SIZE_SAMPLES,
    };
    use proptest::prelude::*;
    use std::cell::RefCell;
    use std::collections::{BTreeSet, VecDeque};
    use std::rc::Rc;
    use std::sync::{Arc, Mutex};

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

    fn frame_with_samples(
        sequence: u64,
        generation: Generation,
        samples: Vec<f32>,
    ) -> Result<PcmFrame, VoiceCoreError> {
        PcmFrame::new(
            samples,
            TimestampMicros(sequence),
            sequence,
            false,
            RouteRevision(1),
            generation,
        )
    }

    fn frame_with_samples_and_discontinuity(
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

    struct AcceptingVerifier;

    impl SignatureVerifier for AcceptingVerifier {
        fn verify(
            &self,
            _canonical_json: &str,
            signature: &ManifestSignature,
        ) -> Result<bool, ModelPackError> {
            Ok(signature.value == "signed")
        }
    }

    fn test_license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn test_provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
        }
    }

    fn test_processing() -> aurora_voice_engine::ProcessingMetadata {
        aurora_voice_engine::ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: HASH.to_owned(),
            preprocessing_abi: "pre-v1".to_owned(),
            postprocessing_abi: "post-v1".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: MONO_CHANNELS,
                frame_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                window_size: 1024,
                cache_state: vec!["state".to_owned()],
            },
        }
    }

    fn test_file(file_id: &str, task: PackTask) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task,
            byte_size: 100,
            sha256: HASH.to_owned(),
            url: format!("https://example.test/{file_id}"),
            compression: CompressionKind::None,
            installed_size: 100,
            install_order: 0,
            dependencies: Vec::new(),
            license: test_license(),
            provenance: test_provenance(),
            processing: test_processing(),
            raven: None,
            revocation: None,
        }
    }

    fn test_variant(file_id: &str) -> ModelPackVariant {
        ModelPackVariant {
            variant_id: "linux".to_owned(),
            target: RuntimeTarget::Desktop,
            os: TargetOs::Linux,
            arch: TargetArch::X86_64,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::<BrowserFeature>::new(),
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
                group_id: "group-a".to_owned(),
                voice_state_group_id: "voice-state-a".to_owned(),
                preprocessing_abi: "pre-v1".to_owned(),
                postprocessing_abi: "post-v1".to_owned(),
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: MONO_CHANNELS,
                frame_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                interoperable: true,
            },
            file_ids: vec![file_id.to_owned()],
            abi: AbiRequirements {
                min_aurora_version: "1.0.0".to_owned(),
                min_runtime_version: "1.0.0".to_owned(),
                min_engine_version: "1.0.0".to_owned(),
                engine_source_revision: "rev1".to_owned(),
                build_flags: vec!["cpu".to_owned()],
            },
            revocation: None,
        }
    }

    fn verified_selection(pack_task: PackTask) -> (VerifiedManifest, SelectedVariant) {
        let manifest = ModelPackManifest {
            schema_version: 1,
            pack_id: format!("pack-{pack_task:?}"),
            pack_version: "1.0.0".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![pack_task],
            license: test_license(),
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
            provenance: test_provenance(),
            files: vec![test_file("model", pack_task)],
            variants: vec![test_variant("model")],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key1".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        };
        let verified = verify_manifest(manifest, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("verified manifest");
        let selection = select_verified_variant(
            &verified,
            &RuntimeSelection {
                target: RuntimeTarget::Desktop,
                os: TargetOs::Linux,
                arch: TargetArch::X86_64,
                browser_features: BTreeSet::new(),
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
        .expect("selected variant");
        (verified, selection)
    }

    fn test_task_binding(task: VoiceTask, pack_task: PackTask) -> TaskPackBinding {
        let (verified, selection) = verified_selection(pack_task);
        TaskPackBinding::from_selection(task, &verified, &selection).expect("task binding")
    }

    #[derive(Clone)]
    struct FakeAudioInput {
        frames: Rc<RefCell<VecDeque<PcmFrame>>>,
        stopped: Rc<RefCell<Vec<TransitionReason>>>,
        preparation_events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl FakeAudioInput {
        fn new(frames: Vec<PcmFrame>) -> Self {
            Self {
                frames: Rc::new(RefCell::new(frames.into())),
                stopped: Rc::new(RefCell::new(Vec::new())),
                preparation_events: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn stopped(&self) -> Vec<TransitionReason> {
            self.stopped.borrow().clone()
        }

        fn push_frame(&self, frame: PcmFrame) {
            self.frames.borrow_mut().push_back(frame);
        }

        fn preparation_events(&self) -> Arc<Mutex<Vec<&'static str>>> {
            Arc::clone(&self.preparation_events)
        }
    }

    #[async_trait(?Send)]
    impl AudioInput for FakeAudioInput {
        async fn start(&mut self, _lease: VoiceCaptureLease) -> Result<(), VoiceCoreError> {
            self.preparation_events
                .lock()
                .map_err(|_| VoiceCoreError::LockPoisoned)?
                .push("audio.start");
            Ok(())
        }

        async fn stop(&mut self, reason: TransitionReason) -> Result<(), VoiceCoreError> {
            self.stopped.borrow_mut().push(reason);
            Ok(())
        }

        async fn next_frame(&mut self) -> Result<Option<PcmFrame>, VoiceCoreError> {
            Ok(self.frames.borrow_mut().pop_front())
        }

        fn current_route_revision(&self) -> RouteRevision {
            RouteRevision(1)
        }
    }

    #[derive(Clone)]
    struct FakeEngine {
        transcript: String,
        transcribed: Rc<RefCell<Vec<Vec<f32>>>>,
        synthesized_text: Rc<RefCell<Vec<String>>>,
        tts_text_limit: Rc<RefCell<Option<usize>>>,
        tts_error: Rc<RefCell<Option<EngineError>>>,
        tts_cancel_on_resource: Rc<RefCell<Option<CancellationToken>>>,
        stt_cancelled: Rc<RefCell<Vec<u64>>>,
        tts_cancelled: Rc<RefCell<Vec<u64>>>,
    }

    impl FakeEngine {
        fn new(transcript: &str) -> Self {
            Self {
                transcript: transcript.to_owned(),
                transcribed: Rc::new(RefCell::new(Vec::new())),
                synthesized_text: Rc::new(RefCell::new(Vec::new())),
                tts_text_limit: Rc::new(RefCell::new(None)),
                tts_error: Rc::new(RefCell::new(None)),
                tts_cancel_on_resource: Rc::new(RefCell::new(None)),
                stt_cancelled: Rc::new(RefCell::new(Vec::new())),
                tts_cancelled: Rc::new(RefCell::new(Vec::new())),
            }
        }

        fn with_tts_text_limit(self, max_bytes: usize) -> Self {
            *self.tts_text_limit.borrow_mut() = Some(max_bytes);
            self
        }

        fn with_tts_error(self, error: EngineError) -> Self {
            *self.tts_error.borrow_mut() = Some(error);
            self
        }

        fn with_tts_resource_cancellation(self, cancellation: CancellationToken) -> Self {
            *self.tts_cancel_on_resource.borrow_mut() = Some(cancellation);
            self
        }

        fn transcribed_audio(&self) -> Vec<Vec<f32>> {
            self.transcribed.borrow().clone()
        }

        fn synthesized_text(&self) -> Vec<String> {
            self.synthesized_text.borrow().clone()
        }
    }

    #[async_trait(?Send)]
    impl FiniteSttPort for FakeEngine {
        fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
            Ok(FiniteSttProviderBinding::Route(RouteFiniteSttBinding::new(
                "route.stt.fake",
                FiniteSttRouteScope::LoopbackSidecar,
                VAD_SAMPLE_RATE_HZ,
                VAD_SAMPLE_RATE_HZ as usize * 10,
                1,
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
            cancellation: &dyn Fn() -> bool,
        ) -> Result<FiniteSttResult, EngineError> {
            if cancellation() {
                return Err(EngineError::Cancelled);
            }
            self.transcribed.borrow_mut().push(audio.samples().to_vec());
            FiniteSttResult::new(&request, &audio, self.transcript.clone())
        }

        async fn cancel_finite_stt_generation(
            &mut self,
            generation: u64,
        ) -> Result<(), EngineError> {
            self.stt_cancelled.borrow_mut().push(generation);
            Ok(())
        }
    }

    #[async_trait(?Send)]
    impl TtsSynthesisPort for FakeEngine {
        fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
            Ok(TtsSynthesisProviderBinding::Route(RouteTtsBinding::new(
                "route.tts.fake",
                "default",
                VAD_SAMPLE_RATE_HZ,
                1,
            )?))
        }

        async fn warm_synthesis(
            &mut self,
            _binding: TtsSynthesisProviderBinding,
        ) -> Result<(), EngineError> {
            Ok(())
        }

        async fn synthesize_text(
            &mut self,
            request: BoundTtsSynthesisRequest,
            cancellation: &dyn Fn() -> bool,
        ) -> Result<TtsSynthesisResult, EngineError> {
            if cancellation() {
                return Err(EngineError::Cancelled);
            }
            self.synthesized_text
                .borrow_mut()
                .push(request.text().to_owned());
            if let Some(error) = self.tts_error.borrow().clone() {
                return Err(error);
            }
            if self
                .tts_text_limit
                .borrow()
                .is_some_and(|limit| request.text().len() > limit)
            {
                if let Some(token) = self.tts_cancel_on_resource.borrow().as_ref() {
                    token.cancel();
                }
                return Err(EngineError::ResourceLimit);
            }
            let chunk = TtsAudioChunk::new(
                &request,
                1,
                VAD_SAMPLE_RATE_HZ,
                MONO_CHANNELS,
                vec![0; 64],
                true,
            )?;
            TtsSynthesisResult::new(&request, vec![chunk], false)
        }

        async fn cancel_synthesis_generation(
            &mut self,
            generation: u64,
        ) -> Result<(), EngineError> {
            self.tts_cancelled.borrow_mut().push(generation);
            Ok(())
        }
    }

    struct FakeTransport {
        response: String,
        error_code: Option<String>,
        invoked: Rc<RefCell<Vec<AssistantTurnRequest>>>,
        cancelled: Rc<RefCell<Vec<Generation>>>,
    }

    impl FakeTransport {
        fn new(response: &str) -> Self {
            Self {
                response: response.to_owned(),
                error_code: None,
                invoked: Rc::new(RefCell::new(Vec::new())),
                cancelled: Rc::new(RefCell::new(Vec::new())),
            }
        }

        fn failing(code: &str) -> Self {
            Self {
                response: String::new(),
                error_code: Some(code.to_owned()),
                invoked: Rc::new(RefCell::new(Vec::new())),
                cancelled: Rc::new(RefCell::new(Vec::new())),
            }
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
            self.invoked.borrow_mut().push(request);
            if let Some(code) = &self.error_code {
                return Err(VoiceCoreError::TransportFault { code: code.clone() });
            }
            Ok(AssistantTurnResponse {
                text: self.response.clone(),
                session_id: None,
                request_id: None,
                correlation_id: None,
            })
        }

        async fn cancel_session(&mut self, generation: Generation) -> Result<(), VoiceCoreError> {
            self.cancelled.borrow_mut().push(generation);
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeAudioOutput {
        played: Rc<RefCell<Vec<Generation>>>,
    }

    impl FakeAudioOutput {
        fn new() -> Self {
            Self {
                played: Rc::new(RefCell::new(Vec::new())),
            }
        }

        fn played_generations(&self) -> Vec<Generation> {
            self.played.borrow().clone()
        }
    }

    #[async_trait(?Send)]
    impl AudioOutput for FakeAudioOutput {
        async fn play(
            &mut self,
            context: AudioPlaybackContext,
            _audio: TtsSynthesisResult,
            cancellation: &dyn Fn() -> bool,
        ) -> Result<AudioPlaybackReceipt, VoiceCoreError> {
            if cancellation() {
                return Err(VoiceCoreError::Cancelled);
            }
            self.played.borrow_mut().push(context.generation);
            Ok(AudioPlaybackReceipt::new(
                context,
                1,
                64,
                TimestampMicros(context.started_at.0.saturating_add(1)),
            ))
        }

        async fn stop(
            &mut self,
            _generation: Generation,
            _reason: TransitionReason,
        ) -> Result<(), VoiceCoreError> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeEventSink {
        events: Vec<RuntimeEvent>,
    }

    #[async_trait(?Send)]
    impl RuntimeEventSink for FakeEventSink {
        async fn snapshot(&mut self, _snapshot: RedactedSnapshot) -> Result<(), VoiceCoreError> {
            Ok(())
        }

        async fn event(&mut self, event: RuntimeEvent) -> Result<(), VoiceCoreError> {
            self.events.push(event);
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct FakeWakeProviderHandles {
        vad_cancelled: Arc<Mutex<Vec<u64>>>,
        kws_cancelled: Arc<Mutex<Vec<u64>>>,
        vad_resets: Arc<Mutex<Vec<StreamResetReason>>>,
        kws_resets: Arc<Mutex<Vec<StreamResetReason>>>,
        preparation_events: Arc<Mutex<Vec<&'static str>>>,
        vad_frames: Arc<Mutex<Vec<(u64, usize, bool)>>>,
        fail_vad_cancel: Arc<Mutex<bool>>,
        fail_kws_cancel: Arc<Mutex<bool>>,
        fail_vad_reset: Arc<Mutex<bool>>,
        fail_kws_reset: Arc<Mutex<bool>>,
    }

    impl FakeWakeProviderHandles {
        fn vad_cancelled(&self) -> Vec<u64> {
            self.vad_cancelled
                .lock()
                .expect("VAD cancellation handle should not be poisoned")
                .clone()
        }

        fn kws_cancelled(&self) -> Vec<u64> {
            self.kws_cancelled
                .lock()
                .expect("KWS cancellation handle should not be poisoned")
                .clone()
        }

        fn vad_resets(&self) -> Vec<StreamResetReason> {
            self.vad_resets
                .lock()
                .expect("VAD reset handle should not be poisoned")
                .clone()
        }

        fn kws_resets(&self) -> Vec<StreamResetReason> {
            self.kws_resets
                .lock()
                .expect("KWS reset handle should not be poisoned")
                .clone()
        }

        fn preparation_events(&self) -> Vec<&'static str> {
            self.preparation_events
                .lock()
                .expect("preparation event handle should not be poisoned")
                .clone()
        }

        fn vad_frames(&self) -> Vec<(u64, usize, bool)> {
            self.vad_frames
                .lock()
                .expect("VAD frame handle should not be poisoned")
                .clone()
        }

        fn fail_vad_cancel(&self) {
            *self
                .fail_vad_cancel
                .lock()
                .expect("VAD failure handle should not be poisoned") = true;
        }
    }

    struct FakeKwsProvider {
        binding: TaskPackBinding,
        match_sequences: BTreeSet<u64>,
        ready: bool,
        handles: FakeWakeProviderHandles,
        _not_send: Rc<()>,
    }

    impl FakeKwsProvider {
        fn new(
            binding: TaskPackBinding,
            match_sequences: impl IntoIterator<Item = u64>,
            handles: FakeWakeProviderHandles,
        ) -> Self {
            Self {
                binding,
                match_sequences: match_sequences.into_iter().collect(),
                ready: true,
                handles,
                _not_send: Rc::new(()),
            }
        }
    }

    #[async_trait(?Send)]
    impl TaskProvider for FakeKwsProvider {
        fn capabilities(&self) -> Vec<TaskCapability> {
            vec![TaskCapability::new(self.binding.clone()).streaming(true)]
        }

        fn resource_report(&self) -> ResourceReport {
            ResourceReport {
                loaded_tasks: vec![VoiceTask::KeywordSpotting],
                memory_bytes: 1,
                active_streams: 0,
                readiness: if self.ready {
                    TaskReadiness::Ready
                } else {
                    TaskReadiness::Cold
                },
            }
        }

        async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
            if request.binding() == &self.binding {
                self.handles
                    .preparation_events
                    .lock()
                    .map_err(|_| EngineError::ProviderFault {
                        code: EngineFaultCode::Provider,
                    })?
                    .push("kws.warm");
                Ok(())
            } else {
                Err(EngineError::TaskUnavailable)
            }
        }

        async fn unload_task(&mut self, _binding: TaskPackBinding) -> Result<(), EngineError> {
            Ok(())
        }

        async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
            self.handles
                .kws_cancelled
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
                .push(generation);
            if *self
                .handles
                .fail_kws_cancel
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
            {
                return Err(EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                });
            }
            Ok(())
        }
    }

    #[async_trait(?Send)]
    impl KwsStreamProvider for FakeKwsProvider {
        async fn start_kws_session(
            &mut self,
            request: BoundKwsRequest,
        ) -> Result<BoundStreamSession, EngineError> {
            self.handles
                .preparation_events
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
                .push("kws.start");
            BoundStreamSession::new(aurora_voice_engine::StreamSessionId(1), request.request())
        }

        async fn push_kws_frame(
            &mut self,
            _session: &BoundStreamSession,
            frame: StreamingAudioFrame<'_>,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<aurora_voice_engine::KwsFrameResult, EngineError> {
            let config = KwsConfig::new(["wake.main"], "phrases:v1", 0.5, 0, 1)?;
            let mut cooldown = KwsCooldownState::new();
            let matches = if self.match_sequences.contains(&frame.sequence()) {
                vec![aurora_voice_engine::KeywordMatch::new(
                    "wake.main",
                    0.9,
                    frame.sequence(),
                )?]
            } else {
                Vec::new()
            };
            aurora_voice_engine::KwsFrameResult::new(&config, &mut cooldown, matches, None)
        }

        async fn reset_kws_session(
            &mut self,
            _session: &BoundStreamSession,
            reason: StreamResetReason,
        ) -> Result<(), EngineError> {
            self.handles
                .kws_resets
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
                .push(reason);
            if *self
                .handles
                .fail_kws_reset
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
            {
                return Err(EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                });
            }
            Ok(())
        }
    }

    struct FakeVadProvider {
        binding: TaskPackBinding,
        speech_sequences: BTreeSet<u64>,
        segment_sequences: BTreeSet<u64>,
        ready: bool,
        handles: FakeWakeProviderHandles,
        _not_send: Rc<()>,
    }

    impl FakeVadProvider {
        fn new(
            binding: TaskPackBinding,
            speech_sequences: impl IntoIterator<Item = u64>,
            segment_sequences: impl IntoIterator<Item = u64>,
            handles: FakeWakeProviderHandles,
        ) -> Self {
            Self {
                binding,
                speech_sequences: speech_sequences.into_iter().collect(),
                segment_sequences: segment_sequences.into_iter().collect(),
                ready: true,
                handles,
                _not_send: Rc::new(()),
            }
        }
    }

    #[async_trait(?Send)]
    impl TaskProvider for FakeVadProvider {
        fn capabilities(&self) -> Vec<TaskCapability> {
            vec![TaskCapability::new(self.binding.clone()).streaming(true)]
        }

        fn resource_report(&self) -> ResourceReport {
            ResourceReport {
                loaded_tasks: vec![VoiceTask::VoiceActivityDetection],
                memory_bytes: 1,
                active_streams: 0,
                readiness: if self.ready {
                    TaskReadiness::Ready
                } else {
                    TaskReadiness::Cold
                },
            }
        }

        async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
            if request.binding() == &self.binding {
                self.handles
                    .preparation_events
                    .lock()
                    .map_err(|_| EngineError::ProviderFault {
                        code: EngineFaultCode::Provider,
                    })?
                    .push("vad.warm");
                Ok(())
            } else {
                Err(EngineError::TaskUnavailable)
            }
        }

        async fn unload_task(&mut self, _binding: TaskPackBinding) -> Result<(), EngineError> {
            Ok(())
        }

        async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
            self.handles
                .vad_cancelled
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
                .push(generation);
            if *self
                .handles
                .fail_vad_cancel
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
            {
                return Err(EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                });
            }
            Ok(())
        }
    }

    #[async_trait(?Send)]
    impl VadStreamProvider for FakeVadProvider {
        async fn start_vad_session(
            &mut self,
            request: BoundVadRequest,
        ) -> Result<BoundStreamSession, EngineError> {
            self.handles
                .preparation_events
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
                .push("vad.start");
            BoundStreamSession::new(aurora_voice_engine::StreamSessionId(2), request.request())
        }

        async fn push_vad_frame(
            &mut self,
            _session: &BoundStreamSession,
            frame: StreamingAudioFrame<'_>,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<aurora_voice_engine::VadAcceptResult, EngineError> {
            self.handles
                .vad_frames
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
                .push((frame.sequence(), frame.samples().len(), frame.is_end_tail()));
            let detected = self.speech_sequences.contains(&frame.sequence());
            let segments = if self.segment_sequences.contains(&frame.sequence()) {
                vec![aurora_voice_engine::SpeechSegment::new(
                    frame.sequence(),
                    frame.sequence(),
                    0,
                    frame.samples().to_vec(),
                    false,
                )?]
            } else {
                Vec::new()
            };
            Ok(aurora_voice_engine::VadAcceptResult::new(
                detected, segments, None,
            ))
        }

        async fn flush_vad_session(
            &mut self,
            _session: &BoundStreamSession,
            _cancellation: &dyn Fn() -> bool,
        ) -> Result<Vec<aurora_voice_engine::SpeechSegment>, EngineError> {
            Ok(Vec::new())
        }

        async fn reset_vad_session(
            &mut self,
            _session: &BoundStreamSession,
            reason: StreamResetReason,
        ) -> Result<(), EngineError> {
            self.handles
                .vad_resets
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
                .push(reason);
            if *self
                .handles
                .fail_vad_reset
                .lock()
                .map_err(|_| EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                })?
            {
                return Err(EngineError::ProviderFault {
                    code: EngineFaultCode::Provider,
                });
            }
            Ok(())
        }
    }

    #[test]
    fn wake_runtime_accepts_thread_affine_providers() -> Result<(), VoiceCoreError> {
        let (runtime, _engine, _handles) =
            runtime_with_wake_handles(Vec::new(), [1], [1], [1], 10, 10)?;

        assert!(runtime.wake_background_ready());
        Ok(())
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
        assert!(matches!(
            manager.next_generation(),
            Err(VoiceCoreError::OwnerAlreadyActive)
        ));
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
    fn capture_generation_preview_matches_next_start_and_stays_monotonic(
    ) -> Result<(), VoiceCoreError> {
        let mut manager = CaptureLeaseManager::new();
        let first_preview = manager.next_generation()?;
        assert_eq!(first_preview, Generation(1));
        let first = manager.request_start(default_test_lease(
            CaptureOwnerKind::Native,
            TimestampMicros(1),
        ))?;
        assert_eq!(first.generation, first_preview);

        manager.release(&CaptureOwnerKind::Native, first.generation)?;
        let second_preview = manager.next_generation()?;
        assert_eq!(second_preview, Generation(2));
        let second = manager.request_start(default_test_lease(
            CaptureOwnerKind::Web,
            TimestampMicros(2),
        ))?;
        assert_eq!(second.generation, second_preview);
        assert!(second.generation > first.generation);
        Ok(())
    }

    #[test]
    fn capture_generation_exhaustion_fails_closed() {
        let mut manager = CaptureLeaseManager {
            active: None,
            generation: u64::MAX,
        };
        assert!(matches!(
            manager.next_generation(),
            Err(VoiceCoreError::GenerationExhausted)
        ));
        assert!(matches!(
            manager.request_start(default_test_lease(
                CaptureOwnerKind::Native,
                TimestampMicros(1)
            )),
            Err(VoiceCoreError::GenerationExhausted)
        ));
        assert!(!manager.has_active());
        assert!(!manager.accepts_generation(Generation(u64::MAX)));
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

    #[test]
    fn spoken_text_projection_normalizes_controls_and_respects_utf8_limit() {
        assert_eq!(
            project_spoken_text("  hello\n\tworld\u{7}again  "),
            Ok("hello world again".to_owned())
        );
        assert_eq!(
            project_spoken_text("\n\t\u{7}\r"),
            Err(EngineError::InvalidRequest)
        );

        let response = format!("{}🙂tail", "a".repeat(TTS_MAX_TEXT_BYTES - 1));
        let spoken = project_spoken_text(&response).expect("bounded spoken text");
        assert_eq!(spoken.len(), TTS_MAX_TEXT_BYTES - 1);
        assert!(!spoken.contains('🙂'));
    }

    #[test]
    fn spoken_text_split_prefers_balanced_sentence_boundaries() {
        let text = "First sentence stays concise. Second sentence is also concise. Third sentence finishes the answer.";
        let (left, right) = split_spoken_segment(text).expect("balanced split");

        assert_eq!(
            format!("{left} {right}"),
            project_spoken_text(text).expect("spoken projection")
        );
        assert!(left.ends_with('.'));
        assert!(left.len().abs_diff(right.len()) < text.len() / 2);
    }

    type TestRuntime = VoiceRuntime<
        FakeAudioInput,
        FakeEngine,
        FakeEngine,
        FakeTransport,
        FakeAudioOutput,
        FakeEventSink,
    >;

    fn wake_config(
        vad_binding: TaskPackBinding,
        kws_binding: TaskPackBinding,
        max_wake_frames: u64,
        max_utterance_frames: u64,
    ) -> WakeOrchestrationConfig {
        WakeOrchestrationConfig::new(
            vad_binding,
            kws_binding,
            VadConfig::default(),
            KwsConfig::new(["wake.main"], "phrases:v1", 0.5, 0, 1).expect("kws config"),
            max_wake_frames,
            max_utterance_frames,
        )
        .expect("wake config")
    }

    fn runtime_with_wake(
        frames: Vec<PcmFrame>,
        kws_matches: impl IntoIterator<Item = u64>,
        vad_speech: impl IntoIterator<Item = u64>,
        vad_segments: impl IntoIterator<Item = u64>,
        max_wake_frames: u64,
        max_utterance_frames: u64,
    ) -> Result<(TestRuntime, FakeEngine), VoiceCoreError> {
        let (runtime, engine, _handles) = runtime_with_wake_handles(
            frames,
            kws_matches,
            vad_speech,
            vad_segments,
            max_wake_frames,
            max_utterance_frames,
        )?;
        Ok((runtime, engine))
    }

    fn runtime_with_wake_handles(
        frames: Vec<PcmFrame>,
        kws_matches: impl IntoIterator<Item = u64>,
        vad_speech: impl IntoIterator<Item = u64>,
        vad_segments: impl IntoIterator<Item = u64>,
        max_wake_frames: u64,
        max_utterance_frames: u64,
    ) -> Result<(TestRuntime, FakeEngine, FakeWakeProviderHandles), VoiceCoreError> {
        runtime_with_wake_audio(
            FakeAudioInput::new(frames),
            kws_matches,
            vad_speech,
            vad_segments,
            max_wake_frames,
            max_utterance_frames,
        )
    }

    fn runtime_with_wake_audio(
        audio: FakeAudioInput,
        kws_matches: impl IntoIterator<Item = u64>,
        vad_speech: impl IntoIterator<Item = u64>,
        vad_segments: impl IntoIterator<Item = u64>,
        max_wake_frames: u64,
        max_utterance_frames: u64,
    ) -> Result<(TestRuntime, FakeEngine, FakeWakeProviderHandles), VoiceCoreError> {
        let vad_binding = test_task_binding(VoiceTask::VoiceActivityDetection, PackTask::Vad);
        let kws_binding = test_task_binding(VoiceTask::KeywordSpotting, PackTask::Kws);
        let engine = FakeEngine::new("wake transcript");
        let handles = FakeWakeProviderHandles {
            preparation_events: audio.preparation_events(),
            ..FakeWakeProviderHandles::default()
        };
        let runtime = VoiceRuntime::new(
            audio,
            engine.clone(),
            engine.clone(),
            FakeTransport::new("wake answer"),
            FakeAudioOutput::new(),
            FakeEventSink::default(),
            "test",
            "wake-runtime-test",
        )?
        .with_wake_providers(
            Box::new(FakeVadProvider::new(
                vad_binding.clone(),
                vad_speech,
                vad_segments,
                handles.clone(),
            )),
            Box::new(FakeKwsProvider::new(
                kws_binding.clone(),
                kws_matches,
                handles.clone(),
            )),
            wake_config(
                vad_binding,
                kws_binding,
                max_wake_frames,
                max_utterance_frames,
            ),
        )?;
        Ok((runtime, engine, handles))
    }

    fn observed_states(sink: &FakeEventSink) -> Vec<VoiceState> {
        sink.events
            .iter()
            .filter_map(|event| match event {
                RuntimeEvent::State { transition } => Some(transition.to),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn focused_transcription_returns_text_without_transport_or_playback(
    ) -> Result<(), VoiceCoreError> {
        let engine = FakeEngine::new("focused transcript");
        let tts_probe = engine.clone();
        let transport = FakeTransport::new("must not dispatch");
        let transport_invocations = Rc::clone(&transport.invoked);
        let output = FakeAudioOutput::new();
        let output_probe = output.clone();
        let mut runtime = VoiceRuntime::new(
            FakeAudioInput::new(vec![frame_with_samples(1, Generation(1), vec![0.1])?]),
            engine.clone(),
            engine,
            transport,
            output,
            FakeEventSink::default(),
            "android",
            "focused-transcription-test",
        )?;

        let transcript = runtime
            .run_push_to_talk_transcription(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(10)),
                TimestampMicros(10),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(transcript, "focused transcript");
        assert!(transport_invocations.borrow().is_empty());
        assert!(tts_probe.synthesized_text().is_empty());
        assert!(output_probe.played_generations().is_empty());
        assert_eq!(runtime.state(), VoiceState::Idle);
        Ok(())
    }

    #[tokio::test]
    async fn push_to_talk_preserves_full_response_while_bounding_spoken_text(
    ) -> Result<(), VoiceCoreError> {
        let response = format!("{}🙂tail", "a".repeat(TTS_MAX_TEXT_BYTES - 1));
        let engine = FakeEngine::new("spoken transcript");
        let tts_probe = engine.clone();
        let mut runtime = VoiceRuntime::new(
            FakeAudioInput::new(vec![frame_with_samples(1, Generation(1), vec![0.1])?]),
            engine.clone(),
            engine,
            FakeTransport::new(&response),
            FakeAudioOutput::new(),
            FakeEventSink::default(),
            "test",
            "spoken-projection-test",
        )?;

        let returned = runtime
            .run_push_to_talk_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(10)),
                TimestampMicros(10),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(returned, response);
        let synthesized = tts_probe.synthesized_text();
        assert_eq!(synthesized.len(), 1);
        assert_eq!(synthesized[0].len(), TTS_MAX_TEXT_BYTES - 1);
        assert!(!synthesized[0].contains('🙂'));
        Ok(())
    }

    #[tokio::test]
    async fn transcript_event_is_emitted_before_assistant_transport_finishes(
    ) -> Result<(), VoiceCoreError> {
        let engine = FakeEngine::new("native wake transcript");
        let mut runtime = VoiceRuntime::new(
            FakeAudioInput::new(vec![frame_with_samples(1, Generation(1), vec![0.1])?]),
            engine.clone(),
            engine,
            FakeTransport::failing("assistant_unavailable"),
            FakeAudioOutput::new(),
            FakeEventSink::default(),
            "android",
            "transcript-event-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(10)),
                TimestampMicros(10),
                CancellationToken::new(),
            )
            .await;

        assert!(matches!(
            result,
            Err(VoiceCoreError::TransportFault { ref code }) if code == "assistant_unavailable"
        ));
        let (_audio, _stt, _tts, _transport, _output, sink) = runtime.into_parts();
        let transcript_index = sink
            .events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    RuntimeEvent::Transcript { text, partial: false, .. }
                        if text == "native wake transcript"
                )
            })
            .expect("final transcript event");
        let dispatch_index = sink
            .events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    RuntimeEvent::State { transition }
                        if transition.to == VoiceState::Dispatching
                )
            })
            .expect("dispatching transition");
        assert!(transcript_index < dispatch_index);
        Ok(())
    }

    #[tokio::test]
    async fn push_to_talk_bisects_and_plays_only_resource_limited_speech(
    ) -> Result<(), VoiceCoreError> {
        let response = "First sentence stays concise. Second sentence is also concise. Third sentence finishes the answer.";
        let engine = FakeEngine::new("spoken transcript").with_tts_text_limit(64);
        let tts_probe = engine.clone();
        let output = FakeAudioOutput::new();
        let output_probe = output.clone();
        let mut runtime = VoiceRuntime::new(
            FakeAudioInput::new(vec![frame_with_samples(1, Generation(1), vec![0.1])?]),
            engine.clone(),
            engine,
            FakeTransport::new(response),
            output,
            FakeEventSink::default(),
            "test",
            "spoken-resource-recovery-test",
        )?;

        let returned = runtime
            .run_push_to_talk_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(10)),
                TimestampMicros(10),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(returned, response);
        let attempts = tts_probe.synthesized_text();
        assert_eq!(attempts.first().map(String::as_str), Some(response));
        let successful = attempts
            .iter()
            .filter(|segment| segment.len() <= 64)
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(successful.join(" "), response);
        assert_eq!(output_probe.played_generations().len(), successful.len());
        Ok(())
    }

    #[tokio::test]
    async fn push_to_talk_does_not_retry_or_play_provider_faults() -> Result<(), VoiceCoreError> {
        let engine =
            FakeEngine::new("spoken transcript").with_tts_error(EngineError::ProviderFault {
                code: EngineFaultCode::Native,
            });
        let tts_probe = engine.clone();
        let output = FakeAudioOutput::new();
        let output_probe = output.clone();
        let mut runtime = VoiceRuntime::new(
            FakeAudioInput::new(vec![frame_with_samples(1, Generation(1), vec![0.1])?]),
            engine.clone(),
            engine,
            FakeTransport::new("Provider faults stay terminal."),
            output,
            FakeEventSink::default(),
            "test",
            "spoken-provider-fault-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(10)),
                TimestampMicros(10),
                CancellationToken::new(),
            )
            .await;

        assert!(matches!(
            result,
            Err(VoiceCoreError::Engine(EngineError::ProviderFault {
                code: EngineFaultCode::Native
            }))
        ));
        assert_eq!(tts_probe.synthesized_text().len(), 1);
        assert!(output_probe.played_generations().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn push_to_talk_cancellation_stops_resource_recovery_before_playback(
    ) -> Result<(), VoiceCoreError> {
        let cancellation = CancellationToken::new();
        let engine = FakeEngine::new("spoken transcript")
            .with_tts_text_limit(32)
            .with_tts_resource_cancellation(cancellation.clone());
        let tts_probe = engine.clone();
        let output = FakeAudioOutput::new();
        let output_probe = output.clone();
        let mut runtime = VoiceRuntime::new(
            FakeAudioInput::new(vec![frame_with_samples(1, Generation(1), vec![0.1])?]),
            engine.clone(),
            engine,
            FakeTransport::new("This response is deliberately long enough to require splitting."),
            output,
            FakeEventSink::default(),
            "test",
            "spoken-resource-cancellation-test",
        )?;

        let result = runtime
            .run_push_to_talk_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(10)),
                TimestampMicros(10),
                cancellation,
            )
            .await;

        assert_eq!(result, Err(VoiceCoreError::Cancelled));
        assert_eq!(tts_probe.synthesized_text().len(), 1);
        assert!(output_probe.played_generations().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_without_ready_providers_fails_before_capture() -> Result<(), VoiceCoreError>
    {
        let engine = FakeEngine::new("unused");
        let mut runtime = VoiceRuntime::new(
            FakeAudioInput::new(vec![frame_with_samples(1, Generation(1), vec![0.1])?]),
            engine.clone(),
            engine.clone(),
            FakeTransport::new("unused"),
            FakeAudioOutput::new(),
            FakeEventSink::default(),
            "test",
            "wake-runtime-test",
        )?;

        assert!(!runtime.wake_background_ready());
        let result = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(10)),
                TimestampMicros(10),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::WakeUnavailable)));
        assert_eq!(runtime.state(), VoiceState::Disabled);
        assert!(!runtime.has_active_capture());
        let (audio, engine, _tts, _transport, _output, _sink) = runtime.into_parts();
        assert!(audio.stopped().is_empty());
        assert!(engine.transcribed_audio().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_does_not_emit_wake_without_keyword() -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
        ];
        let (mut runtime, engine) = runtime_with_wake(frames, [], [], [], 2, 2)?;

        let result = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(20)),
                TimestampMicros(20),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::WakeNotDetected)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(engine.transcribed_audio().is_empty());
        let (_audio, _engine, _tts, _transport, _output, sink) = runtime.into_parts();
        let states = observed_states(&sink);
        assert_eq!(
            states,
            vec![
                VoiceState::Idle,
                VoiceState::ListeningForWake,
                VoiceState::Stopping,
                VoiceState::Idle,
            ]
        );
        assert!(!states.contains(&VoiceState::WakeDetected));
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_rejects_keyword_without_following_speech() -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
        ];
        let (mut runtime, engine) = runtime_with_wake(frames, [1], [], [], 4, 4)?;

        let result = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(30)),
                TimestampMicros(30),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::SpeechNotDetected)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(engine.transcribed_audio().is_empty());
        let (_audio, _engine, _tts, _transport, _output, sink) = runtime.into_parts();
        let states = observed_states(&sink);
        assert_eq!(
            states,
            vec![
                VoiceState::Idle,
                VoiceState::ListeningForWake,
                VoiceState::WakeDetected,
                VoiceState::Stopping,
                VoiceState::Idle,
            ]
        );
        assert!(!states.contains(&VoiceState::CapturingUtterance));
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_transcribes_only_vad_segmented_utterance() -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2; VAD_WINDOW_SIZE_SAMPLES])?,
            frame_with_samples(3, Generation(1), vec![0.4; VAD_WINDOW_SIZE_SAMPLES])?,
        ];
        let (mut runtime, engine) = runtime_with_wake(frames, [1], [2, 3], [3], 4, 4)?;

        let response = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(40)),
                TimestampMicros(40),
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(response, "wake answer");
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert_eq!(
            engine.transcribed_audio(),
            vec![vec![0.4; VAD_WINDOW_SIZE_SAMPLES]]
        );
        let (_audio, _engine, _tts, _transport, _output, sink) = runtime.into_parts();
        let transitions = observed_states(&sink);
        assert!(transitions.contains(&VoiceState::ListeningForWake));
        assert!(transitions.contains(&VoiceState::WakeDetected));
        assert!(transitions.contains(&VoiceState::CapturingUtterance));
        assert!(transitions.contains(&VoiceState::Transcribing));
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_excludes_keyword_detection_frame_from_utterance(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
        ];
        let (mut runtime, engine) = runtime_with_wake(frames, [1], [1, 2], [1, 2], 4, 4)?;

        runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(40)),
                TimestampMicros(40),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(engine.transcribed_audio(), vec![vec![0.2]]);
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_reframes_android_chunks_for_exact_vad_windows() -> Result<(), VoiceCoreError>
    {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1; 1_600])?,
            frame_with_samples(2, Generation(1), vec![0.2; 1_600])?,
        ];
        let (mut runtime, _engine, handles) =
            runtime_with_wake_handles(frames, [1], [5], [5], 4, 4)?;

        runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(40)),
                TimestampMicros(40),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(
            handles.vad_frames(),
            vec![
                (2, 512, false),
                (3, 512, false),
                (4, 512, false),
                (5, 64, true),
            ]
        );
        Ok(())
    }

    #[tokio::test]
    async fn background_wake_prepares_providers_before_audio_capture_starts(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
        ];
        let (mut runtime, _engine, handles) =
            runtime_with_wake_handles(frames, [1], [2], [2], 4, 4)?;

        runtime
            .run_background_turn(
                VoiceCaptureLease {
                    background_eligible: true,
                    ..default_test_lease(CaptureOwnerKind::Native, TimestampMicros(41))
                },
                TimestampMicros(41),
                CancellationToken::new(),
            )
            .await?;

        let events = handles.preparation_events();
        let audio_start = events
            .iter()
            .position(|event| *event == "audio.start")
            .expect("audio capture should start");
        for required in ["vad.warm", "kws.warm", "vad.start", "kws.start"] {
            let provider_event = events
                .iter()
                .position(|event| *event == required)
                .unwrap_or_else(|| panic!("missing provider preparation event: {required}"));
            assert!(
                provider_event < audio_start,
                "{required} must happen before audio capture starts"
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn background_wake_recovers_from_same_route_discontinuity_before_wake(
    ) -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples_and_discontinuity(1, Generation(1), vec![0.1], true)?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
            frame_with_samples(3, Generation(1), vec![0.3])?,
        ];
        let (mut runtime, engine, handles) =
            runtime_with_wake_handles(frames, [2], [3], [3], 4, 4)?;

        let response = runtime
            .run_background_turn(
                VoiceCaptureLease {
                    background_eligible: true,
                    ..default_test_lease(CaptureOwnerKind::Native, TimestampMicros(42))
                },
                TimestampMicros(42),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(response, "wake answer");
        assert_eq!(engine.transcribed_audio(), vec![vec![0.3]]);
        assert!(handles
            .vad_resets()
            .contains(&StreamResetReason::Discontinuity));
        assert!(handles
            .kws_resets()
            .contains(&StreamResetReason::Discontinuity));
        assert_eq!(runtime.state(), VoiceState::Idle);
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_closes_successful_wake_generation_for_next_turn(
    ) -> Result<(), VoiceCoreError> {
        let audio = FakeAudioInput::new(vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
        ]);
        let audio_feed = audio.clone();
        let (mut runtime, engine, handles) = runtime_with_wake_audio(audio, [1], [2], [2], 4, 4)?;

        let first = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(45)),
                TimestampMicros(45),
                CancellationToken::new(),
            )
            .await?;
        audio_feed.push_frame(frame_with_samples(1, Generation(2), vec![0.3])?);
        audio_feed.push_frame(frame_with_samples(2, Generation(2), vec![0.4])?);

        let second = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(46)),
                TimestampMicros(46),
                CancellationToken::new(),
            )
            .await?;

        assert_eq!(first, "wake answer");
        assert_eq!(second, "wake answer");
        assert_eq!(engine.transcribed_audio(), vec![vec![0.2], vec![0.4]]);
        assert_eq!(handles.vad_cancelled(), vec![1, 2]);
        assert_eq!(handles.kws_cancelled(), vec![1, 2]);
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_vad_cleanup_failure_still_cleans_kws() -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
        ];
        let (mut runtime, engine, handles) =
            runtime_with_wake_handles(frames, [1], [2], [2], 4, 4)?;
        handles.fail_vad_cancel();

        let result = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(47)),
                TimestampMicros(47),
                CancellationToken::new(),
            )
            .await;

        assert!(matches!(
            result,
            Err(VoiceCoreError::TransportFault { code }) if code == "wake_cleanup_provider_fault"
        ));
        assert!(handles
            .vad_cancelled()
            .iter()
            .all(|generation| *generation == 1));
        assert!(!handles.vad_cancelled().is_empty());
        assert!(handles
            .kws_cancelled()
            .iter()
            .all(|generation| *generation == 1));
        assert!(!handles.kws_cancelled().is_empty());
        assert!(engine.transcribed_audio().is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn wake_turn_times_out_bounded_utterance_without_segment() -> Result<(), VoiceCoreError> {
        let frames = vec![
            frame_with_samples(1, Generation(1), vec![0.1])?,
            frame_with_samples(2, Generation(1), vec![0.2])?,
            frame_with_samples(3, Generation(1), vec![0.3])?,
        ];
        let (mut runtime, engine) = runtime_with_wake(frames, [1], [1, 2, 3], [], 4, 1)?;

        let result = runtime
            .run_wake_turn(
                default_test_lease(CaptureOwnerKind::Native, TimestampMicros(50)),
                TimestampMicros(50),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, Err(VoiceCoreError::SpeechTimeout)));
        assert_eq!(runtime.state(), VoiceState::Idle);
        assert!(engine.transcribed_audio().is_empty());
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
