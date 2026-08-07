//! Generated Aurora transport DTOs and method descriptors.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

mod extensions;

struct CompiledSchema {
    schema: Value,
    validator: jsonschema::Validator,
}

static COMPILED_SCHEMAS: LazyLock<Result<HashMap<&'static str, CompiledSchema>, String>> =
    LazyLock::new(|| {
        generated::SCHEMA_DESCRIPTORS
            .iter()
            .map(|descriptor| {
                let schema: Value = serde_json::from_str(descriptor.schema_json)
                    .map_err(|error| format!("{}: {error}", descriptor.schema_id))?;
                let validator = jsonschema::validator_for(&schema)
                    .map_err(|error| format!("{}: {error}", descriptor.schema_id))?;
                Ok((descriptor.schema_id, CompiledSchema { schema, validator }))
            })
            .collect()
    });

/// Failure to validate or decode a generated Aurora contract payload.
#[derive(Debug, Error)]
pub enum ContractParseError {
    /// The caller supplied a schema identity absent from the backend inventory.
    #[error("unknown contract schema: {0}")]
    UnknownSchema(String),
    /// An embedded generated schema could not be compiled.
    #[error("embedded contract schema {schema_id} is invalid: {message}")]
    InvalidSchema {
        /// Stable schema identity.
        schema_id: String,
        /// Validator diagnostic without payload contents.
        message: String,
    },
    /// The payload violates its authoritative JSON Schema.
    #[error("contract payload violates {schema_id}: {message}")]
    Validation {
        /// Stable schema identity.
        schema_id: String,
        /// Validator diagnostic without payload contents.
        message: String,
    },
    /// The schema-valid payload could not be decoded into its generated DTO.
    #[error("contract payload could not decode as {schema_id}")]
    Decode {
        /// Stable schema identity.
        schema_id: String,
    },
}

/// A generated request, response, or event schema.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct SchemaDescriptor {
    /// Stable backend schema identity.
    pub schema_id: &'static str,
    /// Typed bus method or event topic.
    pub method_id: &'static str,
    /// `input`, `output`, or `event`.
    pub direction: &'static str,
    /// Authoritative Pydantic model name.
    pub model_name: &'static str,
    /// Canonical SHA-256 of the normalized JSON Schema.
    pub schema_hash: &'static str,
    /// Exact normalized JSON Schema consumed by Rust code generation.
    pub schema_json: &'static str,
}

/// Generated streaming metadata for an Aurora method.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct StreamingDescriptor {
    /// Unary or streaming RPC kind.
    pub rpc_kind: &'static str,
    /// Whether the request body is streamed.
    pub request_stream: bool,
    /// Whether the response is streamed.
    pub response_stream: bool,
    /// Ordered command group, when applicable.
    pub ordered_command_group: Option<&'static str>,
    /// Associated event topic, when applicable.
    pub event_topic: Option<&'static str>,
}

/// Generated method metadata used by native transports.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct MethodDescriptor {
    /// Typed method identity.
    pub method_id: &'static str,
    /// Typed bus topic.
    pub bus_topic: &'static str,
    /// Owning service module.
    pub module: &'static str,
    /// Method name within the module.
    pub name: &'static str,
    /// `use` or `manage` authorization class.
    pub method_type: &'static str,
    /// Exposure declared by the backend contract registry.
    pub exposure: &'static str,
    /// Generated HTTP route.
    pub route_path: &'static str,
    /// Route generation kind.
    pub route_kind: &'static str,
    /// Required authorization permissions.
    pub required_permissions: &'static [&'static str],
    /// Callable feature identities used by route selection.
    pub callable_feature_ids: &'static [&'static str],
    /// Input schema identity.
    pub input_schema_id: &'static str,
    /// Output schema identity.
    pub output_schema_id: &'static str,
    /// Streaming behavior.
    pub streaming: StreamingDescriptor,
}

/// Generated event metadata used by native subscribers.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct EventDescriptor {
    /// Typed event topic.
    pub event_topic: &'static str,
    /// Owning service module.
    pub module: &'static str,
    /// Event name within the module.
    pub name: &'static str,
    /// Generated payload schema identity.
    pub schema_id: &'static str,
    /// Generated payload schema hash.
    pub schema_hash: &'static str,
    /// Required authorization permissions.
    pub required_permissions: &'static [&'static str],
    /// Whether delivery must remain bounded.
    pub bounded: bool,
    /// Whether the event is externally authorized.
    pub authorized: bool,
    /// Ordered event group, when applicable.
    pub ordered_event_group: Option<&'static str>,
    /// Whether the route may carry remote raw audio.
    pub remote_raw_audio_route: bool,
}

fn normalize_contract_value(
    schema_id: &str,
    mut value: Value,
) -> Result<(Value, &'static CompiledSchema), ContractParseError> {
    let schemas =
        COMPILED_SCHEMAS
            .as_ref()
            .map_err(|message| ContractParseError::InvalidSchema {
                schema_id: schema_id.to_owned(),
                message: message.clone(),
            })?;
    let compiled = schemas
        .get(schema_id)
        .ok_or_else(|| ContractParseError::UnknownSchema(schema_id.to_owned()))?;
    extensions::normalize(&compiled.schema, &mut value).map_err(|message| {
        ContractParseError::Validation {
            schema_id: schema_id.to_owned(),
            message,
        }
    })?;
    Ok((value, compiled))
}

fn validate_normalized_contract_schema(
    schema_id: &str,
    compiled: &CompiledSchema,
    value: &Value,
) -> Result<(), ContractParseError> {
    extensions::validate(&compiled.schema, value).map_err(|message| {
        ContractParseError::Validation {
            schema_id: schema_id.to_owned(),
            message,
        }
    })?;
    compiled
        .validator
        .validate(value)
        .map_err(|error| ContractParseError::Validation {
            schema_id: schema_id.to_owned(),
            message: format!(
                "value at {} failed schema validation",
                error.instance_path()
            ),
        })?;
    Ok(())
}

mod generated;

pub use generated::models;
pub use generated::{
    event_by_topic, method_by_id, normalize_generated_contract, schema_by_id,
    validate_generated_contract, EVENT_DESCRIPTORS, METHOD_DESCRIPTORS, SCHEMA_DESCRIPTORS,
};
