use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;

use base64::Engine as _;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const MAX_SCHEMA_DEPTH: usize = 128;

const OPAQUE_JSON_MARKER: &str = "x-aurora-json-value";

pub(crate) struct OpaqueBranchValidators {
    by_pointer: HashMap<String, BranchValidatorSet>,
}

struct BranchValidatorSet {
    any_of: Option<Vec<jsonschema::Validator>>,
    one_of: Option<Vec<jsonschema::Validator>>,
}

#[derive(Default)]
pub(crate) struct OpaqueJsonValues {
    values: BTreeMap<String, Value>,
    unions: Vec<UnionObservation>,
}

struct UnionObservation {
    schema_pointer: String,
    instance_pointer: String,
    keyword: &'static str,
    branches: Vec<usize>,
}

pub(crate) fn compile_opaque_branch_validators(
    root: &Value,
) -> Result<OpaqueBranchValidators, String> {
    validate_supported_opaque_markers(root, root, "", &mut HashSet::new(), 0)?;
    let mut output = HashMap::new();
    let mut visited_refs = HashSet::new();
    compile_branch_validators_at(root, root, "", &mut visited_refs, &mut output, 0)?;
    Ok(OpaqueBranchValidators { by_pointer: output })
}

fn compile_branch_validators_at(
    root: &Value,
    schema: &Value,
    schema_pointer: &str,
    visited_refs: &mut HashSet<String>,
    output: &mut HashMap<String, BranchValidatorSet>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    let Some(object) = schema.as_object() else {
        return Ok(());
    };

    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        if let Some(target_pointer) = reference.strip_prefix('#') {
            let target = resolve_reference(root, reference)?;
            if schema_contains_opaque(root, target, &mut HashSet::new(), depth + 1)
                && visited_refs.insert(target_pointer.to_owned())
            {
                compile_branch_validators_at(
                    root,
                    target,
                    target_pointer,
                    visited_refs,
                    output,
                    depth + 1,
                )?;
            }
        }
    }

    let any_of =
        compile_union_validators(root, object.get("anyOf"), "anyOf", schema_pointer, depth)?;
    let one_of =
        compile_union_validators(root, object.get("oneOf"), "oneOf", schema_pointer, depth)?;
    if any_of.is_some() || one_of.is_some() {
        output.insert(
            schema_pointer.to_owned(),
            BranchValidatorSet { any_of, one_of },
        );
    }

    for (child_pointer, child) in schema_children(schema, schema_pointer)
        .into_iter()
        .filter(|(child_pointer, _)| schema_edge_is_supported(schema_pointer, child_pointer))
    {
        compile_branch_validators_at(root, child, &child_pointer, visited_refs, output, depth + 1)?;
    }
    Ok(())
}

fn compile_union_validators(
    root: &Value,
    branches: Option<&Value>,
    keyword: &str,
    schema_pointer: &str,
    depth: usize,
) -> Result<Option<Vec<jsonschema::Validator>>, String> {
    let Some(branches) = branches.and_then(Value::as_array) else {
        return Ok(None);
    };
    let has_opaque = branches
        .iter()
        .any(|branch| schema_contains_opaque(root, branch, &mut HashSet::new(), depth + 1));
    if !has_opaque {
        return Ok(None);
    }

    let union_pointer = pointer_child(schema_pointer, keyword);
    branches
        .iter()
        .enumerate()
        .map(|(index, branch)| {
            let branch_pointer = pointer_child(&union_pointer, &index.to_string());
            branch_validator(root, branch, &branch_pointer, schema_pointer)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
        .map_err(|_| format!("cannot compile contract {keyword} branch"))
}

fn branch_validator(
    root: &Value,
    branch: &Value,
    branch_pointer: &str,
    union_schema_pointer: &str,
) -> Result<jsonschema::Validator, String> {
    reject_ancestor_resource_scope_changes(root, union_schema_pointer)?;
    let mut references = Vec::new();
    validate_branch_reference_closure(
        root,
        branch,
        branch_pointer,
        &mut HashSet::new(),
        &mut HashSet::new(),
        &mut references,
        0,
    )?;
    for keyword in ["$defs", "definitions"] {
        if let Some(definitions) = root.get(keyword).and_then(Value::as_object) {
            let definitions_pointer = pointer_child("", keyword);
            for (name, definition) in definitions {
                reject_resource_scope_changes(
                    definition,
                    &pointer_child(&definitions_pointer, name),
                    0,
                )?;
            }
        }
    }
    let mut schema = Map::new();
    for key in ["$schema", "$id", "$defs", "definitions"] {
        if let Some(value) = root.get(key) {
            schema.insert(key.to_owned(), value.clone());
        }
    }
    schema.insert("allOf".to_owned(), Value::Array(vec![branch.clone()]));
    let wrapped = Value::Object(schema);
    for reference in references {
        let pointer = reference
            .strip_prefix('#')
            .ok_or_else(|| "unsupported opaque branch reference".to_owned())?;
        if root.pointer(pointer) != wrapped.pointer(pointer) {
            return Err("opaque branch reference scope changed".to_owned());
        }
    }
    jsonschema::validator_for(&wrapped).map_err(|_| "invalid contract branch".to_owned())
}

fn validate_supported_opaque_markers(
    root: &Value,
    schema: &Value,
    schema_pointer: &str,
    visited_refs: &mut HashSet<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    let Some(object) = schema.as_object() else {
        return Ok(());
    };
    if object.get(OPAQUE_JSON_MARKER).and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        if let Some(target_pointer) = reference.strip_prefix('#') {
            let target = resolve_reference(root, reference)?;
            if visited_refs.insert(target_pointer.to_owned()) {
                validate_supported_opaque_markers(
                    root,
                    target,
                    target_pointer,
                    visited_refs,
                    depth + 1,
                )?;
            }
        }
    }
    for (child_pointer, child) in schema_children(schema, schema_pointer) {
        if schema_edge_is_supported(schema_pointer, &child_pointer) {
            validate_supported_opaque_markers(
                root,
                child,
                &child_pointer,
                visited_refs,
                depth + 1,
            )?;
        } else if schema_contains_opaque(root, child, &mut HashSet::new(), depth + 1) {
            return Err("opaque contract marker uses an unsupported schema keyword".to_owned());
        }
    }
    Ok(())
}

fn schema_edge_is_supported(parent_pointer: &str, child_pointer: &str) -> bool {
    [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "additionalProperties",
        "allOf",
        "anyOf",
        "oneOf",
        "items",
        "prefixItems",
    ]
    .iter()
    .any(|keyword| {
        let prefix = pointer_child(parent_pointer, keyword);
        child_pointer == prefix || child_pointer.starts_with(&format!("{prefix}/"))
    })
}

#[allow(clippy::too_many_arguments)]
fn validate_branch_reference_closure(
    root: &Value,
    schema: &Value,
    schema_pointer: &str,
    visited_nodes: &mut HashSet<String>,
    visited_refs: &mut HashSet<String>,
    references: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    if !visited_nodes.insert(schema_pointer.to_owned()) {
        return Ok(());
    }
    let Some(object) = schema.as_object() else {
        return Ok(());
    };
    if has_resource_scope_override(object) {
        return Err("opaque branch changes JSON Schema resource scope".to_owned());
    }
    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        if !reference.starts_with("#/$defs/") {
            return Err("unsupported opaque branch reference".to_owned());
        }
        let target_pointer = reference
            .strip_prefix('#')
            .ok_or_else(|| "unsupported opaque branch reference".to_owned())?;
        let target = resolve_reference(root, reference)?;
        references.push(reference.to_owned());
        if visited_refs.insert(target_pointer.to_owned()) {
            validate_branch_reference_closure(
                root,
                target,
                target_pointer,
                visited_nodes,
                visited_refs,
                references,
                depth + 1,
            )?;
        }
    }
    for (child_pointer, child) in schema_children(schema, schema_pointer) {
        validate_branch_reference_closure(
            root,
            child,
            &child_pointer,
            visited_nodes,
            visited_refs,
            references,
            depth + 1,
        )?;
    }
    Ok(())
}

fn reject_ancestor_resource_scope_changes(
    root: &Value,
    schema_pointer: &str,
) -> Result<(), String> {
    if schema_pointer.is_empty() {
        return Ok(());
    }

    let mut current = root;
    let mut current_pointer = String::new();
    loop {
        let next = schema_children(current, &current_pointer)
            .into_iter()
            .find(|(child_pointer, _)| {
                schema_pointer == child_pointer
                    || schema_pointer.starts_with(&format!("{child_pointer}/"))
            })
            .ok_or_else(|| "opaque branch schema ancestor is unavailable".to_owned())?;
        current_pointer = next.0;
        current = next.1;
        if current.as_object().is_some_and(has_resource_scope_override) {
            return Err("opaque branch changes JSON Schema resource scope".to_owned());
        }
        if current_pointer == schema_pointer {
            return Ok(());
        }
    }
}

fn has_resource_scope_override(object: &Map<String, Value>) -> bool {
    [
        "$schema",
        "$id",
        "$anchor",
        "$dynamicAnchor",
        "$recursiveAnchor",
        "$dynamicRef",
        "$recursiveRef",
    ]
    .iter()
    .any(|keyword| object.contains_key(*keyword))
}

fn reject_resource_scope_changes(
    schema: &Value,
    schema_pointer: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    if schema.as_object().is_some_and(has_resource_scope_override) {
        return Err("copied contract definitions change JSON Schema resource scope".to_owned());
    }
    for (child_pointer, child) in schema_children(schema, schema_pointer) {
        reject_resource_scope_changes(child, &child_pointer, depth + 1)?;
    }
    Ok(())
}

fn schema_contains_opaque(
    root: &Value,
    schema: &Value,
    visited_refs: &mut HashSet<String>,
    depth: usize,
) -> bool {
    if depth > MAX_SCHEMA_DEPTH {
        return false;
    }
    let Some(object) = schema.as_object() else {
        return false;
    };
    if object.get(OPAQUE_JSON_MARKER).and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        if let Ok(target) = resolve_reference(root, reference) {
            let target_pointer = reference.strip_prefix('#').unwrap_or(reference);
            if visited_refs.insert(target_pointer.to_owned())
                && schema_contains_opaque(root, target, visited_refs, depth + 1)
            {
                return true;
            }
        }
    }
    schema_children(schema, "")
        .into_iter()
        .any(|(_, child)| schema_contains_opaque(root, child, visited_refs, depth + 1))
}

fn schema_children<'a>(schema: &'a Value, pointer: &str) -> Vec<(String, &'a Value)> {
    let Some(object) = schema.as_object() else {
        return Vec::new();
    };
    let mut children = Vec::new();
    for keyword in [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "dependentSchemas",
    ] {
        if let Some(entries) = object.get(keyword).and_then(Value::as_object) {
            for (name, child) in entries {
                children.push((pointer_child(&pointer_child(pointer, keyword), name), child));
            }
        }
    }
    for keyword in [
        "additionalProperties",
        "unevaluatedProperties",
        "items",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
        "additionalItems",
        "unevaluatedItems",
        "contentSchema",
    ] {
        if let Some(child) = object
            .get(keyword)
            .filter(|value| value.is_object() || value.is_boolean())
        {
            children.push((pointer_child(pointer, keyword), child));
        }
    }
    for keyword in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(items) = object.get(keyword).and_then(Value::as_array) {
            for (index, child) in items.iter().enumerate() {
                children.push((
                    pointer_child(&pointer_child(pointer, keyword), &index.to_string()),
                    child,
                ));
            }
        }
    }
    if let Some(items) = object.get("items").and_then(Value::as_array) {
        for (index, child) in items.iter().enumerate() {
            children.push((
                pointer_child(&pointer_child(pointer, "items"), &index.to_string()),
                child,
            ));
        }
    }
    if let Some(dependencies) = object.get("dependencies").and_then(Value::as_object) {
        for (name, child) in dependencies
            .iter()
            .filter(|(_, value)| value.is_object() || value.is_boolean())
        {
            children.push((
                pointer_child(&pointer_child(pointer, "dependencies"), name),
                child,
            ));
        }
    }
    children
}

fn pointer_child(parent: &str, segment: &str) -> String {
    let escaped = segment.replace('~', "~0").replace('/', "~1");
    format!("{parent}/{escaped}")
}

pub(crate) fn mask_opaque_json_values(
    schema: &Value,
    branch_validators: &OpaqueBranchValidators,
    value: &Value,
) -> Result<(Value, OpaqueJsonValues), String> {
    let mut opaque = OpaqueJsonValues::default();
    collect_opaque_json_values(
        schema,
        schema,
        "",
        value,
        "",
        branch_validators,
        &mut opaque,
        0,
    )?;
    opaque.unions.retain(|observation| {
        !has_strict_opaque_ancestor(&opaque.values, &observation.instance_pointer)
    });
    let mut masked = value.clone();
    for pointer in opaque.values.keys() {
        if pointer.is_empty() {
            masked = Value::Bool(false);
        } else {
            let slot = masked
                .pointer_mut(pointer)
                .ok_or_else(|| "opaque contract value path is missing".to_owned())?;
            *slot = Value::Bool(false);
        }
    }
    for observation in &opaque.unions {
        let masked_instance = if observation.instance_pointer.is_empty() {
            &masked
        } else {
            masked
                .pointer(&observation.instance_pointer)
                .ok_or_else(|| "contract union instance path is missing".to_owned())?
        };
        let selected = selected_union_branches(
            branch_validators,
            &observation.schema_pointer,
            observation.keyword,
            masked_instance,
        )?;
        if selected != observation.branches {
            return Err("opaque placeholder changes contract union selection".to_owned());
        }
    }
    Ok((masked, opaque))
}

pub(crate) fn restore_opaque_json_values(
    value: &mut Value,
    opaque: OpaqueJsonValues,
) -> Result<(), String> {
    for (pointer, original) in opaque.values {
        if pointer.is_empty() {
            *value = original;
            continue;
        }
        let slot = value
            .pointer_mut(&pointer)
            .ok_or_else(|| "opaque contract value path is missing after DTO decode".to_owned())?;
        *slot = original;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_opaque_json_values(
    root: &Value,
    schema: &Value,
    schema_pointer: &str,
    instance: &Value,
    instance_pointer: &str,
    branch_validators: &OpaqueBranchValidators,
    output: &mut OpaqueJsonValues,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SCHEMA_DEPTH {
        return Err("contract schema reference depth exceeded".to_owned());
    }
    let Some(object) = schema.as_object() else {
        return Ok(());
    };
    if object.get(OPAQUE_JSON_MARKER).and_then(Value::as_bool) == Some(true) {
        insert_opaque_value(output, instance_pointer, instance.clone())?;
        return Ok(());
    }
    if !schema_contains_opaque(root, schema, &mut HashSet::new(), depth) {
        return Ok(());
    }

    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        let target_pointer = reference
            .strip_prefix('#')
            .ok_or_else(|| "external contract schema references are not allowed".to_owned())?;
        let target = resolve_reference(root, reference)?;
        collect_opaque_json_values(
            root,
            target,
            target_pointer,
            instance,
            instance_pointer,
            branch_validators,
            output,
            depth + 1,
        )?;
    }

    for keyword in ["allOf", "anyOf", "oneOf"] {
        let Some(branches) = object.get(keyword).and_then(Value::as_array) else {
            continue;
        };
        if keyword == "allOf" {
            for (index, branch) in branches.iter().enumerate() {
                let branch_pointer =
                    pointer_child(&pointer_child(schema_pointer, keyword), &index.to_string());
                collect_opaque_json_values(
                    root,
                    branch,
                    &branch_pointer,
                    instance,
                    instance_pointer,
                    branch_validators,
                    output,
                    depth + 1,
                )?;
            }
            continue;
        }
        if !branches
            .iter()
            .any(|branch| schema_contains_opaque(root, branch, &mut HashSet::new(), depth + 1))
        {
            continue;
        }
        let selected =
            selected_union_branches(branch_validators, schema_pointer, keyword, instance)?;
        output.unions.push(UnionObservation {
            schema_pointer: schema_pointer.to_owned(),
            instance_pointer: instance_pointer.to_owned(),
            keyword: if keyword == "anyOf" { "anyOf" } else { "oneOf" },
            branches: selected.clone(),
        });
        for index in selected {
            let branch_pointer =
                pointer_child(&pointer_child(schema_pointer, keyword), &index.to_string());
            collect_opaque_json_values(
                root,
                &branches[index],
                &branch_pointer,
                instance,
                instance_pointer,
                branch_validators,
                output,
                depth + 1,
            )?;
        }
    }

    if let (Some(properties), Some(instance_object)) = (
        object.get("properties").and_then(Value::as_object),
        instance.as_object(),
    ) {
        for (name, child_schema) in properties {
            if let Some(child_instance) = instance_object.get(name) {
                collect_opaque_json_values(
                    root,
                    child_schema,
                    &pointer_child(&pointer_child(schema_pointer, "properties"), name),
                    child_instance,
                    &pointer_child(instance_pointer, name),
                    branch_validators,
                    output,
                    depth + 1,
                )?;
            }
        }
    }
    if let (Some(patterns), Some(instance_object)) = (
        object.get("patternProperties").and_then(Value::as_object),
        instance.as_object(),
    ) {
        for (pattern, child_schema) in patterns {
            let regex = regress::Regex::new(pattern)
                .map_err(|_| "invalid contract patternProperties expression".to_owned())?;
            for (name, child_instance) in instance_object {
                if regex.find(name).is_some() {
                    collect_opaque_json_values(
                        root,
                        child_schema,
                        &pointer_child(
                            &pointer_child(schema_pointer, "patternProperties"),
                            pattern,
                        ),
                        child_instance,
                        &pointer_child(instance_pointer, name),
                        branch_validators,
                        output,
                        depth + 1,
                    )?;
                }
            }
        }
    }
    if let (Some(additional_schema), Some(instance_object)) =
        (object.get("additionalProperties"), instance.as_object())
    {
        if additional_schema.as_object().is_some_and(|schema| {
            schema.get(OPAQUE_JSON_MARKER).and_then(Value::as_bool) == Some(true)
        }) {
            let properties = object.get("properties").and_then(Value::as_object);
            for (name, child_instance) in instance_object {
                if !properties.is_some_and(|properties| properties.contains_key(name))
                    && !matches_pattern_property(object, name)?
                {
                    insert_opaque_value(
                        output,
                        &pointer_child(instance_pointer, name),
                        child_instance.clone(),
                    )?;
                }
            }
        } else if additional_schema.is_object() || additional_schema.is_boolean() {
            let properties = object.get("properties").and_then(Value::as_object);
            for (name, child_instance) in instance_object {
                if !properties.is_some_and(|properties| properties.contains_key(name))
                    && !matches_pattern_property(object, name)?
                {
                    collect_opaque_json_values(
                        root,
                        additional_schema,
                        &pointer_child(schema_pointer, "additionalProperties"),
                        child_instance,
                        &pointer_child(instance_pointer, name),
                        branch_validators,
                        output,
                        depth + 1,
                    )?;
                }
            }
        }
    }
    if let (Some(items_schema), Some(instance_array)) = (object.get("items"), instance.as_array()) {
        match items_schema {
            Value::Array(tuple_schemas) => {
                for (index, (child_schema, child_instance)) in
                    tuple_schemas.iter().zip(instance_array).enumerate()
                {
                    collect_opaque_json_values(
                        root,
                        child_schema,
                        &pointer_child(&pointer_child(schema_pointer, "items"), &index.to_string()),
                        child_instance,
                        &pointer_child(instance_pointer, &index.to_string()),
                        branch_validators,
                        output,
                        depth + 1,
                    )?;
                }
            }
            Value::Object(_) | Value::Bool(_) => {
                let first_unevaluated = object
                    .get("prefixItems")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                for (index, child_instance) in
                    instance_array.iter().enumerate().skip(first_unevaluated)
                {
                    collect_opaque_json_values(
                        root,
                        items_schema,
                        &pointer_child(schema_pointer, "items"),
                        child_instance,
                        &pointer_child(instance_pointer, &index.to_string()),
                        branch_validators,
                        output,
                        depth + 1,
                    )?;
                }
            }
            _ => {}
        }
    }
    if let (Some(prefix_items), Some(instance_array)) = (
        object.get("prefixItems").and_then(Value::as_array),
        instance.as_array(),
    ) {
        for (index, (child_schema, child_instance)) in
            prefix_items.iter().zip(instance_array).enumerate()
        {
            collect_opaque_json_values(
                root,
                child_schema,
                &pointer_child(
                    &pointer_child(schema_pointer, "prefixItems"),
                    &index.to_string(),
                ),
                child_instance,
                &pointer_child(instance_pointer, &index.to_string()),
                branch_validators,
                output,
                depth + 1,
            )?;
        }
    }
    Ok(())
}

fn matches_pattern_property(schema: &Map<String, Value>, name: &str) -> Result<bool, String> {
    let Some(patterns) = schema.get("patternProperties").and_then(Value::as_object) else {
        return Ok(false);
    };
    for pattern in patterns.keys() {
        let regex = regress::Regex::new(pattern)
            .map_err(|_| "invalid contract patternProperties expression".to_owned())?;
        if regex.find(name).is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn selected_union_branches(
    branch_validators: &OpaqueBranchValidators,
    schema_pointer: &str,
    keyword: &str,
    instance: &Value,
) -> Result<Vec<usize>, String> {
    let validators = branch_validators
        .by_pointer
        .get(schema_pointer)
        .and_then(|set| match keyword {
            "anyOf" => set.any_of.as_ref(),
            "oneOf" => set.one_of.as_ref(),
            _ => None,
        })
        .ok_or_else(|| "opaque union branch validators are unavailable".to_owned())?;
    let selected: Vec<usize> = validators
        .iter()
        .enumerate()
        .filter_map(|(index, validator)| validator.is_valid(instance).then_some(index))
        .collect();
    let valid = if keyword == "anyOf" {
        !selected.is_empty()
    } else {
        selected.len() == 1
    };
    if !valid {
        return Err("opaque union branch selection is ambiguous".to_owned());
    }
    Ok(selected)
}

fn insert_opaque_value(
    output: &mut OpaqueJsonValues,
    pointer: &str,
    value: Value,
) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    if let Some(existing) = output.values.get(pointer) {
        return if existing == &value {
            Ok(())
        } else {
            Err("overlapping opaque contract values disagree".to_owned())
        };
    }

    if output.values.contains_key("") {
        return Ok(());
    }
    let mut ancestor_end = pointer.rfind('/');
    while let Some(end) = ancestor_end {
        if output.values.contains_key(&pointer[..end]) {
            return Ok(());
        }
        ancestor_end = pointer[..end].rfind('/');
    }

    let descendants_prefix = if pointer.is_empty() {
        "/".to_owned()
    } else {
        format!("{pointer}/")
    };
    let descendants: Vec<String> = output
        .values
        .range(descendants_prefix.clone()..)
        .take_while(|(path, _)| path.starts_with(&descendants_prefix))
        .map(|(path, _)| path.to_owned())
        .collect();
    for descendant in descendants {
        output.values.remove(&descendant);
    }
    output.values.insert(pointer.to_owned(), value);
    Ok(())
}

fn has_strict_opaque_ancestor(values: &BTreeMap<String, Value>, pointer: &str) -> bool {
    if values.contains_key("") {
        return !pointer.is_empty();
    }
    let mut ancestor_end = pointer.rfind('/');
    while let Some(end) = ancestor_end {
        if values.contains_key(&pointer[..end]) {
            return true;
        }
        ancestor_end = pointer[..end].rfind('/');
    }
    false
}

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

#[cfg(test)]
mod opaque_json_schema_tests {
    use serde_json::{json, Value};

    use super::{
        compile_opaque_branch_validators, mask_opaque_json_values, restore_opaque_json_values,
        selected_union_branches,
    };

    fn opaque_map_schema() -> Value {
        json!({
            "type": "object",
            "additionalProperties": { "x-aurora-json-value": true }
        })
    }

    #[test]
    fn rejects_root_relative_reference_in_non_marker_sibling_constraint() {
        let schema = json!({
            "$defs": {
                "OpaqueObject": {
                    "allOf": [
                        opaque_map_schema(),
                        { "properties": { "typed": { "$ref": "#/properties/typed" } } }
                    ]
                },
                "NullableOpaque": {
                    "anyOf": [
                        { "$ref": "#/$defs/OpaqueObject" },
                        { "type": "null" }
                    ]
                }
            },
            "type": "object",
            "properties": {
                "opaque": { "$ref": "#/$defs/NullableOpaque" },
                "typed": { "type": "string" }
            }
        });

        let error = match compile_opaque_branch_validators(&schema) {
            Ok(_) => panic!("root-relative branch reference must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error, "cannot compile contract anyOf branch");
    }

    #[test]
    fn preserves_supported_transitive_defs_reference_scope() {
        let schema = json!({
            "$defs": {
                "NullableOpaque": {
                    "anyOf": [
                        { "$ref": "#/$defs/OpaqueWrapper" },
                        { "type": "null" }
                    ]
                },
                "OpaqueWrapper": { "$ref": "#/$defs/OpaqueObject" },
                "OpaqueObject": {
                    "type": "object",
                    "properties": { "typed": { "$ref": "#/$defs/TypedString" } },
                    "additionalProperties": { "x-aurora-json-value": true }
                },
                "TypedString": { "type": "string" }
            },
            "type": "object",
            "properties": { "payload": { "$ref": "#/$defs/NullableOpaque" } }
        });
        let validators = compile_opaque_branch_validators(&schema)
            .expect("root-local defs refs should retain their original targets");
        let original = json!({
            "typed": "valid sibling",
            "opaque": { "$serde_json::private::RawValue": "{\"n\":1}" }
        });
        assert_eq!(
            selected_union_branches(&validators, "/$defs/NullableOpaque", "anyOf", &original)
                .expect("branch should be selectable"),
            vec![0]
        );
        assert_eq!(
            selected_union_branches(&validators, "/$defs/NullableOpaque", "anyOf", &Value::Null)
                .expect("null should select the nullable branch"),
            vec![1]
        );
        let invalid_typed_sibling = json!({
            "typed": 42,
            "opaque": { "$serde_json::private::RawValue": "{\"n\":1}" }
        });
        assert_eq!(
            selected_union_branches(
                &validators,
                "/$defs/NullableOpaque",
                "anyOf",
                &invalid_typed_sibling
            ),
            Err("opaque union branch selection is ambiguous".to_owned())
        );

        let value = json!({ "payload": original });
        let (masked, saved) = mask_opaque_json_values(&schema, &validators, &value)
            .expect("opaque values should be masked without changing branch selection");
        assert_eq!(masked.pointer("/payload/opaque"), Some(&Value::Bool(false)));
        let mut restored = masked;
        restore_opaque_json_values(&mut restored, saved)
            .expect("opaque values should restore at their original paths");
        assert_eq!(restored, value);
    }

    #[test]
    fn rejects_resource_scope_change_in_transitive_definition() {
        let schema = json!({
            "$defs": {
                "NullableOpaque": {
                    "anyOf": [
                        { "$ref": "#/$defs/OpaqueWrapper" },
                        { "type": "null" }
                    ]
                },
                "OpaqueWrapper": { "$ref": "#/$defs/OpaqueObject" },
                "OpaqueObject": {
                    "type": "object",
                    "properties": { "typed": { "$ref": "#/$defs/ScopedString" } },
                    "additionalProperties": { "x-aurora-json-value": true }
                },
                "ScopedString": { "$id": "urn:changed-scope", "type": "string" }
            },
            "type": "object",
            "properties": { "payload": { "$ref": "#/$defs/NullableOpaque" } }
        });

        let error = match compile_opaque_branch_validators(&schema) {
            Ok(_) => panic!("nested resource scope change must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error, "cannot compile contract anyOf branch");
    }

    #[test]
    fn rejects_unreferenced_copied_definition_resource_scope() {
        let schema = json!({
            "$defs": {
                "Unreferenced": { "$id": "urn:unreferenced-scope", "type": "string" }
            },
            "type": "object",
            "properties": {
                "payload": {
                    "anyOf": [
                        {
                            "type": "object",
                            "additionalProperties": { "x-aurora-json-value": true }
                        },
                        { "type": "null" }
                    ]
                }
            }
        });

        let error = match compile_opaque_branch_validators(&schema) {
            Ok(_) => panic!("every copied definition must retain the original resource scope"),
            Err(error) => error,
        };
        assert_eq!(error, "cannot compile contract anyOf branch");
    }

    #[test]
    fn rejects_opaque_union_under_nested_resource_scope() {
        let schema = json!({
            "$defs": { "Typed": { "type": "string" } },
            "type": "object",
            "properties": {
                "payload": {
                    "$id": "urn:nested-payload-resource",
                    "$defs": { "Typed": { "type": "integer" } },
                    "anyOf": [
                        {
                            "type": "object",
                            "properties": { "typed": { "$ref": "#/$defs/Typed" } },
                            "additionalProperties": { "x-aurora-json-value": true }
                        },
                        { "type": "null" }
                    ]
                }
            }
        });
        let valid_in_original_scope = json!({
            "payload": { "typed": 7, "opaque": { "nested": [1, 2] } }
        });
        let invalid_in_original_scope = json!({
            "payload": { "typed": "outer resource would accept this", "opaque": {} }
        });
        let original_validator = jsonschema::validator_for(&schema)
            .expect("the nested-resource schema is valid JSON Schema");
        assert!(original_validator.is_valid(&valid_in_original_scope));
        assert!(!original_validator.is_valid(&invalid_in_original_scope));

        let mistaken_root_wrapper = json!({
            "$defs": { "Typed": { "type": "string" } },
            "allOf": [{
                "type": "object",
                "properties": { "typed": { "$ref": "#/$defs/Typed" } },
                "additionalProperties": { "x-aurora-json-value": true }
            }]
        });
        let relocated_validator = jsonschema::validator_for(&mistaken_root_wrapper)
            .expect("the wrapper demonstrates the changed root reference scope");
        assert!(relocated_validator.is_valid(&json!({
            "typed": "outer resource would accept this",
            "opaque": false
        })));
        assert!(!relocated_validator.is_valid(&json!({ "typed": 7, "opaque": false })));

        let error = match compile_opaque_branch_validators(&schema) {
            Ok(_) => panic!("nested resource scope must not be rebound to the wrapper root"),
            Err(error) => error,
        };
        assert_eq!(error, "cannot compile contract anyOf branch");
    }

    #[test]
    fn scope_keyword_looking_schema_entry_names_are_not_scope_keywords() {
        let schema = json!({
            "$defs": {
                "$id": {
                    "anyOf": [
                        opaque_map_schema(),
                        { "type": "null" }
                    ]
                }
            },
            "type": "object",
            "properties": {
                "$id": {
                    "anyOf": [
                        opaque_map_schema(),
                        { "type": "null" }
                    ]
                },
                "definitionPayload": { "$ref": "#/$defs/$id" }
            }
        });
        let validators = compile_opaque_branch_validators(&schema)
            .expect("property and definition names are data, not schema keywords");
        let value = json!({
            "$id": { "property-value": { "nested": true } },
            "definitionPayload": { "definition-value": [1, 2] }
        });

        let (masked, saved) = mask_opaque_json_values(&schema, &validators, &value)
            .expect("opaque values under scope-looking names should round-trip");
        assert_eq!(
            masked.pointer("/$id/property-value"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            masked.pointer("/definitionPayload/definition-value"),
            Some(&Value::Bool(false))
        );
        let mut restored = masked;
        restore_opaque_json_values(&mut restored, saved)
            .expect("scope-looking property and definition names should restore");
        assert_eq!(restored, value);
    }

    #[test]
    fn rejects_opaque_markers_under_unhandled_schema_keyword() {
        let schema = json!({
            "type": "object",
            "properties": {
                "payload": {
                    "if": {
                        "properties": {
                            "nested": { "x-aurora-json-value": true }
                        }
                    }
                }
            }
        });

        let error = match compile_opaque_branch_validators(&schema) {
            Ok(_) => panic!("unsupported marker location must be rejected"),
            Err(error) => error,
        };
        assert_eq!(
            error,
            "opaque contract marker uses an unsupported schema keyword"
        );
    }

    #[test]
    fn parent_marker_covers_descendant_union_observations() {
        let schema = json!({
            "allOf": [
                {
                    "properties": {
                        "payload": {
                            "properties": {
                                "choice": {
                                    "anyOf": [
                                        {
                                            "type": "object",
                                            "additionalProperties": { "x-aurora-json-value": true }
                                        },
                                        { "type": "null" }
                                    ]
                                }
                            }
                        }
                    }
                },
                { "properties": { "payload": { "x-aurora-json-value": true } } }
            ],
            "type": "object",
            "properties": { "payload": { "x-aurora-json-value": true } }
        });
        let validators = compile_opaque_branch_validators(&schema)
            .expect("the synthetic schema should have supported marker positions");
        let value = json!({ "payload": { "choice": { "opaque": [1, 2, 3] } } });

        let (masked, saved) = mask_opaque_json_values(&schema, &validators, &value)
            .expect("descendant branch observations under an opaque parent are irrelevant");
        assert_eq!(masked, json!({ "payload": false }));
        let mut restored = masked;
        restore_opaque_json_values(&mut restored, saved)
            .expect("enclosing opaque subtree should restore");
        assert_eq!(restored, value);
    }
}
