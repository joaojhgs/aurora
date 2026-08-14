//! Thin WebAssembly exports and browser-host ports for the shared voice core.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use aurora_voice_core::CancellationToken;
use aurora_voice_core::{
    BoundedPcmBuffer, CaptureLeaseManager, CaptureOwnerKind, CaptureStartReason, Generation,
    PcmFrame, RedactedSnapshot, ResourceReport, RouteRevision, TaskReadiness, TimestampMicros,
    TransitionReason, VoiceCaptureLease, VoiceCoreError, VoiceState, VoiceStateMachine, VoiceTask,
};
use aurora_voice_engine::{
    apply_lifecycle_event, create_lifecycle_snapshot, file_storage_key, lifecycle_storage_key,
    select_verified_variant, ActivePackIdentity, DownloadTask, ImmutableModelFile, InstallEvent,
    InstallState, LifecycleSnapshot, ModelPackError, ModelPackFile, ModelStore, ModelStoreScope,
    PackTask, RuntimeSelection, SelectedVariant, StoreStatus, StoredFile, VerifiedManifest,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const ACTIVE_PREFIX: &str = "aurora.voice.web-store.v1:active:";
const ROLLBACK_PREFIX: &str = "aurora.voice.web-store.v1:rollback:";
const RESERVED_PREFIX: &str = "aurora.voice.web-store.v1:reserved:";
const PROMOTION_PREFIX: &str = "aurora.voice.web-store.v1:promotion:";
const LIFECYCLE_PREFIX: &str = "aurora.voice.web-store.v1:lifecycle:";
const LIFECYCLE_BACKING_PREFIX: &str = "aurora.voice.web-store.v1:lifecycle-backing:";
const MUTATION_PREFIX: &str = "aurora.voice.web-store.v1:mutation:";
const EXPECTED_SELECTION_PREFIX: &str = "aurora.voice.web-store.v1:expected-selection:";
const FILE_PREFIX: &str = "aurora.voice.web-store.v1:file:";
const WITHDRAWAL_KEY: &str = "aurora.voice.web-store.v1:withdrawn";
const HASH_CHUNK_BYTES: u64 = 64 * 1024;
const WASM_SAMPLE_RATE_HZ: u32 = 16_000;
const WASM_CHANNELS: u16 = 1;
const WASM_MAX_SECONDS: u32 = 60;
const WASM_MAX_SAMPLES: usize = WASM_SAMPLE_RATE_HZ as usize * WASM_MAX_SECONDS as usize;
const WASM_MAX_FRAME_SAMPLES: usize = 4_800;
const WASM_MAX_FRAMES: usize = 4_096;
const WASM_MAX_ID_BYTES: usize = 96;
const WASM_MAX_SURFACE_BYTES: usize = 64;
const JS_MAX_SAFE_INTEGER_MICROS: f64 = 9_007_199_254_740_991.0;
const WASM_DEFAULT_ROUTE_REVISION: RouteRevision = RouteRevision(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserPersistenceKind {
    OpfsPreferred,
    IndexedDbFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebPersistenceReport {
    pub status: StoreStatus,
    pub kind: BrowserPersistenceKind,
    pub evicted: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasmRuntimeConfig {
    pub surface: String,
    #[serde(default = "default_wasm_max_frames")]
    pub max_frames: usize,
    #[serde(default = "default_wasm_max_samples")]
    pub max_samples: usize,
}

impl std::fmt::Debug for WasmRuntimeConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WasmRuntimeConfig")
            .field("surface", &self.surface)
            .field("max_frames", &self.max_frames)
            .field("max_samples", &self.max_samples)
            .finish()
    }
}

impl Default for WasmRuntimeConfig {
    fn default() -> Self {
        Self {
            surface: "web".to_owned(),
            max_frames: WASM_MAX_FRAMES,
            max_samples: WASM_MAX_SAMPLES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WasmSessionStart {
    pub session_id: String,
    #[serde(default)]
    pub route_revision: u32,
    #[serde(default)]
    pub at_micros: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasmStartedSession {
    pub generation: u32,
    pub route_revision: u32,
    pub state: VoiceState,
    pub sample_rate_hz: u32,
    pub channels: u16,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct WasmPushFrame {
    pub session_id: String,
    pub generation: u32,
    pub sequence: u32,
    pub timestamp_micros: f64,
    #[serde(default)]
    pub discontinuity: bool,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub samples: Vec<i16>,
}

impl std::fmt::Debug for WasmPushFrame {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WasmPushFrame")
            .field("session_id", &"<redacted>")
            .field("generation", &self.generation)
            .field("sequence", &self.sequence)
            .field("timestamp_micros", &self.timestamp_micros)
            .field("discontinuity", &self.discontinuity)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .field("sample_count", &self.samples.len())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasmPushReceipt {
    pub generation: u32,
    pub sequence: u32,
    pub buffered_frames: usize,
    pub buffered_samples: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WasmStopRequest {
    pub session_id: String,
    pub generation: u32,
    #[serde(default)]
    pub at_micros: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WasmGenerationRequest {
    pub generation: u32,
    #[serde(default)]
    pub at_micros: f64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasmStoppedSession {
    pub generation: u32,
    pub route_revision: u32,
    pub state: VoiceState,
    pub frame_count: usize,
    pub sample_count: usize,
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub pcm_i16: Vec<i16>,
}

impl std::fmt::Debug for WasmStoppedSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WasmStoppedSession")
            .field("generation", &self.generation)
            .field("route_revision", &self.route_revision)
            .field("state", &self.state)
            .field("frame_count", &self.frame_count)
            .field("sample_count", &self.sample_count)
            .field("sample_rate_hz", &self.sample_rate_hz)
            .field("channels", &self.channels)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasmCapabilities {
    pub vad: bool,
    pub kws: bool,
    pub stt: bool,
    pub tts: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebLoadedModelArtifact {
    pub file_id: String,
    pub storage_key: String,
    pub sha256: String,
    pub byte_size: u64,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for WebLoadedModelArtifact {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebLoadedModelArtifact")
            .field("file_id", &self.file_id)
            .field("storage_key", &self.storage_key)
            .field("sha256", &"<redacted>")
            .field("byte_size", &self.byte_size)
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

pub trait WasmTaskInitializer {
    fn initialize_task(
        &mut self,
        task: VoiceTask,
        artifacts: &[WebLoadedModelArtifact],
    ) -> Result<usize, WasmFacadeError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasmRuntimeSnapshot {
    pub active: bool,
    pub generation: Option<u32>,
    pub route_revision: u32,
    pub state: VoiceState,
    pub buffered_frames: usize,
    pub buffered_samples: usize,
    pub dropped_frames: u64,
    pub discontinuities: u64,
    pub closed: bool,
    pub capabilities: WasmCapabilities,
}

#[derive(Clone, PartialEq, Eq)]
pub struct WasmFacadeError {
    code: &'static str,
}

impl WasmFacadeError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Debug for WasmFacadeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WasmFacadeError")
            .field("code", &self.code)
            .finish()
    }
}

impl std::fmt::Display for WasmFacadeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "aurora_voice_wasm:{}", self.code)
    }
}

impl std::error::Error for WasmFacadeError {}

impl From<VoiceCoreError> for WasmFacadeError {
    fn from(error: VoiceCoreError) -> Self {
        match error {
            VoiceCoreError::Backpressure => Self::new("backpressure"),
            VoiceCoreError::BufferClosed => Self::new("buffer_closed"),
            VoiceCoreError::Cancelled => Self::new("cancelled"),
            VoiceCoreError::EmptyFrame | VoiceCoreError::SampleCountMismatch => {
                Self::new("empty_frame")
            }
            VoiceCoreError::GenerationExhausted => Self::new("generation_exhausted"),
            VoiceCoreError::InvalidIdentifier => Self::new("invalid_id"),
            VoiceCoreError::InvalidTransition => Self::new("invalid_state"),
            VoiceCoreError::LockPoisoned => Self::new("internal"),
            VoiceCoreError::NoOwnerActive => Self::new("no_session"),
            VoiceCoreError::OwnerAlreadyActive => Self::new("session_active"),
            VoiceCoreError::OwnerMismatch => Self::new("session_mismatch"),
            VoiceCoreError::SampleNotFinite | VoiceCoreError::SampleOutOfRange => {
                Self::new("invalid_audio")
            }
            VoiceCoreError::StaleGeneration => Self::new("stale_generation"),
            VoiceCoreError::TransportFault { .. } | VoiceCoreError::Engine(_) => {
                Self::new("internal")
            }
        }
    }
}

struct ActiveWasmSession {
    session_id: String,
    generation: Generation,
    route_revision: RouteRevision,
    buffer: BoundedPcmBuffer,
    next_sequence: u64,
    sample_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LoadedWasmTask {
    task: VoiceTask,
    memory_bytes: usize,
}

pub struct AuroraVoiceWasmSessionCore {
    config: WasmRuntimeConfig,
    leases: CaptureLeaseManager,
    state: VoiceStateMachine,
    active: Option<ActiveWasmSession>,
    last_route_revision: RouteRevision,
    loaded_tasks: Vec<LoadedWasmTask>,
}

impl std::fmt::Debug for AuroraVoiceWasmSessionCore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuroraVoiceWasmSessionCore")
            .field("surface", &self.config.surface)
            .field("active", &self.active.is_some())
            .field("state", &self.state.state())
            .field("generation", &self.state.generation().0)
            .field("route_revision", &self.last_route_revision.0)
            .finish()
    }
}

impl AuroraVoiceWasmSessionCore {
    pub fn new(config: WasmRuntimeConfig) -> Result<Self, WasmFacadeError> {
        validate_ascii_id(&config.surface, WASM_MAX_SURFACE_BYTES)?;
        if config.max_frames == 0
            || config.max_frames > WASM_MAX_FRAMES
            || config.max_samples == 0
            || config.max_samples > WASM_MAX_SAMPLES
        {
            return Err(WasmFacadeError::new("config_bounds"));
        }
        let mut state = VoiceStateMachine::new(config.surface.clone());
        state.transition(
            VoiceState::Idle,
            TransitionReason::Enable,
            Generation(0),
            WASM_DEFAULT_ROUTE_REVISION,
            TimestampMicros(0),
        )?;
        Ok(Self {
            config,
            leases: CaptureLeaseManager::new(),
            state,
            active: None,
            last_route_revision: WASM_DEFAULT_ROUTE_REVISION,
            loaded_tasks: Vec::new(),
        })
    }

    pub async fn initialize_task_from_store<H, I>(
        &mut self,
        store: &WebModelStore<H>,
        task: VoiceTask,
        scope: ModelStoreScope,
        manifest: &VerifiedManifest,
        runtime: &RuntimeSelection,
        initializer: &mut I,
    ) -> Result<(), WasmFacadeError>
    where
        H: WebModelStoreHost,
        I: WasmTaskInitializer,
    {
        validate_task_scope(task, scope.task()).map_err(|_| WasmFacadeError::new("task"))?;
        let selection = select_verified_variant(manifest, runtime)
            .map_err(|_| WasmFacadeError::new("selection"))?;
        let artifacts = store
            .load_active_task_artifacts(scope, manifest, &selection)
            .await
            .map_err(|_| WasmFacadeError::new("model_store"))?;
        if artifacts.is_empty() {
            return Err(WasmFacadeError::new("missing_file"));
        }
        let memory_bytes = initializer.initialize_task(task, &artifacts)?;
        let artifact_bytes = artifacts.iter().try_fold(0_usize, |total, artifact| {
            total
                .checked_add(artifact.bytes.len())
                .ok_or(WasmFacadeError::new("memory_bounds"))
        })?;
        self.unload_task(task);
        self.loaded_tasks.push(LoadedWasmTask {
            task,
            memory_bytes: memory_bytes.max(artifact_bytes),
        });
        Ok(())
    }

    pub fn unload_task(&mut self, task: VoiceTask) {
        self.loaded_tasks.retain(|loaded| loaded.task != task);
    }

    pub fn start_session(
        &mut self,
        start: WasmSessionStart,
    ) -> Result<WasmStartedSession, WasmFacadeError> {
        validate_ascii_id(&start.session_id, WASM_MAX_ID_BYTES)?;
        if self.active.is_some() {
            return Err(WasmFacadeError::new("session_active"));
        }
        let route_revision = bounded_route_revision(u64::from(start.route_revision))?;
        let now = TimestampMicros(js_safe_micros(start.at_micros)?);
        let lease = self.leases.request_start(VoiceCaptureLease {
            owner: CaptureOwnerKind::Web,
            surface: self.config.surface.clone(),
            device_route: "browser".to_owned(),
            start_reason: CaptureStartReason::PushToTalk,
            generation: Generation(0),
            created_at: now,
            route_revision,
            background_eligible: false,
            consent_revision: 0,
            heartbeat_at: now,
            stop_deadline: None,
        })?;
        if let Err(error) = self.state.transition(
            VoiceState::Arming,
            TransitionReason::PushToTalk,
            lease.generation,
            route_revision,
            now,
        ) {
            let _ = self
                .leases
                .release(&CaptureOwnerKind::Web, lease.generation);
            return Err(error.into());
        }
        if let Err(error) = self.state.transition(
            VoiceState::CapturingUtterance,
            TransitionReason::SpeechStarted,
            lease.generation,
            route_revision,
            now,
        ) {
            let _ = self
                .leases
                .release(&CaptureOwnerKind::Web, lease.generation);
            return Err(error.into());
        }
        self.last_route_revision = route_revision;
        self.active = Some(ActiveWasmSession {
            session_id: start.session_id,
            generation: lease.generation,
            route_revision,
            buffer: BoundedPcmBuffer::nonblocking_queue(
                self.config.max_frames,
                self.config.max_samples,
                lease.generation,
            ),
            next_sequence: 0,
            sample_count: 0,
        });
        Ok(WasmStartedSession {
            generation: u32_from_u64(lease.generation.0, "generation_bounds")?,
            route_revision: u32_from_u64(route_revision.0, "route_bounds")?,
            state: self.state.state(),
            sample_rate_hz: WASM_SAMPLE_RATE_HZ,
            channels: WASM_CHANNELS,
        })
    }

    pub fn push_pcm_i16(
        &mut self,
        frame: WasmPushFrame,
    ) -> Result<WasmPushReceipt, WasmFacadeError> {
        if frame.sample_rate_hz != WASM_SAMPLE_RATE_HZ || frame.channels != WASM_CHANNELS {
            return Err(WasmFacadeError::new("audio_format"));
        }
        let active = self
            .active
            .as_mut()
            .ok_or(WasmFacadeError::new("no_session"))?;
        validate_ascii_id(&frame.session_id, WASM_MAX_ID_BYTES)?;
        if active.session_id != frame.session_id {
            return Err(WasmFacadeError::new("session_mismatch"));
        }
        let generation = Generation(u64::from(frame.generation));
        if active.generation != generation || !self.leases.accepts_generation(generation) {
            return Err(WasmFacadeError::new("stale_generation"));
        }
        let sequence = u64::from(frame.sequence);
        if !frame.discontinuity && active.next_sequence != sequence {
            return Err(WasmFacadeError::new("sequence"));
        }
        if frame.samples.is_empty() {
            return Err(WasmFacadeError::new("empty_frame"));
        }
        if frame.samples.len() > WASM_MAX_FRAME_SAMPLES {
            return Err(WasmFacadeError::new("frame_bounds"));
        }
        let sample_count = active
            .sample_count
            .checked_add(frame.samples.len())
            .ok_or(WasmFacadeError::new("audio_bounds"))?;
        if sample_count > self.config.max_samples || sample_count > WASM_MAX_SAMPLES {
            return Err(WasmFacadeError::new("audio_bounds"));
        }
        let pcm = PcmFrame::from_i16(
            &frame.samples,
            TimestampMicros(js_safe_micros(frame.timestamp_micros)?),
            sequence,
            frame.discontinuity,
            active.route_revision,
            active.generation,
        )?;
        active.buffer.push(pcm)?;
        active.sample_count = sample_count;
        active.next_sequence = sequence
            .checked_add(1)
            .ok_or(WasmFacadeError::new("sequence"))?;
        let stats = active.buffer.stats()?;
        Ok(WasmPushReceipt {
            generation: u32_from_u64(active.generation.0, "generation_bounds")?,
            sequence: frame.sequence,
            buffered_frames: stats.frames,
            buffered_samples: stats.samples,
        })
    }

    pub fn stop_session(
        &mut self,
        session_id: &str,
        generation: u64,
        at_micros: u64,
    ) -> Result<WasmStoppedSession, WasmFacadeError> {
        validate_ascii_id(session_id, WASM_MAX_ID_BYTES)?;
        let active = self
            .active
            .take()
            .ok_or(WasmFacadeError::new("no_session"))?;
        if active.session_id != session_id || active.generation != Generation(generation) {
            self.active = Some(active);
            return Err(WasmFacadeError::new("session_mismatch"));
        }
        self.state.transition(
            VoiceState::Transcribing,
            TransitionReason::SpeechEnded,
            active.generation,
            active.route_revision,
            TimestampMicros(at_micros),
        )?;
        self.leases
            .release(&CaptureOwnerKind::Web, active.generation)?;
        let mut pcm_i16 = Vec::with_capacity(active.sample_count);
        let mut frame_count = 0_usize;
        while let Some(frame) = active.buffer.pop()? {
            frame_count = frame_count
                .checked_add(1)
                .ok_or(WasmFacadeError::new("audio_bounds"))?;
            for sample in frame.samples() {
                pcm_i16.push(f32_to_i16(*sample));
            }
        }
        self.state.transition(
            VoiceState::Dispatching,
            TransitionReason::Transcribed,
            active.generation,
            active.route_revision,
            TimestampMicros(at_micros),
        )?;
        Ok(WasmStoppedSession {
            generation: u32_from_u64(active.generation.0, "generation_bounds")?,
            route_revision: u32_from_u64(active.route_revision.0, "route_bounds")?,
            state: self.state.state(),
            frame_count,
            sample_count: pcm_i16.len(),
            sample_rate_hz: WASM_SAMPLE_RATE_HZ,
            channels: WASM_CHANNELS,
            pcm_i16,
        })
    }

    pub fn cancel_generation(
        &mut self,
        generation: u64,
        at_micros: u64,
    ) -> Result<(), WasmFacadeError> {
        self.cancel_matching_generation(Generation(generation), TimestampMicros(at_micros))
    }

    pub fn transition_response_ready(
        &mut self,
        generation: u64,
        at_micros: u64,
    ) -> Result<VoiceState, WasmFacadeError> {
        self.state.transition(
            VoiceState::AwaitingResponse,
            TransitionReason::Dispatched,
            Generation(generation),
            self.last_route_revision,
            TimestampMicros(at_micros),
        )?;
        Ok(self.state.state())
    }

    pub fn complete_turn(
        &mut self,
        generation: u64,
        at_micros: u64,
    ) -> Result<VoiceState, WasmFacadeError> {
        let generation = Generation(generation);
        let at = TimestampMicros(at_micros);
        match self.state.state() {
            VoiceState::Dispatching => {
                self.state.transition(
                    VoiceState::AwaitingResponse,
                    TransitionReason::Dispatched,
                    generation,
                    self.last_route_revision,
                    at,
                )?;
                self.state.transition(
                    VoiceState::Speaking,
                    TransitionReason::ResponseReady,
                    generation,
                    self.last_route_revision,
                    at,
                )?;
                self.state.transition(
                    VoiceState::Idle,
                    TransitionReason::PlaybackEnded,
                    generation,
                    self.last_route_revision,
                    at,
                )?;
            }
            VoiceState::AwaitingResponse => {
                self.state.transition(
                    VoiceState::Speaking,
                    TransitionReason::ResponseReady,
                    generation,
                    self.last_route_revision,
                    at,
                )?;
                self.state.transition(
                    VoiceState::Idle,
                    TransitionReason::PlaybackEnded,
                    generation,
                    self.last_route_revision,
                    at,
                )?;
            }
            VoiceState::Speaking => {
                self.state.transition(
                    VoiceState::Idle,
                    TransitionReason::PlaybackEnded,
                    generation,
                    self.last_route_revision,
                    at,
                )?;
            }
            VoiceState::Idle => {}
            _ => return Err(WasmFacadeError::new("invalid_state")),
        }
        Ok(self.state.state())
    }

    pub fn abandon_turn(
        &mut self,
        generation: u64,
        at_micros: u64,
    ) -> Result<VoiceState, WasmFacadeError> {
        let generation = Generation(generation);
        if generation != self.state.generation() {
            return Err(WasmFacadeError::new("stale_generation"));
        }
        let at = TimestampMicros(at_micros);
        match self.state.state() {
            VoiceState::Dispatching | VoiceState::AwaitingResponse | VoiceState::Speaking => {
                self.state
                    .cancel(generation, self.last_route_revision, at)?;
                self.state.transition(
                    VoiceState::Idle,
                    TransitionReason::Stop,
                    generation,
                    self.last_route_revision,
                    at,
                )?;
            }
            VoiceState::Idle => {}
            _ => return Err(WasmFacadeError::new("invalid_state")),
        }
        Ok(self.state.state())
    }

    pub fn snapshot(&self) -> Result<WasmRuntimeSnapshot, WasmFacadeError> {
        let (
            generation,
            buffered_frames,
            buffered_samples,
            dropped_frames,
            discontinuities,
            closed,
        ) = if let Some(active) = &self.active {
            let stats = active.buffer.stats()?;
            (
                Some(u32_from_u64(active.generation.0, "generation_bounds")?),
                stats.frames,
                stats.samples,
                stats.dropped_frames,
                stats.discontinuities,
                stats.closed,
            )
        } else {
            (None, 0, 0, 0, 0, false)
        };
        Ok(WasmRuntimeSnapshot {
            active: self.active.is_some(),
            generation,
            route_revision: u32_from_u64(self.last_route_revision.0, "route_bounds")?,
            state: self.state.state(),
            buffered_frames,
            buffered_samples,
            dropped_frames,
            discontinuities,
            closed,
            capabilities: self.capabilities(),
        })
    }

    pub fn capabilities(&self) -> WasmCapabilities {
        WasmCapabilities {
            vad: self.task_loaded(VoiceTask::VoiceActivityDetection),
            kws: self.task_loaded(VoiceTask::KeywordSpotting),
            stt: self.task_loaded(VoiceTask::SpeechToText),
            tts: self.task_loaded(VoiceTask::TextToSpeech),
        }
    }

    pub fn resource_report(&self, at_micros: u64) -> RedactedSnapshot {
        RedactedSnapshot {
            state: self.state.state(),
            generation: self.state.generation(),
            surface: self.config.surface.clone(),
            route_revision: self.last_route_revision,
            capability: self.capability_report(),
            at: TimestampMicros(at_micros),
        }
    }

    fn capability_report(&self) -> ResourceReport {
        let loaded_tasks = [
            VoiceTask::KeywordSpotting,
            VoiceTask::VoiceActivityDetection,
            VoiceTask::SpeechToText,
            VoiceTask::TextToSpeech,
        ]
        .into_iter()
        .filter(|task| self.task_loaded(*task))
        .collect::<Vec<_>>();
        ResourceReport {
            memory_bytes: self
                .loaded_tasks
                .iter()
                .map(|loaded| loaded.memory_bytes)
                .try_fold(0_u64, |total, bytes| {
                    total.checked_add(u64::try_from(bytes).unwrap_or(u64::MAX))
                })
                .unwrap_or(u64::MAX),
            active_streams: u32::from(self.active.is_some()),
            readiness: if loaded_tasks.is_empty() {
                TaskReadiness::Unavailable
            } else {
                TaskReadiness::Ready
            },
            loaded_tasks,
        }
    }

    fn task_loaded(&self, task: VoiceTask) -> bool {
        self.loaded_tasks.iter().any(|loaded| loaded.task == task)
    }

    fn cancel_matching_generation(
        &mut self,
        generation: Generation,
        at: TimestampMicros,
    ) -> Result<(), WasmFacadeError> {
        let Some(active) = self.active.take() else {
            return Ok(());
        };
        if active.generation != generation {
            self.active = Some(active);
            return Err(WasmFacadeError::new("stale_generation"));
        }
        active.buffer.close()?;
        self.leases
            .release(&CaptureOwnerKind::Web, active.generation)?;
        self.state
            .cancel(active.generation, active.route_revision, at)?;
        self.state.transition(
            VoiceState::Idle,
            TransitionReason::Stop,
            active.generation,
            active.route_revision,
            at,
        )?;
        self.last_route_revision = active.route_revision;
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct AuroraVoiceWasmRuntime {
    core: AuroraVoiceWasmSessionCore,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl AuroraVoiceWasmRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<AuroraVoiceWasmRuntime, JsValue> {
        let config = if config.is_null() || config.is_undefined() {
            WasmRuntimeConfig::default()
        } else {
            serde_wasm_bindgen::from_value(config).map_err(|_| js_error("config_shape"))?
        };
        Ok(Self {
            core: AuroraVoiceWasmSessionCore::new(config).map_err(js_facade_error)?,
        })
    }

    pub fn start_session(&mut self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: WasmSessionStart =
            serde_wasm_bindgen::from_value(request).map_err(|_| js_error("request_shape"))?;
        to_js(self.core.start_session(request))
    }

    pub fn push_pcm_i16(&mut self, frame: JsValue) -> Result<JsValue, JsValue> {
        let frame: WasmPushFrame =
            serde_wasm_bindgen::from_value(frame).map_err(|_| js_error("request_shape"))?;
        to_js(self.core.push_pcm_i16(frame))
    }

    pub fn stop_session(&mut self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: WasmStopRequest =
            serde_wasm_bindgen::from_value(request).map_err(|_| js_error("request_shape"))?;
        to_js(self.core.stop_session(
            &request.session_id,
            u64::from(request.generation),
            js_safe_micros(request.at_micros).map_err(js_facade_error)?,
        ))
    }

    pub fn cancel_generation(&mut self, request: JsValue) -> Result<(), JsValue> {
        let request: WasmGenerationRequest =
            serde_wasm_bindgen::from_value(request).map_err(|_| js_error("request_shape"))?;
        self.core
            .cancel_generation(
                u64::from(request.generation),
                js_safe_micros(request.at_micros).map_err(js_facade_error)?,
            )
            .map_err(js_facade_error)
    }

    pub fn transition_response_ready(&mut self, request: JsValue) -> Result<String, JsValue> {
        let request: WasmGenerationRequest =
            serde_wasm_bindgen::from_value(request).map_err(|_| js_error("request_shape"))?;
        self.core
            .transition_response_ready(
                u64::from(request.generation),
                js_safe_micros(request.at_micros).map_err(js_facade_error)?,
            )
            .map(|state| format!("{state:?}"))
            .map_err(js_facade_error)
    }

    pub fn complete_turn(&mut self, request: JsValue) -> Result<String, JsValue> {
        let request: WasmGenerationRequest =
            serde_wasm_bindgen::from_value(request).map_err(|_| js_error("request_shape"))?;
        self.core
            .complete_turn(
                u64::from(request.generation),
                js_safe_micros(request.at_micros).map_err(js_facade_error)?,
            )
            .map(|state| format!("{state:?}"))
            .map_err(js_facade_error)
    }

    pub fn abandon_turn(&mut self, request: JsValue) -> Result<String, JsValue> {
        let request: WasmGenerationRequest =
            serde_wasm_bindgen::from_value(request).map_err(|_| js_error("request_shape"))?;
        self.core
            .abandon_turn(
                u64::from(request.generation),
                js_safe_micros(request.at_micros).map_err(js_facade_error)?,
            )
            .map(|state| format!("{state:?}"))
            .map_err(js_facade_error)
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        to_js(self.core.snapshot())
    }

    pub fn capabilities(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.core.capabilities()).map_err(|_| js_error("serialize"))
    }

    pub fn resource_report(&self, at_micros: f64) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(
            &self
                .core
                .resource_report(js_safe_micros(at_micros).map_err(js_facade_error)?),
        )
        .map_err(|_| js_error("serialize"))
    }
}

fn default_wasm_max_frames() -> usize {
    WASM_MAX_FRAMES
}

fn default_wasm_max_samples() -> usize {
    WASM_MAX_SAMPLES
}

fn validate_ascii_id(value: &str, max_bytes: usize) -> Result<(), WasmFacadeError> {
    if value.is_empty()
        || value.len() > max_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        Err(WasmFacadeError::new("invalid_id"))
    } else {
        Ok(())
    }
}

fn bounded_route_revision(route_revision: u64) -> Result<RouteRevision, WasmFacadeError> {
    if route_revision == 0 {
        Ok(WASM_DEFAULT_ROUTE_REVISION)
    } else if route_revision > (1_u64 << 52) {
        Err(WasmFacadeError::new("route_bounds"))
    } else {
        Ok(RouteRevision(route_revision))
    }
}

fn u32_from_u64(value: u64, code: &'static str) -> Result<u32, WasmFacadeError> {
    u32::try_from(value).map_err(|_| WasmFacadeError::new(code))
}

fn js_safe_micros(value: f64) -> Result<u64, WasmFacadeError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return Err(WasmFacadeError::new("timestamp"));
    }
    if value > JS_MAX_SAFE_INTEGER_MICROS {
        return Err(WasmFacadeError::new("timestamp_bounds"));
    }
    Ok(value as u64)
}

fn f32_to_i16(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped <= -1.0 {
        i16::MIN
    } else {
        (clamped * f32::from(i16::MAX)).round() as i16
    }
}

#[cfg(target_arch = "wasm32")]
fn to_js<T: Serialize>(result: Result<T, WasmFacadeError>) -> Result<JsValue, JsValue> {
    let value = result.map_err(js_facade_error)?;
    serde_wasm_bindgen::to_value(&value).map_err(|_| js_error("serialize"))
}

#[cfg(target_arch = "wasm32")]
fn js_facade_error(error: WasmFacadeError) -> JsValue {
    js_error(error.code())
}

#[cfg(target_arch = "wasm32")]
fn js_error(code: &'static str) -> JsValue {
    JsValue::from_str(code)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct WithdrawalState {
    corrupt: BTreeSet<String>,
    revoked: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PromotionJournal {
    storage_key: String,
    pack_id: String,
    pack_version: String,
    file_id: String,
    variant_id: String,
    expected_sha256: String,
    expected_bytes: u64,
    stored_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ActivePackRecord {
    identity: ActivePackIdentity,
    files: Vec<ActiveFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ActiveFileRecord {
    storage_key: String,
    pack_id: String,
    pack_version: String,
    variant_id: String,
    file_id: String,
    sha256: String,
    byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LifecycleBackingRecord {
    files: Vec<ActiveFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ScopeMutationJournal {
    #[serde(default)]
    affected_lifecycles: BTreeSet<String>,
    restore: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ExpectedSelectionRecord {
    files: Vec<ActiveFileRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebRecoverySignal {
    Evicted,
    Recovered,
    Corrupt,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebFileStat {
    pub byte_size: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebFetchRequest {
    pub url: String,
    pub offset: u64,
    pub max_bytes: u64,
    pub timeout_millis: u64,
}

impl std::fmt::Debug for WebFetchRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebFetchRequest")
            .field("url", &"<redacted>")
            .field("offset", &self.offset)
            .field("max_bytes", &self.max_bytes)
            .field("timeout_millis", &self.timeout_millis)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebFetchedChunk {
    pub bytes: Vec<u8>,
    pub finished: bool,
}

impl std::fmt::Debug for WebFetchedChunk {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebFetchedChunk")
            .field("byte_len", &self.bytes.len())
            .field("finished", &self.finished)
            .finish()
    }
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum WebHostError {
    #[error("browser model store is unavailable")]
    Unavailable,
    #[error("browser model store quota exceeded")]
    QuotaExceeded,
    #[error("browser model store operation failed: {code}")]
    Store { code: &'static str },
    #[error("browser model download failed: {code}")]
    Network { code: &'static str },
    #[error("browser model download timed out")]
    Timeout,
    #[error("browser model download was cancelled")]
    Cancelled,
    #[error("browser model data did not match the manifest: {code}")]
    Integrity { code: &'static str },
}

impl From<WebHostError> for ModelPackError {
    fn from(error: WebHostError) -> Self {
        match error {
            WebHostError::QuotaExceeded => Self::QuotaExceeded,
            WebHostError::Cancelled => Self::Store { code: "cancelled" },
            WebHostError::Timeout => Self::Store { code: "timeout" },
            WebHostError::Unavailable => Self::Store {
                code: "unavailable",
            },
            WebHostError::Store { code }
            | WebHostError::Network { code }
            | WebHostError::Integrity { code } => Self::Store { code },
        }
    }
}

#[async_trait(?Send)]
pub trait WebModelStoreHost {
    async fn persistence_report(&self) -> Result<WebPersistenceReport, WebHostError>;
    async fn read_json(&self, key: &str) -> Result<Option<String>, WebHostError>;
    async fn write_json(&mut self, key: &str, value: &str) -> Result<(), WebHostError>;
    async fn delete_json(&mut self, key: &str) -> Result<(), WebHostError>;
    async fn list_json_keys(&self, prefix: &str) -> Result<Vec<String>, WebHostError>;
    async fn staging_len(&self, storage_key: &str) -> Result<u64, WebHostError>;
    async fn read_staging_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError>;
    async fn append_staging(
        &mut self,
        storage_key: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), WebHostError>;
    async fn clear_staging(&mut self, storage_key: &str) -> Result<(), WebHostError>;
    async fn promoted_stat(&self, storage_key: &str) -> Result<Option<WebFileStat>, WebHostError>;
    async fn read_promoted_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError>;
    async fn promote_staging_atomic(&mut self, storage_key: &str) -> Result<(), WebHostError>;
    async fn delete_promoted(&mut self, storage_key: &str) -> Result<(), WebHostError>;
    async fn list_promoted_keys(&self) -> Result<Vec<String>, WebHostError>;
    async fn remove_pack_data(&mut self, pack_id: &str) -> Result<(), WebHostError>;
}

#[async_trait(?Send)]
pub trait WebNetworkHost {
    async fn fetch_range(
        &mut self,
        request: WebFetchRequest,
        cancellation: &CancellationToken,
    ) -> Result<WebFetchedChunk, WebHostError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebDownloadPolicy {
    pub max_chunk_bytes: u64,
    pub fetch_timeout_millis: u64,
}

impl WebDownloadPolicy {
    pub fn bounded(max_chunk_bytes: u64) -> Result<Self, WebHostError> {
        if max_chunk_bytes == 0 {
            return Err(WebHostError::Store { code: "policy" });
        }
        Ok(Self {
            max_chunk_bytes,
            fetch_timeout_millis: 30_000,
        })
    }

    pub fn with_fetch_timeout_millis(mut self, timeout_millis: u64) -> Self {
        self.fetch_timeout_millis = timeout_millis;
        self
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct WebDownloadReceipt {
    pub byte_size: u64,
    pub sha256: String,
    pub resumed_from: u64,
}

impl std::fmt::Debug for WebDownloadReceipt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebDownloadReceipt")
            .field("byte_size", &self.byte_size)
            .field("sha256", &"<redacted>")
            .field("resumed_from", &self.resumed_from)
            .finish()
    }
}

#[derive(Debug)]
pub struct WebModelDownloader {
    policy: WebDownloadPolicy,
}

impl WebModelDownloader {
    pub fn new(policy: WebDownloadPolicy) -> Self {
        Self { policy }
    }

    pub async fn download<N, S, F>(
        &self,
        network: &mut N,
        store: &mut S,
        task: &DownloadTask,
        cancellation: &CancellationToken,
        mut progress: F,
    ) -> Result<WebDownloadReceipt, WebHostError>
    where
        N: WebNetworkHost,
        S: WebModelStoreHost,
        F: FnMut(u64, u64),
    {
        validate_digest(&task.expected_sha256)?;
        if task.expected_bytes == 0 {
            return Err(WebHostError::Integrity { code: "size" });
        }
        if cancellation.is_cancelled() {
            return Err(WebHostError::Cancelled);
        }

        let mut offset = store.staging_len(&task.storage_key).await?;
        if offset > task.expected_bytes {
            store.clear_staging(&task.storage_key).await?;
            offset = 0;
        }
        if offset == task.expected_bytes {
            let digest =
                hash_staging_chunks(store, &task.storage_key, self.policy.max_chunk_bytes).await?;
            if digest == task.expected_sha256 {
                progress(offset, task.expected_bytes);
                return Ok(WebDownloadReceipt {
                    byte_size: offset,
                    sha256: digest,
                    resumed_from: offset,
                });
            }
            store.clear_staging(&task.storage_key).await?;
            offset = 0;
        }

        let resumed_from = offset;
        progress(offset, task.expected_bytes);
        while offset < task.expected_bytes {
            if cancellation.is_cancelled() {
                return Err(WebHostError::Cancelled);
            }
            let remaining = task.expected_bytes.saturating_sub(offset);
            let chunk = network
                .fetch_range(
                    WebFetchRequest {
                        url: task.url.clone(),
                        offset,
                        max_bytes: remaining.min(self.policy.max_chunk_bytes),
                        timeout_millis: self.policy.fetch_timeout_millis,
                    },
                    cancellation,
                )
                .await?;
            if cancellation.is_cancelled() {
                return Err(WebHostError::Cancelled);
            }
            if chunk.bytes.is_empty() {
                return Err(WebHostError::Network { code: "empty" });
            }
            let chunk_len = u64::try_from(chunk.bytes.len())
                .map_err(|_| WebHostError::Integrity { code: "size" })?;
            let next_offset = offset
                .checked_add(chunk_len)
                .ok_or(WebHostError::Integrity { code: "size" })?;
            if next_offset > task.expected_bytes {
                store.clear_staging(&task.storage_key).await?;
                return Err(WebHostError::Integrity { code: "size" });
            }
            store
                .append_staging(&task.storage_key, offset, &chunk.bytes)
                .await?;
            offset = next_offset;
            progress(offset, task.expected_bytes);
            if chunk.finished && offset != task.expected_bytes {
                return Err(WebHostError::Integrity { code: "size" });
            }
        }

        let byte_size = store.staging_len(&task.storage_key).await?;
        if byte_size != task.expected_bytes {
            return Err(WebHostError::Integrity { code: "size" });
        }
        let sha256 =
            hash_staging_chunks(store, &task.storage_key, self.policy.max_chunk_bytes).await?;
        if sha256 != task.expected_sha256 {
            store.clear_staging(&task.storage_key).await?;
            return Err(WebHostError::Integrity { code: "hash" });
        }
        Ok(WebDownloadReceipt {
            byte_size,
            sha256,
            resumed_from,
        })
    }
}

#[derive(Debug)]
pub struct WebModelStore<H> {
    host: H,
    now: u64,
}

impl<H> WebModelStore<H> {
    pub fn new(host: H) -> Self {
        Self { host, now: 0 }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    pub fn advance_clock(&mut self, delta: u64) {
        self.now = self.now.saturating_add(delta);
    }
}

impl<H: WebModelStoreHost> WebModelStore<H> {
    pub async fn signal_recovery(
        &mut self,
        pack_id: &str,
        signal: WebRecoverySignal,
    ) -> Result<(), ModelPackError> {
        let mut state = self.withdrawal_state().await?;
        match signal {
            WebRecoverySignal::Evicted | WebRecoverySignal::Corrupt => {
                state.corrupt.insert(pack_id.to_owned());
                self.clear_active_if_pack(pack_id).await?;
            }
            WebRecoverySignal::Revoked => {
                state.revoked.insert(pack_id.to_owned());
                self.clear_active_if_pack(pack_id).await?;
            }
            WebRecoverySignal::Recovered => {
                state.corrupt.remove(pack_id);
            }
        }
        write_json(&mut self.host, WITHDRAWAL_KEY, &state).await?;
        Ok(())
    }

    async fn ensure_not_withdrawn(&self, pack_id: &str) -> Result<(), ModelPackError> {
        let state = self.withdrawal_state().await?;
        if state.corrupt.contains(pack_id) {
            return Err(ModelPackError::Store { code: "corrupt" });
        }
        if state.revoked.contains(pack_id) {
            return Err(ModelPackError::Store { code: "revoked" });
        }
        Ok(())
    }

    async fn withdrawal_state(&self) -> Result<WithdrawalState, ModelPackError> {
        Ok(read_json(&self.host, WITHDRAWAL_KEY)
            .await?
            .unwrap_or_default())
    }

    async fn clear_active_if_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        for key in self.host.list_json_keys(ACTIVE_PREFIX).await? {
            let active: Option<ActivePackRecord> = read_json(&self.host, &key).await?;
            if active
                .as_ref()
                .is_some_and(|active| active.identity.pack_id == pack_id)
            {
                self.host.delete_json(&key).await?;
            }
        }
        Ok(())
    }

    pub async fn recover_scope_transactions(&mut self) -> Result<(), ModelPackError> {
        for key in self.host.list_json_keys(MUTATION_PREFIX).await? {
            let Some(journal): Option<ScopeMutationJournal> = read_json(&self.host, &key).await?
            else {
                self.host.delete_json(&key).await?;
                continue;
            };
            restore_json(&mut self.host, journal.restore).await?;
            self.host.delete_json(&key).await?;
        }
        Ok(())
    }

    pub async fn recover_promotions(&mut self) -> Result<(), ModelPackError> {
        for key in self.host.list_json_keys(PROMOTION_PREFIX).await? {
            let Some(journal): Option<PromotionJournal> = read_json(&self.host, &key).await? else {
                continue;
            };
            let Some(stat) = self.host.promoted_stat(&journal.storage_key).await? else {
                continue;
            };
            if stat.byte_size != journal.expected_bytes {
                self.host.delete_promoted(&journal.storage_key).await?;
                self.host.delete_json(&key).await?;
                continue;
            }
            let (byte_size, sha256) =
                hash_promoted_chunks(&self.host, &journal.storage_key, HASH_CHUNK_BYTES).await?;
            if byte_size != journal.expected_bytes || sha256 != journal.expected_sha256 {
                self.host.delete_promoted(&journal.storage_key).await?;
                self.host.delete_json(&key).await?;
                continue;
            }
            let stored = StoredFile {
                storage_key: journal.storage_key.clone(),
                pack_id: journal.pack_id,
                pack_version: journal.pack_version,
                file_id: journal.file_id,
                variant_id: journal.variant_id,
                sha256,
                byte_size,
                state: InstallState::Ready,
                stored_at: journal.stored_at,
            };
            write_json(&mut self.host, &file_key(&stored.storage_key), &stored).await?;
            self.host
                .delete_json(&reservation_key(&stored.storage_key))
                .await?;
            self.host.delete_json(&key).await?;
        }
        for storage_key in self.host.list_promoted_keys().await? {
            let has_file_metadata = self
                .host
                .read_json(&file_key(&storage_key))
                .await?
                .is_some();
            let has_promotion_journal = self
                .host
                .read_json(&promotion_key(&storage_key))
                .await?
                .is_some();
            if !has_file_metadata && !has_promotion_journal {
                self.host.delete_promoted(&storage_key).await?;
            }
        }
        Ok(())
    }

    async fn active_record(
        &self,
        scope: &ModelStoreScope,
    ) -> Result<Option<ActivePackRecord>, ModelPackError> {
        let Some(record): Option<ActivePackRecord> =
            read_json(&self.host, &active_key(scope)).await?
        else {
            return Ok(None);
        };
        if record.identity.scope != *scope {
            return Ok(None);
        }
        self.ensure_not_withdrawn(&record.identity.pack_id).await?;
        if !self
            .validate_identity_file_records(&record.identity, &record.files)
            .await?
        {
            return Ok(None);
        }
        Ok(Some(record))
    }

    async fn active_elsewhere(
        &self,
        excluded_scope: &ModelStoreScope,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> Result<bool, ModelPackError> {
        let excluded_key = active_key(excluded_scope);
        for key in self.host.list_json_keys(ACTIVE_PREFIX).await? {
            if key == excluded_key {
                continue;
            }
            let Some(record): Option<ActivePackRecord> = read_json(&self.host, &key).await? else {
                continue;
            };
            if record.identity.pack_id == pack_id
                && record.identity.pack_version == pack_version
                && record.identity.variant_id == variant_id
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn validate_file_records(
        &self,
        files: &[ActiveFileRecord],
    ) -> Result<bool, ModelPackError> {
        if files.is_empty() {
            return Ok(false);
        }
        for file in files {
            let Some(stored): Option<StoredFile> =
                read_json(&self.host, &file_key(&file.storage_key)).await?
            else {
                return Ok(false);
            };
            if stored.storage_key != file.storage_key
                || stored.pack_id != file.pack_id
                || stored.pack_version != file.pack_version
                || stored.variant_id != file.variant_id
                || stored.file_id != file.file_id
                || stored.sha256 != file.sha256
                || stored.byte_size != file.byte_size
                || stored.state != InstallState::Ready
            {
                return Ok(false);
            }
            let Ok((byte_size, sha256)) =
                hash_promoted_chunks(&self.host, &file.storage_key, HASH_CHUNK_BYTES).await
            else {
                return Ok(false);
            };
            if byte_size != file.byte_size || sha256 != file.sha256 {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn validate_expected_file_records(
        &self,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
        files: &[ActiveFileRecord],
    ) -> Result<bool, ModelPackError> {
        let Some(expected): Option<ExpectedSelectionRecord> = read_json(
            &self.host,
            &expected_selection_key(pack_id, pack_version, variant_id),
        )
        .await?
        else {
            return Ok(false);
        };
        if !same_file_record_set(files, &expected.files) {
            return Ok(false);
        }
        self.validate_file_records(files).await
    }

    async fn validate_identity_file_records(
        &self,
        identity: &ActivePackIdentity,
        files: &[ActiveFileRecord],
    ) -> Result<bool, ModelPackError> {
        self.validate_expected_file_records(
            &identity.pack_id,
            &identity.pack_version,
            &identity.variant_id,
            files,
        )
        .await
    }

    async fn selected_file_records(
        &self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<Vec<ActiveFileRecord>, ModelPackError> {
        let mut records = Vec::new();
        for file_id in selection.file_ids() {
            let file = manifest
                .manifest()
                .files
                .iter()
                .find(|file| file.file_id == *file_id)
                .ok_or(ModelPackError::Store { code: "selection" })?;
            let key = file_storage_key(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
                &file.file_id,
            );
            let stored: StoredFile =
                read_json(&self.host, &file_key(&key))
                    .await?
                    .ok_or(ModelPackError::Store {
                        code: "missing_file",
                    })?;
            if !stored_matches(&stored, manifest, selection, file) {
                return Err(ModelPackError::Store { code: "corrupt" });
            }
            let (byte_size, sha256) =
                hash_promoted_chunks(&self.host, &key, HASH_CHUNK_BYTES).await?;
            if sha256 != file.sha256 || byte_size != file.byte_size {
                return Err(ModelPackError::Store { code: "corrupt" });
            }
            records.push(ActiveFileRecord {
                storage_key: key,
                pack_id: manifest.manifest().pack_id.clone(),
                pack_version: manifest.manifest().pack_version.clone(),
                variant_id: selection.variant_id().to_owned(),
                file_id: file.file_id.clone(),
                sha256,
                byte_size,
            });
        }
        Ok(records)
    }

    pub async fn load_active_task_artifacts(
        &self,
        scope: ModelStoreScope,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<Vec<WebLoadedModelArtifact>, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        validate_scope_task(&scope, manifest, selection)?;
        let Some(active) = self.active_record(&scope).await? else {
            return Err(ModelPackError::Store {
                code: "missing_active",
            });
        };
        let expected_identity = ActivePackIdentity {
            scope,
            pack_id: manifest.manifest().pack_id.clone(),
            pack_version: manifest.manifest().pack_version.clone(),
            variant_id: selection.variant_id().to_owned(),
        };
        if active.identity != expected_identity {
            return Err(ModelPackError::Store { code: "selection" });
        }
        let records = self.selected_file_records(manifest, selection).await?;
        if !same_file_record_set(&records, &active.files) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        let mut artifacts = Vec::with_capacity(records.len());
        for record in records {
            let bytes = read_promoted_file_bytes(&self.host, &record).await?;
            artifacts.push(WebLoadedModelArtifact {
                file_id: record.file_id,
                storage_key: record.storage_key,
                sha256: record.sha256,
                byte_size: record.byte_size,
                bytes,
            });
        }
        Ok(artifacts)
    }

    fn expected_file_records(
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<Vec<ActiveFileRecord>, ModelPackError> {
        let mut records = Vec::new();
        for file_id in selection.file_ids() {
            let file = manifest
                .manifest()
                .files
                .iter()
                .find(|file| file.file_id == *file_id)
                .ok_or(ModelPackError::Store { code: "selection" })?;
            records.push(ActiveFileRecord {
                storage_key: file_storage_key(
                    &manifest.manifest().pack_id,
                    &manifest.manifest().pack_version,
                    selection.variant_id(),
                    &file.file_id,
                ),
                pack_id: manifest.manifest().pack_id.clone(),
                pack_version: manifest.manifest().pack_version.clone(),
                variant_id: selection.variant_id().to_owned(),
                file_id: file.file_id.clone(),
                sha256: file.sha256.clone(),
                byte_size: file.byte_size,
            });
        }
        Ok(records)
    }

    async fn exact_ready_backing_record(
        &self,
        snapshot: &LifecycleSnapshot,
    ) -> Result<LifecycleBackingRecord, ModelPackError> {
        let Some(expected): Option<ExpectedSelectionRecord> = read_json(
            &self.host,
            &expected_selection_key(
                &snapshot.pack_id,
                &snapshot.pack_version,
                &snapshot.variant_id,
            ),
        )
        .await?
        else {
            return Err(ModelPackError::Store { code: "selection" });
        };
        if expected.files.is_empty() || !self.validate_file_records(&expected.files).await? {
            return Err(ModelPackError::Store {
                code: "missing_file",
            });
        }
        Ok(LifecycleBackingRecord {
            files: expected.files,
        })
    }

    async fn ready_backing_record(
        &self,
        snapshot: &LifecycleSnapshot,
    ) -> Result<LifecycleBackingRecord, ModelPackError> {
        let Some(backing): Option<LifecycleBackingRecord> = read_json(
            &self.host,
            &lifecycle_backing_key(
                &snapshot.pack_id,
                &snapshot.pack_version,
                &snapshot.variant_id,
            ),
        )
        .await?
        else {
            return Err(ModelPackError::Store {
                code: "missing_file",
            });
        };
        if backing.files.is_empty() || !self.validate_file_records(&backing.files).await? {
            return Err(ModelPackError::Store {
                code: "missing_file",
            });
        }
        Ok(backing)
    }

    async fn register_expected_selection(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<(), ModelPackError> {
        let files = Self::expected_file_records(manifest, selection)?;
        if files.len() != selection.file_ids().len() {
            return Err(ModelPackError::Store { code: "selection" });
        }
        write_json(
            &mut self.host,
            &expected_selection_key(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
            ),
            &ExpectedSelectionRecord { files },
        )
        .await?;
        Ok(())
    }

    async fn write_lifecycle_with_backing(
        &mut self,
        snapshot: &LifecycleSnapshot,
        files: &[ActiveFileRecord],
    ) -> Result<(), ModelPackError> {
        write_json(
            &mut self.host,
            &lifecycle_key(
                &snapshot.pack_id,
                &snapshot.pack_version,
                &snapshot.variant_id,
            ),
            snapshot,
        )
        .await?;
        if matches!(snapshot.state, InstallState::Ready | InstallState::Active) {
            write_json(
                &mut self.host,
                &lifecycle_backing_key(
                    &snapshot.pack_id,
                    &snapshot.pack_version,
                    &snapshot.variant_id,
                ),
                &LifecycleBackingRecord {
                    files: files.to_vec(),
                },
            )
            .await?;
        }
        Ok(())
    }

    async fn pending_mutation_affects_lifecycle(
        &self,
        lifecycle_key: &str,
    ) -> Result<bool, ModelPackError> {
        for key in self.host.list_json_keys(MUTATION_PREFIX).await? {
            let Some(journal): Option<ScopeMutationJournal> = read_json(&self.host, &key).await?
            else {
                return Ok(true);
            };
            if journal.affected_lifecycles.is_empty()
                || journal.affected_lifecycles.contains(lifecycle_key)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn additional_reserved_bytes(&self, task: &DownloadTask) -> Result<u64, ModelPackError> {
        for key in self.host.list_json_keys(FILE_PREFIX).await? {
            let Some(file): Option<StoredFile> = read_json(&self.host, &key).await? else {
                continue;
            };
            if file.sha256 == task.expected_sha256 {
                if file.byte_size != task.expected_bytes {
                    return Err(ModelPackError::Store { code: "quota" });
                }
                if let Ok((byte_size, sha256)) =
                    hash_promoted_chunks(&self.host, &file.storage_key, HASH_CHUNK_BYTES).await
                {
                    if byte_size == task.expected_bytes && sha256 == task.expected_sha256 {
                        return Ok(0);
                    }
                }
            }
        }
        for key in self.host.list_json_keys(RESERVED_PREFIX).await? {
            let Some(existing): Option<DownloadTask> = read_json(&self.host, &key).await? else {
                continue;
            };
            if existing.expected_sha256 == task.expected_sha256 {
                if existing.expected_bytes != task.expected_bytes {
                    return Err(ModelPackError::Store { code: "quota" });
                }
                return Ok(0);
            }
        }
        Ok(task.expected_bytes)
    }

    async fn lifecycle_has_valid_backing(
        &self,
        snapshot: &LifecycleSnapshot,
    ) -> Result<bool, ModelPackError> {
        match snapshot.state {
            InstallState::Ready => {
                let Some(backing): Option<LifecycleBackingRecord> = read_json(
                    &self.host,
                    &lifecycle_backing_key(
                        &snapshot.pack_id,
                        &snapshot.pack_version,
                        &snapshot.variant_id,
                    ),
                )
                .await?
                else {
                    return Ok(false);
                };
                self.validate_expected_file_records(
                    &snapshot.pack_id,
                    &snapshot.pack_version,
                    &snapshot.variant_id,
                    &backing.files,
                )
                .await
            }
            InstallState::Active => {
                for key in self.host.list_json_keys(ACTIVE_PREFIX).await? {
                    let Some(record): Option<ActivePackRecord> =
                        read_json(&self.host, &key).await?
                    else {
                        continue;
                    };
                    let identity_matches = record.identity.pack_id == snapshot.pack_id
                        && record.identity.pack_version == snapshot.pack_version
                        && record.identity.variant_id == snapshot.variant_id;
                    if !identity_matches {
                        continue;
                    }
                    let valid_active = self
                        .active_record(&record.identity.scope)
                        .await?
                        .is_some_and(|active| active.identity == record.identity);
                    if valid_active {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            _ => Ok(true),
        }
    }
}

#[async_trait(?Send)]
impl<H: WebModelStoreHost> ModelStore for WebModelStore<H> {
    async fn status(&self) -> Result<StoreStatus, ModelPackError> {
        Ok(self.host.persistence_report().await?.status)
    }

    async fn lifecycle(
        &self,
        pack_id: &str,
        pack_version: &str,
        variant_id: &str,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        let key = lifecycle_key(pack_id, pack_version, variant_id);
        let report = self.host.persistence_report().await?;
        if report.evicted || self.pending_mutation_affects_lifecycle(&key).await? {
            return Ok(None);
        }
        let Some(snapshot): Option<LifecycleSnapshot> = read_json(&self.host, &key).await? else {
            return Ok(None);
        };
        let withdrawal = self.withdrawal_state().await?;
        if withdrawal.corrupt.contains(pack_id) || withdrawal.revoked.contains(pack_id) {
            return Ok(None);
        }
        if self.lifecycle_has_valid_backing(&snapshot).await? {
            Ok(Some(snapshot))
        } else {
            Ok(None)
        }
    }

    async fn set_lifecycle(&mut self, snapshot: LifecycleSnapshot) -> Result<(), ModelPackError> {
        let backing = if matches!(snapshot.state, InstallState::Ready | InstallState::Active) {
            self.exact_ready_backing_record(&snapshot).await?.files
        } else {
            Vec::new()
        };
        self.write_lifecycle_with_backing(&snapshot, &backing).await
    }

    async fn reserve_file(
        &mut self,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
        file: &ModelPackFile,
    ) -> Result<DownloadTask, ModelPackError> {
        if !selection.belongs_to(manifest) || !selection.file_ids().contains(&file.file_id) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        self.register_expected_selection(manifest, selection)
            .await?;
        self.ensure_not_withdrawn(&manifest.manifest().pack_id)
            .await?;
        let status = self.status().await?;
        let storage_key = file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            &file.file_id,
        );
        let task = DownloadTask {
            storage_key: storage_key.clone(),
            pack_id: manifest.manifest().pack_id.clone(),
            pack_version: manifest.manifest().pack_version.clone(),
            file_id: file.file_id.clone(),
            url: file.url.clone(),
            expected_sha256: file.sha256.clone(),
            expected_bytes: file.byte_size,
            variant_id: selection.variant_id().to_owned(),
        };
        if let Some(existing) = self.resume_metadata(&storage_key).await? {
            if same_task(&existing, &task) {
                return Ok(existing);
            }
            return Err(ModelPackError::Store {
                code: "reservation",
            });
        }
        if let Some(stored) =
            read_json::<StoredFile, _>(&self.host, &file_key(&storage_key)).await?
        {
            if stored_matches(&stored, manifest, selection, file) {
                return Ok(task);
            }
            return Err(ModelPackError::Store { code: "corrupt" });
        }
        if let Some(available) = status.bytes_available {
            let additional = self.additional_reserved_bytes(&task).await?;
            let required = status
                .bytes_used
                .checked_add(status.bytes_reserved)
                .and_then(|used| used.checked_add(additional))
                .ok_or(ModelPackError::QuotaExceeded)?;
            if required > available {
                return Err(ModelPackError::QuotaExceeded);
            }
        }
        write_json(&mut self.host, &reservation_key(&storage_key), &task).await?;
        Ok(task)
    }

    async fn resume_metadata(
        &self,
        storage_key: &str,
    ) -> Result<Option<DownloadTask>, ModelPackError> {
        read_json(&self.host, &reservation_key(storage_key)).await
    }

    async fn promote_file(
        &mut self,
        storage_key: &str,
        sha256: &str,
        byte_size: u64,
    ) -> Result<StoredFile, ModelPackError> {
        let task: DownloadTask = read_json(&self.host, &reservation_key(storage_key))
            .await?
            .ok_or(ModelPackError::Store {
                code: "reservation",
            })?;
        if task.expected_sha256 != sha256 {
            return Err(ModelPackError::Store { code: "hash" });
        }
        if task.expected_bytes != byte_size {
            return Err(ModelPackError::Store { code: "size" });
        }
        self.ensure_not_withdrawn(&task.pack_id).await?;
        let journal = PromotionJournal {
            storage_key: storage_key.to_owned(),
            pack_id: task.pack_id,
            pack_version: task.pack_version,
            file_id: task.file_id,
            variant_id: task.variant_id,
            stored_at: self.now,
            expected_sha256: sha256.to_owned(),
            expected_bytes: byte_size,
        };
        write_json(&mut self.host, &promotion_key(storage_key), &journal).await?;
        self.host.promote_staging_atomic(storage_key).await?;
        let (actual_bytes, actual_hash) =
            hash_promoted_chunks(&self.host, storage_key, HASH_CHUNK_BYTES).await?;
        if actual_bytes != byte_size || actual_hash != sha256 {
            self.host.delete_promoted(storage_key).await?;
            return Err(ModelPackError::Store { code: "hash" });
        }
        let stored = StoredFile {
            storage_key: storage_key.to_owned(),
            pack_id: journal.pack_id,
            pack_version: journal.pack_version,
            file_id: journal.file_id,
            variant_id: journal.variant_id,
            sha256: actual_hash,
            byte_size: actual_bytes,
            state: InstallState::Ready,
            stored_at: journal.stored_at,
        };
        write_json(&mut self.host, &file_key(storage_key), &stored).await?;
        self.host.delete_json(&reservation_key(storage_key)).await?;
        self.host.delete_json(&promotion_key(storage_key)).await?;
        Ok(stored)
    }

    async fn activate_pack(
        &mut self,
        scope: ModelStoreScope,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
    ) -> Result<LifecycleSnapshot, ModelPackError> {
        if !selection.belongs_to(manifest) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        validate_scope_task(&scope, manifest, selection)?;
        self.recover_scope_transactions().await?;
        self.recover_promotions().await?;
        self.ensure_not_withdrawn(&manifest.manifest().pack_id)
            .await?;
        let active_files = self.selected_file_records(manifest, selection).await?;
        self.register_expected_selection(manifest, selection)
            .await?;

        let current_key = lifecycle_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
        );
        let current = self
            .lifecycle(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
            )
            .await?
            .unwrap_or_else(|| {
                create_lifecycle_snapshot(
                    manifest.manifest().pack_id.clone(),
                    manifest.manifest().pack_version.clone(),
                    selection.variant_id().to_owned(),
                    self.now,
                    InstallState::Ready,
                )
            });
        if !matches!(current.state, InstallState::Ready | InstallState::Active) {
            return Err(ModelPackError::Store { code: "not_ready" });
        }
        let next = if current.state == InstallState::Active {
            current
        } else {
            apply_lifecycle_event(&current, InstallEvent::Activate, self.now, None)?
        };
        let previous_record = self.active_record(&scope).await?;
        let previous_active = previous_record.as_ref().map(|record| &record.identity);
        let mut restore = BTreeMap::new();
        let active_key = active_key(&scope);
        let rollback_key = rollback_key(&scope);
        restore.insert(active_key.clone(), self.host.read_json(&active_key).await?);
        restore.insert(
            rollback_key.clone(),
            self.host.read_json(&rollback_key).await?,
        );
        restore.insert(
            current_key.clone(),
            self.host.read_json(&current_key).await?,
        );
        let mut affected_lifecycles = BTreeSet::from([current_key.clone()]);
        restore.insert(
            lifecycle_backing_key(
                &manifest.manifest().pack_id,
                &manifest.manifest().pack_version,
                selection.variant_id(),
            ),
            self.host
                .read_json(&lifecycle_backing_key(
                    &manifest.manifest().pack_id,
                    &manifest.manifest().pack_version,
                    selection.variant_id(),
                ))
                .await?,
        );
        if let Some(active) = previous_active.as_ref() {
            let key = lifecycle_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(key.clone(), self.host.read_json(&key).await?);
            affected_lifecycles.insert(key);
            let backing_key =
                lifecycle_backing_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(
                backing_key.clone(),
                self.host.read_json(&backing_key).await?,
            );
        }
        let previous_snapshot = if let Some(active) = previous_active {
            self.lifecycle(&active.pack_id, &active.pack_version, &active.variant_id)
                .await?
        } else {
            None
        };

        let result: Result<(), ModelPackError> = async {
            write_json(
                &mut self.host,
                &mutation_key(&scope),
                &ScopeMutationJournal {
                    affected_lifecycles: affected_lifecycles.clone(),
                    restore: restore.clone(),
                },
            )
            .await?;
            if let Some(active) = previous_active {
                if active.pack_id != manifest.manifest().pack_id
                    || active.pack_version != manifest.manifest().pack_version
                    || active.variant_id != selection.variant_id()
                {
                    if let Some(record) = previous_record.as_ref() {
                        write_json(&mut self.host, &rollback_key, record).await?;
                    }
                    if let Some(snapshot) = previous_snapshot.clone() {
                        if !self
                            .active_elsewhere(
                                &scope,
                                &active.pack_id,
                                &active.pack_version,
                                &active.variant_id,
                            )
                            .await?
                        {
                            let deactivated = apply_lifecycle_event(
                                &snapshot,
                                InstallEvent::Deactivate,
                                self.now,
                                None,
                            )?;
                            let backing = self.ready_backing_record(&deactivated).await?.files;
                            self.write_lifecycle_with_backing(&deactivated, &backing)
                                .await?;
                        }
                    }
                }
            }
            self.write_lifecycle_with_backing(&next, &active_files)
                .await?;
            write_json(
                &mut self.host,
                &active_key,
                &ActivePackRecord {
                    identity: ActivePackIdentity {
                        scope: scope.clone(),
                        pack_id: next.pack_id.clone(),
                        pack_version: next.pack_version.clone(),
                        variant_id: selection.variant_id().to_owned(),
                    },
                    files: active_files,
                },
            )
            .await?;
            self.host.delete_json(&mutation_key(&scope)).await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            if restore_json(&mut self.host, restore).await.is_ok() {
                let _ = self.host.delete_json(&mutation_key(&scope)).await;
            }
            return Err(error);
        }
        Ok(next)
    }

    async fn rollback_active(
        &mut self,
        scope: ModelStoreScope,
    ) -> Result<Option<LifecycleSnapshot>, ModelPackError> {
        self.recover_scope_transactions().await?;
        let Some(rollback_record): Option<ActivePackRecord> =
            read_json(&self.host, &rollback_key(&scope)).await?
        else {
            return Ok(None);
        };
        let rollback = rollback_record.identity.clone();
        self.ensure_not_withdrawn(&rollback.pack_id).await?;
        if rollback.scope != scope
            || !self
                .validate_identity_file_records(&rollback, &rollback_record.files)
                .await?
        {
            return Err(ModelPackError::Store { code: "rollback" });
        }
        let active_key = active_key(&scope);
        let rollback_key = rollback_key(&scope);
        let mut restore = BTreeMap::new();
        restore.insert(active_key.clone(), self.host.read_json(&active_key).await?);
        restore.insert(
            rollback_key.clone(),
            self.host.read_json(&rollback_key).await?,
        );
        restore.insert(
            lifecycle_key(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            ),
            self.host
                .read_json(&lifecycle_key(
                    &rollback.pack_id,
                    &rollback.pack_version,
                    &rollback.variant_id,
                ))
                .await?,
        );
        let mut affected_lifecycles = BTreeSet::from([lifecycle_key(
            &rollback.pack_id,
            &rollback.pack_version,
            &rollback.variant_id,
        )]);
        restore.insert(
            lifecycle_backing_key(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            ),
            self.host
                .read_json(&lifecycle_backing_key(
                    &rollback.pack_id,
                    &rollback.pack_version,
                    &rollback.variant_id,
                ))
                .await?,
        );
        if let Some(active) = self
            .active_record(&scope)
            .await?
            .map(|record| record.identity)
        {
            let active_lifecycle_key =
                lifecycle_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(
                active_lifecycle_key.clone(),
                self.host.read_json(&active_lifecycle_key).await?,
            );
            affected_lifecycles.insert(active_lifecycle_key);
            let active_backing_key =
                lifecycle_backing_key(&active.pack_id, &active.pack_version, &active.variant_id);
            restore.insert(
                active_backing_key.clone(),
                self.host.read_json(&active_backing_key).await?,
            );
        }
        let current_identity = self
            .active_record(&scope)
            .await?
            .map(|record| record.identity);
        let current_snapshot = if let Some(active) = current_identity.as_ref() {
            self.lifecycle(&active.pack_id, &active.pack_version, &active.variant_id)
                .await?
        } else {
            None
        };
        let rollback_snapshot = self
            .lifecycle(
                &rollback.pack_id,
                &rollback.pack_version,
                &rollback.variant_id,
            )
            .await?
            .ok_or(ModelPackError::Store { code: "rollback" })?;

        let result: Result<LifecycleSnapshot, ModelPackError> = async {
            write_json(
                &mut self.host,
                &mutation_key(&scope),
                &ScopeMutationJournal {
                    affected_lifecycles: affected_lifecycles.clone(),
                    restore: restore.clone(),
                },
            )
            .await?;
            if let Some(active) = current_identity {
                if let Some(snapshot) = current_snapshot {
                    if !self
                        .active_elsewhere(
                            &scope,
                            &active.pack_id,
                            &active.pack_version,
                            &active.variant_id,
                        )
                        .await?
                    {
                        let ready = apply_lifecycle_event(
                            &snapshot,
                            InstallEvent::Deactivate,
                            self.now,
                            None,
                        )?;
                        let backing = self.ready_backing_record(&ready).await?.files;
                        self.write_lifecycle_with_backing(&ready, &backing).await?;
                    }
                }
            }
            let active = if rollback_snapshot.state == InstallState::Active {
                rollback_snapshot
            } else {
                apply_lifecycle_event(&rollback_snapshot, InstallEvent::Activate, self.now, None)?
            };
            self.write_lifecycle_with_backing(&active, &rollback_record.files)
                .await?;
            write_json(&mut self.host, &active_key, &rollback_record).await?;
            self.host.delete_json(&rollback_key).await?;
            self.host.delete_json(&mutation_key(&scope)).await?;
            Ok(active)
        }
        .await;
        match result {
            Ok(active) => Ok(Some(active)),
            Err(error) => {
                if restore_json(&mut self.host, restore).await.is_ok() {
                    let _ = self.host.delete_json(&mutation_key(&scope)).await;
                }
                Err(error)
            }
        }
    }

    async fn remove_pack(&mut self, pack_id: &str) -> Result<(), ModelPackError> {
        self.recover_scope_transactions().await?;
        self.host.remove_pack_data(pack_id).await?;
        self.clear_active_if_pack(pack_id).await?;
        for key in self.host.list_json_keys(ROLLBACK_PREFIX).await? {
            let rollback: Option<ActivePackRecord> = read_json(&self.host, &key).await?;
            if rollback
                .as_ref()
                .is_some_and(|record| record.identity.pack_id == pack_id)
            {
                self.host.delete_json(&key).await?;
            }
        }
        let mut withdrawal = self.withdrawal_state().await?;
        withdrawal.corrupt.remove(pack_id);
        withdrawal.revoked.remove(pack_id);
        write_json(&mut self.host, WITHDRAWAL_KEY, &withdrawal).await?;
        Ok(())
    }

    async fn active_pack(
        &self,
        scope: ModelStoreScope,
    ) -> Result<Option<ActivePackIdentity>, ModelPackError> {
        if self.host.persistence_report().await?.evicted
            || self.host.read_json(&mutation_key(&scope)).await?.is_some()
        {
            return Ok(None);
        }
        Ok(self
            .active_record(&scope)
            .await?
            .map(|record| record.identity))
    }

    async fn open_immutable_file(
        &self,
        selection: &SelectedVariant,
        file_id: &str,
    ) -> Result<ImmutableModelFile, ModelPackError> {
        if !selection.file_ids().contains(file_id) {
            return Err(ModelPackError::Store { code: "selection" });
        }
        if self.host.persistence_report().await?.evicted {
            return Err(ModelPackError::Store { code: "evicted" });
        }
        self.ensure_not_withdrawn(selection.pack_id()).await?;
        let storage_key = file_storage_key(
            selection.pack_id(),
            selection.pack_version(),
            selection.variant_id(),
            file_id,
        );
        let stored: StoredFile = read_json(&self.host, &file_key(&storage_key))
            .await?
            .ok_or(ModelPackError::Store {
                code: "missing_file",
            })?;
        if stored.pack_id != selection.pack_id()
            || stored.pack_version != selection.pack_version()
            || stored.variant_id != selection.variant_id()
            || stored.file_id != file_id
        {
            return Err(ModelPackError::Store { code: "selection" });
        }
        let (byte_size, sha256) =
            hash_promoted_chunks(&self.host, &storage_key, HASH_CHUNK_BYTES).await?;
        if stored.byte_size != byte_size || stored.sha256 != sha256 {
            return Err(ModelPackError::Store { code: "corrupt" });
        }
        Ok(ImmutableModelFile {
            storage_key: stored.storage_key,
            sha256: stored.sha256,
            byte_size: stored.byte_size,
            variant_id: stored.variant_id,
        })
    }
}

#[derive(Clone)]
pub struct InMemoryWebHost {
    bytes_available: Option<u64>,
    persistent: bool,
    kind: BrowserPersistenceKind,
    evicted: bool,
    json: BTreeMap<String, String>,
    staging: BTreeMap<String, Vec<u8>>,
    files: BTreeMap<String, Vec<u8>>,
    fail_next_write: bool,
    fail_next_write_after_promote: bool,
    max_read_request: Cell<u64>,
}

impl std::fmt::Debug for InMemoryWebHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InMemoryWebHost")
            .field("bytes_available", &self.bytes_available)
            .field("persistent", &self.persistent)
            .field("kind", &self.kind)
            .field("evicted", &self.evicted)
            .field("json_entries", &self.json.len())
            .field("staging_entries", &self.staging.len())
            .field("file_entries", &self.files.len())
            .field("max_read_request", &self.max_read_request.get())
            .finish()
    }
}

impl InMemoryWebHost {
    pub fn new(bytes_available: Option<u64>) -> Self {
        Self {
            bytes_available,
            persistent: true,
            kind: BrowserPersistenceKind::OpfsPreferred,
            evicted: false,
            json: BTreeMap::new(),
            staging: BTreeMap::new(),
            files: BTreeMap::new(),
            fail_next_write: false,
            fail_next_write_after_promote: false,
            max_read_request: Cell::new(0),
        }
    }

    pub fn indexed_db_fallback(mut self) -> Self {
        self.kind = BrowserPersistenceKind::IndexedDbFallback;
        self
    }

    pub fn set_evicted(&mut self, evicted: bool) {
        self.evicted = evicted;
    }

    pub fn fail_next_write(&mut self) {
        self.fail_next_write = true;
    }

    pub fn fail_next_write_after_promote(&mut self) {
        self.fail_next_write_after_promote = true;
    }

    pub fn insert_json(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.json.insert(key.into(), value.into());
    }

    pub fn insert_promoted(&mut self, storage_key: impl Into<String>, bytes: Vec<u8>) {
        self.files.insert(storage_key.into(), bytes);
    }

    pub fn forge_stored_file(&mut self, storage_key: &str, stored: &StoredFile) {
        if let Ok(value) = serde_json::to_string(stored) {
            self.json.insert(file_key(storage_key), value);
        }
    }

    pub fn max_observed_read_request(&self) -> u64 {
        self.max_read_request.get()
    }

    pub fn promoted_contains(&self, storage_key: &str) -> bool {
        self.files.contains_key(storage_key)
    }

    fn maybe_fail(&mut self) -> Result<(), WebHostError> {
        if self.fail_next_write {
            self.fail_next_write = false;
            Err(WebHostError::Store {
                code: "persistence",
            })
        } else {
            Ok(())
        }
    }

    fn used_bytes(&self) -> Result<u64, WebHostError> {
        let mut seen_hashes = BTreeMap::new();
        let mut total = 0_u64;
        for bytes in self.files.values() {
            let hash = sha256_hex(bytes);
            let len =
                u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
            if let Some(previous) = seen_hashes.insert(hash, len) {
                if previous != len {
                    return Err(WebHostError::Store { code: "quota" });
                }
            } else {
                total = total.checked_add(len).ok_or(WebHostError::QuotaExceeded)?;
            }
        }
        Ok(total)
    }

    fn reserved_bytes(&self) -> Result<u64, WebHostError> {
        let mut promoted_hashes = BTreeMap::new();
        for bytes in self.files.values() {
            let hash = sha256_hex(bytes);
            let len =
                u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
            promoted_hashes.insert(hash, len);
        }
        let mut seen_reservations = BTreeMap::new();
        let mut total = 0_u64;
        for task in self
            .json
            .iter()
            .filter(|(key, _)| key.starts_with(RESERVED_PREFIX))
            .filter_map(|(_, value)| serde_json::from_str::<DownloadTask>(value).ok())
        {
            if let Some(promoted_size) = promoted_hashes.get(&task.expected_sha256) {
                if *promoted_size != task.expected_bytes {
                    return Err(WebHostError::Store { code: "quota" });
                }
                continue;
            }
            if let Some(previous_size) =
                seen_reservations.insert(task.expected_sha256.clone(), task.expected_bytes)
            {
                if previous_size != task.expected_bytes {
                    return Err(WebHostError::Store { code: "quota" });
                }
                continue;
            }
            total = total
                .checked_add(task.expected_bytes)
                .ok_or(WebHostError::QuotaExceeded)?;
        }
        Ok(total)
    }
}

#[async_trait(?Send)]
impl WebModelStoreHost for InMemoryWebHost {
    async fn persistence_report(&self) -> Result<WebPersistenceReport, WebHostError> {
        Ok(WebPersistenceReport {
            status: StoreStatus {
                bytes_used: self.used_bytes()?,
                bytes_reserved: self.reserved_bytes()?,
                bytes_available: self.bytes_available,
                persistent: self.persistent,
            },
            kind: self.kind,
            evicted: self.evicted,
        })
    }

    async fn read_json(&self, key: &str) -> Result<Option<String>, WebHostError> {
        Ok(self.json.get(key).cloned())
    }

    async fn write_json(&mut self, key: &str, value: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.json.insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    async fn delete_json(&mut self, key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.json.remove(key);
        Ok(())
    }

    async fn list_json_keys(&self, prefix: &str) -> Result<Vec<String>, WebHostError> {
        Ok(self
            .json
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect())
    }

    async fn staging_len(&self, storage_key: &str) -> Result<u64, WebHostError> {
        Ok(self
            .staging
            .get(storage_key)
            .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
            .unwrap_or(0))
    }

    async fn read_staging_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError> {
        self.max_read_request
            .set(self.max_read_request.get().max(max_bytes));
        read_chunk(self.staging.get(storage_key), offset, max_bytes)
    }

    async fn append_staging(
        &mut self,
        storage_key: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let expected_offset = self
            .staging
            .get(storage_key)
            .map(|current| u64::try_from(current.len()).unwrap_or(u64::MAX))
            .unwrap_or(0);
        if expected_offset != offset {
            return Err(WebHostError::Store { code: "resume" });
        }
        let additional =
            u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
        if let Some(available) = self.bytes_available {
            let reservation: Option<DownloadTask> = self
                .json
                .get(&reservation_key(storage_key))
                .and_then(|value| serde_json::from_str(value).ok());
            let unreserved_additional = if let Some(task) = reservation {
                let staged_after = offset
                    .checked_add(additional)
                    .ok_or(WebHostError::QuotaExceeded)?;
                if staged_after > task.expected_bytes {
                    return Err(WebHostError::Store { code: "size" });
                }
                0
            } else {
                additional
            };
            let required = self
                .used_bytes()?
                .checked_add(self.reserved_bytes()?)
                .and_then(|used| used.checked_add(unreserved_additional))
                .ok_or(WebHostError::QuotaExceeded)?;
            if required > available {
                return Err(WebHostError::QuotaExceeded);
            }
        }
        let current = self.staging.entry(storage_key.to_owned()).or_default();
        current.extend_from_slice(bytes);
        Ok(())
    }

    async fn clear_staging(&mut self, storage_key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.staging.remove(storage_key);
        Ok(())
    }

    async fn promoted_stat(&self, storage_key: &str) -> Result<Option<WebFileStat>, WebHostError> {
        Ok(self.files.get(storage_key).map(|bytes| WebFileStat {
            byte_size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        }))
    }

    async fn read_promoted_chunk(
        &self,
        storage_key: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<WebFetchedChunk, WebHostError> {
        self.max_read_request
            .set(self.max_read_request.get().max(max_bytes));
        read_chunk(self.files.get(storage_key), offset, max_bytes)
    }

    async fn promote_staging_atomic(&mut self, storage_key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let bytes = self
            .staging
            .remove(storage_key)
            .ok_or(WebHostError::Store { code: "staging" })?;
        self.files.insert(storage_key.to_owned(), bytes);
        if self.fail_next_write_after_promote {
            self.fail_next_write_after_promote = false;
            self.fail_next_write = true;
        }
        Ok(())
    }

    async fn delete_promoted(&mut self, storage_key: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        self.files.remove(storage_key);
        Ok(())
    }

    async fn list_promoted_keys(&self) -> Result<Vec<String>, WebHostError> {
        Ok(self.files.keys().cloned().collect())
    }

    async fn remove_pack_data(&mut self, pack_id: &str) -> Result<(), WebHostError> {
        self.maybe_fail()?;
        let mut storage_keys = BTreeSet::new();
        let metadata_keys: BTreeSet<String> = self
            .json
            .iter()
            .filter_map(|(key, value)| {
                if key.starts_with(FILE_PREFIX) {
                    if let Ok(file) = serde_json::from_str::<StoredFile>(value) {
                        if file.pack_id == pack_id {
                            storage_keys.insert(file.storage_key);
                            return Some(key.clone());
                        }
                    }
                }
                if key.starts_with(RESERVED_PREFIX) || key.starts_with(PROMOTION_PREFIX) {
                    if let Ok(task) = serde_json::from_str::<DownloadTask>(value) {
                        if task.pack_id == pack_id {
                            storage_keys.insert(task.storage_key);
                            return Some(key.clone());
                        }
                    }
                    if let Ok(journal) = serde_json::from_str::<PromotionJournal>(value) {
                        if journal.pack_id == pack_id {
                            storage_keys.insert(journal.storage_key);
                            return Some(key.clone());
                        }
                    }
                }
                if key.starts_with(LIFECYCLE_PREFIX) {
                    return serde_json::from_str::<LifecycleSnapshot>(value)
                        .ok()
                        .filter(|snapshot| snapshot.pack_id == pack_id)
                        .map(|_| key.clone());
                }
                if key.starts_with(LIFECYCLE_BACKING_PREFIX)
                    && serde_json::from_str::<LifecycleBackingRecord>(value)
                        .ok()
                        .is_some_and(|record| {
                            record.files.iter().any(|file| file.pack_id == pack_id)
                        })
                {
                    return Some(key.clone());
                }
                if key.starts_with(EXPECTED_SELECTION_PREFIX)
                    && serde_json::from_str::<ExpectedSelectionRecord>(value)
                        .ok()
                        .is_some_and(|record| {
                            record.files.iter().any(|file| file.pack_id == pack_id)
                        })
                {
                    return Some(key.clone());
                }
                None
            })
            .collect();
        for key in metadata_keys {
            self.json.remove(&key);
        }
        self.staging.retain(|key, _| !storage_keys.contains(key));
        self.files.retain(|key, _| !storage_keys.contains(key));
        Ok(())
    }
}

fn read_chunk(
    bytes: Option<&Vec<u8>>,
    offset: u64,
    max_bytes: u64,
) -> Result<WebFetchedChunk, WebHostError> {
    let bytes = bytes.ok_or(WebHostError::Store {
        code: "missing_file",
    })?;
    if max_bytes == 0 {
        return Err(WebHostError::Store { code: "policy" });
    }
    let offset = usize::try_from(offset).map_err(|_| WebHostError::Integrity { code: "size" })?;
    let max_bytes =
        usize::try_from(max_bytes).map_err(|_| WebHostError::Integrity { code: "size" })?;
    if offset > bytes.len() {
        return Err(WebHostError::Store { code: "range" });
    }
    let end = offset.saturating_add(max_bytes).min(bytes.len());
    Ok(WebFetchedChunk {
        bytes: bytes[offset..end].to_vec(),
        finished: end == bytes.len(),
    })
}

#[derive(Clone)]
pub struct InMemoryNetworkHost {
    assets: BTreeMap<String, Vec<u8>>,
    chunk_limit: usize,
    fail_after_chunks: Option<usize>,
    timeout_next: bool,
    cancel_next: bool,
    cancel_after_start: bool,
    chunks_served: usize,
}

impl std::fmt::Debug for InMemoryNetworkHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InMemoryNetworkHost")
            .field("asset_count", &self.assets.len())
            .field("chunk_limit", &self.chunk_limit)
            .field("fail_after_chunks", &self.fail_after_chunks)
            .field("timeout_next", &self.timeout_next)
            .field("cancel_next", &self.cancel_next)
            .field("cancel_after_start", &self.cancel_after_start)
            .field("chunks_served", &self.chunks_served)
            .finish()
    }
}

impl InMemoryNetworkHost {
    pub fn new(chunk_limit: usize) -> Self {
        Self {
            assets: BTreeMap::new(),
            chunk_limit: chunk_limit.max(1),
            fail_after_chunks: None,
            timeout_next: false,
            cancel_next: false,
            cancel_after_start: false,
            chunks_served: 0,
        }
    }

    pub fn insert(&mut self, url: impl Into<String>, bytes: Vec<u8>) {
        self.assets.insert(url.into(), bytes);
    }

    pub fn fail_after_chunks(&mut self, chunks: usize) {
        self.fail_after_chunks = Some(chunks);
    }

    pub fn clear_failure(&mut self) {
        self.fail_after_chunks = None;
        self.timeout_next = false;
        self.cancel_next = false;
        self.cancel_after_start = false;
    }

    pub fn timeout_next(&mut self) {
        self.timeout_next = true;
    }

    pub fn cancel_next(&mut self) {
        self.cancel_next = true;
    }

    pub fn cancel_after_start(&mut self) {
        self.cancel_after_start = true;
    }

    pub fn chunks_served(&self) -> usize {
        self.chunks_served
    }
}

#[async_trait(?Send)]
impl WebNetworkHost for InMemoryNetworkHost {
    async fn fetch_range(
        &mut self,
        request: WebFetchRequest,
        cancellation: &CancellationToken,
    ) -> Result<WebFetchedChunk, WebHostError> {
        if request.timeout_millis == 0 || self.timeout_next {
            self.timeout_next = false;
            return Err(WebHostError::Timeout);
        }
        if self.cancel_next || cancellation.is_cancelled() {
            self.cancel_next = false;
            return Err(WebHostError::Cancelled);
        }
        if self.cancel_after_start {
            self.cancel_after_start = false;
            cancellation.cancel();
            return Err(WebHostError::Cancelled);
        }
        if self
            .fail_after_chunks
            .is_some_and(|limit| self.chunks_served >= limit)
        {
            return Err(WebHostError::Network {
                code: "interrupted",
            });
        }
        let asset = self
            .assets
            .get(&request.url)
            .ok_or(WebHostError::Network { code: "missing" })?;
        let offset = usize::try_from(request.offset)
            .map_err(|_| WebHostError::Integrity { code: "size" })?;
        if offset > asset.len() {
            return Err(WebHostError::Network { code: "range" });
        }
        let requested = usize::try_from(request.max_bytes)
            .unwrap_or(usize::MAX)
            .min(self.chunk_limit);
        let end = offset.saturating_add(requested).min(asset.len());
        self.chunks_served = self.chunks_served.saturating_add(1);
        Ok(WebFetchedChunk {
            bytes: asset[offset..end].to_vec(),
            finished: end == asset.len(),
        })
    }
}

async fn read_json<T: DeserializeOwned, H: WebModelStoreHost>(
    host: &H,
    key: &str,
) -> Result<Option<T>, ModelPackError> {
    host.read_json(key)
        .await?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| ModelPackError::Store { code: "metadata" })
        })
        .transpose()
}

async fn write_json<T: Serialize, H: WebModelStoreHost>(
    host: &mut H,
    key: &str,
    value: &T,
) -> Result<(), ModelPackError> {
    let value =
        serde_json::to_string(value).map_err(|_| ModelPackError::Store { code: "metadata" })?;
    host.write_json(key, &value).await?;
    Ok(())
}

async fn restore_json<H: WebModelStoreHost>(
    host: &mut H,
    restore: BTreeMap<String, Option<String>>,
) -> Result<(), WebHostError> {
    for (key, value) in restore {
        if let Some(value) = value {
            host.write_json(&key, &value).await?;
        } else {
            host.delete_json(&key).await?;
        }
    }
    Ok(())
}

async fn hash_staging_chunks<H: WebModelStoreHost>(
    host: &H,
    storage_key: &str,
    max_chunk_bytes: u64,
) -> Result<String, WebHostError> {
    let len = host.staging_len(storage_key).await?;
    let (_count, digest) = hash_chunks(len, max_chunk_bytes, |offset, max_bytes| async move {
        host.read_staging_chunk(storage_key, offset, max_bytes)
            .await
    })
    .await?;
    Ok(digest)
}

async fn hash_promoted_chunks<H: WebModelStoreHost>(
    host: &H,
    storage_key: &str,
    max_chunk_bytes: u64,
) -> Result<(u64, String), WebHostError> {
    let stat = host
        .promoted_stat(storage_key)
        .await?
        .ok_or(WebHostError::Store {
            code: "missing_file",
        })?;
    let (count, digest) = hash_chunks(
        stat.byte_size,
        max_chunk_bytes,
        |offset, max_bytes| async move {
            host.read_promoted_chunk(storage_key, offset, max_bytes)
                .await
        },
    )
    .await?;
    Ok((count, digest))
}

async fn read_promoted_file_bytes<H: WebModelStoreHost>(
    host: &H,
    record: &ActiveFileRecord,
) -> Result<Vec<u8>, WebHostError> {
    let mut bytes = Vec::with_capacity(
        usize::try_from(record.byte_size).map_err(|_| WebHostError::Integrity { code: "size" })?,
    );
    let mut hasher = Sha256::new();
    let mut offset = 0_u64;
    while offset < record.byte_size {
        let remaining = record.byte_size.saturating_sub(offset);
        let chunk = host
            .read_promoted_chunk(&record.storage_key, offset, remaining.min(HASH_CHUNK_BYTES))
            .await?;
        if chunk.bytes.is_empty() {
            return Err(WebHostError::Store { code: "chunk" });
        }
        let len = u64::try_from(chunk.bytes.len())
            .map_err(|_| WebHostError::Integrity { code: "size" })?;
        let next = offset
            .checked_add(len)
            .ok_or(WebHostError::Integrity { code: "size" })?;
        if next > record.byte_size {
            return Err(WebHostError::Integrity { code: "size" });
        }
        hasher.update(&chunk.bytes);
        bytes.extend_from_slice(&chunk.bytes);
        offset = next;
    }
    let byte_size =
        u64::try_from(bytes.len()).map_err(|_| WebHostError::Integrity { code: "size" })?;
    if byte_size != record.byte_size || encode_hex(&hasher.finalize()) != record.sha256 {
        return Err(WebHostError::Integrity { code: "hash" });
    }
    Ok(bytes)
}

async fn hash_chunks<F, Fut>(
    byte_size: u64,
    max_chunk_bytes: u64,
    mut read: F,
) -> Result<(u64, String), WebHostError>
where
    F: FnMut(u64, u64) -> Fut,
    Fut: std::future::Future<Output = Result<WebFetchedChunk, WebHostError>>,
{
    if max_chunk_bytes == 0 {
        return Err(WebHostError::Store { code: "policy" });
    }
    let mut hasher = Sha256::new();
    let mut offset = 0_u64;
    while offset < byte_size {
        let remaining = byte_size.saturating_sub(offset);
        let chunk = read(offset, remaining.min(max_chunk_bytes)).await?;
        if chunk.bytes.is_empty() {
            return Err(WebHostError::Store { code: "chunk" });
        }
        let len = u64::try_from(chunk.bytes.len())
            .map_err(|_| WebHostError::Integrity { code: "size" })?;
        let next = offset
            .checked_add(len)
            .ok_or(WebHostError::Integrity { code: "size" })?;
        if next > byte_size {
            return Err(WebHostError::Integrity { code: "size" });
        }
        hasher.update(&chunk.bytes);
        offset = next;
    }
    Ok((offset, encode_hex(&hasher.finalize())))
}

fn lifecycle_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    tuple_key(LIFECYCLE_PREFIX, pack_id, pack_version, variant_id)
}

fn lifecycle_backing_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    tuple_key(LIFECYCLE_BACKING_PREFIX, pack_id, pack_version, variant_id)
}

fn expected_selection_key(pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    tuple_key(EXPECTED_SELECTION_PREFIX, pack_id, pack_version, variant_id)
}

fn tuple_key(prefix: &str, pack_id: &str, pack_version: &str, variant_id: &str) -> String {
    format!(
        "{prefix}{}",
        lifecycle_storage_key(pack_id, pack_version, variant_id)
    )
}

fn active_key(scope: &ModelStoreScope) -> String {
    format!(
        "{ACTIVE_PREFIX}{}:{}",
        scope.task().as_str(),
        scope.slot_id()
    )
}

fn rollback_key(scope: &ModelStoreScope) -> String {
    format!(
        "{ROLLBACK_PREFIX}{}:{}",
        scope.task().as_str(),
        scope.slot_id()
    )
}

fn mutation_key(scope: &ModelStoreScope) -> String {
    format!(
        "{MUTATION_PREFIX}{}:{}",
        scope.task().as_str(),
        scope.slot_id()
    )
}

fn reservation_key(storage_key: &str) -> String {
    format!("{RESERVED_PREFIX}{storage_key}")
}

fn promotion_key(storage_key: &str) -> String {
    format!("{PROMOTION_PREFIX}{storage_key}")
}

fn file_key(storage_key: &str) -> String {
    format!("{FILE_PREFIX}{storage_key}")
}

fn same_task(left: &DownloadTask, right: &DownloadTask) -> bool {
    left.storage_key == right.storage_key
        && left.pack_id == right.pack_id
        && left.pack_version == right.pack_version
        && left.file_id == right.file_id
        && left.expected_sha256 == right.expected_sha256
        && left.expected_bytes == right.expected_bytes
        && left.variant_id == right.variant_id
}

fn same_file_record_set(left: &[ActiveFileRecord], right: &[ActiveFileRecord]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let left: BTreeMap<&str, &ActiveFileRecord> = left
        .iter()
        .map(|file| (file.storage_key.as_str(), file))
        .collect();
    let right: BTreeMap<&str, &ActiveFileRecord> = right
        .iter()
        .map(|file| (file.storage_key.as_str(), file))
        .collect();
    left == right
}

fn validate_scope_task(
    scope: &ModelStoreScope,
    manifest: &VerifiedManifest,
    selection: &SelectedVariant,
) -> Result<(), ModelPackError> {
    let manifest_advertises_task = manifest
        .manifest()
        .tasks
        .iter()
        .any(|task| *task == scope.task());
    let selected_has_primary_task = manifest
        .manifest()
        .files
        .iter()
        .any(|file| selection.file_ids().contains(&file.file_id) && file.task == scope.task());
    if manifest_advertises_task && selected_has_primary_task {
        Ok(())
    } else {
        Err(ModelPackError::Store { code: "task" })
    }
}

fn validate_task_scope(task: VoiceTask, pack_task: PackTask) -> Result<(), ModelPackError> {
    match task {
        VoiceTask::KeywordSpotting if matches!(pack_task, PackTask::Kws | PackTask::Wakeword) => {
            Ok(())
        }
        VoiceTask::VoiceActivityDetection if pack_task == PackTask::Vad => Ok(()),
        VoiceTask::SpeechToText if pack_task == PackTask::Stt => Ok(()),
        VoiceTask::TextToSpeech if pack_task == PackTask::Tts => Ok(()),
        _ => Err(ModelPackError::Store { code: "task" }),
    }
}

fn stored_matches(
    stored: &StoredFile,
    manifest: &VerifiedManifest,
    selection: &SelectedVariant,
    file: &ModelPackFile,
) -> bool {
    stored.storage_key
        == file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            &file.file_id,
        )
        && stored.pack_id == manifest.manifest().pack_id
        && stored.pack_version == manifest.manifest().pack_version
        && stored.variant_id == selection.variant_id()
        && stored.file_id == file.file_id
        && stored.sha256 == file.sha256
        && stored.byte_size == file.byte_size
        && stored.state == InstallState::Ready
}

fn validate_digest(value: &str) -> Result<(), WebHostError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(WebHostError::Integrity { code: "hash" })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    encode_hex(&hasher.finalize())
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[cfg(test)]
mod wasm_facade_tests {
    use super::*;
    use aurora_voice_engine::{
        verify_manifest, AbiRequirements, CapabilityFlags, Compatibility, CompressionKind,
        DeviceClass, EngineKind, LanguageSupport, LicenseGrant, LicenseInfo, ManifestSignature,
        ModelPackManifest, ModelPackVariant, ProcessingMetadata, Provenance, ResourceBudget,
        RuntimeGates, RuntimeTarget, ShapeMetadata, SignatureVerifier, TargetArch, TargetOs,
        TrustPolicy,
    };

    fn runtime() -> AuroraVoiceWasmSessionCore {
        AuroraVoiceWasmSessionCore::new(WasmRuntimeConfig {
            surface: "hosted-web".to_owned(),
            max_frames: 8,
            max_samples: 32_000,
        })
        .expect("runtime")
    }

    fn start(runtime: &mut AuroraVoiceWasmSessionCore) -> WasmStartedSession {
        runtime
            .start_session(WasmSessionStart {
                session_id: "session-1".to_owned(),
                route_revision: 7,
                at_micros: 10.0,
            })
            .expect("start")
    }

    fn frame(generation: u32, sequence: u32, samples: Vec<i16>) -> WasmPushFrame {
        WasmPushFrame {
            session_id: "session-1".to_owned(),
            generation,
            sequence,
            timestamp_micros: f64::from(20_u32.saturating_add(sequence)),
            discontinuity: false,
            sample_rate_hz: WASM_SAMPLE_RATE_HZ,
            channels: WASM_CHANNELS,
            samples,
        }
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

    #[derive(Default)]
    struct RecordingInitializer {
        loaded: Vec<(VoiceTask, Vec<String>, Vec<Vec<u8>>)>,
    }

    impl WasmTaskInitializer for RecordingInitializer {
        fn initialize_task(
            &mut self,
            task: VoiceTask,
            artifacts: &[WebLoadedModelArtifact],
        ) -> Result<usize, WasmFacadeError> {
            if artifacts.is_empty() {
                return Err(WasmFacadeError::new("missing_file"));
            }
            self.loaded.push((
                task,
                artifacts
                    .iter()
                    .map(|artifact| artifact.file_id.clone())
                    .collect(),
                artifacts
                    .iter()
                    .map(|artifact| artifact.bytes.clone())
                    .collect(),
            ));
            artifacts.iter().try_fold(0_usize, |total, artifact| {
                total
                    .checked_add(artifact.bytes.len())
                    .ok_or(WasmFacadeError::new("memory_bounds"))
            })
        }
    }

    fn test_scope(task: PackTask) -> ModelStoreScope {
        ModelStoreScope::default_for_task(task)
    }

    fn web_runtime_selection() -> RuntimeSelection {
        RuntimeSelection {
            target: RuntimeTarget::Web,
            os: TargetOs::Web,
            arch: TargetArch::Wasm32,
            browser_features: BTreeSet::new(),
            device_memory_mb: Some(4096),
            max_download_bytes: u64::MAX,
            max_installed_bytes: u64::MAX,
            max_memory_bytes: u64::MAX,
            cpu_threads: 4,
            max_rtf_millis_per_second: 1_000,
            device_class: DeviceClass::Balanced,
            require_interoperable: false,
        }
    }

    fn test_model_file(file_id: &str, task: PackTask, bytes: &[u8]) -> ModelPackFile {
        ModelPackFile {
            file_id: file_id.to_owned(),
            asset_id: file_id.to_owned(),
            task,
            byte_size: u64::try_from(bytes.len()).expect("test bytes fit"),
            sha256: sha256_hex(bytes),
            url: format!("/models/{file_id}"),
            compression: CompressionKind::None,
            installed_size: u64::try_from(bytes.len()).expect("test bytes fit"),
            install_order: 0,
            dependencies: Vec::new(),
            license: LicenseInfo {
                identifier: "Apache-2.0".to_owned(),
                text_url: "https://example.test/license".to_owned(),
                text_sha256: sha256_hex(b"license"),
                commercial_use: true,
                redistribution: LicenseGrant::RedistributionAllowed,
                attribution: "Aurora".to_owned(),
            },
            provenance: Provenance {
                upstream_source: "https://example.test/source".to_owned(),
                upstream_revision: "rev1".to_owned(),
                build_recipe_sha256: sha256_hex(b"recipe"),
            },
            processing: ProcessingMetadata {
                tokenizer_sha256: None,
                operator_inventory_sha256: sha256_hex(b"ops"),
                preprocessing_abi: "pre".to_owned(),
                postprocessing_abi: "post".to_owned(),
                shapes: ShapeMetadata {
                    sample_rate_hz: 16_000,
                    channels: 1,
                    frame_size: 512,
                    window_size: 1024,
                    cache_state: vec!["hidden".to_owned()],
                },
            },
            raven: None,
            revocation: None,
        }
    }

    fn test_variant(file_id: &str, size: u64) -> ModelPackVariant {
        ModelPackVariant {
            variant_id: "wasm".to_owned(),
            target: RuntimeTarget::Web,
            os: TargetOs::Web,
            arch: TargetArch::Wasm32,
            engine: EngineKind::SherpaOnnx,
            required_browser_features: Vec::new(),
            min_device_memory_mb: None,
            runtime_gates: RuntimeGates {
                min_cpu_threads: 1,
                max_rtf_millis_per_second: 1_000,
                min_device_class: DeviceClass::Low,
            },
            resource_budget: ResourceBudget {
                max_download_bytes: size,
                max_installed_bytes: size,
                max_memory_bytes: 1024,
            },
            compatibility: Compatibility {
                group_id: "group".to_owned(),
                voice_state_group_id: "voice-state".to_owned(),
                preprocessing_abi: "pre".to_owned(),
                postprocessing_abi: "post".to_owned(),
                sample_rate_hz: 16_000,
                channels: 1,
                frame_size: 512,
                interoperable: false,
            },
            file_ids: vec![file_id.to_owned()],
            abi: AbiRequirements {
                min_aurora_version: "1".to_owned(),
                min_runtime_version: "1".to_owned(),
                min_engine_version: "1".to_owned(),
                engine_source_revision: "rev".to_owned(),
                build_flags: Vec::new(),
            },
            revocation: None,
        }
    }

    fn test_manifest(task: PackTask, bytes: &[u8]) -> VerifiedManifest {
        let file = test_model_file("model", task, bytes);
        let raw = ModelPackManifest {
            schema_version: 1,
            pack_id: format!("test-{}", task.as_str()),
            pack_version: "1".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![task],
            license: file.license.clone(),
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
            provenance: file.provenance.clone(),
            files: vec![file.clone()],
            variants: vec![test_variant(&file.file_id, file.byte_size)],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        };
        verify_manifest(raw, &TrustPolicy::default(), Some(&AcceptingVerifier))
            .expect("manifest verifies")
    }

    async fn install_active_pack(
        store: &mut WebModelStore<InMemoryWebHost>,
        manifest: &VerifiedManifest,
        selection: &SelectedVariant,
        task: PackTask,
        bytes: &[u8],
    ) {
        let file = manifest
            .manifest()
            .files
            .iter()
            .find(|file| file.file_id == "model")
            .expect("model file");
        let download = store
            .reserve_file(manifest, selection, file)
            .await
            .expect("reserve");
        store
            .host_mut()
            .append_staging(&download.storage_key, 0, bytes)
            .await
            .expect("stage");
        store
            .promote_file(
                &download.storage_key,
                &sha256_hex(bytes),
                u64::try_from(bytes.len()).expect("test bytes fit"),
            )
            .await
            .expect("promote");
        store
            .activate_pack(test_scope(task), manifest, selection)
            .await
            .expect("activate");
    }

    #[test]
    fn maps_generation_exhaustion_to_stable_redacted_code() {
        assert_eq!(
            WasmFacadeError::from(VoiceCoreError::GenerationExhausted).code(),
            "generation_exhausted"
        );
    }

    #[test]
    fn rejects_overlapping_sessions_and_preserves_active_session() {
        let mut runtime = runtime();
        let started = start(&mut runtime);
        let err = runtime
            .start_session(WasmSessionStart {
                session_id: "session-2".to_owned(),
                route_revision: 7,
                at_micros: 11.0,
            })
            .expect_err("overlap should fail");
        assert_eq!(err.code(), "session_active");
        assert_eq!(
            runtime.snapshot().expect("snapshot").generation,
            Some(started.generation)
        );
    }

    #[test]
    fn requires_exact_generation_session_and_sequence() {
        let mut runtime = runtime();
        let started = start(&mut runtime);
        assert_eq!(
            runtime
                .push_pcm_i16(frame(started.generation + 1, 0, vec![1, 2]))
                .expect_err("stale generation")
                .code(),
            "stale_generation"
        );
        let mut wrong_session = frame(started.generation, 0, vec![1, 2]);
        wrong_session.session_id = "session-2".to_owned();
        assert_eq!(
            runtime
                .push_pcm_i16(wrong_session)
                .expect_err("session mismatch")
                .code(),
            "session_mismatch"
        );
        assert_eq!(
            runtime
                .push_pcm_i16(frame(started.generation, 1, vec![1, 2]))
                .expect_err("sequence gap")
                .code(),
            "sequence"
        );
        runtime
            .push_pcm_i16(frame(started.generation, 0, vec![1, 2]))
            .expect("first frame");
        assert_eq!(
            runtime
                .push_pcm_i16(frame(started.generation, 0, vec![3, 4]))
                .expect_err("duplicate sequence")
                .code(),
            "sequence"
        );
    }

    #[test]
    fn enforces_audio_format_and_total_bounds() {
        let mut runtime = AuroraVoiceWasmSessionCore::new(WasmRuntimeConfig {
            surface: "web".to_owned(),
            max_frames: 8,
            max_samples: 4,
        })
        .expect("runtime");
        let started = runtime
            .start_session(WasmSessionStart {
                session_id: "session-1".to_owned(),
                route_revision: 1,
                at_micros: 0.0,
            })
            .expect("start");
        let mut wrong_rate = frame(started.generation, 0, vec![1]);
        wrong_rate.sample_rate_hz = 8_000;
        assert_eq!(
            runtime.push_pcm_i16(wrong_rate).expect_err("format").code(),
            "audio_format"
        );
        runtime
            .push_pcm_i16(frame(started.generation, 0, vec![1, 2, 3, 4]))
            .expect("within bounds");
        assert_eq!(
            runtime
                .push_pcm_i16(frame(started.generation, 1, vec![5]))
                .expect_err("bounds")
                .code(),
            "audio_bounds"
        );
    }

    #[test]
    fn caps_each_pcm_frame_at_forty_eight_hundred_samples() {
        let mut runtime = AuroraVoiceWasmSessionCore::new(WasmRuntimeConfig {
            surface: "web".to_owned(),
            max_frames: 8,
            max_samples: 16_000,
        })
        .expect("runtime");
        let started = runtime
            .start_session(WasmSessionStart {
                session_id: "session-1".to_owned(),
                route_revision: 1,
                at_micros: 0.0,
            })
            .expect("start");
        runtime
            .push_pcm_i16(frame(
                started.generation,
                0,
                vec![0; WASM_MAX_FRAME_SAMPLES],
            ))
            .expect("4800 sample frame");
        assert_eq!(
            runtime
                .push_pcm_i16(frame(
                    started.generation,
                    1,
                    vec![0; WASM_MAX_FRAME_SAMPLES + 1],
                ))
                .expect_err("4801 sample frame")
                .code(),
            "frame_bounds"
        );
    }

    #[test]
    fn stop_returns_exact_bounded_pcm_and_metadata() {
        let mut runtime = runtime();
        let started = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(started.generation, 0, vec![i16::MIN, 0, i16::MAX]))
            .expect("first frame");
        runtime
            .push_pcm_i16(frame(started.generation, 1, vec![42]))
            .expect("second frame");
        let stopped = runtime
            .stop_session("session-1", u64::from(started.generation), 30)
            .expect("stop");
        assert_eq!(stopped.generation, started.generation);
        assert_eq!(stopped.route_revision, 7);
        assert_eq!(stopped.frame_count, 2);
        assert_eq!(stopped.sample_count, 4);
        assert_eq!(stopped.pcm_i16, vec![i16::MIN, 0, i16::MAX, 42]);
        assert!(!runtime.snapshot().expect("snapshot").active);
    }

    #[test]
    fn cancel_erases_pcm_and_rejects_post_cancel_stop() {
        let mut runtime = runtime();
        let started = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(started.generation, 0, vec![7, 8, 9]))
            .expect("frame");
        runtime
            .cancel_generation(u64::from(started.generation), 40)
            .expect("cancel");
        let snapshot = runtime.snapshot().expect("snapshot");
        assert!(!snapshot.active);
        assert_eq!(snapshot.buffered_samples, 0);
        assert_eq!(
            runtime
                .stop_session("session-1", u64::from(started.generation), 41)
                .expect_err("no post-cancel result")
                .code(),
            "no_session"
        );
        let restarted = start(&mut runtime);
        assert!(restarted.generation > started.generation);
    }

    #[test]
    fn discontinuity_is_recoverable_and_resets_sequence_expectation() {
        let mut runtime = runtime();
        let started = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(started.generation, 0, vec![1]))
            .expect("first frame");
        let mut discontinuous = frame(started.generation, 0, vec![2, 3]);
        discontinuous.discontinuity = true;
        runtime.push_pcm_i16(discontinuous).expect("discontinuity");
        let snapshot = runtime.snapshot().expect("snapshot");
        assert!(snapshot.active);
        assert_eq!(snapshot.discontinuities, 1);
        runtime
            .push_pcm_i16(frame(started.generation, 1, vec![4]))
            .expect("sequence follows reset marker");
    }

    #[test]
    fn lifecycle_state_advances_to_remote_response_wait() {
        let mut runtime = runtime();
        let started = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(started.generation, 0, vec![1, 2]))
            .expect("frame");
        let stopped = runtime
            .stop_session("session-1", u64::from(started.generation), 30)
            .expect("stop");
        assert_eq!(stopped.state, VoiceState::Dispatching);
        let state = runtime
            .transition_response_ready(u64::from(started.generation), 31)
            .expect("response wait");
        assert_eq!(state, VoiceState::AwaitingResponse);
    }

    #[test]
    fn complete_turn_returns_to_idle_and_allows_repeat_turn() {
        let mut runtime = runtime();
        let first = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(first.generation, 0, vec![1, 2]))
            .expect("first frame");
        runtime
            .stop_session("session-1", u64::from(first.generation), 30)
            .expect("first stop");
        assert_eq!(
            runtime
                .start_session(WasmSessionStart {
                    session_id: "session-2".to_owned(),
                    route_revision: 7,
                    at_micros: 31.0,
                })
                .expect_err("dispatching is not idle")
                .code(),
            "invalid_state"
        );
        assert_eq!(
            runtime
                .complete_turn(u64::from(first.generation), 32)
                .expect("complete"),
            VoiceState::Idle
        );
        let second = runtime
            .start_session(WasmSessionStart {
                session_id: "session-2".to_owned(),
                route_revision: 8,
                at_micros: 33.0,
            })
            .expect("second start");
        assert!(second.generation > first.generation);
        assert_eq!(second.state, VoiceState::CapturingUtterance);
    }

    #[test]
    fn abandon_turn_cancels_pending_turn_to_idle_and_allows_repeat_start() {
        let mut runtime = runtime();
        let first = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(first.generation, 0, vec![1, 2]))
            .expect("first frame");
        runtime
            .stop_session("session-1", u64::from(first.generation), 30)
            .expect("first stop");
        assert_eq!(
            runtime
                .abandon_turn(u64::from(first.generation), 31)
                .expect("abandon"),
            VoiceState::Idle
        );
        let transitions = runtime.state.transitions();
        assert_eq!(
            transitions[transitions.len() - 2].reason,
            TransitionReason::Cancel
        );
        assert_eq!(transitions[transitions.len() - 2].to, VoiceState::Stopping);
        assert_eq!(
            transitions[transitions.len() - 1].reason,
            TransitionReason::Stop
        );
        assert_eq!(transitions[transitions.len() - 1].to, VoiceState::Idle);
        let second = runtime
            .start_session(WasmSessionStart {
                session_id: "session-2".to_owned(),
                route_revision: 8,
                at_micros: 32.0,
            })
            .expect("second start");
        assert!(second.generation > first.generation);
    }

    #[test]
    fn abandon_turn_rejects_stale_generation_and_redacts_error() {
        let mut runtime = runtime();
        let first = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(first.generation, 0, vec![123, 456]))
            .expect("frame");
        runtime
            .stop_session("session-1", u64::from(first.generation), 30)
            .expect("stop");
        let err = runtime
            .abandon_turn(u64::from(first.generation + 1), 31)
            .expect_err("stale abandon");
        assert_eq!(err.code(), "stale_generation");
        let rendered = format!("{err:?}");
        assert!(!rendered.contains("123"));
        assert!(!rendered.contains("456"));
        assert_eq!(
            runtime.snapshot().expect("snapshot").state,
            VoiceState::Dispatching
        );
    }

    #[test]
    fn abandon_turn_is_idempotent_only_for_current_idle_generation() {
        let mut runtime = runtime();
        let first = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(first.generation, 0, vec![1, 2]))
            .expect("frame");
        runtime
            .stop_session("session-1", u64::from(first.generation), 30)
            .expect("stop");
        runtime
            .abandon_turn(u64::from(first.generation), 31)
            .expect("first abandon");
        assert_eq!(
            runtime
                .abandon_turn(u64::from(first.generation), 32)
                .expect("matching idle abandon"),
            VoiceState::Idle
        );
        assert_eq!(
            runtime
                .abandon_turn(u64::from(first.generation + 1), 33)
                .expect_err("stale idle abandon")
                .code(),
            "stale_generation"
        );
    }

    #[test]
    fn abandon_turn_accepts_current_epoch_microsecond_timestamps() {
        let mut runtime = runtime();
        let epoch_micros = 1_786_102_400_123_000.0;
        let first = runtime
            .start_session(WasmSessionStart {
                session_id: "session-1".to_owned(),
                route_revision: 7,
                at_micros: epoch_micros,
            })
            .expect("start");
        runtime
            .push_pcm_i16(WasmPushFrame {
                session_id: "session-1".to_owned(),
                generation: first.generation,
                sequence: 0,
                timestamp_micros: epoch_micros + 1.0,
                discontinuity: false,
                sample_rate_hz: WASM_SAMPLE_RATE_HZ,
                channels: WASM_CHANNELS,
                samples: vec![1, 2],
            })
            .expect("frame");
        runtime
            .stop_session(
                "session-1",
                u64::from(first.generation),
                epoch_micros as u64 + 2,
            )
            .expect("stop");
        assert_eq!(
            runtime
                .abandon_turn(u64::from(first.generation), epoch_micros as u64 + 3)
                .expect("abandon"),
            VoiceState::Idle
        );
    }

    #[test]
    fn default_frame_bound_accepts_sixty_seconds_of_twenty_millisecond_frames() {
        let mut runtime =
            AuroraVoiceWasmSessionCore::new(WasmRuntimeConfig::default()).expect("default runtime");
        let started = runtime
            .start_session(WasmSessionStart {
                session_id: "session-1".to_owned(),
                route_revision: 1,
                at_micros: 0.0,
            })
            .expect("start");
        for sequence in 0..3_000_u32 {
            runtime
                .push_pcm_i16(frame(started.generation, sequence, vec![0; 320]))
                .expect("20ms frame");
        }
        let snapshot = runtime.snapshot().expect("snapshot");
        assert_eq!(snapshot.buffered_frames, 3_000);
        assert_eq!(snapshot.buffered_samples, WASM_MAX_SAMPLES);
        assert_eq!(
            runtime
                .push_pcm_i16(frame(started.generation, 3_000, vec![0]))
                .expect_err("past 60 seconds")
                .code(),
            "audio_bounds"
        );
    }

    #[test]
    fn snapshots_reports_errors_and_debug_are_redacted() {
        let mut runtime = runtime();
        let started = start(&mut runtime);
        runtime
            .push_pcm_i16(frame(started.generation, 0, vec![321, 654]))
            .expect("frame");
        let frame_debug = format!(
            "{:?}",
            frame(started.generation, 1, vec![111, 222, 333, 444])
        );
        assert!(frame_debug.contains("sample_count"));
        assert!(!frame_debug.contains("111"));
        assert!(!frame_debug.contains("session-1"));
        let stopped = runtime
            .stop_session("session-1", u64::from(started.generation + 99), 99)
            .expect_err("mismatch");
        assert_eq!(format!("{stopped}"), "aurora_voice_wasm:session_mismatch");
        let snapshot = runtime.snapshot().expect("snapshot");
        let json = serde_json::to_string(&snapshot).expect("json");
        assert!(!json.contains("session-1"));
        assert!(!json.contains("321"));
        assert!(!json.contains("654"));
    }

    #[test]
    fn accepts_large_js_safe_microsecond_timestamps_without_u32_rollover() {
        let large_micros = 1_786_102_400_123_000.0;
        let mut runtime = runtime();
        let started = runtime
            .start_session(WasmSessionStart {
                session_id: "session-1".to_owned(),
                route_revision: 1,
                at_micros: large_micros,
            })
            .expect("large timestamp start");
        runtime
            .push_pcm_i16(WasmPushFrame {
                session_id: "session-1".to_owned(),
                generation: started.generation,
                sequence: 0,
                timestamp_micros: large_micros + 4_500_000_000.0,
                discontinuity: false,
                sample_rate_hz: WASM_SAMPLE_RATE_HZ,
                channels: WASM_CHANNELS,
                samples: vec![1, 2],
            })
            .expect("large timestamp frame");
        let stopped = runtime
            .stop_session(
                "session-1",
                u64::from(started.generation),
                large_micros as u64 + 1,
            )
            .expect("large timestamp stop");
        assert_eq!(stopped.sample_count, 2);
    }

    #[test]
    fn rejects_non_safe_js_timestamp_values() {
        assert_eq!(
            js_safe_micros(-1.0).expect_err("negative").code(),
            "timestamp"
        );
        assert_eq!(
            js_safe_micros(1.5).expect_err("fractional").code(),
            "timestamp"
        );
        assert_eq!(
            js_safe_micros(f64::NAN).expect_err("nan").code(),
            "timestamp"
        );
        assert_eq!(
            js_safe_micros(JS_MAX_SAFE_INTEGER_MICROS + 2.0)
                .expect_err("too large")
                .code(),
            "timestamp_bounds"
        );
    }

    #[test]
    fn capabilities_remain_false_until_task_artifacts_initialize() {
        let runtime = runtime();
        assert_eq!(
            runtime.capabilities(),
            WasmCapabilities {
                vad: false,
                kws: false,
                stt: false,
                tts: false
            }
        );
        let report = runtime.resource_report(50);
        assert!(report.capability.loaded_tasks.is_empty());
        assert_eq!(report.capability.memory_bytes, 0);
        assert_eq!(report.capability.active_streams, 0);
        assert_eq!(report.capability.readiness, TaskReadiness::Unavailable);
    }

    #[tokio::test]
    async fn wasm_task_readiness_requires_loading_selected_active_artifacts() {
        let bytes = b"stt-model-bytes";
        let manifest = test_manifest(PackTask::Stt, bytes);
        let runtime_selection = web_runtime_selection();
        let selection =
            select_verified_variant(&manifest, &runtime_selection).expect("selection resolves");
        let mut store = WebModelStore::new(InMemoryWebHost::new(Some(4096)));
        install_active_pack(&mut store, &manifest, &selection, PackTask::Stt, bytes).await;
        let mut runtime = runtime();
        let mut initializer = RecordingInitializer::default();

        runtime
            .initialize_task_from_store(
                &store,
                VoiceTask::SpeechToText,
                test_scope(PackTask::Stt),
                &manifest,
                &runtime_selection,
                &mut initializer,
            )
            .await
            .expect("initialize from active artifacts");

        assert_eq!(initializer.loaded.len(), 1);
        assert_eq!(initializer.loaded[0].0, VoiceTask::SpeechToText);
        assert_eq!(initializer.loaded[0].1, vec!["model".to_owned()]);
        assert_eq!(initializer.loaded[0].2, vec![bytes.to_vec()]);
        assert_eq!(
            runtime.capabilities(),
            WasmCapabilities {
                vad: false,
                kws: false,
                stt: true,
                tts: false
            }
        );
        let report = runtime.resource_report(51);
        assert_eq!(
            report.capability.loaded_tasks,
            vec![VoiceTask::SpeechToText]
        );
        assert_eq!(
            report.capability.memory_bytes,
            u64::try_from(bytes.len()).expect("test bytes fit")
        );
        assert_eq!(report.capability.readiness, TaskReadiness::Ready);
    }

    #[tokio::test]
    async fn wasm_task_readiness_fails_closed_for_corrupt_active_artifacts() {
        let bytes = b"stt-model-bytes";
        let manifest = test_manifest(PackTask::Stt, bytes);
        let runtime_selection = web_runtime_selection();
        let selection =
            select_verified_variant(&manifest, &runtime_selection).expect("selection resolves");
        let mut store = WebModelStore::new(InMemoryWebHost::new(Some(4096)));
        install_active_pack(&mut store, &manifest, &selection, PackTask::Stt, bytes).await;
        let storage_key = file_storage_key(
            &manifest.manifest().pack_id,
            &manifest.manifest().pack_version,
            selection.variant_id(),
            "model",
        );
        store
            .host_mut()
            .insert_promoted(storage_key, b"corrupt".to_vec());
        let mut runtime = runtime();
        let mut initializer = RecordingInitializer::default();

        assert_eq!(
            runtime
                .initialize_task_from_store(
                    &store,
                    VoiceTask::SpeechToText,
                    test_scope(PackTask::Stt),
                    &manifest,
                    &runtime_selection,
                    &mut initializer,
                )
                .await
                .expect_err("corrupt active artifacts")
                .code(),
            "model_store"
        );
        assert!(initializer.loaded.is_empty());
        assert!(!runtime.capabilities().stt);
        assert_eq!(
            runtime.resource_report(52).capability.readiness,
            TaskReadiness::Unavailable
        );
    }

    #[test]
    fn rejects_non_ascii_or_oversized_ids_without_leaking_values() {
        let err = AuroraVoiceWasmSessionCore::new(WasmRuntimeConfig {
            surface: "web\nhidden".to_owned(),
            max_frames: 8,
            max_samples: 32,
        })
        .expect_err("surface");
        assert_eq!(err.code(), "invalid_id");
        assert!(!format!("{err:?}").contains("web"));
        let mut runtime = runtime();
        let err = runtime
            .start_session(WasmSessionStart {
                session_id: "session with spaces".to_owned(),
                route_revision: 1,
                at_micros: 0.0,
            })
            .expect_err("id");
        assert_eq!(err.code(), "invalid_id");
        assert!(!format!("{err:?}").contains("spaces"));
    }
}
