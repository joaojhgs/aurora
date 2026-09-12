//! Port of `packages/aurora-sdk/src/peer-host/contract-registry.ts`.
//!
//! Execution policy: which generated backend methods may be projected onto the
//! mesh at all, what limits they run under, which events are safe to hand a
//! remote subscriber, and the one emission validator that has to hold a state
//! machine — the TTS audio chunk sequencer.
//!
//! ## Where TypeScript was loose
//!
//! * TypeScript builds descriptors from `generated-contracts.ts`, which carries
//!   Zod schemas and handler closures. Rust builds them from
//!   [`aurora_contracts`], the same generated inventory in its Rust form, and
//!   carries only the policy half — see [`crate::types`] for why.
//! * `descriptor.callable_features` and `speech_constraints` have no Rust
//!   counterpart in the generated inventory yet, so they are not represented.
//!   Neither participates in an authorization or execution decision; they are
//!   route-selection metadata the TypeScript host reads. Recorded here so the
//!   gap is a written exclusion rather than a silent omission.

use std::collections::BTreeMap;

use crate::types::{
    PeerHostEventDescriptor, PeerHostMethodDescriptor, PeerHostMethodExposure, PeerHostMethodType,
    PeerHostProjectionMethodType,
};

/// Default largest request body for a projected method: 256 KiB.
pub const DEFAULT_METHOD_BYTES: u64 = 256 * 1024;
/// Default largest event payload: 64 KiB.
pub const DEFAULT_EVENT_BYTES: u64 = 64 * 1024;
/// Default request deadline: 30 seconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Default concurrent requests per projected method.
pub const DEFAULT_MAX_CONCURRENT: u32 = 10;
/// Default longest subscription lifetime, in seconds.
pub const DEFAULT_MAX_TTL_SECONDS: u32 = 120;
/// Longest stream identifier an event payload may carry.
pub const MAX_EVENT_STREAM_ID_LENGTH: usize = 256;

/// The version advertised on the mesh for the projected surface.
///
/// Mirrors `AURORA_BACKEND_CONTRACT_VERSION` in
/// `packages/aurora-sdk/src/generated/backend-contracts.zod.ts`. A literal
/// `0.0.0` here once made every thin shell fail any `min_version` policy on a
/// major-version mismatch while an equivalent Python node passed. The shared
/// fixture corpus asserts both languages carry the same value.
pub const AURORA_BACKEND_CONTRACT_VERSION: &str = "1.0.0";

/// Provider capabilities a `Tooling` method advertises.
pub const TOOLING_PROVIDER_CAPABILITIES: [&str; 2] = ["tool_discovery", "tool_execution"];

/// Generated methods that may never be projected onto the mesh.
pub const GENERATED_PEER_HOST_BLOCKED_METHODS: [&str; 3] = [
    "Gateway.ExplainRoute",
    "Transcription.ProcessAudio",
    "WakeWord.ProcessAudio",
];

/// The four `Tooling` methods a peer host projects.
pub const TOOLING_PEER_HOST_METHODS: [&str; 4] = [
    "Tooling.GetTools",
    "Tooling.GetExportCatalog",
    "Tooling.PrepareExecution",
    "Tooling.ExecuteTool",
];

/// Why a generated contract could not be projected.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ContractRegistryError {
    /// Continuous audio capture cannot be hosted across devices.
    #[error("continuous audio capture cannot be hosted across devices")]
    ContinuousAudioCapture,
    /// Gateway route inspection is not a peer-host service.
    #[error("gateway route inspection cannot be registered as a peer-host service")]
    GatewayRouteInspection,
    /// The generated method is not unary.
    #[error("generated peer-host method is not unary: {0}")]
    NotUnary(String),
    /// The generated event is unauthorized, unbounded, or carries raw audio.
    #[error("generated peer-host event is not safe for remote projection: {0}")]
    EventNotSafe(String),
    /// The identity is absent from the generated inventory.
    #[error("unknown generated contract: {0}")]
    UnknownContract(String),
    /// The identity is already registered.
    #[error("duplicate peer-host method: {0}")]
    DuplicateMethod(String),
    /// The topic is already registered.
    #[error("duplicate peer-host event topic: {0}")]
    DuplicateEvent(String),
}

/// Optional overrides when projecting a generated method.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GeneratedPeerHostRegistrationOptions {
    /// Override the request body limit.
    pub max_request_bytes: Option<u64>,
    /// Override the deadline.
    pub timeout_ms: Option<u64>,
    /// Override the advertised provider capabilities.
    pub service_capabilities: Option<Vec<String>>,
    /// Override the advertised service version.
    pub service_version: Option<String>,
    /// Override the concurrency ceiling.
    pub max_concurrent: Option<u32>,
}

/// Optional overrides when projecting a generated event.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GeneratedPeerHostEventRegistrationOptions {
    /// Override the subscription lifetime ceiling.
    pub max_ttl_seconds: Option<u32>,
    /// Override the event payload limit.
    pub max_event_bytes: Option<u64>,
}

/// Refuse a method the mesh may not carry.
///
/// The two error messages are product-visible and are preserved verbatim.
pub fn assert_generated_peer_host_method(method_id: &str) -> Result<(), ContractRegistryError> {
    if !GENERATED_PEER_HOST_BLOCKED_METHODS.contains(&method_id) {
        return Ok(());
    }
    if method_id == "WakeWord.ProcessAudio" || method_id == "Transcription.ProcessAudio" {
        return Err(ContractRegistryError::ContinuousAudioCapture);
    }
    Err(ContractRegistryError::GatewayRouteInspection)
}

/// Build a peer-host method descriptor from the generated backend contract.
pub fn generated_peer_host_method_descriptor(
    method_id: &str,
    options: &GeneratedPeerHostRegistrationOptions,
) -> Result<PeerHostMethodDescriptor, ContractRegistryError> {
    assert_generated_peer_host_method(method_id)?;
    let descriptor = aurora_contracts::method_by_id(method_id)
        .ok_or_else(|| ContractRegistryError::UnknownContract(method_id.to_owned()))?;
    if descriptor.streaming.rpc_kind != "unary" {
        return Err(ContractRegistryError::NotUnary(method_id.to_owned()));
    }
    let service_capabilities = options.service_capabilities.clone().unwrap_or_else(|| {
        if descriptor.module == "Tooling" {
            TOOLING_PROVIDER_CAPABILITIES
                .iter()
                .map(|capability| (*capability).to_owned())
                .collect()
        } else {
            Vec::new()
        }
    });
    Ok(PeerHostMethodDescriptor {
        method_id: method_id.to_owned(),
        module: Some(descriptor.module.to_owned()),
        name: Some(descriptor.name.to_owned()),
        summary: Some(String::new()),
        bus_topic: Some(descriptor.bus_topic.to_owned()),
        exposure: PeerHostMethodExposure::parse(descriptor.exposure),
        method_type: PeerHostMethodType::Unary,
        projection_method_type: PeerHostProjectionMethodType::parse(descriptor.method_type),
        input_schema_id: descriptor.input_schema_id.to_owned(),
        output_schema_id: descriptor.output_schema_id.to_owned(),
        required_permissions: descriptor
            .required_permissions
            .iter()
            .map(|permission| (*permission).to_owned())
            .collect(),
        callable_feature_ids: descriptor
            .callable_feature_ids
            .iter()
            .map(|feature| (*feature).to_owned())
            .collect(),
        service_capabilities,
        service_version: Some(
            options
                .service_version
                .clone()
                .unwrap_or_else(|| AURORA_BACKEND_CONTRACT_VERSION.to_owned()),
        ),
        max_concurrent: Some(options.max_concurrent.unwrap_or(DEFAULT_MAX_CONCURRENT)),
        max_request_bytes: Some(options.max_request_bytes.unwrap_or(DEFAULT_METHOD_BYTES)),
        timeout_ms: Some(options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)),
    })
}

/// Build an authorized peer-host event descriptor from generated metadata.
///
/// The three-part safety gate is the whole point: an event may be projected
/// only when it is externally authorized, bounded in delivery, and not a raw
/// audio route.
pub fn generated_peer_host_event_descriptor(
    topic: &str,
    options: &GeneratedPeerHostEventRegistrationOptions,
) -> Result<PeerHostEventDescriptor, ContractRegistryError> {
    let descriptor = aurora_contracts::event_by_topic(topic)
        .ok_or_else(|| ContractRegistryError::UnknownContract(topic.to_owned()))?;
    if !descriptor.authorized || !descriptor.bounded || descriptor.remote_raw_audio_route {
        return Err(ContractRegistryError::EventNotSafe(topic.to_owned()));
    }
    Ok(PeerHostEventDescriptor {
        topic: topic.to_owned(),
        module: Some(descriptor.module.to_owned()),
        name: Some(descriptor.name.to_owned()),
        output_schema_id: descriptor.schema_id.to_owned(),
        required_permissions: descriptor
            .required_permissions
            .iter()
            .map(|permission| (*permission).to_owned())
            .collect(),
        max_ttl_seconds: Some(options.max_ttl_seconds.unwrap_or(DEFAULT_MAX_TTL_SECONDS)),
        max_event_bytes: Some(options.max_event_bytes.unwrap_or(DEFAULT_EVENT_BYTES)),
        ordered_event_group: descriptor.ordered_event_group.map(str::to_owned),
    })
}

/// The set of methods and events one peer host projects.
#[derive(Clone, Debug, Default)]
pub struct PeerHostContractRegistry {
    methods: BTreeMap<String, PeerHostMethodDescriptor>,
    events: BTreeMap<String, PeerHostEventDescriptor>,
}

impl PeerHostContractRegistry {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a method. Registering the same identity twice is refused.
    pub fn register(
        &mut self,
        descriptor: PeerHostMethodDescriptor,
    ) -> Result<&mut Self, ContractRegistryError> {
        if self.methods.contains_key(&descriptor.method_id) {
            return Err(ContractRegistryError::DuplicateMethod(descriptor.method_id));
        }
        self.methods
            .insert(descriptor.method_id.clone(), descriptor);
        Ok(self)
    }

    /// Add an event. Registering the same topic twice is refused.
    pub fn register_event(
        &mut self,
        descriptor: PeerHostEventDescriptor,
    ) -> Result<&mut Self, ContractRegistryError> {
        if self.events.contains_key(&descriptor.topic) {
            return Err(ContractRegistryError::DuplicateEvent(descriptor.topic));
        }
        self.events.insert(descriptor.topic.clone(), descriptor);
        Ok(self)
    }

    /// Project a generated method into this registry.
    pub fn register_generated(
        &mut self,
        method_id: &str,
        options: &GeneratedPeerHostRegistrationOptions,
    ) -> Result<&mut Self, ContractRegistryError> {
        let descriptor = generated_peer_host_method_descriptor(method_id, options)?;
        self.register(descriptor)
    }

    /// Project a generated event into this registry.
    pub fn register_generated_event(
        &mut self,
        topic: &str,
        options: &GeneratedPeerHostEventRegistrationOptions,
    ) -> Result<&mut Self, ContractRegistryError> {
        let descriptor = generated_peer_host_event_descriptor(topic, options)?;
        self.register_event(descriptor)
    }

    /// Look one method up.
    #[must_use]
    pub fn get(&self, method_id: &str) -> Option<&PeerHostMethodDescriptor> {
        self.methods.get(method_id)
    }

    /// Every method, sorted by identity.
    #[must_use]
    pub fn list(&self) -> Vec<&PeerHostMethodDescriptor> {
        self.methods.values().collect()
    }

    /// Look one event up.
    #[must_use]
    pub fn get_event(&self, topic: &str) -> Option<&PeerHostEventDescriptor> {
        self.events.get(topic)
    }

    /// Every event, sorted by topic.
    #[must_use]
    pub fn list_events(&self) -> Vec<&PeerHostEventDescriptor> {
        self.events.values().collect()
    }

    /// Validate an inbound payload against the method's input schema.
    pub fn parse_input(
        &self,
        method: &PeerHostMethodDescriptor,
        value: serde_json::Value,
    ) -> Result<serde_json::Value, aurora_contracts::ContractParseError> {
        // `normalize_generated_contract` validates as it normalizes, which is
        // what `parseBoundary` does on the TypeScript side.
        aurora_contracts::normalize_generated_contract(&method.input_schema_id, value)
    }

    /// Validate an outbound payload against the method's output schema.
    pub fn parse_output(
        &self,
        method: &PeerHostMethodDescriptor,
        value: serde_json::Value,
    ) -> Result<serde_json::Value, aurora_contracts::ContractParseError> {
        // `normalize_generated_contract` validates as it normalizes, which is
        // what `parseBoundary` does on the TypeScript side.
        aurora_contracts::normalize_generated_contract(&method.output_schema_id, value)
    }

    /// Validate an event payload against its schema.
    pub fn parse_event_output(
        &self,
        event: &PeerHostEventDescriptor,
        value: serde_json::Value,
    ) -> Result<serde_json::Value, aurora_contracts::ContractParseError> {
        // `normalize_generated_contract` validates as it normalizes, which is
        // what `parseBoundary` does on the TypeScript side.
        aurora_contracts::normalize_generated_contract(&event.output_schema_id, value)
    }
}

/// The four-method `Tooling` registry a thin peer host projects.
pub fn create_tooling_peer_host_registry() -> Result<PeerHostContractRegistry, ContractRegistryError>
{
    let mut registry = PeerHostContractRegistry::new();
    let options = GeneratedPeerHostRegistrationOptions::default();
    for method_id in TOOLING_PEER_HOST_METHODS {
        registry.register_generated(method_id, &options)?;
    }
    Ok(registry)
}

// ---------------------------------------------------------------------------
// TTS audio chunk emission validator
// ---------------------------------------------------------------------------

/// Why a TTS audio chunk was refused.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TtsAudioChunkError {
    /// The payload was not a JSON object.
    #[error("TTS audio event must be an object")]
    NotAnObject,
    /// `stream_id` was absent, empty, or over-long.
    #[error("TTS audio event stream_id is not a bounded identifier")]
    StreamIdNotBounded,
    /// `sequence` was absent or not a non-negative integer.
    #[error("TTS audio event sequence is invalid")]
    SequenceInvalid,
    /// `is_final` or `audio_data` had the wrong type.
    #[error("TTS audio event terminal fields are invalid")]
    TerminalFieldsInvalid,
    /// `source_sequence` was present but not an integer.
    #[error("TTS audio event source sequence is invalid")]
    SourceSequenceInvalid,
    /// The payload's `correlation_id` disagreed with the emission context.
    #[error("TTS audio event correlation does not match payload")]
    CorrelationMismatch,
    /// The sequence skipped, repeated, or followed a final marker.
    #[error("TTS audio event sequence is not monotonic")]
    SequenceNotMonotonic,
    /// A final marker carried audio, a source sequence, or a duration.
    #[error("TTS audio event final marker is invalid")]
    FinalMarkerInvalid,
    /// A non-final chunk had no non-negative `source_sequence`.
    #[error("TTS audio event source sequence is required")]
    SourceSequenceRequired,
    /// A non-final chunk's `source_sequence` went backwards or skipped.
    #[error("TTS audio event source sequence is not ordered")]
    SourceSequenceNotOrdered,
}

#[derive(Clone, Copy, Debug)]
struct TtsAudioSequenceState {
    next_sequence: i64,
    last_source_sequence: Option<i64>,
    final_seen: bool,
}

/// Stateful validator for `TTS.AudioChunk` emissions.
///
/// Ported whole because it is the only descriptor-level validator that carries
/// state, and that state is what stops a provider from replaying, reordering,
/// or continuing a stream past its own final marker.
#[derive(Clone, Debug, Default)]
pub struct TtsAudioChunkEmissionValidator {
    streams: BTreeMap<String, TtsAudioSequenceState>,
}

impl TtsAudioChunkEmissionValidator {
    /// A validator with no streams in flight.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Check one emission, advancing the stream state on success.
    pub fn validate(
        &mut self,
        value: &serde_json::Value,
        correlation_id: Option<&str>,
    ) -> Result<(), TtsAudioChunkError> {
        let Some(object) = value.as_object() else {
            return Err(TtsAudioChunkError::NotAnObject);
        };

        let stream_id = object
            .get("stream_id")
            .and_then(serde_json::Value::as_str)
            .ok_or(TtsAudioChunkError::StreamIdNotBounded)?;
        let stream_id_length = stream_id.chars().map(char::len_utf16).sum::<usize>();
        if stream_id_length == 0 || stream_id_length > MAX_EVENT_STREAM_ID_LENGTH {
            return Err(TtsAudioChunkError::StreamIdNotBounded);
        }

        let sequence = safe_integer(object.get("sequence"))
            .filter(|value| *value >= 0)
            .ok_or(TtsAudioChunkError::SequenceInvalid)?;

        let is_final = object
            .get("is_final")
            .and_then(serde_json::Value::as_bool)
            .ok_or(TtsAudioChunkError::TerminalFieldsInvalid)?;
        let audio_data = object
            .get("audio_data")
            .and_then(serde_json::Value::as_str)
            .ok_or(TtsAudioChunkError::TerminalFieldsInvalid)?;

        let raw_source_sequence = object.get("source_sequence");
        let source_sequence_absent =
            matches!(raw_source_sequence, None | Some(serde_json::Value::Null));
        let source_sequence = if source_sequence_absent {
            None
        } else {
            Some(
                safe_integer(raw_source_sequence)
                    .ok_or(TtsAudioChunkError::SourceSequenceInvalid)?,
            )
        };

        if let Some(correlation_id) = correlation_id {
            let payload_correlation_id = object
                .get("correlation_id")
                .and_then(serde_json::Value::as_str);
            if payload_correlation_id != Some(correlation_id) {
                return Err(TtsAudioChunkError::CorrelationMismatch);
            }
        }

        let state_key = format!("{}\u{0}{}", correlation_id.unwrap_or(""), stream_id);
        let previous = self.streams.get(&state_key).copied();
        let expected_sequence = previous.map_or(0, |state| state.next_sequence);
        if sequence != expected_sequence || previous.is_some_and(|state| state.final_seen) {
            return Err(TtsAudioChunkError::SequenceNotMonotonic);
        }

        if is_final {
            let duration_ms = object.get("duration_ms");
            let duration_is_zero = duration_ms
                .and_then(serde_json::Value::as_f64)
                .is_some_and(|value| value == 0.0);
            if !audio_data.is_empty() || source_sequence.is_some() || !duration_is_zero {
                return Err(TtsAudioChunkError::FinalMarkerInvalid);
            }
        } else {
            let source_sequence = source_sequence
                .filter(|value| *value >= 0)
                .ok_or(TtsAudioChunkError::SourceSequenceRequired)?;
            let ordered = match previous.and_then(|state| state.last_source_sequence) {
                None => source_sequence == 0,
                Some(last) => source_sequence == last || source_sequence == last + 1,
            };
            if !ordered {
                return Err(TtsAudioChunkError::SourceSequenceNotOrdered);
            }
        }

        self.streams.insert(
            state_key,
            TtsAudioSequenceState {
                next_sequence: sequence + 1,
                last_source_sequence: if is_final {
                    previous.and_then(|state| state.last_source_sequence)
                } else {
                    source_sequence
                },
                final_seen: is_final,
            },
        );
        Ok(())
    }
}

/// `Number.isSafeInteger` over a JSON value.
///
/// TypeScript rejects `true` here because `Number.isSafeInteger(true)` is
/// false; `serde_json::Value::as_i64` on a boolean is `None`, so the same
/// input is refused for the same reason.
fn safe_integer(value: Option<&serde_json::Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    if number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(number as i64)
}
