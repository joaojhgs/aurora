use std::collections::BTreeSet;

use serde_json::{Map, Value};

const MAX_SCHEMA_DEPTH: usize = 128;

pub(crate) fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    validate_node(schema, schema, value, 0)
}

pub(crate) fn normalize(schema: &Value, value: &mut Value) -> Result<(), String> {
    normalize_node(schema, schema, value, 0)
}

fn normalize_node(
    root: &Value,
    schema: &Value,
    value: &mut Value,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    let Some(node) = schema.as_object() else {
        return Ok(());
    };

    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        normalize_node(root, resolve_reference(root, reference)?, value, depth + 1)?;
    }

    normalize_markers(node, value)?;

    normalize_branch_group(root, node.get("allOf"), value, depth, BranchMode::All)?;
    normalize_branch_group(root, node.get("anyOf"), value, depth, BranchMode::Any)?;
    normalize_branch_group(root, node.get("oneOf"), value, depth, BranchMode::Any)?;

    if let (Some(properties), Some(instance)) = (
        node.get("properties").and_then(Value::as_object),
        value.as_object_mut(),
    ) {
        for (name, property_schema) in properties {
            if let Some(property_value) = instance.get_mut(name) {
                normalize_node(root, property_schema, property_value, depth + 1)?;
            }
        }
    }
    if let (Some(items), Some(instance)) = (node.get("items"), value.as_array_mut()) {
        for item in instance {
            normalize_node(root, items, item, depth + 1)?;
        }
    }

    Ok(())
}

fn normalize_branch_group(
    root: &Value,
    branches: Option<&Value>,
    value: &mut Value,
    depth: usize,
    mode: BranchMode,
) -> Result<(), String> {
    let Some(branches) = branches.and_then(Value::as_array) else {
        return Ok(());
    };
    match mode {
        BranchMode::All => {
            for branch in branches {
                normalize_node(root, branch, value, depth + 1)?;
            }
            Ok(())
        }
        BranchMode::Any => {
            for branch in branches {
                if branch_matches(root, branch, value, depth + 1)? {
                    normalize_node(root, branch, value, depth + 1)?;
                    return Ok(());
                }
            }
            Ok(())
        }
    }
}

fn validate_node(root: &Value, schema: &Value, value: &Value, depth: usize) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    let Some(node) = schema.as_object() else {
        return Ok(());
    };

    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        let target = resolve_reference(root, reference)?;
        validate_node(root, target, value, depth + 1)?;
    }

    validate_markers(node, value)?;

    validate_branch_group(root, node.get("allOf"), value, depth, BranchMode::All)?;
    validate_branch_group(root, node.get("anyOf"), value, depth, BranchMode::Any)?;
    validate_branch_group(root, node.get("oneOf"), value, depth, BranchMode::Any)?;

    if let (Some(properties), Some(instance)) = (
        node.get("properties").and_then(Value::as_object),
        value.as_object(),
    ) {
        for (name, property_schema) in properties {
            if let Some(property_value) = instance.get(name) {
                validate_node(root, property_schema, property_value, depth + 1)?;
            }
        }
    }
    if let (Some(items), Some(instance)) = (node.get("items"), value.as_array()) {
        for item in instance {
            validate_node(root, items, item, depth + 1)?;
        }
    }

    Ok(())
}

#[derive(Clone, Copy)]
enum BranchMode {
    All,
    Any,
}

fn validate_branch_group(
    root: &Value,
    branches: Option<&Value>,
    value: &Value,
    depth: usize,
    mode: BranchMode,
) -> Result<(), String> {
    let Some(branches) = branches.and_then(Value::as_array) else {
        return Ok(());
    };
    match mode {
        BranchMode::All => {
            for branch in branches {
                validate_node(root, branch, value, depth + 1)?;
            }
            Ok(())
        }
        BranchMode::Any => {
            let mut matched = false;
            let mut first_error = None;
            for branch in branches {
                if !branch_matches(root, branch, value, depth + 1)? {
                    continue;
                }
                matched = true;
                match validate_node(root, branch, value, depth + 1) {
                    Ok(()) => return Ok(()),
                    Err(error) if first_error.is_none() => first_error = Some(error),
                    Err(_) => {}
                }
            }
            if matched {
                Err(first_error
                    .unwrap_or_else(|| "contract extension validation failed".to_owned()))
            } else {
                Ok(())
            }
        }
    }
}

fn branch_matches(
    root: &Value,
    schema: &Value,
    value: &Value,
    depth: usize,
) -> Result<bool, String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    let Some(node) = schema.as_object() else {
        return Ok(true);
    };
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        return branch_matches(root, resolve_reference(root, reference)?, value, depth + 1);
    }
    if let Some(constant) = node.get("const") {
        return Ok(constant == value);
    }
    if let Some(options) = node.get("enum").and_then(Value::as_array) {
        return Ok(options.contains(value));
    }
    if let Some(types) = node.get("type") {
        return Ok(match types {
            Value::String(kind) => value_has_type(value, kind),
            Value::Array(kinds) => kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| value_has_type(value, kind)),
            _ => true,
        });
    }
    if node.contains_key("properties") {
        return Ok(value.is_object());
    }
    if node.contains_key("items") {
        return Ok(value.is_array());
    }
    Ok(true)
}

fn value_has_type(value: &Value, kind: &str) -> bool {
    match kind {
        "array" => value.is_array(),
        "boolean" => value.is_boolean(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "object" => value.is_object(),
        "string" => value.is_string(),
        _ => true,
    }
}

fn resolve_reference<'a>(root: &'a Value, reference: &str) -> Result<&'a Value, String> {
    let Some(pointer) = reference.strip_prefix('#') else {
        return Err("external contract schema references are not allowed".to_owned());
    };
    root.pointer(pointer)
        .ok_or_else(|| "contract schema contains an unresolved local reference".to_owned())
}

fn validate_markers(schema: &Map<String, Value>, value: &Value) -> Result<(), String> {
    if schema
        .get("x-aurora-string-non-blank")
        .and_then(Value::as_bool)
        == Some(true)
        && value.as_str().is_some_and(|text| text.trim().is_empty())
    {
        return Err("string must not be blank".to_owned());
    }

    if schema
        .get("x-aurora-string-trimmed")
        .and_then(Value::as_bool)
        == Some(true)
        && value.as_str().is_some_and(|text| text.trim() != text)
    {
        return Err("string must be trimmed".to_owned());
    }

    if schema
        .get("x-aurora-unique-string-array-normalize")
        .and_then(Value::as_bool)
        == Some(true)
        && value.as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .is_some_and(|text| text.is_empty() || text.trim() != text)
            })
        })
    {
        return Err("string list items must be non-empty and trimmed".to_owned());
    }

    if schema
        .get("x-aurora-tts-audio-chunk-event-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_audio_chunk(value)?;
    }
    if schema
        .get("x-aurora-projection-page-termination")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_projection_page(value)?;
    }
    if schema
        .get("x-aurora-projection-identity")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_projection_identity(value)?;
    }
    if schema
        .get("x-aurora-tts-operation-id")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_operation_id(value)?;
    }
    if schema
        .get("x-aurora-bounded-nonblank-string-set-normalize")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_bounded_nonblank_string_set(value)?;
    }
    if schema
        .get("x-aurora-route-explain-no-raw-payload")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_route_explain_no_raw_payload(value)?;
    }
    if schema
        .get("x-aurora-route-explain-selector-fields")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_route_explain_selector_fields(value)?;
    }
    if schema
        .get("x-aurora-route-explain-speech-no-raw-payload")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_route_explain_speech_no_raw_payload(value)?;
    }
    Ok(())
}

fn normalize_markers(schema: &Map<String, Value>, value: &mut Value) -> Result<(), String> {
    if schema
        .get("x-aurora-speech-language-string-normalize")
        .and_then(Value::as_bool)
        == Some(true)
    {
        normalize_speech_language_value(value, schema_is_nullable(schema));
    }
    if schema
        .get("x-aurora-speech-language-auto-null")
        .and_then(Value::as_bool)
        == Some(true)
    {
        normalize_speech_language_auto_null_value(value);
    }
    if schema
        .get("x-aurora-speech-language-array-normalize")
        .and_then(Value::as_bool)
        == Some(true)
    {
        normalize_speech_language_array(value);
    }
    if schema
        .get("x-aurora-bounded-nonblank-string-set-normalize")
        .and_then(Value::as_bool)
        == Some(true)
    {
        normalize_string_set(value);
    }
    if schema
        .get("x-aurora-unique-string-array-normalize")
        .and_then(Value::as_bool)
        == Some(true)
    {
        normalize_string_set(value);
    }
    if schema
        .get("x-aurora-tts-operation-id")
        .and_then(Value::as_bool)
        == Some(true)
    {
        if let Some(text) = value.as_str() {
            if text.chars().count() > 128 {
                return Err("operation_id must be a non-blank portable identifier".to_owned());
            }
            *value = Value::String(text.trim().to_owned());
        }
    }
    Ok(())
}

fn validate_audio_chunk(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let is_final = object.get("is_final").and_then(Value::as_bool) == Some(true);
    let has_audio = object.get("audio_data").and_then(Value::as_str) != Some("");
    if !is_final && !has_audio {
        return Err("non-final audio chunk requires audio data".to_owned());
    }
    Ok(())
}

fn validate_projection_page(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let complete = object.get("complete").and_then(Value::as_bool) == Some(true);
    let has_next = has_non_null(object, "next_cursor");
    let has_total = has_non_null(object, "total_count");
    let has_checksum = has_non_null(object, "final_checksum");
    let valid = if complete {
        !has_next && has_total && has_checksum
    } else {
        has_next && !has_total && !has_checksum
    };
    if !valid {
        return Err("projection page termination is inconsistent".to_owned());
    }
    Ok(())
}

fn has_non_null(object: &Map<String, Value>, field: &str) -> bool {
    object.get(field).is_some_and(|value| !value.is_null())
}

fn schema_is_nullable(schema: &Map<String, Value>) -> bool {
    schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
        .is_some_and(|options| {
            options.iter().any(|option| {
                option
                    .as_object()
                    .and_then(|node| node.get("type"))
                    .and_then(Value::as_str)
                    == Some("null")
            })
        })
}

fn normalize_speech_language_value(value: &mut Value, blank_as_null: bool) {
    let Some(text) = value.as_str() else {
        return;
    };
    let normalized = text.trim().replace('_', "-").to_lowercase();
    if blank_as_null && normalized.is_empty() {
        *value = Value::Null;
    } else {
        *value = Value::String(normalized);
    }
}

fn normalize_speech_language_auto_null_value(value: &mut Value) {
    let Some(text) = value.as_str() else {
        return;
    };
    let normalized = text.trim().replace('_', "-").to_lowercase();
    if normalized.is_empty() || normalized == "auto" {
        *value = Value::Null;
    } else {
        *value = Value::String(normalized);
    }
}

fn normalize_speech_language_array(value: &mut Value) {
    let Some(items) = value.as_array() else {
        return;
    };
    let mut normalized = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return;
        };
        normalized.push(text.trim().replace('_', "-").to_lowercase());
    }
    normalized.sort();
    normalized.dedup();
    *value = Value::Array(normalized.into_iter().map(Value::String).collect());
}

fn normalize_string_set(value: &mut Value) {
    let Some(items) = value.as_array() else {
        return;
    };
    let mut normalized = BTreeSet::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return;
        };
        normalized.insert(text.to_owned());
    }
    *value = Value::Array(normalized.into_iter().map(Value::String).collect());
}

fn validate_tts_operation_id(value: &Value) -> Result<(), String> {
    let Some(text) = value.as_str() else {
        return Ok(());
    };
    if text.chars().count() > 128 || !is_tts_operation_id(text) {
        return Err("operation_id must be a non-blank portable identifier".to_owned());
    }
    Ok(())
}

fn is_tts_operation_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && chars.count() <= 127
        && value.chars().skip(1).all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        })
}

fn validate_bounded_nonblank_string_set(value: &Value) -> Result<(), String> {
    let Some(items) = value.as_array() else {
        return Ok(());
    };
    if items.iter().any(|item| {
        item.as_str().is_some_and(|text| {
            text.chars().count() == 0 || text.trim().is_empty() || text.chars().count() > 256
        })
    }) {
        return Err("string set items must be non-blank and bounded".to_owned());
    }
    Ok(())
}

fn validate_route_explain_no_raw_payload(value: &Value) -> Result<(), String> {
    validate_route_explain_raw_payload_node(value, &mut Vec::new())
}

fn validate_route_explain_raw_payload_node(
    value: &Value,
    path: &mut Vec<String>,
) -> Result<(), String> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(index.to_string());
                validate_route_explain_raw_payload_node(item, path)?;
                path.pop();
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if is_route_explain_raw_payload_key(key) {
                    return Err(format!(
                        "route explanations must not include request payload fields at {}",
                        issue_path(path, key)
                    ));
                }
                if path.is_empty() && key == "speech" {
                    continue;
                }
                path.push(key.clone());
                validate_route_explain_raw_payload_node(child, path)?;
                path.pop();
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_route_explain_selector_fields(value: &Value) -> Result<(), String> {
    let Some(selector) = value
        .as_object()
        .and_then(|object| object.get("selector"))
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    for key in selector.keys() {
        if !matches!(
            key.as_str(),
            "peer_id"
                | "provider_id"
                | "service_instance_id"
                | "resource_namespace"
                | "tool_id"
                | "hardware_target"
                | "data_scope"
        ) {
            return Err(format!(
                "route explanation selectors must use typed selector fields at $.selector.{key}"
            ));
        }
    }
    Ok(())
}

fn validate_route_explain_speech_no_raw_payload(value: &Value) -> Result<(), String> {
    let Some(speech) = value
        .as_object()
        .and_then(|object| object.get("speech"))
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    for key in speech.keys() {
        if is_route_explain_raw_payload_key(key) {
            return Err(format!(
                "speech route hints must not include request payload fields at $.speech.{key}"
            ));
        }
    }
    Ok(())
}

fn is_route_explain_raw_payload_key(key: &str) -> bool {
    matches!(
        key,
        "text" | "audio" | "audio_data" | "payload" | "message" | "messages" | "input" | "params"
    )
}

fn issue_path(path: &[String], key: &str) -> String {
    if path.is_empty() {
        format!("$.{key}")
    } else {
        format!("$.{}.{key}", path.join("."))
    }
}

fn validate_projection_identity(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let provider_peer_id = object
        .get("provider_peer_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "projection provider identity is missing".to_owned())?;
    if provider_peer_id.is_empty()
        || provider_peer_id.chars().count() > 160
        || provider_peer_id.trim() != provider_peer_id
        || has_projection_control_character(provider_peer_id)
    {
        return Err("projection provider identity is invalid".to_owned());
    }
    let service_instance_id = object
        .get("service_instance_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "projection service identity is missing".to_owned())?;
    if service_instance_id.is_empty() || service_instance_id.chars().count() > 256 {
        return Err("projection service identity is invalid".to_owned());
    }
    let local = format!(
        "local:{}:Tooling",
        percent_encode_projection(provider_peer_id)
    );
    let remote = format!("remote:{provider_peer_id}:Tooling");
    if service_instance_id != local && service_instance_id != remote {
        return Err("projection service identity does not match its provider".to_owned());
    }

    for tool in object
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if !is_projection_tool_identity(tool, provider_peer_id, service_instance_id) {
            return Err("projection tool identity is invalid".to_owned());
        }
    }
    for blocked in object
        .get("blocked_tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let tool = blocked.get("tool").unwrap_or(&Value::Null);
        if !is_projection_tool_identity(tool, provider_peer_id, service_instance_id) {
            return Err("blocked projection tool identity is invalid".to_owned());
        }
    }
    Ok(())
}

fn is_projection_tool_identity(
    value: &Value,
    provider_peer_id: &str,
    service_instance_id: &str,
) -> bool {
    let Some(tool) = value.as_object() else {
        return false;
    };
    let Some(provenance) = tool.get("provenance").and_then(Value::as_object) else {
        return false;
    };
    if tool.get("tool_id_scheme").and_then(Value::as_str) != Some("aurora-tool")
        || tool.get("tool_id_version").and_then(Value::as_u64) != Some(1)
        || tool.get("provider_peer_id").and_then(Value::as_str) != Some(provider_peer_id)
        || tool
            .get("provider_service_instance_id")
            .and_then(Value::as_str)
            != Some(service_instance_id)
        || provenance.get("provider_peer_id").and_then(Value::as_str) != Some(provider_peer_id)
        || provenance
            .get("provider_service_instance_id")
            .and_then(Value::as_str)
            != Some(service_instance_id)
    {
        return false;
    }

    let Some(contract_id) = tool.get("tool_contract_id").and_then(Value::as_str) else {
        return false;
    };
    if contract_id.is_empty()
        || contract_id.chars().count() > 160
        || contract_id.trim() != contract_id
        || has_projection_control_character(contract_id)
    {
        return false;
    }
    let Some(global_id) = tool.get("global_tool_id").and_then(Value::as_str) else {
        return false;
    };
    if global_id.is_empty() || global_id.chars().count() > 1024 {
        return false;
    }
    global_id
        == format!(
            "aurora-tool:v1:{}:Tooling:{}",
            percent_encode_projection(provider_peer_id),
            percent_encode_projection(contract_id)
        )
}

fn has_projection_control_character(value: &str) -> bool {
    value.chars().any(|character| {
        let code_point = u32::from(character);
        code_point < 0x20 || code_point == 0x7f
    })
}

fn percent_encode_projection(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::percent_encode_projection;

    #[test]
    fn projection_percent_encoding_is_uppercase_rfc3986() {
        assert_eq!(percent_encode_projection("peer /☃"), "peer%20%2F%E2%98%83");
    }
}
