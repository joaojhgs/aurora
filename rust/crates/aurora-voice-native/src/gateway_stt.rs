//! Native Gateway-backed finite STT adapter.

use std::fmt;
use std::time::Duration;

use async_trait::async_trait;
use aurora_contracts::{ids, models};
use aurora_voice_core::CancellationToken;
use aurora_voice_engine::{
    BoundFiniteSttRequest, EngineError, EngineFaultCode, FiniteSttAudio, FiniteSttPort,
    FiniteSttProviderBinding, FiniteSttResult, FiniteSttRouteScope, RouteFiniteSttBinding,
};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::{
    MicrophoneAudioPolicy, NativeGatewayEndpointClass, NativeGatewayMicrophoneAudioProfile,
    NativeGatewayTransport, NativeRequestOptions, TransportError,
};

const GATEWAY_STT_POLL_INTERVAL: Duration = Duration::from_millis(5);
const PCM16_BYTES_PER_SAMPLE: usize = 2;
const STT_REQUEST_ID_PREFIX: &str = "native-stt";
const DEFAULT_STT_MODEL: &str = "realtime";

/// Route, model, and microphone-policy binding for Gateway finite STT.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeGatewayFiniteSttConfig {
    route: RouteFiniteSttBinding,
    model: String,
    microphone_audio_policy: MicrophoneAudioPolicy,
}

impl NativeGatewayFiniteSttConfig {
    pub fn new(
        route: RouteFiniteSttBinding,
        model: impl Into<String>,
        microphone_audio_policy: MicrophoneAudioPolicy,
    ) -> Result<Self, EngineError> {
        route.validate()?;
        let model = model.into();
        if !valid_identifier(&model)
            || !route_policy_matches(route.route_scope(), microphone_audio_policy)
        {
            return Err(EngineError::InvalidRequest);
        }
        Ok(Self {
            route,
            model,
            microphone_audio_policy,
        })
    }

    pub fn realtime(
        route: RouteFiniteSttBinding,
        microphone_audio_policy: MicrophoneAudioPolicy,
    ) -> Result<Self, EngineError> {
        Self::new(route, DEFAULT_STT_MODEL, microphone_audio_policy)
    }

    pub fn route(&self) -> &RouteFiniteSttBinding {
        &self.route
    }

    pub fn microphone_audio_policy(&self) -> MicrophoneAudioPolicy {
        self.microphone_audio_policy
    }
}

impl fmt::Debug for NativeGatewayFiniteSttConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayFiniteSttConfig")
            .field("route", &self.route)
            .field("model_bytes", &self.model.len())
            .field("microphone_audio_policy", &self.microphone_audio_policy)
            .finish()
    }
}

/// Finite STT adapter that routes complete captured audio to the typed Gateway API.
pub struct NativeGatewayFiniteStt {
    transport: NativeGatewayTransport,
    config: NativeGatewayFiniteSttConfig,
    active_generation: Option<u64>,
    active_cancellation: Option<CancellationToken>,
}

impl NativeGatewayFiniteStt {
    pub fn new(
        transport: NativeGatewayTransport,
        config: NativeGatewayFiniteSttConfig,
    ) -> Result<Self, EngineError> {
        validate_transport_profile(
            config.route.route_scope(),
            transport.microphone_audio_profile(),
        )?;
        Ok(Self {
            transport,
            config,
            active_generation: None,
            active_cancellation: None,
        })
    }

    fn validate_request(
        &self,
        request: &BoundFiniteSttRequest,
        audio: &FiniteSttAudio,
    ) -> Result<(), EngineError> {
        let route_request = request.route_request().ok_or(EngineError::InvalidRequest)?;
        if route_request.route() != self.config.route()
            || route_request.generation() != request.generation()
            || audio.generation() != request.generation()
            || audio.frames() != request.frames()
            || audio.sample_rate_hz() != self.config.route.sample_rate_hz()
            || audio.channels() != self.config.route.channels()
            || audio.samples().len() > self.config.route.max_audio_samples()
            || route_request
                .language()
                .is_some_and(|language| !valid_gateway_language(language))
        {
            return Err(EngineError::InvalidRequest);
        }
        if !route_policy_matches(
            route_request.route().route_scope(),
            self.config.microphone_audio_policy,
        ) {
            return Err(EngineError::InvalidRequest);
        }
        validate_transport_profile(
            route_request.route().route_scope(),
            self.transport.microphone_audio_profile(),
        )?;
        Ok(())
    }

    fn request_options(
        route_revision: u64,
        generation: u64,
    ) -> Result<NativeRequestOptions, EngineError> {
        NativeRequestOptions::new(format!(
            "{STT_REQUEST_ID_PREFIX}-{route_revision}-{generation}"
        ))
        .map_err(map_transport_error)
        .and_then(|options| {
            options
                .with_idempotency_key(format!(
                    "{STT_REQUEST_ID_PREFIX}-generation-{route_revision}-{generation}"
                ))
                .map_err(map_transport_error)
        })
    }
}

impl fmt::Debug for NativeGatewayFiniteStt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGatewayFiniteStt")
            .field("config", &self.config)
            .field("active_generation", &self.active_generation)
            .field("active_cancellation", &self.active_cancellation.is_some())
            .finish_non_exhaustive()
    }
}

#[async_trait(?Send)]
impl FiniteSttPort for NativeGatewayFiniteStt {
    fn finite_stt_binding(&self) -> Result<FiniteSttProviderBinding, EngineError> {
        Ok(FiniteSttProviderBinding::Route(self.config.route().clone()))
    }

    async fn warm_finite_stt(
        &mut self,
        binding: FiniteSttProviderBinding,
    ) -> Result<(), EngineError> {
        match binding {
            FiniteSttProviderBinding::Route(route) if route == *self.config.route() => Ok(()),
            FiniteSttProviderBinding::Route(_) | FiniteSttProviderBinding::LocalTask(_) => {
                Err(EngineError::TaskUnavailable)
            }
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
        self.validate_request(&request, &audio)?;
        if cancellation() {
            return Err(EngineError::Cancelled);
        }

        let generation = request.generation();
        self.active_generation = Some(generation);
        let gateway_cancellation = CancellationToken::new();
        self.active_cancellation = Some(gateway_cancellation.clone());

        let result = self
            .invoke_transcription(&request, &audio, &gateway_cancellation, cancellation)
            .await;

        if self.active_generation == Some(generation) {
            self.active_generation = None;
            self.active_cancellation = None;
        }
        result
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

impl NativeGatewayFiniteStt {
    async fn invoke_transcription(
        &self,
        request: &BoundFiniteSttRequest,
        audio: &FiniteSttAudio,
        gateway_cancellation: &CancellationToken,
        cancellation: &dyn Fn() -> bool,
    ) -> Result<FiniteSttResult, EngineError> {
        let route_request = request.route_request().ok_or(EngineError::InvalidRequest)?;
        let options =
            Self::request_options(route_request.route().route_revision(), request.generation())?;
        let payload = stt_payload(request, audio, route_request.language(), &self.config)?;
        let invoke = self.transport.invoke_generated(
            ids::TRANSCRIPTION_TRANSCRIBE,
            payload,
            &options,
            gateway_cancellation,
        );
        tokio::pin!(invoke);

        let response = loop {
            tokio::select! {
                result = &mut invoke => break result.map_err(map_transport_error)?,
                () = tokio::time::sleep(GATEWAY_STT_POLL_INTERVAL) => {
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

        parse_stt_response(request, audio, &response)
    }
}

fn stt_payload(
    request: &BoundFiniteSttRequest,
    audio: &FiniteSttAudio,
    language: Option<&str>,
    config: &NativeGatewayFiniteSttConfig,
) -> Result<Value, EngineError> {
    let encoded_audio = encode_pcm16_base64(audio, request.max_audio_samples())?;
    let payload = json!({
        "audio_data": encoded_audio,
        "format": "raw",
        "sample_rate": audio.sample_rate_hz(),
        "channels": audio.channels(),
        "language": language,
        "auto_language_candidates": [],
        "model": config.model,
        "mesh_selector": Value::Null,
    });
    let typed: models::TranscribeAudioRequest =
        serde_json::from_value(payload).map_err(|_| EngineError::InvalidRequest)?;
    serde_json::to_value(typed).map_err(|_| EngineError::InvalidRequest)
}

fn encode_pcm16_base64(
    audio: &FiniteSttAudio,
    max_audio_samples: usize,
) -> Result<String, EngineError> {
    let samples = audio.samples();
    if samples.is_empty() || samples.len() > max_audio_samples {
        return Err(EngineError::InvalidRequest);
    }
    let byte_len = samples
        .len()
        .checked_mul(PCM16_BYTES_PER_SAMPLE)
        .ok_or(EngineError::ResourceLimit)?;
    let mut raw = Vec::new();
    raw.try_reserve_exact(byte_len)
        .map_err(|_| EngineError::ResourceLimit)?;
    for sample in samples {
        if !sample.is_finite() || !(-1.0..=1.0).contains(sample) {
            return Err(EngineError::InvalidRequest);
        }
        raw.extend_from_slice(&f32_to_i16(*sample).to_le_bytes());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(raw))
}

fn parse_stt_response(
    request: &BoundFiniteSttRequest,
    audio: &FiniteSttAudio,
    response: &Value,
) -> Result<FiniteSttResult, EngineError> {
    let typed: models::TranscribeAudioResponse =
        serde_json::from_value(response.clone()).map_err(|_| provider_fault())?;
    let value = serde_json::to_value(typed).map_err(|_| provider_fault())?;
    let text = required_str(&value, "text")?;
    let model_used = required_str(&value, "model_used")?;
    let duration_ms = required_f64(&value, "duration_ms")?;
    let confidence = value.get("confidence").and_then(Value::as_f64);
    let language = value.get("language").and_then(Value::as_str);
    if !valid_transcript_text(text)
        || !valid_identifier(model_used)
        || !duration_ms.is_finite()
        || duration_ms < 0.0
        || duration_mismatch(duration_ms, audio.samples().len(), audio.sample_rate_hz())
        || confidence.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        || language.is_some_and(|value| !valid_gateway_language(value))
    {
        return Err(provider_fault());
    }
    FiniteSttResult::new(request, audio, text).map_err(|_| provider_fault())
}

fn route_policy_matches(route_scope: FiniteSttRouteScope, policy: MicrophoneAudioPolicy) -> bool {
    matches!(
        (route_scope, policy),
        (
            FiniteSttRouteScope::LoopbackSidecar,
            MicrophoneAudioPolicy::LoopbackOnly
        ) | (
            FiniteSttRouteScope::RemoteGateway,
            MicrophoneAudioPolicy::ExplicitRemoteConsent
        )
    )
}

fn validate_transport_profile(
    route_scope: FiniteSttRouteScope,
    profile: NativeGatewayMicrophoneAudioProfile,
) -> Result<(), EngineError> {
    let matches = match route_scope {
        FiniteSttRouteScope::LoopbackSidecar => {
            profile.endpoint_class() == NativeGatewayEndpointClass::Loopback
                && profile.microphone_audio_policy() == MicrophoneAudioPolicy::LoopbackOnly
        }
        FiniteSttRouteScope::RemoteGateway => {
            profile.endpoint_class() == NativeGatewayEndpointClass::Remote
                && profile.microphone_audio_policy() == MicrophoneAudioPolicy::ExplicitRemoteConsent
        }
    };
    if matches {
        Ok(())
    } else {
        Err(EngineError::InvalidRequest)
    }
}

fn f32_to_i16(sample: f32) -> i16 {
    if sample <= -1.0 {
        i16::MIN
    } else if sample >= 1.0 {
        i16::MAX
    } else {
        (sample * f32::from(i16::MAX)).round() as i16
    }
}

fn duration_mismatch(duration_ms: f64, samples: usize, sample_rate_hz: u32) -> bool {
    let expected = samples as f64 * 1000.0 / f64::from(sample_rate_hz);
    (duration_ms - expected).abs() > 1.0
}

fn valid_gateway_language(value: &str) -> bool {
    matches!(
        value,
        "de" | "en" | "es" | "fr" | "it" | "ja" | "ko" | "pt" | "zh"
    )
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b':'))
}

fn valid_transcript_text(value: &str) -> bool {
    !value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str, EngineError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(provider_fault)
}

fn required_f64(value: &Value, field: &str) -> Result<f64, EngineError> {
    value
        .get(field)
        .and_then(Value::as_f64)
        .ok_or_else(provider_fault)
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
        TransportError::RemoteAudioBlocked => EngineError::InvalidRequest,
        TransportError::InvalidConfiguration
        | TransportError::UnsafeEndpoint
        | TransportError::UnknownMethod
        | TransportError::UnknownEvent
        | TransportError::InvalidPayload
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
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;

    use super::*;
    use aurora_voice_engine::{FiniteSttAudioBuilder, RouteFiniteSttRequest};
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

    fn loopback_transport(base_url: Url, policy: MicrophoneAudioPolicy) -> NativeGatewayTransport {
        NativeGatewayTransport::new(
            base_url,
            crate::GatewayAuth::Bearer("native-secret".to_owned()),
            crate::TransportLimits {
                allow_loopback_http: true,
                microphone_audio_policy: policy,
                ..crate::TransportLimits::default()
            },
        )
        .expect("transport")
    }

    fn unused_loopback_transport(policy: MicrophoneAudioPolicy) -> NativeGatewayTransport {
        loopback_transport(
            Url::parse("http://127.0.0.1:9/").expect("loopback URL"),
            policy,
        )
    }

    fn route(scope: FiniteSttRouteScope) -> RouteFiniteSttBinding {
        RouteFiniteSttBinding::new("gateway.stt", scope, 16_000, 16_000, 5).expect("route")
    }

    fn config(
        scope: FiniteSttRouteScope,
        policy: MicrophoneAudioPolicy,
    ) -> NativeGatewayFiniteSttConfig {
        NativeGatewayFiniteSttConfig::realtime(route(scope), policy).expect("config")
    }

    fn request(
        scope: FiniteSttRouteScope,
        generation: u64,
    ) -> (BoundFiniteSttRequest, FiniteSttAudio) {
        let route_request =
            RouteFiniteSttRequest::new(route(scope), Some("en".to_owned()), generation)
                .expect("route request");
        let mut builder = FiniteSttAudioBuilder::new_route(route_request).expect("builder");
        builder.push_frame(&[0.0, 0.5, -0.5, 1.0]).expect("frame");
        builder.finish().expect("finite audio")
    }

    fn success_body() -> Value {
        json!({
            "confidence": 0.75,
            "duration_ms": 4.0 * 1000.0 / 16_000.0,
            "language": "en",
            "model_used": "realtime",
            "text": "hello aurora",
        })
    }

    fn request_body(request: &str) -> Value {
        let (_, body) = request.split_once("\r\n\r\n").expect("request body");
        serde_json::from_str(body).expect("JSON body")
    }

    #[tokio::test]
    async fn route_stt_posts_raw_pcm_with_typed_generated_request() {
        let server = FixtureServer::one_response(json_response(success_body()));
        let mut adapter = NativeGatewayFiniteStt::new(
            loopback_transport(server.base_url.clone(), MicrophoneAudioPolicy::LoopbackOnly),
            config(
                FiniteSttRouteScope::LoopbackSidecar,
                MicrophoneAudioPolicy::LoopbackOnly,
            ),
        )
        .expect("adapter");
        let (request, audio) = request(FiniteSttRouteScope::LoopbackSidecar, 42);

        let result = adapter
            .transcribe_finite(request, audio, &|| false)
            .await
            .expect("transcription");

        assert_eq!(result.transcript(), "hello aurora");
        assert_eq!(result.generation(), 42);
        assert_eq!(result.frames(), 1);
        let captured = server.request.recv().expect("captured request");
        assert!(captured.starts_with("POST /api/Transcription/Transcribe HTTP/1.1"));
        assert!(captured.contains("authorization: Bearer native-secret"));
        assert!(!captured.contains("hello aurora"));
        let body = request_body(&captured);
        assert_eq!(body.get("format").and_then(Value::as_str), Some("raw"));
        assert_eq!(
            body.get("sample_rate").and_then(Value::as_u64),
            Some(16_000)
        );
        assert_eq!(body.get("channels").and_then(Value::as_u64), Some(1));
        assert_eq!(body.get("language").and_then(Value::as_str), Some("en"));
        let raw = base64::engine::general_purpose::STANDARD
            .decode(
                body.get("audio_data")
                    .and_then(Value::as_str)
                    .expect("audio"),
            )
            .expect("audio base64");
        assert_eq!(raw.len(), 8);
    }

    #[tokio::test]
    async fn route_policy_blocks_remote_without_explicit_consent() {
        assert!(NativeGatewayFiniteSttConfig::realtime(
            route(FiniteSttRouteScope::RemoteGateway),
            MicrophoneAudioPolicy::LoopbackOnly,
        )
        .is_err());

        assert_eq!(
            NativeGatewayFiniteStt::new(
                unused_loopback_transport(MicrophoneAudioPolicy::Blocked),
                NativeGatewayFiniteSttConfig::realtime(
                    route(FiniteSttRouteScope::LoopbackSidecar),
                    MicrophoneAudioPolicy::LoopbackOnly,
                )
                .expect("config"),
            )
            .map(|_| ()),
            Err(EngineError::InvalidRequest)
        );

        let remote_transport = NativeGatewayTransport::new(
            Url::parse("https://remote.example.invalid/").expect("remote URL"),
            crate::GatewayAuth::None,
            crate::TransportLimits {
                microphone_audio_policy: MicrophoneAudioPolicy::ExplicitRemoteConsent,
                ..crate::TransportLimits::default()
            },
        )
        .expect("remote transport");
        assert_eq!(
            NativeGatewayFiniteStt::new(
                remote_transport,
                NativeGatewayFiniteSttConfig::realtime(
                    route(FiniteSttRouteScope::LoopbackSidecar),
                    MicrophoneAudioPolicy::LoopbackOnly,
                )
                .expect("config"),
            )
            .map(|_| ()),
            Err(EngineError::InvalidRequest)
        );

        let loopback_remote_scope = NativeGatewayTransport::new(
            Url::parse("http://127.0.0.1:9/").expect("loopback URL"),
            crate::GatewayAuth::None,
            crate::TransportLimits {
                allow_loopback_http: true,
                microphone_audio_policy: MicrophoneAudioPolicy::ExplicitRemoteConsent,
                ..crate::TransportLimits::default()
            },
        )
        .expect("loopback transport");
        assert_eq!(
            NativeGatewayFiniteStt::new(
                loopback_remote_scope,
                NativeGatewayFiniteSttConfig::realtime(
                    route(FiniteSttRouteScope::RemoteGateway),
                    MicrophoneAudioPolicy::ExplicitRemoteConsent,
                )
                .expect("config"),
            )
            .map(|_| ()),
            Err(EngineError::InvalidRequest)
        );

        let blocked_transport = unused_loopback_transport(MicrophoneAudioPolicy::Blocked);
        assert_eq!(
            validate_transport_profile(
                FiniteSttRouteScope::LoopbackSidecar,
                blocked_transport.microphone_audio_profile(),
            ),
            Err(EngineError::InvalidRequest)
        );
    }

    #[test]
    fn audio_encoding_is_bounded_and_redacted() {
        let (_request, audio) = request(FiniteSttRouteScope::LoopbackSidecar, 8);
        assert_eq!(
            encode_pcm16_base64(&audio, 3),
            Err(EngineError::InvalidRequest)
        );
        let encoded = encode_pcm16_base64(&audio, 4).expect("encoded");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("decode")
                .len(),
            8
        );
        let debug = format!("{audio:?}");
        assert!(!debug.contains("0.5"));
    }

    #[test]
    fn malicious_response_is_sanitized_provider_fault() {
        let (request, audio) = request(FiniteSttRouteScope::LoopbackSidecar, 8);
        let mut body = success_body();
        body["text"] = Value::String("bad\u{0000}text".to_owned());
        assert_eq!(
            parse_stt_response(&request, &audio, &body),
            Err(provider_fault())
        );
        body = success_body();
        body["duration_ms"] = Value::from(500.0);
        assert_eq!(
            parse_stt_response(&request, &audio, &body),
            Err(provider_fault())
        );
    }

    #[tokio::test]
    async fn cancellation_and_cleanup_are_idempotent() {
        let mut adapter = NativeGatewayFiniteStt::new(
            unused_loopback_transport(MicrophoneAudioPolicy::LoopbackOnly),
            config(
                FiniteSttRouteScope::LoopbackSidecar,
                MicrophoneAudioPolicy::LoopbackOnly,
            ),
        )
        .expect("adapter");
        let (request, audio) = request(FiniteSttRouteScope::LoopbackSidecar, 9);
        assert_eq!(
            adapter.transcribe_finite(request, audio, &|| true).await,
            Err(EngineError::Cancelled)
        );
        adapter.active_generation = Some(9);
        adapter.active_cancellation = Some(CancellationToken::new());
        assert_eq!(adapter.cancel_finite_stt_generation(9).await, Ok(()));
        assert_eq!(adapter.cancel_finite_stt_generation(9).await, Ok(()));
        let debug = format!("{adapter:?}");
        assert!(!debug.contains("native-secret"));
        assert!(!debug.contains("hello aurora"));
        assert!(adapter.active_cancellation.is_none());
    }

    #[tokio::test]
    async fn stale_binding_is_unavailable() {
        let mut adapter = NativeGatewayFiniteStt::new(
            unused_loopback_transport(MicrophoneAudioPolicy::LoopbackOnly),
            config(
                FiniteSttRouteScope::LoopbackSidecar,
                MicrophoneAudioPolicy::LoopbackOnly,
            ),
        )
        .expect("adapter");
        assert_eq!(
            adapter
                .warm_finite_stt(FiniteSttProviderBinding::Route(route(
                    FiniteSttRouteScope::RemoteGateway
                )))
                .await,
            Err(EngineError::TaskUnavailable)
        );
    }
}
