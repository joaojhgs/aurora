//! Pure node-owned routing policy documents shared by native and WASM callers.
//!
//! This module validates and calculates candidate documents only. It does not
//! persist policy, authenticate a peer, authorize a route, or acknowledge that a
//! runtime has applied a revision.
//!
//! Raw JSON containing escaped lone UTF-16 surrogates in string values is
//! rejected by Rust's Unicode-scalar string decoder. The TypeScript SDK's
//! JSON.parse can retain those code units, so parity vectors characterize
//! lone-surrogate inputs as an intentional decoder-domain exception.

use serde::de::{self, DeserializeOwned, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Number, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;
use thiserror::Error;

pub const NODE_CONFIG_V1_VERSION: u64 = 1;
pub const NODE_CONFIG_V2_VERSION: u64 = 2;
pub const SPEECH_CONFIG_VERSION: u64 = 1;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_FEATURE_OVERRIDES: usize = 256;
const MAX_SAFE_ID_LENGTH: usize = 256;
const MAX_FEATURE_ID_LENGTH: usize = 128;

/// Errors contain no input payload text, which may contain local policy values.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum NodePolicyError {
    #[error("invalid node policy JSON")]
    InvalidJson,
    #[error("invalid node policy document")]
    InvalidDocument,
    #[error("unsupported node policy version")]
    UnsupportedVersion,
    #[error("node policy revision conflict")]
    RevisionConflict {
        expected_revision: u64,
        current_revision: u64,
    },
    #[error("node policy revision exhausted")]
    RevisionExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeConfigModule {
    Tooling,
    Tts,
    Stt,
    Orchestrator,
    Memory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutingPreference {
    Local,
    Network,
    LocalOnly,
    NetworkOnly,
}

impl<'de> Deserialize<'de> for RoutingPreference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "local" => Ok(Self::Local),
            "network" => Ok(Self::Network),
            "local_only" => Ok(Self::LocalOnly),
            "network_only" => Ok(Self::NetworkOnly),
            _ => Err(de::Error::unknown_variant(
                &value,
                &["local", "network", "local_only", "network_only"],
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutingFallback {
    Local,
    Network,
    Error,
    None,
}

impl<'de> Deserialize<'de> for RoutingFallback {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "local" => Ok(Self::Local),
            "network" => Ok(Self::Network),
            "error" => Ok(Self::Error),
            "none" => Ok(Self::None),
            _ => Err(de::Error::unknown_variant(
                &value,
                &["local", "network", "error", "none"],
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServiceRouting {
    pub prefer: RoutingPreference,
    pub fallback: RoutingFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exposure {
    pub enabled: bool,
}

/// A field that is omitted when missing but rejects explicit null.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Omitted<T> {
    #[default]
    Missing,
    Value(T),
}

impl<T> Omitted<T> {
    fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

impl<T: Serialize> Serialize for Omitted<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Missing => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Omitted<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct OmittedVisitor<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for OmittedVisitor<T> {
            type Value = Omitted<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a non-null optional value")
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Err(E::custom("explicit null is not permitted"))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Err(E::custom("explicit null is not permitted"))
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                T::deserialize(deserializer).map(Omitted::Value)
            }
        }

        deserializer.deserialize_option(OmittedVisitor(PhantomData))
    }
}

/// A nullable field that distinguishes an omitted key from an explicit null.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum NullableField<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<T> NullableField<T> {
    fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

impl<T: Serialize> Serialize for NullableField<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Missing | Self::Null => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for NullableField<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct NullableVisitor<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for NullableVisitor<T> {
            type Value = NullableField<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a nullable value")
            }

            fn visit_none<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(NullableField::Null)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(NullableField::Null)
            }

            fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
            where
                D: Deserializer<'de>,
            {
                T::deserialize(deserializer).map(NullableField::Value)
            }
        }

        deserializer.deserialize_option(NullableVisitor(PhantomData))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeServiceConfig {
    pub routing: ServiceRouting,
    #[serde(default, skip_serializing_if = "Omitted::is_missing")]
    pub expose: Omitted<Exposure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FeatureOverrides {
    pub feature_overrides: BTreeMap<NodeConfigModule, BTreeMap<String, Exposure>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeConfigDocumentV1 {
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub version: u64,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub updated_at_ms: u64,
    pub services: BTreeMap<NodeConfigModule, NodeServiceConfig>,
    pub expose: FeatureOverrides,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeechStage {
    Stt,
    Tts,
    Kws,
    Vad,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeechNetworkKind {
    Mesh,
    Gateway,
}

impl<'de> Deserialize<'de> for SpeechNetworkKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        match value.as_str() {
            "mesh" => Ok(Self::Mesh),
            "gateway" => Ok(Self::Gateway),
            _ => Err(de::Error::unknown_variant(&value, &["mesh", "gateway"])),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechStageTarget {
    pub peer_id: String,
    #[serde(default, skip_serializing_if = "NullableField::is_missing")]
    pub resource_id: NullableField<String>,
    #[serde(default, skip_serializing_if = "NullableField::is_missing")]
    pub model_id: NullableField<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechStageConfig {
    pub routing: ServiceRouting,
    #[serde(default, skip_serializing_if = "Omitted::is_missing")]
    pub network_kind: Omitted<SpeechNetworkKind>,
    #[serde(default, skip_serializing_if = "NullableField::is_missing")]
    pub target: NullableField<SpeechStageTarget>,
    #[serde(default)]
    pub experimental_remote: bool,
    #[serde(default, skip_serializing_if = "NullableField::is_missing")]
    pub model_id: NullableField<String>,
    #[serde(default, skip_serializing_if = "NullableField::is_missing")]
    pub language: NullableField<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechStages {
    pub stt: SpeechStageConfig,
    pub tts: SpeechStageConfig,
    pub kws: SpeechStageConfig,
    pub vad: SpeechStageConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechSharing {
    pub stt: bool,
    pub tts: bool,
    pub kws: bool,
    pub vad: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechLimits {
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub max_attempts: u64,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub admission_timeout_ms: u64,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub finite_deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpeechConfig {
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub version: u64,
    pub stages: SpeechStages,
    pub sharing: SpeechSharing,
    pub limits: SpeechLimits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeConfigDocumentV2 {
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub version: u64,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub revision: u64,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub updated_at_ms: u64,
    pub services: BTreeMap<NodeConfigModule, NodeServiceConfig>,
    pub expose: FeatureOverrides,
    pub speech: SpeechConfig,
    #[serde(default)]
    pub background_transcription: BackgroundTranscriptionPolicy,
    #[serde(default)]
    pub legacy_v1_snapshot: Option<Box<NodeConfigDocumentV1>>,
}

/// Saved preferences; capability, permission and actual capture are not policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BackgroundTranscriptionPolicy {
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub version: u64,
    pub enabled: bool,
    pub ambient: bool,
    pub notification: bool,
    #[serde(deserialize_with = "deserialize_safe_u64")]
    pub retention_days: u64,
    #[serde(default, skip_serializing_if = "NullableField::is_missing")]
    pub language: NullableField<String>,
}

impl Default for BackgroundTranscriptionPolicy {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            ambient: false,
            notification: false,
            retention_days: 30,
            language: NullableField::Missing,
        }
    }
}

/// Construct the default V1 policy document.
///
/// The timestamp must be a non-negative JavaScript-safe integer. This returns
/// a value only; it does not persist or apply the policy.
pub fn empty_node_config_document_v1(now: u64) -> Result<NodeConfigDocumentV1, NodePolicyError> {
    validate_timestamp(now)?;
    let services = [
        (
            NodeConfigModule::Tooling,
            service_config(RoutingPreference::Local, RoutingFallback::Network, true),
        ),
        (
            NodeConfigModule::Tts,
            service_config(RoutingPreference::Local, RoutingFallback::Network, false),
        ),
        (
            NodeConfigModule::Stt,
            service_config(RoutingPreference::Local, RoutingFallback::Network, false),
        ),
        (
            NodeConfigModule::Orchestrator,
            service_config(RoutingPreference::Local, RoutingFallback::Network, false),
        ),
        (
            NodeConfigModule::Memory,
            service_config(
                RoutingPreference::NetworkOnly,
                RoutingFallback::Error,
                false,
            ),
        ),
    ]
    .into_iter()
    .collect();

    Ok(NodeConfigDocumentV1 {
        version: NODE_CONFIG_V1_VERSION,
        updated_at_ms: now,
        services,
        expose: FeatureOverrides {
            feature_overrides: BTreeMap::new(),
        },
    })
}

/// Construct a default V2 policy document at revision 1.
///
/// The timestamp must be a non-negative JavaScript-safe integer. This returns
/// a document value only; it does not persist or apply the policy.
pub fn empty_node_config_document_v2(now: u64) -> Result<NodeConfigDocumentV2, NodePolicyError> {
    let legacy = empty_node_config_document_v1(now)?;
    let local_stage = || SpeechStageConfig {
        routing: ServiceRouting {
            prefer: RoutingPreference::LocalOnly,
            fallback: RoutingFallback::Error,
        },
        network_kind: Omitted::Missing,
        target: NullableField::Missing,
        experimental_remote: false,
        model_id: NullableField::Missing,
        language: NullableField::Missing,
    };
    let inherited_stage = |module: NodeConfigModule| SpeechStageConfig {
        routing: legacy
            .services
            .get(&module)
            .expect("default service exists")
            .routing
            .clone(),
        network_kind: Omitted::Missing,
        target: NullableField::Missing,
        experimental_remote: false,
        model_id: NullableField::Missing,
        language: NullableField::Missing,
    };

    Ok(NodeConfigDocumentV2 {
        version: NODE_CONFIG_V2_VERSION,
        revision: 1,
        updated_at_ms: now,
        services: legacy.services.clone(),
        expose: legacy.expose.clone(),
        speech: SpeechConfig {
            version: SPEECH_CONFIG_VERSION,
            stages: SpeechStages {
                stt: inherited_stage(NodeConfigModule::Stt),
                tts: inherited_stage(NodeConfigModule::Tts),
                kws: local_stage(),
                vad: local_stage(),
            },
            sharing: SpeechSharing {
                stt: false,
                tts: false,
                kws: false,
                vad: false,
            },
            limits: SpeechLimits {
                max_attempts: 2,
                admission_timeout_ms: 5_000,
                finite_deadline_ms: 60_000,
            },
        },
        background_transcription: BackgroundTranscriptionPolicy::default(),
        legacy_v1_snapshot: None,
    })
}

/// Parse and strictly validate a V1 JSON policy document.
///
/// Duplicate JSON object keys use serde_json's last-key-wins parsing behavior.
/// Escaped lone UTF-16 surrogates are rejected by Rust's string decoder.
pub fn validate_node_config_document_v1_json(
    input: &str,
) -> Result<NodeConfigDocumentV1, NodePolicyError> {
    let value = parse_json_value(input)?;
    validate_node_config_document_v1_value(value)
}

/// Strictly validate an already-decoded V1 policy value.
pub fn validate_node_config_document_v1_value(
    value: Value,
) -> Result<NodeConfigDocumentV1, NodePolicyError> {
    let document: NodeConfigDocumentV1 = decode(value)?;
    validate_v1(&document)?;
    Ok(document)
}

/// Parse and strictly validate a V2 JSON policy document.
///
/// This validates the document's shape and safe-integer fields; it does not
/// authorize routes or claim that a runtime has applied the revision.
pub fn validate_node_config_document_v2_json(
    input: &str,
) -> Result<NodeConfigDocumentV2, NodePolicyError> {
    let value = parse_json_value(input)?;
    validate_node_config_document_v2_value(value)
}

/// Strictly validate an already-decoded V2 policy value.
pub fn validate_node_config_document_v2_value(
    value: Value,
) -> Result<NodeConfigDocumentV2, NodePolicyError> {
    let version = value
        .as_object()
        .and_then(|object| object.get("version"))
        .and_then(number_as_safe_u64)
        .ok_or(NodePolicyError::InvalidDocument)?;
    if version != NODE_CONFIG_V2_VERSION {
        return Err(NodePolicyError::UnsupportedVersion);
    }
    let document: NodeConfigDocumentV2 = decode(value)?;
    validate_v2(&document)?;
    Ok(document)
}

/// Migrate legacy input to a validated V1 document.
///
/// The timestamp is used only when the input requires generated defaults; a
/// valid V1 pass-through uses its own validated timestamp.
pub fn migrate_node_config_document_v1(
    value: Value,
    now: u64,
) -> Result<NodeConfigDocumentV1, NodePolicyError> {
    if value.is_null() {
        return empty_node_config_document_v1(now);
    }
    let object = value.as_object().ok_or(NodePolicyError::InvalidDocument)?;
    match object.get("version") {
        Some(version) if number_as_safe_u64(version) == Some(NODE_CONFIG_V1_VERSION) => {
            return validate_node_config_document_v1_value(value);
        }
        Some(version) if number_as_safe_u64(version) == Some(0) => {}
        Some(_) => return Err(NodePolicyError::UnsupportedVersion),
        None => {}
    }

    let mut defaults = empty_node_config_document_v1(now)?;
    let Some(legacy_services) = object.get("services") else {
        return Ok(defaults);
    };
    let services_object = legacy_services
        .as_object()
        .ok_or(NodePolicyError::InvalidDocument)?;
    for (module_name, legacy_value) in services_object {
        let Some(module) = parse_module(module_name) else {
            continue;
        };
        let legacy = legacy_value
            .as_object()
            .ok_or(NodePolicyError::InvalidDocument)?;
        let routing_value = legacy.get("routing").unwrap_or(legacy_value);
        let routing = routing_value
            .as_object()
            .ok_or(NodePolicyError::InvalidDocument)?;
        let default_routing = defaults
            .services
            .get(&module)
            .ok_or(NodePolicyError::InvalidDocument)?
            .routing
            .clone();
        let prefer = legacy_route_field(routing.get("prefer"), default_routing.prefer)?;
        let fallback = legacy_fallback_field(routing.get("fallback"), default_routing.fallback)?;
        let expose = match legacy.get("expose") {
            Some(value) => decode_exposure(value.clone())?,
            None => Omitted::Missing,
        };
        defaults.services.insert(
            module,
            NodeServiceConfig {
                routing: ServiceRouting { prefer, fallback },
                expose,
            },
        );
    }

    if let Some(updated_at) = object.get("updatedAtMs") {
        if updated_at.is_number() {
            defaults.updated_at_ms =
                number_as_safe_u64(updated_at).ok_or(NodePolicyError::InvalidDocument)?;
        }
    }
    if let Some(expose) = object.get("expose").filter(|value| !value.is_null()) {
        defaults.expose = decode(expose.clone())?;
    }
    validate_v1(&defaults)?;
    Ok(defaults)
}

/// Migrate legacy input to a validated V2 document with an immutable V1 snapshot.
///
/// The timestamp is used only when defaults are needed. A valid V1/V2
/// pass-through uses the timestamp carried by that document. This function
/// does not persist or apply the migrated policy.
pub fn migrate_node_config_document_v2(
    value: Value,
    now: u64,
) -> Result<NodeConfigDocumentV2, NodePolicyError> {
    if value.is_null() {
        return empty_node_config_document_v2(now);
    }
    if value
        .as_object()
        .and_then(|object| object.get("version"))
        .and_then(number_as_safe_u64)
        == Some(NODE_CONFIG_V2_VERSION)
    {
        return validate_node_config_document_v2_value(value);
    }

    let legacy = migrate_node_config_document_v1(value, now)?;
    let mut document = empty_node_config_document_v2(legacy.updated_at_ms)?;
    document.services = legacy.services.clone();
    document.expose = legacy.expose.clone();
    document.legacy_v1_snapshot = Some(Box::new(legacy.clone()));
    if let Some(service) = legacy.services.get(&NodeConfigModule::Stt) {
        document.speech.stages.stt.routing = service.routing.clone();
    }
    if let Some(service) = legacy.services.get(&NodeConfigModule::Tts) {
        document.speech.stages.tts.routing = service.routing.clone();
    }
    validate_v2(&document)?;
    Ok(document)
}

/// Calculate a validated candidate only; this function does not persist or acknowledge it.
///
/// It rejects stale revisions and safe-integer exhaustion, and retains the
/// validated current V1 snapshot instead of accepting a draft replacement.
pub fn update_node_config_document_v2(
    current: &NodeConfigDocumentV2,
    draft: Value,
    expected_revision: u64,
    now: u64,
) -> Result<NodeConfigDocumentV2, NodePolicyError> {
    validate_timestamp(now)?;
    if expected_revision > MAX_SAFE_INTEGER {
        return Err(NodePolicyError::InvalidDocument);
    }
    let current_value =
        serde_json::to_value(current).map_err(|_| NodePolicyError::InvalidDocument)?;
    let current = validate_node_config_document_v2_value(current_value)?;
    if current.revision != expected_revision {
        return Err(NodePolicyError::RevisionConflict {
            expected_revision,
            current_revision: current.revision,
        });
    }
    if current.revision == MAX_SAFE_INTEGER {
        return Err(NodePolicyError::RevisionExhausted);
    }

    let mut candidate = validate_node_config_document_v2_value(draft)?;
    candidate.revision = current.revision + 1;
    candidate.updated_at_ms = now;
    candidate.legacy_v1_snapshot = current.legacy_v1_snapshot;
    validate_v2(&candidate)?;
    Ok(candidate)
}

fn service_config(
    prefer: RoutingPreference,
    fallback: RoutingFallback,
    exposed: bool,
) -> NodeServiceConfig {
    NodeServiceConfig {
        routing: ServiceRouting { prefer, fallback },
        expose: Omitted::Value(Exposure { enabled: exposed }),
    }
}

fn parse_json_value(input: &str) -> Result<Value, NodePolicyError> {
    aurora_voice_engine::json_text::parse_json_value(input)
        .map_err(|_| NodePolicyError::InvalidJson)
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, NodePolicyError> {
    reject_array_shapes(&value)?;
    serde_json::from_value(canonicalize_safe_integer_fields(value))
        .map_err(|_| NodePolicyError::InvalidDocument)
}

fn reject_array_shapes(value: &Value) -> Result<(), NodePolicyError> {
    match value {
        Value::Array(_) => Err(NodePolicyError::InvalidDocument),
        Value::Object(fields) => fields.values().try_for_each(reject_array_shapes),
        _ => Ok(()),
    }
}

fn canonicalize_safe_integer_fields(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| {
                    let normalized = if is_safe_integer_field(&key) {
                        number_as_safe_u64(&value)
                            .map(Number::from)
                            .map(Value::Number)
                    } else {
                        None
                    };
                    (
                        key,
                        normalized.unwrap_or_else(|| canonicalize_safe_integer_fields(value)),
                    )
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(canonicalize_safe_integer_fields)
                .collect(),
        ),
        other => other,
    }
}

fn is_safe_integer_field(name: &str) -> bool {
    matches!(
        name,
        "version"
            | "revision"
            | "updatedAtMs"
            | "maxAttempts"
            | "admissionTimeoutMs"
            | "finiteDeadlineMs"
    )
}

fn decode_exposure(value: Value) -> Result<Omitted<Exposure>, NodePolicyError> {
    let exposure = decode(value)?;
    Ok(Omitted::Value(exposure))
}

fn validate_v1(document: &NodeConfigDocumentV1) -> Result<(), NodePolicyError> {
    if document.version != NODE_CONFIG_V1_VERSION {
        return Err(NodePolicyError::UnsupportedVersion);
    }
    validate_timestamp(document.updated_at_ms)?;
    validate_feature_overrides(&document.expose)?;
    Ok(())
}

fn validate_v2(document: &NodeConfigDocumentV2) -> Result<(), NodePolicyError> {
    if document.version != NODE_CONFIG_V2_VERSION {
        return Err(NodePolicyError::UnsupportedVersion);
    }
    if document.revision == 0 || document.revision > MAX_SAFE_INTEGER {
        return Err(NodePolicyError::InvalidDocument);
    }
    validate_timestamp(document.updated_at_ms)?;
    let background = &document.background_transcription;
    if background.version != 1 || !(1..=3_650).contains(&background.retention_days) {
        return Err(NodePolicyError::InvalidDocument);
    }
    if let NullableField::Value(language) = &background.language {
        if language.encode_utf16().count() > 64 {
            return Err(NodePolicyError::InvalidDocument);
        }
    }
    if document.speech.version != SPEECH_CONFIG_VERSION {
        return Err(NodePolicyError::InvalidDocument);
    }
    if !matches!(document.speech.limits.max_attempts, 1 | 2)
        || !(1..=60_000).contains(&document.speech.limits.admission_timeout_ms)
        || !(1..=60_000).contains(&document.speech.limits.finite_deadline_ms)
    {
        return Err(NodePolicyError::InvalidDocument);
    }
    validate_feature_overrides(&document.expose)?;
    validate_speech_stage(SpeechStage::Stt, &document.speech.stages.stt)?;
    validate_speech_stage(SpeechStage::Tts, &document.speech.stages.tts)?;
    validate_speech_stage(SpeechStage::Kws, &document.speech.stages.kws)?;
    validate_speech_stage(SpeechStage::Vad, &document.speech.stages.vad)?;
    if let Some(snapshot) = &document.legacy_v1_snapshot {
        validate_v1(snapshot)?;
    }
    Ok(())
}

fn validate_feature_overrides(expose: &FeatureOverrides) -> Result<(), NodePolicyError> {
    let mut count = 0;
    for feature_map in expose.feature_overrides.values() {
        for feature_id in feature_map.keys() {
            count += 1;
            if count > MAX_FEATURE_OVERRIDES || !valid_feature_id(feature_id) {
                return Err(NodePolicyError::InvalidDocument);
            }
        }
    }
    Ok(())
}

fn validate_speech_stage(
    stage: SpeechStage,
    config: &SpeechStageConfig,
) -> Result<(), NodePolicyError> {
    if matches!(stage, SpeechStage::Kws | SpeechStage::Vad)
        && !config.experimental_remote
        && matches!(
            config.routing.prefer,
            RoutingPreference::Network | RoutingPreference::NetworkOnly
        )
    {
        return Err(NodePolicyError::InvalidDocument);
    }
    match &config.target {
        NullableField::Missing | NullableField::Null => {}
        NullableField::Value(target) => {
            if !valid_speech_id(&target.peer_id)
                || !valid_nullable_id(&target.resource_id)
                || !valid_nullable_id(&target.model_id)
            {
                return Err(NodePolicyError::InvalidDocument);
            }
        }
    }
    Ok(())
}

fn valid_nullable_id(field: &NullableField<String>) -> bool {
    match field {
        NullableField::Missing | NullableField::Null => true,
        NullableField::Value(value) => valid_speech_id(value),
    }
}

fn valid_speech_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SAFE_ID_LENGTH
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => true,
            b'.' | b'_' | b':' | b'-' => index > 0,
            _ => false,
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn valid_feature_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FEATURE_ID_LENGTH
        && !matches!(value, "__proto__" | "prototype" | "constructor")
        && value.bytes().all(|byte| {
            matches!(
                byte,
                b'A'..=b'Z'
                    | b'a'..=b'z'
                    | b'0'..=b'9'
                    | b'.'
                    | b'_'
                    | b':'
                    | b'-'
            )
        })
}

fn validate_timestamp(value: u64) -> Result<(), NodePolicyError> {
    if value > MAX_SAFE_INTEGER {
        Err(NodePolicyError::InvalidDocument)
    } else {
        Ok(())
    }
}

fn parse_module(module: &str) -> Option<NodeConfigModule> {
    match module {
        "tooling" => Some(NodeConfigModule::Tooling),
        "tts" => Some(NodeConfigModule::Tts),
        "stt" => Some(NodeConfigModule::Stt),
        "orchestrator" => Some(NodeConfigModule::Orchestrator),
        "memory" => Some(NodeConfigModule::Memory),
        _ => None,
    }
}

fn legacy_route_field(
    value: Option<&Value>,
    default: RoutingPreference,
) -> Result<RoutingPreference, NodePolicyError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(default);
    };
    decode(value.clone())
}

fn legacy_fallback_field(
    value: Option<&Value>,
    default: RoutingFallback,
) -> Result<RoutingFallback, NodePolicyError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(default);
    };
    decode(value.clone())
}

fn number_as_safe_u64(value: &Value) -> Option<u64> {
    let number = value.as_number()?;
    if let Some(value) = number.as_u64() {
        return (value <= MAX_SAFE_INTEGER).then_some(value);
    }
    if let Some(value) = number.as_i64() {
        return (value >= 0 && value as u64 <= MAX_SAFE_INTEGER).then_some(value as u64);
    }
    number_as_integral_float(number)
}

fn number_as_integral_float(number: &Number) -> Option<u64> {
    let value = number.as_f64()?;
    if !value.is_finite() || value < 0.0 || value > MAX_SAFE_INTEGER as f64 || value.fract() != 0.0
    {
        return None;
    }
    let integer = value as u64;
    (integer <= MAX_SAFE_INTEGER && integer as f64 == value).then_some(integer)
}

fn deserialize_safe_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    struct SafeU64Visitor;

    impl Visitor<'_> for SafeU64Visitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a non-negative JavaScript-safe integer")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value <= MAX_SAFE_INTEGER {
                Ok(value)
            } else {
                Err(E::custom("integer exceeds safe range"))
            }
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value >= 0 {
                self.visit_u64(value as u64)
            } else {
                Err(E::custom("integer must be non-negative"))
            }
        }

        fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if !value.is_finite()
                || value < 0.0
                || value > MAX_SAFE_INTEGER as f64
                || value.fract() != 0.0
            {
                return Err(E::custom("number is not a safe integer"));
            }
            let integer = value as u64;
            if integer <= MAX_SAFE_INTEGER && integer as f64 == value {
                Ok(integer)
            } else {
                Err(E::custom("number is not exactly representable"))
            }
        }
    }

    deserializer.deserialize_any(SafeU64Visitor)
}
