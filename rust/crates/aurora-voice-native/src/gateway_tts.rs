//! Native Gateway-backed finite TTS synthesis adapter.

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use aurora_contracts::{ids, models};
use aurora_voice_core::CancellationToken;
use aurora_voice_engine::{
    BoundTtsSynthesisRequest, EngineError, EngineFaultCode, RouteTtsBinding, TtsAudioChunk,
    TtsSynthesisPort, TtsSynthesisProviderBinding, TtsSynthesisResult,
};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::{NativeGatewayTransport, NativeRequestOptions, TransportError};

const GATEWAY_TTS_POLL_INTERVAL: Duration = Duration::from_millis(5);
const WAV_HEADER_MIN_BYTES: usize = 44;
const WAV_MAX_CHUNKS: usize = 32;
const MAX_TTS_DURATION_SECONDS: usize = 30;
const PCM_FORMAT: u16 = 1;
const MONO_CHANNELS: u16 = 1;
const PCM16_BITS_PER_SAMPLE: u16 = 16;
const PCM16_BYTES_PER_SAMPLE: usize = 2;
const TTS_REQUEST_ID_PREFIX: &str = "native-tts";

/// Route and bounds for a Gateway-backed synthesis provider.
#[derive(Clone, PartialEq)]
pub struct NativeGatewayTtsConfig {
    route: RouteTtsBinding,
    voice: Option<String>,
    speed: f64,
    max_audio_samples: usize,
}

impl NativeGatewayTtsConfig {
    pub fn new(
        route: RouteTtsBinding,
        voice: Option<String>,
        speed: f64,
        max_audio_samples: usize,
    ) -> Result<Self, EngineError> {
        route.validate()?;
        let max_allowed_samples = usize::try_from(route.sample_rate_hz())
            .ok()
            .and_then(|sample_rate| sample_rate.checked_mul(MAX_TTS_DURATION_SECONDS))
            .ok_or(EngineError::ResourceLimit)?;
        if !speed.is_finite()
            || !(0.25..=4.0).contains(&speed)
            || max_audio_samples == 0
            || max_audio_samples > max_allowed_samples
        {
            return Err(EngineError::InvalidRequest);
        }
        if voice.as_deref().is_some_and(|value| !valid_voice_id(value)) {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            route,
            voice,
            speed,
            max_audio_samples,
        })
    }

    pub fn route(&self) -> &RouteTtsBinding {
        &self.route
    }

    pub fn max_audio_samples(&self) -> usize {
        self.max_audio_samples
    }

    pub fn voice(&self) -> Option<&str> {
        self.voice.as_deref()
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }
}

impl fmt::Debug for NativeGatewayTtsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayTtsConfig")
            .field("route", &self.route)
            .field("voice_present", &self.voice.is_some())
            .field("speed", &self.speed)
            .field("max_audio_samples", &self.max_audio_samples)
            .finish()
    }
}

/// Finite TTS adapter that routes synthesis to the typed Gateway API.
pub struct NativeGatewayTtsSynthesizer {
    transport: NativeGatewayTransport,
    config: NativeGatewayTtsConfig,
    active_generation: Option<u64>,
    active_cancellation: Option<CancellationToken>,
}

impl NativeGatewayTtsSynthesizer {
    pub fn new(transport: NativeGatewayTransport, config: NativeGatewayTtsConfig) -> Self {
        Self {
            transport,
            config,
            active_generation: None,
            active_cancellation: None,
        }
    }

    fn validate_request(&self, request: &BoundTtsSynthesisRequest) -> Result<(), EngineError> {
        let route_request = request.route_request().ok_or(EngineError::InvalidRequest)?;
        if route_request.route() != self.config.route()
            || request.config().seed().is_some()
            || route_request
                .language()
                .is_some_and(|language| !valid_gateway_language(language))
            || self
                .config
                .voice
                .as_deref()
                .map_or(request.config().logical_voice_id() != "default", |voice| {
                    request.config().logical_voice_id() != voice
                })
        {
            return Err(EngineError::InvalidRequest);
        }
        request.config().validate_route(self.config.route())?;
        Ok(())
    }

    fn request_options(
        route_revision: u64,
        generation: u64,
    ) -> Result<NativeRequestOptions, EngineError> {
        NativeRequestOptions::new(format!(
            "{TTS_REQUEST_ID_PREFIX}-{route_revision}-{generation}"
        ))
        .map_err(map_transport_error)
        .and_then(|options| {
            options
                .with_idempotency_key(format!(
                    "{TTS_REQUEST_ID_PREFIX}-generation-{route_revision}-{generation}"
                ))
                .map_err(map_transport_error)
        })
    }
}

impl fmt::Debug for NativeGatewayTtsSynthesizer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayTtsSynthesizer")
            .field("config", &self.config)
            .field("active_generation", &self.active_generation)
            .field("active_cancellation", &self.active_cancellation.is_some())
            .finish_non_exhaustive()
    }
}

#[async_trait(?Send)]
impl TtsSynthesisPort for NativeGatewayTtsSynthesizer {
    fn synthesis_binding(&self) -> Result<TtsSynthesisProviderBinding, EngineError> {
        Ok(TtsSynthesisProviderBinding::Route(
            self.config.route().clone(),
        ))
    }

    async fn warm_synthesis(
        &mut self,
        binding: TtsSynthesisProviderBinding,
    ) -> Result<(), EngineError> {
        match binding {
            TtsSynthesisProviderBinding::Route(route) if route == *self.config.route() => Ok(()),
            TtsSynthesisProviderBinding::Route(_) | TtsSynthesisProviderBinding::LocalTask(_) => {
                Err(EngineError::TaskUnavailable)
            }
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
        self.validate_request(&request)?;
        if cancellation() {
            return Err(EngineError::Cancelled);
        }

        let generation = request.generation();
        self.active_generation = Some(generation);
        let gateway_cancellation = CancellationToken::new();
        self.active_cancellation = Some(gateway_cancellation.clone());

        let result = self
            .invoke_synthesis(&request, &gateway_cancellation, cancellation)
            .await;

        if self.active_generation == Some(generation) {
            self.active_generation = None;
            self.active_cancellation = None;
        }
        result
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

impl NativeGatewayTtsSynthesizer {
    async fn invoke_synthesis(
        &self,
        request: &BoundTtsSynthesisRequest,
        gateway_cancellation: &CancellationToken,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<TtsSynthesisResult, EngineError> {
        let route_request = request.route_request().ok_or(EngineError::InvalidRequest)?;
        let options =
            Self::request_options(route_request.route().route_revision(), request.generation())?;
        let payload = tts_payload(request, route_request.language(), &self.config)?;
        let invoke = self.transport.invoke_generated(
            ids::TTS_SYNTHESIZE,
            payload,
            &options,
            gateway_cancellation,
        );
        tokio::pin!(invoke);

        let response = loop {
            tokio::select! {
                result = &mut invoke => break result.map_err(map_transport_error)?,
                () = tokio::time::sleep(GATEWAY_TTS_POLL_INTERVAL) => {
                    if cancellation() {
                        gateway_cancellation.cancel();
                        return Err(EngineError::Cancelled);
                    }
                }
            }
        };

        if cancellation() {
            gateway_cancellation.cancel();
            return Err(EngineError::Cancelled);
        }

        parse_tts_response(request, &response, self.config.max_audio_samples())
    }
}

fn tts_payload(
    request: &BoundTtsSynthesisRequest,
    language: Option<&str>,
    config: &NativeGatewayTtsConfig,
) -> Result<Value, EngineError> {
    let payload = json!({
        "text": request.text(),
        "voice": config.voice,
        "language": language,
        "speed": config.speed,
        "format": "wav",
        "sample_rate": request.config().sample_rate_hz(),
        "mesh_selector": Value::Null,
    });
    let typed: models::TtsSynthesizeRequest =
        serde_json::from_value(payload).map_err(|_| EngineError::InvalidRequest)?;
    serde_json::to_value(typed).map_err(|_| EngineError::InvalidRequest)
}

fn parse_tts_response(
    request: &BoundTtsSynthesisRequest,
    response: &Value,
    max_audio_samples: usize,
) -> Result<TtsSynthesisResult, EngineError> {
    let typed: models::TtsSynthesizeResponse =
        serde_json::from_value(response.clone()).map_err(|_| provider_fault())?;
    let value = serde_json::to_value(typed).map_err(|_| provider_fault())?;
    let text = required_str(&value, "text")?;
    let format = required_str(&value, "format")?;
    let sample_rate = required_u64(&value, "sample_rate")?;
    let channels = required_u64(&value, "channels")?;
    let duration_ms = required_f64(&value, "duration_ms")?;
    if text != request.text()
        || format != "wav"
        || sample_rate != u64::from(request.config().sample_rate_hz())
        || channels != u64::from(request.config().channels())
        || !duration_ms.is_finite()
        || duration_ms < 0.0
    {
        return Err(provider_fault());
    }

    let encoded_audio = required_str(&value, "audio_data")?;
    let audio = decode_strict_base64(encoded_audio, max_audio_samples)?;
    let samples =
        parse_pcm16_mono_wav(&audio, request.config().sample_rate_hz(), max_audio_samples)?;
    validate_duration(
        duration_ms,
        samples.len(),
        request.config().sample_rate_hz(),
    )?;
    let chunks = tts_chunks(request, samples)?;
    TtsSynthesisResult::new(request, chunks, false)
}

fn decode_strict_base64(encoded: &str, max_audio_samples: usize) -> Result<Vec<u8>, EngineError> {
    if encoded.is_empty() || encoded.as_bytes().iter().any(u8::is_ascii_whitespace) {
        return Err(provider_fault());
    }
    let max_wav_bytes = max_audio_samples
        .checked_mul(PCM16_BYTES_PER_SAMPLE)
        .and_then(|bytes| bytes.checked_add(4096))
        .ok_or(EngineError::ResourceLimit)?;
    let max_encoded = max_wav_bytes
        .checked_add(2)
        .and_then(|bytes| bytes.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or(EngineError::ResourceLimit)?;
    if encoded.len() > max_encoded {
        return Err(EngineError::ResourceLimit);
    }
    let decoded_capacity = encoded
        .len()
        .checked_div(4)
        .and_then(|groups| groups.checked_mul(3))
        .ok_or(EngineError::ResourceLimit)?;
    let mut decoded = Vec::new();
    decoded
        .try_reserve_exact(decoded_capacity)
        .map_err(|_| EngineError::ResourceLimit)?;
    base64::engine::general_purpose::STANDARD
        .decode_vec(encoded, &mut decoded)
        .map_err(|_| provider_fault())?;
    if decoded.len() > max_wav_bytes
        || base64::engine::general_purpose::STANDARD.encode(&decoded) != encoded
    {
        return Err(provider_fault());
    }
    Ok(decoded)
}

fn parse_pcm16_mono_wav(
    bytes: &[u8],
    sample_rate_hz: u32,
    max_audio_samples: usize,
) -> Result<Vec<i16>, EngineError> {
    if bytes.len() < WAV_HEADER_MIN_BYTES
        || bytes.get(0..4) != Some(b"RIFF")
        || bytes.get(8..12) != Some(b"WAVE")
    {
        return Err(provider_fault());
    }
    let declared_len = read_u32_le(bytes, 4)? as usize;
    if declared_len.checked_add(8) != Some(bytes.len()) {
        return Err(provider_fault());
    }

    let mut offset = 12_usize;
    let mut chunk_count = 0_usize;
    let mut fmt_seen = false;
    let mut data_seen = false;
    let mut data_range = 0..0;
    while offset < bytes.len() {
        chunk_count = chunk_count
            .checked_add(1)
            .ok_or(EngineError::ResourceLimit)?;
        if chunk_count > WAV_MAX_CHUNKS || offset.checked_add(8).is_none_or(|end| end > bytes.len())
        {
            return Err(provider_fault());
        }
        let id = bytes.get(offset..offset + 4).ok_or_else(provider_fault)?;
        let len = read_u32_le(bytes, offset + 4)? as usize;
        let data_start = offset.checked_add(8).ok_or(EngineError::ResourceLimit)?;
        let data_end = data_start
            .checked_add(len)
            .ok_or(EngineError::ResourceLimit)?;
        if data_end > bytes.len() {
            return Err(provider_fault());
        }
        match id {
            b"fmt " => {
                if fmt_seen || len != 16 {
                    return Err(provider_fault());
                }
                fmt_seen = true;
                validate_fmt_chunk(&bytes[data_start..data_end], sample_rate_hz)?;
            }
            b"data" => {
                if data_seen || len == 0 || len % PCM16_BYTES_PER_SAMPLE != 0 {
                    return Err(provider_fault());
                }
                let samples = len / PCM16_BYTES_PER_SAMPLE;
                if samples > max_audio_samples {
                    return Err(EngineError::ResourceLimit);
                }
                data_seen = true;
                data_range = data_start..data_end;
            }
            _ => {}
        }
        let padded_len = len.checked_add(len % 2).ok_or(EngineError::ResourceLimit)?;
        offset = data_start
            .checked_add(padded_len)
            .ok_or(EngineError::ResourceLimit)?;
    }
    if offset != bytes.len() || !fmt_seen || !data_seen {
        return Err(provider_fault());
    }

    let sample_count = data_range.len() / PCM16_BYTES_PER_SAMPLE;
    let mut samples = Vec::new();
    samples
        .try_reserve_exact(sample_count)
        .map_err(|_| EngineError::ResourceLimit)?;
    for chunk in bytes[data_range].chunks_exact(PCM16_BYTES_PER_SAMPLE) {
        samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }
    Ok(samples)
}

fn validate_fmt_chunk(chunk: &[u8], sample_rate_hz: u32) -> Result<(), EngineError> {
    let audio_format = read_u16_le(chunk, 0)?;
    let channels = read_u16_le(chunk, 2)?;
    let sample_rate = read_u32_le(chunk, 4)?;
    let byte_rate = read_u32_le(chunk, 8)?;
    let block_align = read_u16_le(chunk, 12)?;
    let bits_per_sample = read_u16_le(chunk, 14)?;
    let expected_byte_rate = sample_rate_hz
        .checked_mul(u32::from(MONO_CHANNELS) * 2)
        .ok_or(EngineError::ResourceLimit)?;
    if audio_format != PCM_FORMAT
        || channels != MONO_CHANNELS
        || sample_rate != sample_rate_hz
        || byte_rate != expected_byte_rate
        || block_align != MONO_CHANNELS * 2
        || bits_per_sample != PCM16_BITS_PER_SAMPLE
    {
        return Err(provider_fault());
    }
    Ok(())
}

fn validate_duration(
    duration_ms: f64,
    samples: usize,
    sample_rate_hz: u32,
) -> Result<(), EngineError> {
    let expected = samples as f64 * 1000.0 / f64::from(sample_rate_hz);
    if (duration_ms - expected).abs() > 1.0 {
        return Err(provider_fault());
    }
    Ok(())
}

fn tts_chunks(
    request: &BoundTtsSynthesisRequest,
    samples: Vec<i16>,
) -> Result<Vec<TtsAudioChunk>, EngineError> {
    if samples.is_empty() {
        return Err(EngineError::InvalidRequest);
    }
    let chunk_samples = request.config().chunk_samples();
    let mut chunks = Vec::new();
    chunks
        .try_reserve_exact(samples.len().div_ceil(chunk_samples))
        .map_err(|_| EngineError::ResourceLimit)?;
    for (index, chunk) in samples.chunks(chunk_samples).enumerate() {
        let sequence = u64::try_from(index)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or(EngineError::ResourceLimit)?;
        let mut owned = Vec::new();
        owned
            .try_reserve_exact(chunk.len())
            .map_err(|_| EngineError::ResourceLimit)?;
        owned.extend_from_slice(chunk);
        chunks.push(TtsAudioChunk::new(
            request,
            sequence,
            request.config().sample_rate_hz(),
            request.config().channels(),
            owned,
            index == samples.len().saturating_sub(1) / chunk_samples,
        )?);
    }
    Ok(chunks)
}

fn valid_gateway_language(value: &str) -> bool {
    matches!(
        value,
        "de" | "en" | "es" | "fr" | "it" | "ja" | "ko" | "pt" | "zh"
    )
}

fn valid_voice_id(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix("standard:") {
        let mut parts = rest.split(':');
        let Some(namespace) = parts.next() else {
            return false;
        };
        let Some(name) = parts.next() else {
            return false;
        };
        return parts.next().is_none()
            && valid_voice_component(namespace)
            && valid_voice_component(name);
    }
    value
        .strip_prefix("clone:")
        .is_some_and(valid_lower_hex_uuid_v1_to_v5)
}

fn valid_voice_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

fn valid_lower_hex_uuid_v1_to_v5(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.get(8) == Some(&b'-')
        && bytes.get(13) == Some(&b'-')
        && matches!(bytes.get(14), Some(b'1'..=b'5'))
        && bytes.get(18) == Some(&b'-')
        && matches!(bytes.get(19), Some(b'8' | b'9' | b'a' | b'b'))
        && bytes.get(23) == Some(&b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                || byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
        })
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, EngineError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(EngineError::InvalidRequest)
}

fn required_u64(value: &Value, field: &str) -> Result<u64, EngineError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or(EngineError::InvalidRequest)
}

fn required_f64(value: &Value, field: &str) -> Result<f64, EngineError> {
    value
        .get(field)
        .and_then(Value::as_f64)
        .ok_or(EngineError::InvalidRequest)
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Result<u16, EngineError> {
    let end = offset.checked_add(2).ok_or(EngineError::ResourceLimit)?;
    let value = bytes.get(offset..end).ok_or(EngineError::InvalidRequest)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, EngineError> {
    let end = offset.checked_add(4).ok_or(EngineError::ResourceLimit)?;
    let value = bytes.get(offset..end).ok_or(EngineError::InvalidRequest)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
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
        | TransportError::InvalidStream => EngineError::ProviderFault {
            code: EngineFaultCode::Provider,
        },
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
    use aurora_voice_engine::{
        BoundTtsSynthesisRequest, RouteTtsSynthesisRequest, TtsSynthesisConfig,
    };
    use std::io::{Read, Write};
    use std::net::SocketAddr;
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;
    use url::Url;

    struct FixtureServer {
        base_url: Url,
        address: SocketAddr,
        request: mpsc::Receiver<String>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl FixtureServer {
        fn one_response(response: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
            let address = listener.local_addr().expect("fixture address");
            let (sender, request) = mpsc::channel();
            let thread = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept fixture request");
                let captured = read_http_request(&mut stream);
                sender.send(captured).expect("capture request");
                stream.write_all(&response).expect("write fixture response");
            });
            Self {
                base_url: Url::parse(&format!("http://{address}/")).expect("fixture URL"),
                address,
                request,
                thread: Some(thread),
            }
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            if let Some(thread) = self.thread.take() {
                let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(50));
                thread.join().expect("join fixture server");
            }
        }
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = stream.read(&mut buffer).expect("read fixture request");
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn json_response(body: Value) -> Vec<u8> {
        let body = body.to_string();
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes()
        .into_iter()
        .chain(body.into_bytes())
        .collect()
    }

    fn loopback_transport(base_url: Url) -> NativeGatewayTransport {
        NativeGatewayTransport::new(
            base_url,
            crate::GatewayAuth::Bearer("native-secret".to_owned()),
            crate::TransportLimits {
                allow_loopback_http: true,
                ..crate::TransportLimits::default()
            },
        )
        .expect("transport")
    }

    fn unused_loopback_transport() -> NativeGatewayTransport {
        loopback_transport(Url::parse("http://127.0.0.1:9/").expect("loopback URL"))
    }

    fn route() -> RouteTtsBinding {
        RouteTtsBinding::new("gateway.default", "voice.default", 16_000, 3).expect("route")
    }

    fn config() -> NativeGatewayTtsConfig {
        NativeGatewayTtsConfig::new(route(), None, 1.0, 16_000).expect("config")
    }

    fn request(generation: u64, chunk_samples: usize) -> BoundTtsSynthesisRequest {
        let route_request =
            RouteTtsSynthesisRequest::new(route(), Some("en".to_owned()), generation)
                .expect("route request");
        let config =
            TtsSynthesisConfig::new("default", "voice.default", 16_000, chunk_samples, None)
                .expect("tts config");
        BoundTtsSynthesisRequest::new_route(route_request, "hello aurora", config)
            .expect("bound request")
    }

    fn wav(samples: &[i16], sample_rate_hz: u32) -> Vec<u8> {
        let data_len = samples.len() * PCM16_BYTES_PER_SAMPLE;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36_u32 + data_len as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&PCM_FORMAT.to_le_bytes());
        bytes.extend_from_slice(&MONO_CHANNELS.to_le_bytes());
        bytes.extend_from_slice(&sample_rate_hz.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate_hz * 2).to_le_bytes());
        bytes.extend_from_slice(&(MONO_CHANNELS * 2).to_le_bytes());
        bytes.extend_from_slice(&PCM16_BITS_PER_SAMPLE.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data_len as u32).to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn success_body(samples: &[i16]) -> Value {
        let encoded = base64::engine::general_purpose::STANDARD.encode(wav(samples, 16_000));
        json!({
            "audio_data": encoded,
            "channels": 1,
            "duration_ms": samples.len() as f64 * 1000.0 / 16_000.0,
            "format": "wav",
            "sample_rate": 16_000,
            "text": "hello aurora",
        })
    }

    fn request_body(request: &str) -> Value {
        let (_, body) = request.split_once("\r\n\r\n").expect("request body");
        serde_json::from_str(body).expect("JSON body")
    }

    #[tokio::test]
    async fn route_tts_posts_typed_generated_request_and_chunks_wav() {
        let samples = (0..1025).map(|sample| sample as i16).collect::<Vec<_>>();
        let server = FixtureServer::one_response(json_response(success_body(&samples)));
        let mut adapter =
            NativeGatewayTtsSynthesizer::new(loopback_transport(server.base_url.clone()), config());
        let request = request(42, 1024);

        let result = adapter
            .synthesize_text(request, &|| false)
            .await
            .expect("synthesis");

        assert_eq!(result.chunk_count(), 2);
        assert!(!result.cancelled());
        assert_eq!(result.chunks()[0].samples().len(), 1024);
        assert_eq!(result.chunks()[0].sequence(), 1);
        assert!(!result.chunks()[0].final_chunk());
        assert_eq!(result.chunks()[1].samples(), &[1024]);
        assert!(result.chunks()[1].final_chunk());

        let captured = server.request.recv().expect("captured request");
        assert!(captured.starts_with("POST /api/TTS/Synthesize HTTP/1.1"));
        assert!(captured.contains("authorization: Bearer native-secret"));
        let body = request_body(&captured);
        assert_eq!(
            body.get("text").and_then(Value::as_str),
            Some("hello aurora")
        );
        assert_eq!(body.get("format").and_then(Value::as_str), Some("wav"));
        assert_eq!(
            body.get("sample_rate").and_then(Value::as_u64),
            Some(16_000)
        );
        assert_eq!(body.get("language").and_then(Value::as_str), Some("en"));
    }

    #[test]
    fn parser_rejects_noncanonical_and_oversize_audio_before_samples_escape() {
        let request = request(7, 1024);
        let mut body = success_body(&[0, 1, 2]);
        body["audio_data"] = Value::String("AA==\n".to_owned());
        assert_eq!(
            parse_tts_response(&request, &body, 16_000),
            Err(provider_fault())
        );

        let encoded = base64::engine::general_purpose::STANDARD.encode(wav(&[0, 1, 2, 3], 16_000));
        body["audio_data"] = Value::String(encoded);
        assert_eq!(
            parse_tts_response(&request, &body, 3),
            Err(EngineError::ResourceLimit)
        );
    }

    #[test]
    fn parser_rejects_bad_wav_identity_and_duration() {
        let request = request(7, 1024);
        let mut body = success_body(&[0, 1, 2]);
        body["sample_rate"] = Value::from(24_000);
        assert_eq!(
            parse_tts_response(&request, &body, 16_000),
            Err(provider_fault())
        );

        let mut body = success_body(&[0, 1, 2]);
        body["duration_ms"] = Value::from(500.0);
        assert_eq!(
            parse_tts_response(&request, &body, 16_000),
            Err(provider_fault())
        );
    }

    #[tokio::test]
    async fn cancellation_stops_request_without_payload_leaks() {
        let mut adapter = NativeGatewayTtsSynthesizer::new(unused_loopback_transport(), config());
        let request = request(9, 1024);

        let cancelled = adapter
            .synthesize_text(request, &|| true)
            .await
            .expect_err("cancelled");

        assert_eq!(cancelled, EngineError::Cancelled);
        let debug = format!("{adapter:?}");
        assert!(!debug.contains("native-secret"));
        assert!(!debug.contains("hello aurora"));
    }

    #[tokio::test]
    async fn stale_binding_generation_and_cleanup_are_idempotent() {
        let mut adapter = NativeGatewayTtsSynthesizer::new(unused_loopback_transport(), config());
        let bad_route =
            RouteTtsBinding::new("gateway.other", "voice.default", 16_000, 3).expect("route");

        assert_eq!(
            adapter
                .warm_synthesis(TtsSynthesisProviderBinding::Route(bad_route))
                .await,
            Err(EngineError::TaskUnavailable)
        );
        assert_eq!(adapter.cancel_synthesis_generation(123).await, Ok(()));
        assert_eq!(adapter.cancel_synthesis_generation(123).await, Ok(()));
    }

    #[tokio::test]
    async fn cancellation_token_can_abort_active_generation_cleanup() {
        let mut adapter = NativeGatewayTtsSynthesizer::new(unused_loopback_transport(), config());
        adapter.active_generation = Some(77);
        adapter.active_cancellation = Some(CancellationToken::new());
        adapter
            .cancel_synthesis_generation(77)
            .await
            .expect("cancel");
        assert_eq!(adapter.active_generation, None);
        assert!(adapter.active_cancellation.is_none());
    }
}
