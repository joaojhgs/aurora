//! Platform-independent speech-engine ports.

#![forbid(unsafe_code)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Engine task families the shared runtime can request without choosing a
/// concrete inference backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceTask {
    KeywordSpotting,
    VoiceActivityDetection,
    SpeechToText,
    TextToSpeech,
}

/// High-level task readiness, independent of platform storage details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskReadiness {
    Cold,
    Warming,
    Ready,
    Unavailable,
}

/// Capability metadata that is safe to expose in product state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCapability {
    pub task: VoiceTask,
    pub languages: Vec<String>,
    pub sample_rate_hz: u32,
    pub streaming: bool,
    pub local_only: bool,
}

impl TaskCapability {
    pub fn new(task: VoiceTask, sample_rate_hz: u32) -> Self {
        Self {
            task,
            languages: Vec::new(),
            sample_rate_hz,
            streaming: false,
            local_only: true,
        }
    }

    pub fn with_languages(
        mut self,
        languages: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.languages = languages.into_iter().map(Into::into).collect();
        self
    }

    pub fn streaming(mut self, streaming: bool) -> Self {
        self.streaming = streaming;
        self
    }
}

/// Current resource use report for one engine provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceReport {
    pub loaded_tasks: Vec<VoiceTask>,
    pub memory_bytes: u64,
    pub active_streams: u32,
    pub readiness: TaskReadiness,
}

impl Default for ResourceReport {
    fn default() -> Self {
        Self {
            loaded_tasks: Vec::new(),
            memory_bytes: 0,
            active_streams: 0,
            readiness: TaskReadiness::Cold,
        }
    }
}

/// A cancellable provider request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequest {
    pub task: VoiceTask,
    pub language: Option<String>,
    pub generation: u64,
}

/// Provider errors must stay product-safe and exclude credentials or raw audio.
#[derive(Debug, Clone, Error, PartialEq, Eq, Serialize, Deserialize)]
pub enum EngineError {
    #[error("task unavailable")]
    TaskUnavailable,
    #[error("cancelled")]
    Cancelled,
    #[error("resource limit")]
    ResourceLimit,
    #[error("invalid request")]
    InvalidRequest,
    #[error("provider fault: {code}")]
    ProviderFault { code: String },
}

/// Engine-independent task provider.
#[async_trait(?Send)]
pub trait TaskProvider {
    fn capabilities(&self) -> Vec<TaskCapability>;

    fn resource_report(&self) -> ResourceReport;

    async fn warm_task(&mut self, request: TaskRequest) -> Result<(), EngineError>;

    async fn unload_task(&mut self, task: VoiceTask) -> Result<(), EngineError>;

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError>;
}

/// A minimal finite turn engine boundary. Real sherpa/native/web adapters are
/// intentionally later phases.
#[async_trait(?Send)]
pub trait SpeechEngine: TaskProvider {
    async fn transcribe_finite(
        &mut self,
        request: TaskRequest,
        frames: usize,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<String, EngineError>;

    async fn synthesize_text(
        &mut self,
        request: TaskRequest,
        text: &str,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<i16>, EngineError>;
}
