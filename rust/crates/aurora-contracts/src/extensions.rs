use std::collections::BTreeSet;
use std::fmt::Write as _;

use base64::Engine as _;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

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
        .get("x-aurora-tts-language-pack-voice-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_language_pack_voice(value)?;
    }
    if schema
        .get("x-aurora-tts-language-pack-descriptor-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_language_pack_descriptor(value)?;
    }
    if schema
        .get("x-aurora-tts-language-pack-list-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_language_pack_list(value)?;
    }
    if schema
        .get("x-aurora-tts-capabilities-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_capabilities(value)?;
    }
    if schema
        .get("x-aurora-tts-voice-descriptor-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_voice_descriptor(value)?;
    }
    if schema
        .get("x-aurora-tts-voice-list-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_voice_list(value)?;
    }
    if schema
        .get("x-aurora-tts-profile-descriptor-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_profile_descriptor(value)?;
    }
    if schema
        .get("x-aurora-tts-profile-list-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_profile_list(value)?;
    }
    if schema
        .get("x-aurora-tts-get-profile-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_get_profile_response(value)?;
    }
    if schema
        .get("x-aurora-tts-update-profile-patch-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_update_profile_patch(value)?;
    }
    if schema
        .get("x-aurora-tts-create-profile-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_create_profile_response(value)?;
    }
    if schema
        .get("x-aurora-tts-delete-profile-request-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_delete_profile_request(value)?;
    }
    if schema
        .get("x-aurora-tts-delete-profile-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_delete_profile_response(value)?;
    }
    if schema
        .get("x-aurora-tts-profile-mutation-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_profile_mutation_response(value)?;
    }
    if schema
        .get("x-aurora-tts-import-start-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_import_start_response(value)?;
    }
    if schema
        .get("x-aurora-tts-import-chunk-request-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_import_chunk_request(value)?;
    }
    if schema
        .get("x-aurora-tts-import-chunk-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_import_chunk_response(value)?;
    }
    if schema
        .get("x-aurora-stt-transcribe-language-shape")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_stt_transcribe_language_shape(value)?;
    }
    if schema
        .get("x-aurora-speech-language-requirement")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_speech_language_requirement(value)?;
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
        .get("x-aurora-tts-clone-state-bundle-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_clone_state_bundle(value)?;
    }
    if schema
        .get("x-aurora-tts-export-profile-request-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_export_profile_request(value)?;
    }
    if schema
        .get("x-aurora-tts-export-profile-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_export_profile_response(value)?;
    }
    if schema
        .get("x-aurora-tts-import-profile-response-invariant")
        .and_then(Value::as_bool)
        == Some(true)
    {
        validate_tts_import_profile_response(value)?;
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
    if schema
        .get("x-aurora-speech-language-requirement")
        .and_then(Value::as_bool)
        == Some(true)
    {
        normalize_speech_language_requirement(value)?;
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

fn validate_tts_language_pack_voice(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let ready = object.get("ready").and_then(Value::as_bool) == Some(true);
    let installed = object.get("installed").and_then(Value::as_bool) == Some(true);
    let default = object.get("default").and_then(Value::as_bool) == Some(true);
    let active = object.get("active").and_then(Value::as_bool) == Some(true);
    if ready && !installed {
        return Err("ready language pack voice must be installed".to_owned());
    }
    if (default || active) && !ready {
        return Err("default or active language pack voice must be ready".to_owned());
    }
    Ok(())
}

fn validate_tts_language_pack_list(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let Some(packs) = object.get("packs").and_then(Value::as_array) else {
        return Ok(());
    };
    let pack_ids: Vec<&str> = packs
        .iter()
        .filter_map(|pack| {
            pack.as_object()
                .and_then(|pack| pack.get("pack_id"))
                .and_then(Value::as_str)
        })
        .collect();
    if has_duplicate_strings(pack_ids.iter().copied()) {
        return Err("language pack list cannot contain duplicate packs".to_owned());
    }
    match object.get("catalog_status").and_then(Value::as_str) {
        Some("available")
            if object
                .get("catalog_error_code")
                .is_some_and(|value| !value.is_null()) =>
        {
            return Err("available language pack catalog cannot include an error code".to_owned());
        }
        Some("unavailable") if object.get("catalog_error_code").is_none_or(Value::is_null) => {
            return Err("unavailable language pack catalog requires an error code".to_owned());
        }
        _ => {}
    }
    let Some(stale_default) = object.get("stale_default_voice_id").and_then(Value::as_str) else {
        return Ok(());
    };
    for pack in packs {
        let Some(voices) = pack
            .as_object()
            .and_then(|pack| pack.get("voices"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for voice in voices {
            let Some(voice) = voice.as_object() else {
                continue;
            };
            let ready = voice.get("ready").and_then(Value::as_bool) == Some(true);
            let default = voice.get("default").and_then(Value::as_bool) == Some(true);
            let voice_id = voice.get("voice_id").and_then(Value::as_str);
            if (ready || default) && voice_id == Some(stale_default) {
                return Err("stale default voice cannot be ready or default".to_owned());
            }
        }
    }
    Ok(())
}

fn validate_tts_capabilities(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let supported = string_set(object.get("supported_language_pack_ids"));
    let installed_ids = string_list(object.get("installed_language_pack_ids"));
    let installed = string_set(object.get("installed_language_pack_ids"));
    let resident_ids = string_list(object.get("resident_language_pack_ids"));
    let resident = string_set(object.get("resident_language_pack_ids"));
    let bindings = object_array(object.get("resident_language_packs"));
    let binding_ids: Vec<&str> = bindings
        .iter()
        .filter_map(|binding| binding.get("pack_id").and_then(Value::as_str))
        .collect();
    for id in installed_ids {
        if !supported.contains(id) {
            return Err("installed packs must be supported".to_owned());
        }
    }
    for id in resident_ids {
        if !installed.contains(id) {
            return Err("resident packs must be installed".to_owned());
        }
    }
    if has_duplicate_strings(binding_ids.iter().copied()) {
        return Err("resident language pack bindings must be unique".to_owned());
    }
    if binding_ids.len() != resident.len() || binding_ids.iter().any(|id| !resident.contains(id)) {
        return Err("resident language pack ids and bindings must match".to_owned());
    }
    let mut bound_ready_languages = BTreeSet::new();
    for binding in &bindings {
        for language in string_list(binding.get("ready_languages")) {
            bound_ready_languages.insert(language);
        }
    }
    let ready_languages = string_set(object.get("ready_languages"));
    if bound_ready_languages != ready_languages {
        return Err("ready languages must match resident language pack bindings".to_owned());
    }
    if number_field(object, "resident_base_model_count")
        .zip(number_field(object, "max_resident_base_models"))
        .is_some_and(|(count, max)| count > max)
    {
        return Err("resident base model count exceeds limit".to_owned());
    }
    let ready = bool_field(object, "ready") == Some(true);
    if !ready && !ready_languages.is_empty() {
        return Err("ready=false cannot advertise ready languages".to_owned());
    }
    if ready {
        let model_status = object.get("model_status").and_then(Value::as_str);
        if !matches!(model_status, Some("ready" | "degraded")) {
            return Err("ready capability needs a usable model status".to_owned());
        }
        if ready_languages.is_empty() || resident.is_empty() {
            return Err("ready capability needs resident languages and packs".to_owned());
        }
        if number_field(object, "resident_base_model_count").is_some_and(|count| count < 1) {
            return Err("ready capability needs a resident base model".to_owned());
        }
        if string_list(object.get("output_formats")).is_empty()
            || object
                .get("sample_rates")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        {
            return Err("ready capability needs output formats and sample rates".to_owned());
        }
    } else if object.get("model_status").and_then(Value::as_str) == Some("ready") {
        return Err("model_status=ready requires ready=true".to_owned());
    }
    let cloning = bool_field(object, "cloning") == Some(true);
    if cloning {
        if string_list(object.get("accepted_clone_import_formats")).is_empty() {
            return Err("cloning needs at least one accepted import format".to_owned());
        }
        if number_field(object, "max_clone_import_bytes").is_none_or(|value| value < 1)
            || number_field(object, "max_clone_chunk_bytes").is_none_or(|value| value < 1)
        {
            return Err("cloning needs positive import limits".to_owned());
        }
    } else if !string_list(object.get("accepted_clone_import_formats")).is_empty()
        || number_field(object, "max_clone_import_bytes").is_some_and(|value| value != 0)
        || number_field(object, "max_clone_chunk_bytes").is_some_and(|value| value != 0)
    {
        return Err("cloning=false cannot advertise clone import support".to_owned());
    }
    Ok(())
}

fn validate_tts_voice_descriptor(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let voice_id = optional_string(object, "voice_id");
    match object.get("kind").and_then(Value::as_str) {
        Some("standard") if voice_id.is_none_or(|id| !id.starts_with("standard:")) => {
            Err("standard voice kind needs a standard logical voice id".to_owned())
        }
        Some("cloned") if voice_id.is_none_or(|id| !id.starts_with("clone:")) => {
            Err("cloned voice kind needs a clone logical voice id".to_owned())
        }
        _ if bool_field(object, "ready") == Some(true)
            && string_list(object.get("compatible_language_pack_ids")).is_empty() =>
        {
            Err("ready voice needs a compatible language pack".to_owned())
        }
        _ => Ok(()),
    }
}

fn validate_tts_voice_list(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let voices = object_array(object.get("voices"));
    if voices
        .iter()
        .any(|voice| bool_field(voice, "ready") != Some(true))
    {
        return Err("use-safe voice list cannot contain unready voices".to_owned());
    }
    let ids = voices
        .iter()
        .filter_map(|voice| voice.get("voice_id").and_then(Value::as_str));
    if has_duplicate_strings(ids) {
        return Err("use-safe voice list cannot contain duplicate voices".to_owned());
    }
    Ok(())
}

fn validate_tts_language_pack_descriptor(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let voices = object_array(object.get("voices"));
    let ids = voices
        .iter()
        .filter_map(|voice| voice.get("voice_id").and_then(Value::as_str));
    if has_duplicate_strings(ids) {
        return Err("language pack cannot contain duplicate voices".to_owned());
    }
    let installed = voices
        .iter()
        .filter(|voice| bool_field(voice, "installed") == Some(true))
        .count() as i64;
    let ready = voices
        .iter()
        .filter(|voice| bool_field(voice, "ready") == Some(true))
        .count() as i64;
    let has_default = voices
        .iter()
        .any(|voice| bool_field(voice, "default") == Some(true));
    if number_field(object, "voice_count") != Some(voices.len() as i64) {
        return Err("voice count must match listed voices".to_owned());
    }
    if number_field(object, "installed_voice_count") != Some(installed) {
        return Err("installed voice count must match listed voices".to_owned());
    }
    if number_field(object, "ready_voice_count") != Some(ready) {
        return Err("ready voice count must match listed voices".to_owned());
    }
    if bool_field(object, "installed") != Some(installed > 0) {
        return Err("installed pack state must match installed voices".to_owned());
    }
    if bool_field(object, "ready") != Some(ready > 0) {
        return Err("ready pack state must match ready voices".to_owned());
    }
    if bool_field(object, "default") != Some(has_default) {
        return Err("default pack state must match listed voices".to_owned());
    }
    Ok(())
}

fn validate_tts_profile_descriptor(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let voice_id = optional_string(object, "voice_id");
    match object.get("kind").and_then(Value::as_str) {
        Some("standard") if voice_id.is_none_or(|id| !id.starts_with("standard:")) => {
            return Err("standard profile kind needs a standard logical voice id".to_owned());
        }
        Some("cloned") if voice_id.is_none_or(|id| !id.starts_with("clone:")) => {
            return Err("cloned profile kind needs a clone logical voice id".to_owned());
        }
        _ => {}
    }
    if bool_field(object, "ready") == Some(true) && bool_field(object, "installed") != Some(true) {
        return Err("ready profile must be installed".to_owned());
    }
    if (bool_field(object, "default") == Some(true) || bool_field(object, "active") == Some(true))
        && bool_field(object, "ready") != Some(true)
    {
        return Err("default or active profile must be ready".to_owned());
    }
    if object.get("kind").and_then(Value::as_str) == Some("standard")
        && bool_field(object, "retained_source") == Some(true)
    {
        return Err("standard profile cannot retain clone source".to_owned());
    }
    if object.get("visibility").and_then(Value::as_str) == Some("private")
        && !string_list(object.get("allowed_peer_ids")).is_empty()
    {
        return Err("private profile cannot expose allowed peers".to_owned());
    }
    Ok(())
}

fn validate_tts_profile_list(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let profiles = object_array(object.get("profiles"));
    let ids = profiles
        .iter()
        .filter_map(|profile| profile.get("voice_id").and_then(Value::as_str));
    if has_duplicate_strings(ids) {
        return Err("voice profile list cannot contain duplicate profiles".to_owned());
    }
    Ok(())
}

fn validate_tts_get_profile_response(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let found = bool_field(object, "found") == Some(true);
    let profile = object.get("profile");
    if found && profile.is_none_or(Value::is_null) {
        return Err("found voice profile response requires profile".to_owned());
    }
    if !found && profile.is_some_and(|profile| !profile.is_null()) {
        return Err("missing voice profile response cannot include profile".to_owned());
    }
    Ok(())
}

fn validate_tts_update_profile_patch(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if !object.contains_key("display_name")
        && !object.contains_key("enabled")
        && !object.contains_key("visibility")
        && !object.contains_key("allowed_peer_ids")
    {
        return Err("voice profile update must include a change".to_owned());
    }
    if object.get("visibility").and_then(Value::as_str) == Some("private")
        && !string_list(object.get("allowed_peer_ids")).is_empty()
    {
        return Err("private visibility cannot include allowed peers".to_owned());
    }
    Ok(())
}

fn validate_tts_create_profile_response(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let ok = matches!(
        object.get("status").and_then(Value::as_str),
        Some("created" | "queued" | "ready")
    );
    let voice_id = optional_string(object, "voice_id");
    if ok && object.get("revision").is_none_or(Value::is_null) {
        return Err("successful create result needs revision".to_owned());
    }
    if ok && object.get("voice_id").is_none_or(Value::is_null) {
        return Err("successful create result needs voice_id".to_owned());
    }
    if voice_id.is_some_and(|id| !id.starts_with("clone:")) {
        return Err("created profile must use a clone logical voice id".to_owned());
    }
    Ok(())
}

fn validate_tts_delete_profile_request(value: &Value) -> Result<(), String> {
    validate_clone_voice_id(
        value,
        "voice_id",
        "only cloned voice profiles can be deleted",
    )
}

fn validate_tts_delete_profile_response(value: &Value) -> Result<(), String> {
    validate_clone_voice_id(
        value,
        "voice_id",
        "deleted profile result must use a clone logical voice id",
    )?;
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if matches!(
        object.get("status").and_then(Value::as_str),
        Some("deleted" | "revision_conflict")
    ) && object.get("revision").is_none_or(Value::is_null)
    {
        return Err("delete result needs revision".to_owned());
    }
    Ok(())
}

fn validate_tts_profile_mutation_response(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if !matches!(
        object.get("status").and_then(Value::as_str),
        Some("rejected" | "not_found")
    ) && object.get("revision").is_none_or(Value::is_null)
    {
        return Err("successful or conflicting mutation result needs revision".to_owned());
    }
    Ok(())
}

fn validate_tts_import_start_response(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let Some(max_chunk_bytes) = number_field(object, "max_chunk_bytes") else {
        return Ok(());
    };
    let Some(max_chunks) = number_field(object, "max_chunks") else {
        return Ok(());
    };
    let Some(accepted_total_bytes) = number_field(object, "accepted_total_bytes") else {
        return Ok(());
    };
    if max_chunk_bytes.saturating_mul(max_chunks) < accepted_total_bytes {
        return Err("upload session capacity is below accepted total bytes".to_owned());
    }
    Ok(())
}

fn validate_tts_import_chunk_request(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let Some(chunk_data) = object.get("chunk_data").and_then(Value::as_str) else {
        return Ok(());
    };
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(chunk_data)
        .map_err(|_| "chunk_data must be valid base64".to_owned())?;
    if decoded.is_empty() {
        return Err("decoded chunk must not be empty".to_owned());
    }
    if decoded.len() > 49_152 {
        return Err("decoded chunk exceeds limit".to_owned());
    }
    if object
        .get("chunk_sha256")
        .and_then(Value::as_str)
        .is_some_and(|expected| sha256_hex(&decoded) != expected)
    {
        return Err("chunk SHA-256 mismatch".to_owned());
    }
    let json_len = serde_json::to_vec(value)
        .map_err(|_| "voice import chunk request cannot be measured".to_owned())?
        .len();
    if json_len > 131_072 {
        return Err("voice import chunk request exceeds JSON limit".to_owned());
    }
    Ok(())
}

fn validate_tts_import_chunk_response(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if let Some(sequence) = number_field(object, "sequence") {
        if number_field(object, "next_sequence") != Some(sequence + 1) {
            return Err("next_sequence must acknowledge exactly one chunk".to_owned());
        }
    }
    if object.get("status").and_then(Value::as_str) == Some("duplicate")
        && bool_field(object, "idempotent") != Some(true)
    {
        return Err("duplicate chunk acknowledgement must be idempotent".to_owned());
    }
    if object.get("status").and_then(Value::as_str) == Some("accepted")
        && bool_field(object, "idempotent") == Some(true)
    {
        return Err("first chunk acknowledgement cannot be idempotent".to_owned());
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

fn normalize_speech_language_requirement(value: &mut Value) -> Result<(), String> {
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    match object.get_mut("language") {
        Some(language) => normalize_speech_language_value(language, true),
        None => {
            object.insert("language".to_owned(), Value::Null);
        }
    }
    match object.get_mut("auto_language_candidates") {
        Some(candidates) => normalize_speech_language_array(candidates),
        None => {
            object.insert(
                "auto_language_candidates".to_owned(),
                Value::Array(Vec::new()),
            );
        }
    }
    if !object.contains_key("table_revision") {
        object.insert(
            "table_revision".to_owned(),
            Value::String("aurora-speech-language-v2".to_owned()),
        );
    }
    let expected = speech_language_requirement_digest(object)?;
    if object
        .get("digest")
        .and_then(Value::as_str)
        .is_some_and(|actual| actual != expected)
    {
        return Err("language requirement digest mismatch".to_owned());
    }
    object.insert("digest".to_owned(), Value::String(expected));
    Ok(())
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

fn validate_tts_clone_state_bundle(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let data = object
        .get("artifact_data_base64")
        .and_then(Value::as_str)
        .ok_or_else(|| "voice state bundle artifact data is missing".to_owned())?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "voice state bundle artifact data must be valid base64".to_owned())?;
    let expected_size = object
        .get("artifact_size_bytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| "voice state bundle artifact size is missing".to_owned())?;
    if decoded.len() as u64 != expected_size {
        return Err("voice state bundle artifact size mismatch".to_owned());
    }
    let expected_sha = object
        .get("artifact_sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "voice state bundle artifact digest is missing".to_owned())?;
    if sha256_hex(&decoded) != expected_sha {
        return Err("voice state bundle artifact digest mismatch".to_owned());
    }
    if object
        .get("voice_id")
        .and_then(Value::as_str)
        .is_some_and(|voice_id| !voice_id.starts_with("clone:"))
    {
        return Err("voice state bundle must identify a cloned voice".to_owned());
    }
    Ok(())
}

fn validate_tts_export_profile_request(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if object
        .get("voice_id")
        .and_then(Value::as_str)
        .is_some_and(|voice_id| !voice_id.starts_with("clone:"))
    {
        return Err("only cloned voice profiles can be exported".to_owned());
    }
    Ok(())
}

fn validate_tts_export_profile_response(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let status = object.get("status").and_then(Value::as_str);
    let revision = object.get("revision").filter(|value| !value.is_null());
    let bundle = object.get("bundle").filter(|value| !value.is_null());
    if status == Some("exported") {
        if revision.is_none() || bundle.is_none() {
            return Err("exported voice profile responses require revision and bundle".to_owned());
        }
        let response_voice_id = object.get("voice_id").and_then(Value::as_str);
        let bundle_voice_id = bundle
            .and_then(Value::as_object)
            .and_then(|bundle| bundle.get("voice_id"))
            .and_then(Value::as_str);
        if response_voice_id != bundle_voice_id {
            return Err("exported voice profile bundle identity mismatch".to_owned());
        }
    } else if bundle.is_some() {
        return Err("non-exported voice profile responses cannot include a bundle".to_owned());
    }
    Ok(())
}

fn validate_tts_import_profile_response(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let needs_revision = object
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "imported" | "unchanged" | "conflict"));
    if needs_revision && object.get("revision").is_none_or(Value::is_null) {
        return Err("voice profile import result requires revision".to_owned());
    }
    Ok(())
}

fn validate_stt_transcribe_language_shape(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if object
        .get("language")
        .is_some_and(|language| !language.is_null())
        && !string_list(object.get("auto_language_candidates")).is_empty()
    {
        return Err("exact STT language cannot include auto candidates".to_owned());
    }
    Ok(())
}

fn validate_speech_language_requirement(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    let language = object.get("language");
    let candidates = string_list(object.get("auto_language_candidates"));
    match object.get("mode").and_then(Value::as_str) {
        Some("exact") => {
            if language.is_none_or(Value::is_null) {
                return Err("exact language requirement needs language".to_owned());
            }
            if !candidates.is_empty() {
                return Err("exact language requirement cannot include auto candidates".to_owned());
            }
        }
        Some("auto") => {
            if language.is_some_and(|value| !value.is_null()) {
                return Err("auto language requirement cannot include exact language".to_owned());
            }
        }
        _ => {}
    }
    if !is_sorted_string_list(&candidates) {
        return Err("auto language candidates must be sorted".to_owned());
    }
    let expected = speech_language_requirement_digest(object)?;
    if object
        .get("digest")
        .and_then(Value::as_str)
        .is_some_and(|actual| actual != expected)
    {
        return Err("language requirement digest mismatch".to_owned());
    }
    Ok(())
}

fn speech_language_requirement_digest(object: &Map<String, Value>) -> Result<String, String> {
    let candidates = object
        .get("auto_language_candidates")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let language = object.get("language").cloned().unwrap_or(Value::Null);
    let mode = object.get("mode").cloned().unwrap_or(Value::Null);
    let table_revision = object
        .get("table_revision")
        .cloned()
        .unwrap_or_else(|| Value::String("aurora-speech-language-v2".to_owned()));
    let canonical = format!(
        "{{\"auto_language_candidates\":{},\"language\":{},\"mode\":{},\"table_revision\":{}}}",
        serde_json::to_string(&candidates)
            .map_err(|_| "language requirement digest payload is invalid".to_owned())?,
        serde_json::to_string(&language)
            .map_err(|_| "language requirement digest payload is invalid".to_owned())?,
        serde_json::to_string(&mode)
            .map_err(|_| "language requirement digest payload is invalid".to_owned())?,
        serde_json::to_string(&table_revision)
            .map_err(|_| "language requirement digest payload is invalid".to_owned())?,
    );
    Ok(sha256_hex(canonical.as_bytes()))
}

fn validate_clone_voice_id(value: &Value, field: &str, message: &str) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if optional_string(object, field).is_none_or(|voice_id| !voice_id.starts_with("clone:")) {
        return Err(message.to_owned());
    }
    Ok(())
}

fn object_array(value: Option<&Value>) -> Vec<&Map<String, Value>> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect()
}

fn string_list(value: Option<&Value>) -> Vec<&str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn string_set(value: Option<&Value>) -> BTreeSet<&str> {
    string_list(value).into_iter().collect()
}

fn optional_string<'a>(object: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    object.get(field).and_then(Value::as_str)
}

fn bool_field(object: &Map<String, Value>, field: &str) -> Option<bool> {
    object.get(field).and_then(Value::as_bool)
}

fn number_field(object: &Map<String, Value>, field: &str) -> Option<i64> {
    object.get(field).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
    })
}

fn has_duplicate_strings<'a>(values: impl IntoIterator<Item = &'a str>) -> bool {
    let mut seen = BTreeSet::new();
    values.into_iter().any(|value| !seen.insert(value))
}

fn is_sorted_string_list(values: &[&str]) -> bool {
    values
        .windows(2)
        .all(|pair| pair[0].chars().cmp(pair[1].chars()) != std::cmp::Ordering::Greater)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
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
