//! Finite speech adapters over the existing authorized native mesh call path.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use aurora_contracts::models;
use aurora_voice_core::CancellationToken;
use aurora_voice_engine::{
    BoundFiniteSttRequest, BoundTtsSynthesisRequest, EngineError, EngineFaultCode, FiniteSttAudio,
    FiniteSttPort, FiniteSttProviderBinding, FiniteSttResult, FiniteSttRouteScope,
    RouteFiniteSttBinding, RouteTtsBinding, TtsAudioChunk, TtsSynthesisPort,
    TtsSynthesisProviderBinding, TtsSynthesisResult,
};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::{
    NativeMeshAssistantRoute, NativeMeshAssistantSpeechTransport, NativeMeshSpeechCall,
    NativeMeshSpeechMethod, TransportError, TransportLimits,
};

const PCM16_BYTES_PER_SAMPLE: usize = 2;
const WAV_HEADER_MIN_BYTES: usize = 44;
const WAV_MAX_CHUNKS: usize = 32;
const MAX_TTS_DURATION_SECONDS: usize = 30;
const MAX_TTS_CHUNKS: usize = 512;
const MAX_TRANSCRIPT_BYTES: usize = 64 * 1024;
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Exact remote speech resource selected by trusted speech policy.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeMeshFiniteSttConfig {
    route: RouteFiniteSttBinding,
    peer_id: String,
    resource_id: String,
    model_id: String,
    language: Option<String>,
    remote_audio_consent: bool,
    limits: TransportLimits,
}

impl NativeMeshFiniteSttConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        route: RouteFiniteSttBinding,
        peer_id: impl Into<String>,
        resource_id: impl Into<String>,
        model_id: Option<String>,
        language: Option<String>,
        remote_audio_consent: bool,
        limits: TransportLimits,
    ) -> Result<Self, EngineError> {
        let peer_id = peer_id.into();
        let resource_id = resource_id.into();
        let model_id = model_id.ok_or(EngineError::InvalidRequest)?;
        route.validate()?;
        if !valid_route_id(&peer_id)
            || !valid_route_id(&resource_id)
            || !valid_route_id(&model_id)
            || language
                .as_deref()
                .is_some_and(|value| !valid_language(value))
            || !remote_audio_consent
            || route.route_scope() != FiniteSttRouteScope::RemoteGateway
            || limits.microphone_audio_policy != crate::MicrophoneAudioPolicy::ExplicitRemoteConsent
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            route,
            peer_id,
            resource_id,
            model_id,
            language,
            remote_audio_consent,
            limits,
        })
    }
}

impl fmt::Debug for NativeMeshFiniteSttConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeMeshFiniteSttConfig")
            .field("route", &self.route)
            .field("peer_id_bytes", &self.peer_id.len())
            .field("resource_id_bytes", &self.resource_id.len())
            .field("model_id_bytes", &self.model_id.len())
            .field("language_present", &self.language.is_some())
            .field("remote_audio_consent", &self.remote_audio_consent)
            .finish_non_exhaustive()
    }
}

/// Finite STT adapter; audio stays bounded and is sent only with explicit consent.
pub struct NativeMeshFiniteStt {
    transport: NativeMeshAssistantSpeechTransport,
    config: NativeMeshFiniteSttConfig,
    active_generation: Option<u64>,
    active_cancellation: Option<CancellationToken>,
}

impl NativeMeshFiniteStt {
    pub fn new(config: NativeMeshFiniteSttConfig) -> Result<Self, EngineError> {
        let route = NativeMeshAssistantRoute::new(Some(config.peer_id.clone()))
            .map_err(map_transport_error)?;
        let transport = NativeMeshAssistantSpeechTransport::new(route, config.limits)
            .map_err(map_transport_error)?;
        Ok(Self {
            transport,
            config,
            active_generation: None,
            active_cancellation: None,
        })
    }
}

impl fmt::Debug for NativeMeshFiniteStt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeMeshFiniteStt")
            .field("config", &self.config)
            .field("active_generation", &self.active_generation)
            .field("active_cancellation", &self.active_cancellation.is_some())
            .finish()
    }
}

#[async_trait(?Send)]
impl FiniteSttPort for NativeMeshFiniteStt {
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
        Ok(FiniteSttProviderBinding::Route(self.config.route.clone()))
    }

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError> {
        match binding {
            FiniteSttProviderBinding::Route(route) if route == self.config.route => Ok(()),
            _ => Err(EngineError::TaskUnavailable),
        }
    }

    async fn transcribe_finite(
        &mut self,
        request: BoundFiniteSttRequest,
        audio: FiniteSttAudio,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        if self.active_generation.is_some() {
            return Err(EngineError::ResourceLimit);
        }
        validate_stt_request(&self.config, &request, &audio)?;
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        let payload = stt_payload(&self.config, &request, &audio)?;
        let generation = request.generation();
        let call = NativeMeshSpeechCall::new(
            NativeMeshSpeechMethod::Transcribe,
            payload,
            new_request_id("stt", generation),
            self.config.limits.request_timeout,
        )
        .map_err(map_transport_error)?;
        let token = CancellationToken::new();
        self.active_generation = Some(generation);
        self.active_cancellation = Some(token.clone());
        let response_future = self.transport.finite_speech_call(call, token.clone());
        tokio::pin!(response_future);
        let response = loop {
            tokio::select! {
                result = &mut response_future => break result,
                () = tokio::time::sleep(Duration::from_millis(5)) => {
                    if cancellation() {
                        token.cancel();
                    }
                }
            }
        };
        if self.active_generation == Some(generation) {
            self.active_generation = None;
            self.active_cancellation = None;
        }
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        parse_stt_response(&request, &audio, response.map_err(map_transport_error)?)
    }

    async fn cancel_finite_stt_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        if self.active_generation == Some(generation) {
            if let Some(token) = &self.active_cancellation {
                token.cancel();
            }
            self.active_generation = None;
            self.active_cancellation = None;
        }
        Ok(())
    }
}

/// Bounded exact-target selection for finite TTS synthesis over mesh.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeMeshTtsConfig {
    route: RouteTtsBinding,
    peer_id: String,
    resource_id: String,
    model_id: Option<String>,
    voice: Option<String>,
    language: Option<String>,
    limits: TransportLimits,
    max_audio_samples: usize,
}

impl NativeMeshTtsConfig {
    pub fn new(
        route: RouteTtsBinding,
        peer_id: impl Into<String>,
        resource_id: impl Into<String>,
        model_id: Option<String>,
        voice: Option<String>,
        language: Option<String>,
        limits: TransportLimits,
        max_audio_samples: usize,
    ) -> Result<Self, EngineError> {
        let peer_id = peer_id.into();
        let resource_id = resource_id.into();
        route.validate()?;
        let max_allowed = usize::try_from(route.sample_rate_hz())
            .ok()
            .and_then(|rate| rate.checked_mul(MAX_TTS_DURATION_SECONDS))
            .ok_or(EngineError::ResourceLimit)?;
        if !valid_route_id(&peer_id)
            || !valid_route_id(&resource_id)
            || model_id
                .as_deref()
                .is_some_and(|value| !valid_model_id(value))
            || voice.as_deref().is_some_and(|value| !valid_voice_id(value))
            || language
                .as_deref()
                .is_some_and(|value| !valid_language(value))
            || max_audio_samples == 0
            || max_audio_samples > max_allowed
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            route,
            peer_id,
            resource_id,
            model_id,
            voice,
            language,
            limits,
            max_audio_samples,
        })
    }
}

impl fmt::Debug for NativeMeshTtsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeMeshTtsConfig")
            .field("route", &self.route)
            .field("peer_id_bytes", &self.peer_id.len())
            .field("resource_id_bytes", &self.resource_id.len())
            .field("model_id_present", &self.model_id.is_some())
            .field("voice_present", &self.voice.is_some())
            .field("language_present", &self.language.is_some())
            .field("max_audio_samples", &self.max_audio_samples)
            .finish_non_exhaustive()
    }
}

/// Finite TTS adapter; playback remains owned by the caller on this device.
pub struct NativeMeshTtsSynthesizer {
    transport: NativeMeshAssistantSpeechTransport,
    config: NativeMeshTtsConfig,
    active_generation: Option<u64>,
    active_cancellation: Option<CancellationToken>,
}

impl NativeMeshTtsSynthesizer {
    pub fn new(config: NativeMeshTtsConfig) -> Result<Self, EngineError> {
        let route = NativeMeshAssistantRoute::new(Some(config.peer_id.clone()))
            .map_err(map_transport_error)?;
        let transport = NativeMeshAssistantSpeechTransport::new(route, config.limits)
            .map_err(map_transport_error)?;
        Ok(Self {
            transport,
            config,
            active_generation: None,
            active_cancellation: None,
        })
    }
}

impl fmt::Debug for NativeMeshTtsSynthesizer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeMeshTtsSynthesizer")
            .field("config", &self.config)
            .field("active_generation", &self.active_generation)
            .field("active_cancellation", &self.active_cancellation.is_some())
            .finish()
    }
}

#[async_trait(?Send)]
impl TtsSynthesisPort for NativeMeshTtsSynthesizer {
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
        Ok(TtsSynthesisProviderBinding::Route(
            self.config.route.clone(),
        ))
    }

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError> {
        match binding {
            TtsSynthesisProviderBinding::Route(route) if route == self.config.route => Ok(()),
            _ => Err(EngineError::TaskUnavailable),
        }
    }

    async fn synthesize_text(
        &mut self,
        request: BoundTtsSynthesisRequest,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        if self.active_generation.is_some() {
            return Err(EngineError::ResourceLimit);
        }
        validate_tts_request(&self.config, &request)?;
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        let payload = tts_payload(&self.config, &request)?;
        let generation = request.generation();
        let call = NativeMeshSpeechCall::new(
            NativeMeshSpeechMethod::Synthesize,
            payload,
            new_request_id("tts", generation),
            self.config.limits.request_timeout,
        )
        .map_err(map_transport_error)?;
        let token = CancellationToken::new();
        self.active_generation = Some(generation);
        self.active_cancellation = Some(token.clone());
        let response_future = self.transport.finite_speech_call(call, token.clone());
        tokio::pin!(response_future);
        let response = loop {
            tokio::select! {
                result = &mut response_future => break result,
                () = tokio::time::sleep(Duration::from_millis(5)) => {
                    if cancellation() {
                        token.cancel();
                    }
                }
            }
        };
        if self.active_generation == Some(generation) {
            self.active_generation = None;
            self.active_cancellation = None;
        }
        if cancellation() {
            return Err(EngineError::Cancelled);
        }
        parse_tts_response(
            &request,
            response.map_err(map_transport_error)?,
            self.config.max_audio_samples,
        )
    }

    async fn cancel_synthesis_generation(&mut self, generation: u64) -> Result<(), EngineError> {
        if self.active_generation == Some(generation) {
            if let Some(token) = &self.active_cancellation {
                token.cancel();
            }
            self.active_generation = None;
            self.active_cancellation = None;
        }
        Ok(())
    }
}

fn validate_stt_request(
    config: &NativeMeshFiniteSttConfig,
    request: &BoundFiniteSttRequest,
    audio: &FiniteSttAudio,
) -> Result<(), EngineError> {
    let route = request.route_request().ok_or(EngineError::InvalidRequest)?;
    if route.route() != &config.route
        || route.generation() != request.generation()
        || audio.generation() != request.generation()
        || audio.frames() != request.frames()
        || audio.sample_rate_hz() != config.route.sample_rate_hz()
        || audio.channels() != config.route.channels()
        || audio.samples().is_empty()
        || audio.samples().len() > request.max_audio_samples()
        || route.language() != config.language.as_deref()
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn validate_tts_request(
    config: &NativeMeshTtsConfig,
    request: &BoundTtsSynthesisRequest,
) -> Result<(), EngineError> {
    let route = request.route_request().ok_or(EngineError::InvalidRequest)?;
    if route.route() != &config.route
        || route.generation() != request.generation()
        || route.language() != config.language.as_deref()
        || request.config().seed().is_some()
        || config
            .voice
            .as_deref()
            .map_or(request.config().logical_voice_id() != "default", |voice| {
                request.config().logical_voice_id() != voice
            })
    {
        return Err(EngineError::InvalidRequest);
    }
    Ok(())
}

fn stt_payload(
    config: &NativeMeshFiniteSttConfig,
    request: &BoundFiniteSttRequest,
    audio: &FiniteSttAudio,
) -> Result<Value, EngineError> {
    let byte_len = audio
        .samples()
        .len()
        .checked_mul(PCM16_BYTES_PER_SAMPLE)
        .ok_or(EngineError::ResourceLimit)?;
    let mut raw = Vec::new();
    raw.try_reserve_exact(byte_len)
        .map_err(|_| EngineError::ResourceLimit)?;
    for sample in audio.samples() {
        if !sample.is_finite() || !(-1.0..=1.0).contains(sample) {
            return Err(EngineError::InvalidRequest);
        }
        let converted = if *sample <= -1.0 {
            i16::MIN
        } else if *sample >= 1.0 {
            i16::MAX
        } else {
            (*sample * f32::from(i16::MAX)).round() as i16
        };
        raw.extend_from_slice(&converted.to_le_bytes());
    }
    let payload = json!({
        "audio_data": base64::engine::general_purpose::STANDARD.encode(raw),
        "format": "raw",
        "sample_rate": audio.sample_rate_hz(),
        "channels": audio.channels(),
        "language": request.route_request().and_then(|route| route.language()),
        "auto_language_candidates": [],
        "model": config.model_id,
        "mesh_selector": mesh_selector(&config.peer_id, &config.resource_id),
    });
    let typed: models::TranscribeAudioRequest =
        serde_json::from_value(payload).map_err(|_| EngineError::InvalidRequest)?;
    serde_json::to_value(typed).map_err(|_| EngineError::InvalidRequest)
}

fn tts_payload(
    config: &NativeMeshTtsConfig,
    request: &BoundTtsSynthesisRequest,
) -> Result<Value, EngineError> {
    let voice = if request.config().logical_voice_id() == "default" {
        None
    } else {
        Some(request.config().logical_voice_id())
    };
    let payload = json!({
        "text": request.text(),
        "model_id": config.model_id,
        "voice": voice,
        "language": request.route_request().and_then(|route| route.language()),
        "speed": 1.0,
        "format": "wav",
        "sample_rate": request.config().sample_rate_hz(),
        "mesh_selector": mesh_selector(&config.peer_id, &config.resource_id),
    });
    let typed: models::TtsSynthesizeRequest =
        serde_json::from_value(payload).map_err(|_| EngineError::InvalidRequest)?;
    serde_json::to_value(typed).map_err(|_| EngineError::InvalidRequest)
}

fn mesh_selector(peer_id: &str, resource_id: &str) -> Value {
    json!({
        "peer_id": peer_id,
        "service_instance_id": resource_id,
    })
}

fn parse_stt_response(
    request: &BoundFiniteSttRequest,
    audio: &FiniteSttAudio,
    response: Value,
) -> Result<FiniteSttResult, EngineError> {
    let typed: models::TranscribeAudioResponse =
        serde_json::from_value(response).map_err(|_| provider_fault())?;
    let value = serde_json::to_value(typed).map_err(|_| provider_fault())?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(provider_fault)?;
    let model_used = value
        .get("model_used")
        .and_then(Value::as_str)
        .ok_or_else(provider_fault)?;
    let duration_ms = value
        .get("duration_ms")
        .and_then(Value::as_f64)
        .ok_or_else(provider_fault)?;
    if !valid_route_id(model_used)
        || text.len() > MAX_TRANSCRIPT_BYTES
        || text.chars().any(char::is_control)
        || !duration_ms.is_finite()
        || duration_ms < 0.0
        || (duration_ms - audio.samples().len() as f64 * 1000.0 / f64::from(audio.sample_rate_hz()))
            .abs()
            > 1.0
        || value
            .get("confidence")
            .and_then(Value::as_f64)
            .is_some_and(|confidence| !confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
    {
        return Err(provider_fault());
    }
    FiniteSttResult::new(request, audio, text).map_err(|_| provider_fault())
}

fn parse_tts_response(
    request: &BoundTtsSynthesisRequest,
    response: Value,
    max_audio_samples: usize,
) -> Result<TtsSynthesisResult, EngineError> {
    let typed: models::TtsSynthesizeResponse =
        serde_json::from_value(response).map_err(|_| provider_fault())?;
    let value = serde_json::to_value(typed).map_err(|_| provider_fault())?;
    let format = value
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(provider_fault)?;
    let sample_rate = value
        .get("sample_rate")
        .and_then(Value::as_u64)
        .ok_or_else(provider_fault)?;
    let channels = value
        .get("channels")
        .and_then(Value::as_u64)
        .ok_or_else(provider_fault)?;
    let duration_ms = value
        .get("duration_ms")
        .and_then(Value::as_f64)
        .ok_or_else(provider_fault)?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(provider_fault)?;
    let encoded = value
        .get("audio_data")
        .and_then(Value::as_str)
        .ok_or_else(provider_fault)?;
    if format != "wav"
        || sample_rate != u64::from(request.config().sample_rate_hz())
        || channels != u64::from(request.config().channels())
        || text != request.text()
        || !duration_ms.is_finite()
        || duration_ms < 0.0
    {
        return Err(provider_fault());
    }
    let bytes = decode_base64(encoded, max_audio_samples)?;
    let samples = parse_pcm16_wav(&bytes, request.config().sample_rate_hz(), max_audio_samples)?;
    let expected_duration =
        samples.len() as f64 * 1000.0 / f64::from(request.config().sample_rate_hz());
    if (duration_ms - expected_duration).abs() > 1.0 {
        return Err(provider_fault());
    }
    let chunk_samples = request.config().chunk_samples();
    let mut chunks = Vec::new();
    let chunk_count = samples.len().div_ceil(chunk_samples);
    if chunk_count == 0 || chunk_count > MAX_TTS_CHUNKS {
        return Err(EngineError::ResourceLimit);
    }
    chunks
        .try_reserve_exact(chunk_count)
        .map_err(|_| EngineError::ResourceLimit)?;
    for (index, part) in samples.chunks(chunk_samples).enumerate() {
        let sequence = u64::try_from(index)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or(EngineError::ResourceLimit)?;
        chunks.push(TtsAudioChunk::new(
            request,
            sequence,
            request.config().sample_rate_hz(),
            request.config().channels(),
            part.to_vec(),
            index + 1 == chunk_count,
        )?);
    }
    TtsSynthesisResult::new(request, chunks, false)
}

fn decode_base64(encoded: &str, max_samples: usize) -> Result<Vec<u8>, EngineError> {
    if encoded.is_empty() || encoded.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return Err(provider_fault());
    }
    let max_bytes = max_samples
        .checked_mul(PCM16_BYTES_PER_SAMPLE)
        .and_then(|size| size.checked_add(4096))
        .ok_or(EngineError::ResourceLimit)?;
    let max_encoded = max_bytes
        .checked_add(2)
        .and_then(|size| size.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or(EngineError::ResourceLimit)?;
    if encoded.len() > max_encoded {
        return Err(EngineError::ResourceLimit);
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(encoded.len() / 4 * 3)
        .map_err(|_| EngineError::ResourceLimit)?;
    base64::engine::general_purpose::STANDARD
        .decode_vec(encoded, &mut bytes)
        .map_err(|_| provider_fault())?;
    if bytes.len() > max_bytes
        || base64::engine::general_purpose::STANDARD.encode(&bytes) != encoded
    {
        return Err(provider_fault());
    }
    Ok(bytes)
}

fn parse_pcm16_wav(
    bytes: &[u8],
    sample_rate: u32,
    max_samples: usize,
) -> Result<Vec<i16>, EngineError> {
    if bytes.len() < WAV_HEADER_MIN_BYTES
        || bytes.get(0..4) != Some(b"RIFF")
        || bytes.get(8..12) != Some(b"WAVE")
        || read_u32(bytes, 4)?.checked_add(8)
            != Some(u32::try_from(bytes.len()).map_err(|_| EngineError::ResourceLimit)?)
    {
        return Err(provider_fault());
    }
    let mut offset = 12_usize;
    let mut count = 0_usize;
    let mut format_seen = false;
    let mut data: Option<std::ops::Range<usize>> = None;
    while offset < bytes.len() {
        count += 1;
        if count > WAV_MAX_CHUNKS || offset + 8 > bytes.len() {
            return Err(provider_fault());
        }
        let id = &bytes[offset..offset + 4];
        let len = usize::try_from(read_u32(bytes, offset + 4)?)
            .map_err(|_| EngineError::ResourceLimit)?;
        let start = offset + 8;
        let end = start.checked_add(len).ok_or(EngineError::ResourceLimit)?;
        if end > bytes.len() {
            return Err(provider_fault());
        }
        match id {
            b"fmt " => {
                if format_seen
                    || len != 16
                    || read_u16(bytes, start)? != 1
                    || read_u16(bytes, start + 2)? != 1
                    || read_u32(bytes, start + 4)? != sample_rate
                    || read_u32(bytes, start + 8)?
                        != sample_rate
                            .checked_mul(2)
                            .ok_or(EngineError::ResourceLimit)?
                    || read_u16(bytes, start + 12)? != 2
                    || read_u16(bytes, start + 14)? != 16
                {
                    return Err(provider_fault());
                }
                format_seen = true;
            }
            b"data" => {
                if data.is_some() || len == 0 || len % 2 != 0 || len / 2 > max_samples {
                    return Err(provider_fault());
                }
                data = Some(start..end);
            }
            _ => {}
        }
        offset = end.checked_add(len % 2).ok_or(EngineError::ResourceLimit)?;
    }
    let range = data.ok_or_else(provider_fault)?;
    if offset != bytes.len() || !format_seen {
        return Err(provider_fault());
    }
    Ok(bytes[range]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, EngineError> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or_else(provider_fault)?
            .try_into()
            .map_err(|_| provider_fault())?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, EngineError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or_else(provider_fault)?
            .try_into()
            .map_err(|_| provider_fault())?,
    ))
}

fn valid_route_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

fn valid_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| match index {
            0 => byte.is_ascii_alphanumeric(),
            _ => byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte),
        })
}

fn valid_language(value: &str) -> bool {
    if value.len() < 2 || value.len() > 255 || value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return false;
    }
    let mut parts = value.split('-');
    let Some(primary) = parts.next() else {
        return false;
    };
    let primary_ok =
        (2..=8).contains(&primary.len()) && primary.bytes().all(|byte| byte.is_ascii_lowercase());
    if primary_ok {
        return parts.all(|part| {
            !part.is_empty()
                && part.len() <= 8
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        });
    }
    matches!(primary, "i" | "x")
        && parts.clone().next().is_some()
        && parts.all(|part| {
            !part.is_empty()
                && part.len() <= 8
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn valid_voice_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("standard:") else {
        return value.strip_prefix("clone:").is_some_and(|uuid| {
            uuid.len() == 36
                && uuid.bytes().enumerate().all(|(index, byte)| match index {
                    8 | 13 | 18 | 23 => byte == b'-',
                    _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
                })
        });
    };
    let mut parts = rest.split(':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(namespace), Some(voice), None) => [namespace, voice].into_iter().all(|part| {
            !part.is_empty()
                && part.len() <= 64
                && part.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                })
        }),
        _ => false,
    }
}

fn new_request_id(stage: &str, generation: u64) -> String {
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("native-speech-{stage}-{generation}-{sequence}")
}

fn map_transport_error(error: TransportError) -> EngineError {
    match error {
        TransportError::Cancelled => EngineError::Cancelled,
        TransportError::RequestTooLarge
        | TransportError::ResponseTooLarge
        | TransportError::EventTooLarge => EngineError::ResourceLimit,
        TransportError::Timeout => EngineError::ProviderFault {
            code: EngineFaultCode::Timeout,
        },
        TransportError::RequestFailed | TransportError::HttpStatus { .. } => {
            EngineError::ProviderFault {
                code: EngineFaultCode::HostUnavailable,
            }
        }
        TransportError::InvalidConfiguration
        | TransportError::UnsafeEndpoint
        | TransportError::UnknownMethod
        | TransportError::UnknownEvent
        | TransportError::InvalidPayload
        | TransportError::RemoteAudioBlocked
        | TransportError::InvalidResponse
        | TransportError::InvalidStream => provider_fault(),
    }
}

fn provider_fault() -> EngineError {
    EngineError::ProviderFault {
        code: EngineFaultCode::Provider,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_voice_engine::{RouteTtsSynthesisRequest, TtsSynthesisConfig};

    fn route(name: &str) -> RouteTtsBinding {
        RouteTtsBinding::new(name, "mesh.default", 16_000, 3).expect("route")
    }

    fn request(route: RouteTtsBinding) -> BoundTtsSynthesisRequest {
        let route_request = RouteTtsSynthesisRequest::new(route, None, 7).expect("route request");
        let config = TtsSynthesisConfig::new("default", "mesh.default", 16_000, 1_024, None)
            .expect("synthesis config");
        BoundTtsSynthesisRequest::new_route(route_request, "hello aurora", config)
            .expect("bound synthesis request")
    }

    #[test]
    fn mesh_tts_payload_keeps_selected_model_exact_resource_and_rejects_route_mismatch() {
        let selected_route = route("mesh.tts");
        let config = NativeMeshTtsConfig::new(
            selected_route.clone(),
            "peer-123",
            "remote:peer-123:TTS",
            Some("model:sha256:0123456789abcdef".to_owned()),
            None,
            None,
            TransportLimits::default(),
            16_000 * MAX_TTS_DURATION_SECONDS,
        )
        .expect("valid selected mesh TTS config");
        let selected_request = request(selected_route);
        validate_tts_request(&config, &selected_request).expect("matching route binding");
        let payload = tts_payload(&config, &selected_request).expect("typed mesh TTS payload");
        assert_eq!(payload["model_id"], "model:sha256:0123456789abcdef");
        assert!(payload["voice"].is_null());
        assert_eq!(payload["mesh_selector"]["peer_id"], "peer-123");
        assert_eq!(
            payload["mesh_selector"]["service_instance_id"],
            "remote:peer-123:TTS"
        );

        let mismatched_request = request(route("mesh.other"));
        assert!(matches!(
            validate_tts_request(&config, &mismatched_request),
            Err(EngineError::InvalidRequest)
        ));
    }
}
