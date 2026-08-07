//! Bound Sherpa VAD adapter.
//!
//! This crate keeps the public provider surface on the shared engine types.
//! Native FFI and browser hosts sit below [`SherpaVadBackend`].

#![forbid(unsafe_code)]

use async_trait::async_trait;
use aurora_voice_engine::{
    check_engine_cancellation, BoundStreamSession, BoundTaskRequest, BoundVadRequest, EngineError,
    EngineFaultCode, ResourceReport, SpeechSegment, StreamResetReason, StreamSessionId,
    StreamingAudioFrame, TaskCapability, TaskPackBinding, TaskProvider, TaskReadiness,
    VadAcceptResult, VadConfig, VadStreamProvider, VoiceTask, MONO_CHANNELS, VAD_SAMPLE_RATE_HZ,
    VAD_WINDOW_SIZE_SAMPLES,
};
use std::fmt;
use thiserror::Error;

const MAX_DRAINED_SEGMENTS: usize = 512;

/// Product-safe backend fault classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendFaultCode {
    HostUnavailable,
    NativeFault,
    WasmFault,
    BackendFault,
}

impl BackendFaultCode {
    pub const fn as_engine_fault(self) -> EngineFaultCode {
        match self {
            Self::HostUnavailable => EngineFaultCode::HostUnavailable,
            Self::NativeFault => EngineFaultCode::Native,
            Self::WasmFault => EngineFaultCode::Wasm,
            Self::BackendFault => EngineFaultCode::Provider,
        }
    }
}

impl fmt::Display for BackendFaultCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HostUnavailable => "host_unavailable",
            Self::NativeFault => "native_fault",
            Self::WasmFault => "wasm_fault",
            Self::BackendFault => "backend_fault",
        })
    }
}

/// Adapter errors contain no paths, provider names, pointers, or raw host
/// messages.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum SherpaAdapterError {
    #[error("invalid sherpa VAD configuration")]
    InvalidConfig,
    #[error("invalid VAD frame")]
    InvalidFrame,
    #[error("invalid VAD segment")]
    InvalidSegment,
    #[error("cancelled")]
    Cancelled,
    #[error("backend fault: {code}")]
    BackendFault { code: BackendFaultCode },
}

impl SherpaAdapterError {
    pub fn from_host_fault(_raw_host_message: impl AsRef<str>) -> Self {
        Self::BackendFault {
            code: BackendFaultCode::BackendFault,
        }
    }

    fn into_engine_error(self) -> EngineError {
        match self {
            Self::InvalidConfig | Self::InvalidFrame | Self::InvalidSegment => {
                EngineError::InvalidRequest
            }
            Self::Cancelled => EngineError::Cancelled,
            Self::BackendFault { code } => EngineError::ProviderFault {
                code: code.as_engine_fault(),
            },
        }
    }
}

/// Safe host/backend boundary. Implementations may own native FFI or browser
/// state internally, but only shared engine values cross this trait.
pub trait SherpaVadBackend {
    fn accept_waveform(&mut self, frame: StreamingAudioFrame<'_>)
        -> Result<(), SherpaAdapterError>;

    fn is_speech_detected(&mut self) -> Result<bool, SherpaAdapterError>;

    fn pop_completed_segment(&mut self) -> Result<Option<SpeechSegment>, SherpaAdapterError>;

    fn flush(&mut self) -> Result<(), SherpaAdapterError>;

    fn clear_queued_segments(&mut self) -> Result<(), SherpaAdapterError>;

    fn reset(&mut self) -> Result<(), SherpaAdapterError>;
}

#[derive(Debug, Clone, PartialEq)]
struct ActiveVadSession {
    session: BoundStreamSession,
    config: VadConfig,
}

/// Corrected bound VAD provider for a single installed Sherpa model selection.
#[derive(Debug)]
pub struct SherpaVadProvider<B> {
    installed_binding: TaskPackBinding,
    backend: B,
    readiness: TaskReadiness,
    active: Option<ActiveVadSession>,
    next_session_id: u64,
    last_backend_fault: Option<BackendFaultCode>,
}

impl<B> SherpaVadProvider<B>
where
    B: SherpaVadBackend,
{
    pub fn new(installed_binding: TaskPackBinding, backend: B) -> Result<Self, EngineError> {
        validate_vad_binding(&installed_binding)?;
        Ok(Self {
            installed_binding,
            backend,
            readiness: TaskReadiness::Ready,
            active: None,
            next_session_id: 1,
            last_backend_fault: None,
        })
    }

    pub fn binding(&self) -> &TaskPackBinding {
        &self.installed_binding
    }

    pub fn active_session(&self) -> Option<StreamSessionId> {
        self.active
            .as_ref()
            .map(|active| active.session.session_id())
    }

    pub fn last_backend_fault(&self) -> Option<BackendFaultCode> {
        self.last_backend_fault
    }

    pub fn clear_queued_segments(
        &mut self,
        session: &BoundStreamSession,
    ) -> Result<(), EngineError> {
        self.ensure_session(session)?;
        let result = self.backend.clear_queued_segments();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    pub fn into_backend(self) -> B {
        self.backend
    }

    fn ensure_binding(&self, binding: &TaskPackBinding) -> Result<(), EngineError> {
        if binding == &self.installed_binding {
            Ok(())
        } else {
            Err(EngineError::InvalidRequest)
        }
    }

    fn ensure_request(&self, request: &BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_binding(request.binding())?;
        if request.request().task != VoiceTask::VoiceActivityDetection {
            return Err(EngineError::InvalidRequest);
        }
        Ok(())
    }

    fn ensure_session(
        &self,
        session: &BoundStreamSession,
    ) -> Result<&ActiveVadSession, EngineError> {
        match &self.active {
            Some(active)
                if active.session.session_id() == session.session_id()
                    && session.task() == VoiceTask::VoiceActivityDetection
                    && active.session == *session
                    && session.binding() == &self.installed_binding =>
            {
                Ok(active)
            }
            _ => Err(EngineError::InvalidRequest),
        }
    }

    fn cancel_active(&mut self) -> Result<(), EngineError> {
        self.active = None;
        let result = self.backend.reset();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    fn reset_active_backend(&mut self) -> Result<(), EngineError> {
        let result = self.backend.reset();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    fn drain_completed(
        &mut self,
        config: &VadConfig,
        cancellation: &dyn Fn() -> bool,
        flushed: bool,
    ) -> Result<Vec<SpeechSegment>, EngineError> {
        let max_buffer_samples = usize::try_from(
            config
                .buffer_samples()
                .map_err(|_| EngineError::ResourceLimit)?,
        )
        .map_err(|_| EngineError::ResourceLimit)?;
        let max_speech_samples = usize::try_from(
            config
                .max_speech_samples()
                .map_err(|_| EngineError::ResourceLimit)?,
        )
        .map_err(|_| EngineError::ResourceLimit)?;
        let mut segments = Vec::new();
        let mut total_samples = 0_usize;

        for _ in 0..MAX_DRAINED_SEGMENTS {
            if cancellation() {
                self.cancel_active()?;
                return Err(EngineError::Cancelled);
            }
            let result = self.backend.pop_completed_segment();
            let segment = match self
                .capture_backend(result)
                .map_err(SherpaAdapterError::into_engine_error)?
            {
                Some(segment) => segment,
                None => return Ok(segments),
            };
            if cancellation() {
                self.cancel_active()?;
                return Err(EngineError::Cancelled);
            }
            validate_segment(&segment, max_speech_samples)?;
            total_samples = total_samples
                .checked_add(segment.samples().len())
                .ok_or(EngineError::ResourceLimit)?;
            if total_samples > max_buffer_samples {
                let result = self.backend.clear_queued_segments();
                let _ = self.capture_backend(result);
                return Err(EngineError::InvalidRequest);
            }
            segments.push(if flushed && !segment.flushed() {
                SpeechSegment::new(
                    segment.start_frame(),
                    segment.end_frame(),
                    segment.start_sample(),
                    segment.samples().to_vec(),
                    true,
                )?
            } else {
                segment
            });
        }

        let result = self.backend.clear_queued_segments();
        let _ = self.capture_backend(result);
        Err(EngineError::ResourceLimit)
    }

    fn capture_backend<T>(
        &mut self,
        result: Result<T, SherpaAdapterError>,
    ) -> Result<T, SherpaAdapterError> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let SherpaAdapterError::BackendFault { code } = error {
                    self.last_backend_fault = Some(code);
                    Err(SherpaAdapterError::BackendFault { code })
                } else {
                    Err(error)
                }
            }
        }
    }
}

#[async_trait(?Send)]
impl<B> TaskProvider for SherpaVadProvider<B>
where
    B: SherpaVadBackend,
{
    fn capabilities(&self) -> Vec<TaskCapability> {
        vec![TaskCapability::new(self.installed_binding.clone()).streaming(true)]
    }

    fn resource_report(&self) -> ResourceReport {
        ResourceReport {
            loaded_tasks: vec![VoiceTask::VoiceActivityDetection],
            memory_bytes: self.installed_binding.resource_budget().max_memory_bytes,
            active_streams: u32::from(self.active.is_some()),
            readiness: self.readiness,
        }
    }

    async fn warm_task(&mut self, request: BoundTaskRequest) -> Result<(), EngineError> {
        self.ensure_request(&request)
    }

    async fn unload_task(&mut self, binding: TaskPackBinding) -> Result<(), EngineError> {
        self.ensure_binding(&binding)?;
        self.active = None;
        let result = self.backend.reset();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)
    }

    async fn cancel_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.session.generation() == generation)
        {
            self.cancel_active()?;
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl<B> VadStreamProvider for SherpaVadProvider<B>
where
    B: SherpaVadBackend,
{
    async fn start_vad_session(
        &mut self,
        request: BoundVadRequest,
    ) -> Result<BoundStreamSession, EngineError> {
        self.ensure_request(request.request())?;
        request.config().validate_binding(&self.installed_binding)?;
        if self.active.is_some() {
            return Err(EngineError::ResourceLimit);
        }
        let session_id = StreamSessionId(self.next_session_id);
        self.next_session_id = self.next_session_id.saturating_add(1);
        let session = BoundStreamSession::new(session_id, request.request())?;
        self.active = Some(ActiveVadSession {
            session: session.clone(),
            config: request.config().clone(),
        });
        Ok(session)
    }

    async fn push_vad_frame(
        &mut self,
        session: &BoundStreamSession,
        frame: StreamingAudioFrame<'_>,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<VadAcceptResult, EngineError> {
        let config = self.ensure_session(session)?.config.clone();
        validate_frame(&config, &frame)?;
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }

        let reset = if frame.discontinuity() {
            self.reset_active_backend()?;
            Some(StreamResetReason::Discontinuity)
        } else {
            None
        };

        let result = self.backend.accept_waveform(frame);
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }
        let result = self.backend.is_speech_detected();
        let detected = self
            .capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        let segments = self.drain_completed(&config, cancellation, false)?;
        Ok(VadAcceptResult::new(detected, segments, reset))
    }

    async fn flush_vad_session(
        &mut self,
        session: &BoundStreamSession,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<Vec<SpeechSegment>, EngineError> {
        let config = self.ensure_session(session)?.config.clone();
        check_engine_cancellation(cancellation)?;
        let result = self.backend.flush();
        self.capture_backend(result)
            .map_err(SherpaAdapterError::into_engine_error)?;
        if cancellation() {
            self.cancel_active()?;
            return Err(EngineError::Cancelled);
        }
        self.drain_completed(&config, cancellation, true)
    }

    async fn reset_vad_session(
        &mut self,
        session: &BoundStreamSession,
        _reason: StreamResetReason,
    ) -> Result<(), EngineError> {
        self.ensure_session(session)?;
        self.reset_active_backend()
    }
}

fn validate_vad_binding(binding: &TaskPackBinding) -> Result<(), EngineError> {
    if binding.task() != VoiceTask::VoiceActivityDetection
        || binding.sample_rate_hz() != VAD_SAMPLE_RATE_HZ
        || binding.channels() != MONO_CHANNELS
        || binding.frame_size() != VAD_WINDOW_SIZE_SAMPLES as u32
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn validate_frame(config: &VadConfig, frame: &StreamingAudioFrame<'_>) -> Result<(), EngineError> {
    if frame.is_end_tail() {
        config.validate_end_tail_samples(frame.samples())
    } else {
        config.validate_frame_samples(frame.samples())
    }
}

fn validate_segment(segment: &SpeechSegment, max_speech_samples: usize) -> Result<(), EngineError> {
    if segment.samples().is_empty() || segment.samples().len() > max_speech_samples {
        return Err(EngineError::InvalidRequest);
    }
    if segment
        .samples()
        .iter()
        .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
    {
        return Err(EngineError::InvalidRequest);
    }
    let sample_len =
        u64::try_from(segment.samples().len()).map_err(|_| EngineError::ResourceLimit)?;
    if segment.start_sample().checked_add(sample_len) != Some(segment.end_sample_exclusive()) {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

#[cfg(feature = "native-vad")]
mod native_backend {
    use super::*;
    use aurora_voice_sherpa_sys::{
        ErrorCode as NativeErrorCode, SileroVadConfig as NativeSileroVadConfig,
        VoiceActivityDetector,
    };
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};

    #[derive(Debug)]
    pub struct NativeVadBackend {
        detector: VoiceActivityDetector,
        pending: VecDeque<SpeechSegment>,
    }

    impl NativeVadBackend {
        pub fn from_selected_model(
            binding: &TaskPackBinding,
            selected_file_id: &str,
            model_path: impl Into<PathBuf>,
            config: &VadConfig,
        ) -> Result<Self, EngineError> {
            validate_vad_binding(binding)?;
            config.validate_binding(binding)?;
            if !binding
                .selected_file_ids()
                .iter()
                .any(|file_id| file_id == selected_file_id)
            {
                return Err(EngineError::InvalidRequest);
            }
            Self::from_path(model_path.into(), config)
        }

        fn from_path(model_path: PathBuf, config: &VadConfig) -> Result<Self, EngineError> {
            let native_config = native_config(&model_path, config)?;
            let detector = VoiceActivityDetector::new(&native_config).map_err(native_error)?;
            Ok(Self {
                detector,
                pending: VecDeque::new(),
            })
        }
    }

    impl SherpaVadBackend for NativeVadBackend {
        fn accept_waveform(
            &mut self,
            frame: StreamingAudioFrame<'_>,
        ) -> Result<(), SherpaAdapterError> {
            match self.detector.accept_waveform(frame.samples()) {
                Ok(()) => Ok(()),
                Err(error) if is_queued_segment_undrained(&error) => {
                    self.drain_native_segments()?;
                    self.detector
                        .accept_waveform(frame.samples())
                        .map_err(native_adapter_error)
                }
                Err(error) => Err(native_adapter_error(error)),
            }
        }

        fn is_speech_detected(&mut self) -> Result<bool, SherpaAdapterError> {
            self.detector.detected().map_err(native_adapter_error)
        }

        fn pop_completed_segment(&mut self) -> Result<Option<SpeechSegment>, SherpaAdapterError> {
            if let Some(segment) = self.pending.pop_front() {
                return Ok(Some(segment));
            }

            self.drain_native_segments()?;
            Ok(self.pending.pop_front())
        }

        fn flush(&mut self) -> Result<(), SherpaAdapterError> {
            self.detector.flush().map_err(native_adapter_error)
        }

        fn clear_queued_segments(&mut self) -> Result<(), SherpaAdapterError> {
            self.pending.clear();
            self.detector.clear().map_err(native_adapter_error)
        }

        fn reset(&mut self) -> Result<(), SherpaAdapterError> {
            self.pending.clear();
            self.detector.reset().map_err(native_adapter_error)
        }
    }

    impl NativeVadBackend {
        fn drain_native_segments(&mut self) -> Result<(), SherpaAdapterError> {
            for segment in self
                .detector
                .drain_speech_segments()
                .map_err(native_adapter_error)?
            {
                self.pending.push_back(native_segment_to_engine(segment)?);
            }
            Ok(())
        }
    }

    fn native_segment_to_engine(
        segment: aurora_voice_sherpa_sys::SpeechSegment,
    ) -> Result<SpeechSegment, SherpaAdapterError> {
        SpeechSegment::new(
            0,
            0,
            u64::try_from(segment.start).map_err(|_| SherpaAdapterError::InvalidSegment)?,
            segment.samples,
            false,
        )
        .map_err(|_| SherpaAdapterError::InvalidSegment)
    }

    fn native_config(
        model_path: &Path,
        config: &VadConfig,
    ) -> Result<NativeSileroVadConfig, EngineError> {
        Ok(NativeSileroVadConfig::new(model_path)
            .with_threshold(config.threshold())
            .with_min_silence_duration(config.min_silence_duration_ms() as f32 / 1_000.0)
            .with_min_speech_duration(config.min_speech_duration_ms() as f32 / 1_000.0)
            .with_max_speech_duration(config.max_speech_duration_ms() as f32 / 1_000.0)
            .with_window_size(
                i32::try_from(config.window_size_samples())
                    .map_err(|_| EngineError::ResourceLimit)?,
            )
            .with_sample_rate(
                i32::try_from(config.sample_rate_hz()).map_err(|_| EngineError::ResourceLimit)?,
            )
            .with_buffer_size_seconds(config.buffer_duration_ms() as f32 / 1_000.0))
    }

    fn native_error(error: aurora_voice_sherpa_sys::VadError) -> EngineError {
        match error {
            aurora_voice_sherpa_sys::VadError::NativeUnavailable => EngineError::ProviderFault {
                code: EngineFaultCode::HostUnavailable,
            },
            aurora_voice_sherpa_sys::VadError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::VadError::InvalidWaveform { .. } => {
                EngineError::InvalidRequest
            }
            _ => EngineError::ProviderFault {
                code: EngineFaultCode::Native,
            },
        }
    }

    fn native_adapter_error(error: aurora_voice_sherpa_sys::VadError) -> SherpaAdapterError {
        match error {
            aurora_voice_sherpa_sys::VadError::NativeUnavailable => {
                SherpaAdapterError::BackendFault {
                    code: BackendFaultCode::HostUnavailable,
                }
            }
            aurora_voice_sherpa_sys::VadError::InvalidConfig { .. }
            | aurora_voice_sherpa_sys::VadError::InvalidWaveform { .. } => {
                SherpaAdapterError::InvalidFrame
            }
            _ => SherpaAdapterError::BackendFault {
                code: BackendFaultCode::NativeFault,
            },
        }
    }

    fn is_queued_segment_undrained(error: &aurora_voice_sherpa_sys::VadError) -> bool {
        matches!(
            error,
            aurora_voice_sherpa_sys::VadError::InvalidWaveform {
                code: NativeErrorCode::WaveformQueuedSegmentUndrained
            }
        )
    }
}

#[cfg(feature = "native-vad")]
pub use native_backend::NativeVadBackend;

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_engine::{
        select_verified_variant, verify_manifest, AbiRequirements, CapabilityFlags, Compatibility,
        CompressionKind, DeviceClass, EngineKind, LanguageSupport, LicenseGrant, LicenseInfo,
        ManifestSignature, ModelPackError, ModelPackFile, ModelPackManifest, PackTask,
        ProcessingMetadata, Provenance, ResourceBudget, RuntimeGates, RuntimeSelection,
        RuntimeTarget, SelectedVariant, ShapeMetadata, SignatureVerifier, TargetArch, TargetOs,
        TrustPolicy, VerifiedManifest,
    };
    use std::cell::Cell;
    use std::collections::{BTreeSet, VecDeque};

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Debug, Default)]
    struct FakeBackend {
        calls: Vec<&'static str>,
        detected: bool,
        segments: VecDeque<SpeechSegment>,
        repeat_segment: Option<SpeechSegment>,
        fail_on: Option<&'static str>,
        accepted_samples: usize,
    }

    impl FakeBackend {
        fn with_segment(segment: SpeechSegment) -> Self {
            let mut segments = VecDeque::new();
            segments.push_back(segment);
            Self {
                segments,
                ..Self::default()
            }
        }

        fn maybe_fail(&self, operation: &'static str) -> Result<(), SherpaAdapterError> {
            if self.fail_on == Some(operation) {
                Err(SherpaAdapterError::from_host_fault(
                    "native=/secret/model.onnx provider=private ptr=0xfeed",
                ))
            } else {
                Ok(())
            }
        }
    }

    impl SherpaVadBackend for FakeBackend {
        fn accept_waveform(
            &mut self,
            frame: StreamingAudioFrame<'_>,
        ) -> Result<(), SherpaAdapterError> {
            self.calls.push("accept");
            self.accepted_samples += frame.samples().len();
            self.maybe_fail("accept")
        }

        fn is_speech_detected(&mut self) -> Result<bool, SherpaAdapterError> {
            self.calls.push("detected");
            self.maybe_fail("detected")?;
            Ok(self.detected)
        }

        fn pop_completed_segment(&mut self) -> Result<Option<SpeechSegment>, SherpaAdapterError> {
            self.calls.push("pop");
            self.maybe_fail("pop")?;
            Ok(self
                .segments
                .pop_front()
                .or_else(|| self.repeat_segment.clone()))
        }

        fn flush(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("flush");
            self.maybe_fail("flush")
        }

        fn clear_queued_segments(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("clear");
            self.segments.clear();
            self.repeat_segment = None;
            self.maybe_fail("clear")
        }

        fn reset(&mut self) -> Result<(), SherpaAdapterError> {
            self.calls.push("reset");
            self.segments.clear();
            self.repeat_segment = None;
            self.detected = false;
            self.maybe_fail("reset")
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

    fn provider(backend: FakeBackend) -> SherpaVadProvider<FakeBackend> {
        SherpaVadProvider::new(binding(), backend).expect("valid provider")
    }

    fn binding() -> TaskPackBinding {
        let (manifest, selection) = selected();
        TaskPackBinding::from_selection(VoiceTask::VoiceActivityDetection, &manifest, &selection)
            .expect("binding")
    }

    fn request(binding: TaskPackBinding, generation: u64) -> BoundTaskRequest {
        BoundTaskRequest::new(
            aurora_voice_engine::TaskRequest {
                task: VoiceTask::VoiceActivityDetection,
                language: None,
                generation,
            },
            binding,
        )
        .expect("bound request")
    }

    fn vad_request(binding: TaskPackBinding, generation: u64) -> BoundVadRequest {
        BoundVadRequest::new(request(binding, generation), VadConfig::default()).expect("bound vad")
    }

    fn start(provider: &mut SherpaVadProvider<FakeBackend>, generation: u64) -> BoundStreamSession {
        futures_lite(
            vad_request(provider.binding().clone(), generation),
            |request| provider.start_vad_session(request),
        )
        .expect("session starts")
    }

    fn frame(samples: &[f32]) -> StreamingAudioFrame<'_> {
        StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, samples, false)
            .expect("valid frame")
    }

    fn tail(samples: &[f32]) -> StreamingAudioFrame<'_> {
        StreamingAudioFrame::end_tail(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, samples, false)
            .expect("valid tail")
    }

    fn discontinuity_frame(samples: &[f32]) -> StreamingAudioFrame<'_> {
        StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, samples, true)
            .expect("valid frame")
    }

    fn window_samples() -> Vec<f32> {
        vec![0.0; VAD_WINDOW_SIZE_SAMPLES]
    }

    fn segment(samples: Vec<f32>) -> SpeechSegment {
        SpeechSegment::new(0, 0, 0, samples, false).expect("valid segment")
    }

    #[test]
    fn advertises_only_bound_vad_capability() {
        let provider = provider(FakeBackend::default());
        let capabilities = provider.capabilities();
        assert_eq!(capabilities.len(), 1);
        assert_eq!(capabilities[0].task(), VoiceTask::VoiceActivityDetection);
        assert_eq!(capabilities[0].binding(), provider.binding());
        assert!(capabilities[0].streaming_enabled());
    }

    #[test]
    fn rejects_binding_mismatch_for_warm_unload_and_start() {
        let mut provider = provider(FakeBackend::default());
        let wrong = wrong_binding();
        let wrong_request = request(wrong.clone(), 1);
        assert_eq!(
            futures_lite(wrong_request, |request| provider.warm_task(request)),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            futures_lite(wrong.clone(), |binding| provider.unload_task(binding)),
            Err(EngineError::InvalidRequest)
        );
        assert_eq!(
            futures_lite(vad_request(wrong, 1), |request| {
                provider.start_vad_session(request)
            }),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn start_prevents_stale_session_ids_generation_and_concurrent_sessions() {
        let mut provider = provider(FakeBackend::default());
        let session = start(&mut provider, 42);
        assert_eq!(
            futures_lite(vad_request(provider.binding().clone(), 43), |request| {
                provider.start_vad_session(request)
            }),
            Err(EngineError::ResourceLimit)
        );
        let wrong_id = BoundStreamSession::new(
            StreamSessionId(session.session_id().0 + 99),
            &request(provider.binding().clone(), 42),
        )
        .expect("wrong id handle");
        assert_eq!(
            futures_lite((), |_| provider.flush_vad_session(&wrong_id, &|| false)),
            Err(EngineError::InvalidRequest)
        );
        let stale_generation = BoundStreamSession::new(
            session.session_id(),
            &request(provider.binding().clone(), 43),
        )
        .expect("stale generation handle");
        assert_eq!(
            futures_lite((), |_| provider
                .flush_vad_session(&stale_generation, &|| false)),
            Err(EngineError::InvalidRequest)
        );
        futures_lite((), |_| provider.cancel_generation(42)).expect("cancel");
        assert!(provider.active_session().is_none());
    }

    #[test]
    fn accepts_detects_and_drains_in_deterministic_order() {
        let mut backend = FakeBackend::with_segment(segment(vec![0.1, 0.2]));
        backend.detected = true;
        let mut provider = provider(backend);
        let session = start(&mut provider, 1);
        let samples = window_samples();

        let result = futures_lite((), |_| {
            provider.push_vad_frame(&session, frame(&samples), &|| false)
        })
        .expect("push succeeds");
        assert!(result.detected());
        assert_eq!(result.segments().len(), 1);
        assert_eq!(result.segments()[0].samples(), &[0.1, 0.2]);

        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["accept", "detected", "pop", "pop"]);
        assert_eq!(backend.accepted_samples, VAD_WINDOW_SIZE_SAMPLES);
    }

    #[test]
    fn rejects_non_window_normal_accept_and_preserves_short_tail() {
        let mut provider = provider(FakeBackend::default());
        let session = start(&mut provider, 1);
        assert_eq!(
            futures_lite((), |_| provider.push_vad_frame(
                &session,
                tail(&[0.0]),
                &|| false
            ))
            .expect("tail accepted")
            .segments()
            .len(),
            0
        );
        let short = StreamingAudioFrame::new(1, VAD_SAMPLE_RATE_HZ, MONO_CHANNELS, &[0.0], false)
            .expect("generic frame");
        assert_eq!(
            futures_lite((), |_| provider.push_vad_frame(&session, short, &|| false)),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn discontinuity_resets_before_accepting_frame() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        let samples = window_samples();
        let result = futures_lite((), |_| {
            provider.push_vad_frame(&session, discontinuity_frame(&samples), &|| false)
        })
        .expect("push succeeds");
        assert_eq!(result.reset(), Some(StreamResetReason::Discontinuity));
        assert!(result.segments().is_empty());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["reset", "accept", "detected", "pop"]);
    }

    #[test]
    fn cancellation_after_feed_resets_before_detect_or_drain() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        let samples = window_samples();
        let checks = Cell::new(0);
        let cancel_after_feed = || {
            let check = checks.get();
            checks.set(check + 1);
            check == 1
        };
        let result = futures_lite((), |_| {
            provider.push_vad_frame(&session, frame(&samples), &cancel_after_feed)
        });
        assert_eq!(result, Err(EngineError::Cancelled));
        assert!(provider.active_session().is_none());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["accept", "reset"]);
    }

    #[test]
    fn flush_runs_before_completed_segment_drain_and_marks_segments() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        let segments = futures_lite((), |_| provider.flush_vad_session(&session, &|| false))
            .expect("flush succeeds");
        assert_eq!(segments.len(), 1);
        assert!(segments[0].flushed());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["flush", "pop", "pop"]);
    }

    #[test]
    fn clear_queued_segments_is_distinct_from_reset() {
        let mut provider = provider(FakeBackend::with_segment(segment(vec![0.1, 0.2])));
        let session = start(&mut provider, 1);
        provider
            .clear_queued_segments(&session)
            .expect("clear queued segments");
        let segments = futures_lite((), |_| provider.flush_vad_session(&session, &|| false))
            .expect("flush succeeds");
        assert!(segments.is_empty());
        let backend = provider.into_backend();
        assert_eq!(backend.calls, vec!["clear", "flush", "pop"]);
    }

    #[test]
    fn bounded_drain_rejects_faulty_host_and_clears_queue() {
        let backend = FakeBackend {
            repeat_segment: Some(segment(vec![0.0])),
            ..FakeBackend::default()
        };
        let mut provider = provider(backend);
        let session = start(&mut provider, 1);
        assert_eq!(
            futures_lite((), |_| provider.flush_vad_session(&session, &|| false)),
            Err(EngineError::ResourceLimit)
        );
        let backend = provider.into_backend();
        assert_eq!(backend.calls.last(), Some(&"clear"));
    }

    #[test]
    fn rejects_invalid_completed_segments_before_exposing_them() {
        let invalid = SpeechSegment::new(0, 0, 0, vec![1.2], false).expect_err("invalid");
        assert_eq!(invalid, EngineError::InvalidRequest);
        let mut provider = provider(FakeBackend::with_segment(
            SpeechSegment::new(0, 0, 0, vec![0.0; 200_000], false).expect("valid shape"),
        ));
        let session = start(&mut provider, 1);
        assert_eq!(
            futures_lite((), |_| provider.flush_vad_session(&session, &|| false)),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn host_faults_are_redacted_in_error_and_report() {
        let backend = FakeBackend {
            fail_on: Some("accept"),
            ..FakeBackend::default()
        };
        let mut provider = provider(backend);
        let session = start(&mut provider, 1);
        let samples = window_samples();
        let error = futures_lite((), |_| {
            provider.push_vad_frame(&session, frame(&samples), &|| false)
        })
        .expect_err("backend fault");
        let rendered = format!("{error:?} {error}");
        assert!(rendered.contains("provider"));
        assert!(!rendered.contains("/secret"));
        assert!(!rendered.contains("ptr="));
        assert_eq!(
            provider.last_backend_fault(),
            Some(BackendFaultCode::BackendFault)
        );
    }

    #[cfg(feature = "native-vad")]
    #[test]
    fn native_feature_constructor_is_bound_to_selected_file() {
        let binding = binding();
        let result = NativeVadBackend::from_selected_model(
            &binding,
            "missing",
            "model.onnx",
            &VadConfig::default(),
        );
        assert!(matches!(result, Err(EngineError::InvalidRequest)));
    }

    fn futures_lite<T, F, Fut, R>(input: T, f: F) -> R
    where
        F: FnOnce(T) -> Fut,
        Fut: std::future::Future<Output = R>,
    {
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        let mut future = Box::pin(f(input));
        loop {
            match std::future::Future::poll(future.as_mut(), &mut context) {
                std::task::Poll::Ready(output) => return output,
                std::task::Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn selected() -> (VerifiedManifest, SelectedVariant) {
        let verified = verify_manifest(
            manifest("pack", PackTask::Vad),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        )
        .expect("verified");
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
        .expect("selected");
        (verified, selection)
    }

    fn wrong_binding() -> TaskPackBinding {
        let verified = verify_manifest(
            manifest("other", PackTask::Vad),
            &TrustPolicy::default(),
            Some(&AcceptingVerifier),
        )
        .expect("verified");
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
        .expect("selected");
        TaskPackBinding::from_selection(VoiceTask::VoiceActivityDetection, &verified, &selection)
            .expect("wrong binding")
    }

    fn manifest(pack_id: &str, task: PackTask) -> ModelPackManifest {
        ModelPackManifest {
            schema_version: 1,
            pack_id: pack_id.to_owned(),
            pack_version: "1.0.0".to_owned(),
            display_name: "Pack".to_owned(),
            tasks: vec![task],
            license: license(),
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
            provenance: provenance(),
            files: vec![ModelPackFile {
                file_id: "model".to_owned(),
                asset_id: "model".to_owned(),
                task,
                byte_size: 100,
                sha256: HASH.to_owned(),
                url: "/models/model".to_owned(),
                compression: CompressionKind::None,
                installed_size: 100,
                install_order: 0,
                dependencies: Vec::new(),
                license: license(),
                provenance: provenance(),
                processing: processing(),
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
                    group_id: "group-a".to_owned(),
                    voice_state_group_id: "voice-state-a".to_owned(),
                    preprocessing_abi: "pre-v1".to_owned(),
                    postprocessing_abi: "post-v1".to_owned(),
                    sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                    channels: MONO_CHANNELS,
                    frame_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                    interoperable: true,
                },
                file_ids: vec!["model".to_owned()],
                abi: AbiRequirements {
                    min_aurora_version: "1.0.0".to_owned(),
                    min_runtime_version: "1.0.0".to_owned(),
                    min_engine_version: "1.0.0".to_owned(),
                    engine_source_revision: "rev1".to_owned(),
                    build_flags: vec!["cpu".to_owned()],
                },
                revocation: None,
            }],
            rollback_from: None,
            supersedes_pack_id: None,
            revocation: None,
            signature: Some(ManifestSignature {
                key_id: "key1".to_owned(),
                algorithm: "ed25519".to_owned(),
                value: "signed".to_owned(),
            }),
        }
    }

    fn license() -> LicenseInfo {
        LicenseInfo {
            identifier: "Apache-2.0".to_owned(),
            text_url: "https://example.test/license".to_owned(),
            text_sha256: HASH.to_owned(),
            commercial_use: true,
            redistribution: LicenseGrant::RedistributionAllowed,
            attribution: "Aurora".to_owned(),
        }
    }

    fn provenance() -> Provenance {
        Provenance {
            upstream_source: "https://example.test/source".to_owned(),
            upstream_revision: "rev1".to_owned(),
            build_recipe_sha256: HASH.to_owned(),
        }
    }

    fn processing() -> ProcessingMetadata {
        ProcessingMetadata {
            tokenizer_sha256: None,
            operator_inventory_sha256: HASH.to_owned(),
            preprocessing_abi: "pre-v1".to_owned(),
            postprocessing_abi: "post-v1".to_owned(),
            shapes: ShapeMetadata {
                sample_rate_hz: VAD_SAMPLE_RATE_HZ,
                channels: MONO_CHANNELS,
                frame_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                window_size: VAD_WINDOW_SIZE_SAMPLES as u32,
                cache_state: vec!["hidden".to_owned()],
            },
        }
    }
}
