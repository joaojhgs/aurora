use std::path::PathBuf;

use aurora_contracts::{normalize_generated_contract, ContractParseError};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct ParseFixture {
    vectors: Vec<ParseVector>,
}

#[derive(Deserialize)]
struct ParseVector {
    accepted: bool,
    input: Value,
    schema_id: String,
}

#[derive(Clone, Copy)]
enum Target {
    Insert { parent: &'static str },
    Replace { pointer: &'static str },
}

struct OpaqueSchemaCase {
    schema_id: &'static str,
    target: Target,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../../tests/fixtures/local_speech/runtime/contracts/backend_contract_parse_vectors.json",
    )
}

fn accepted_input(schema_id: &str) -> Value {
    let fixture: ParseFixture = serde_json::from_slice(
        &std::fs::read(fixture_path()).expect("contract fixture should be readable"),
    )
    .expect("contract fixture should be valid JSON");
    fixture
        .vectors
        .into_iter()
        .find(|vector| vector.accepted && vector.schema_id == schema_id)
        .unwrap_or_else(|| panic!("missing accepted fixture for {schema_id}"))
        .input
}

fn opaque_probe_value() -> Value {
    json!({
        "nested": {
            "number_token": {"$serde_json::private::Number": "1"},
            "raw_value_token": {"$serde_json::private::RawValue": "{\"ok\":true}"},
            "raw_value_plain_text": {
                "$serde_json::private::RawValue": "not JSON: { this remains ordinary data"
            },
            "ordinary": {
                "message": "ordinary text stays text",
                "number_token_text": "$serde_json::private::Number",
                "raw_value_non_json_text": "not JSON: { this stays ordinary text"
            }
        },
        "array": [
            {"$serde_json::private::Number": "2"},
            {"$serde_json::private::RawValue": "[\"plain\",3]"},
            {"note": "nested ordinary text"}
        ]
    })
}

fn put_probe(input: &mut Value, target: Target, opaque: Value) -> String {
    match target {
        Target::Insert { parent } => {
            let object = input
                .pointer_mut(parent)
                .and_then(Value::as_object_mut)
                .unwrap_or_else(|| panic!("fixture parent {parent} should be an object"));
            object.insert("opaque_probe".to_owned(), opaque);
            format!("{parent}/opaque_probe")
        }
        Target::Replace { pointer } => {
            *input
                .pointer_mut(pointer)
                .unwrap_or_else(|| panic!("fixture target {pointer} should exist")) = opaque;
            pointer.to_owned()
        }
    }
}

#[test]
fn all_opaque_schema_families_preserve_json_values_through_public_normalizer() {
    let cases = [
        OpaqueSchemaCase {
            schema_id: "Aurora.EventStream.envelope.AuroraEventStreamEvent",
            target: Target::Insert { parent: "/payload" },
        },
        OpaqueSchemaCase {
            schema_id: "Orchestrator.ExternalUserInput.output.OrchestratorResponse",
            target: Target::Insert {
                parent: "/metadata",
            },
        },
        OpaqueSchemaCase {
            schema_id: "Orchestrator.Response.event.AssistantStreamEvent",
            target: Target::Insert {
                parent: "/metadata",
            },
        },
        OpaqueSchemaCase {
            schema_id: "Tooling.ExecuteTool.input.ToolingExecuteToolRequest",
            target: Target::Insert {
                parent: "/arguments",
            },
        },
        OpaqueSchemaCase {
            schema_id: "Tooling.ExecuteTool.output.ToolingExecuteToolResponse",
            target: Target::Replace { pointer: "/data" },
        },
        OpaqueSchemaCase {
            schema_id: "Tooling.GetExportCatalog.output.ToolingGetExportCatalogResponse",
            target: Target::Insert {
                parent: "/tools/0/args_schema",
            },
        },
        OpaqueSchemaCase {
            schema_id: "Tooling.GetTools.output.ToolingGetToolsResponse",
            target: Target::Insert {
                parent: "/tools/0/args_schema",
            },
        },
        OpaqueSchemaCase {
            schema_id: "Tooling.PrepareExecution.input.ToolingPrepareExecutionRequest",
            target: Target::Insert {
                parent: "/arguments",
            },
        },
        OpaqueSchemaCase {
            schema_id: "Tooling.PrepareExecution.output.ToolingPrepareExecutionResponse",
            target: Target::Insert {
                parent: "/display_args_preview",
            },
        },
    ];
    let opaque = opaque_probe_value();

    for case in cases {
        let input = accepted_input(case.schema_id);
        normalize_generated_contract(case.schema_id, input.clone()).unwrap_or_else(|error| {
            panic!("baseline fixture rejected for {}: {error}", case.schema_id)
        });

        let mut with_opaque = input;
        let output_pointer = put_probe(&mut with_opaque, case.target, opaque.clone());
        let normalized =
            normalize_generated_contract(case.schema_id, with_opaque).unwrap_or_else(|error| {
                panic!("opaque fixture rejected for {}: {error}", case.schema_id)
            });
        assert_eq!(
            normalized.pointer(&output_pointer),
            Some(&opaque),
            "{}",
            case.schema_id
        );

        let canonical =
            serde_json::to_vec(&normalized).expect("normalized output should serialize");
        let repeated = normalize_generated_contract(case.schema_id, normalized.clone())
            .unwrap_or_else(|error| {
                panic!(
                    "repeated normalization failed for {}: {error}",
                    case.schema_id
                )
            });
        assert_eq!(repeated, normalized, "{}", case.schema_id);
        assert_eq!(
            serde_json::to_vec(&repeated).expect("repeated output should serialize"),
            canonical,
            "{}",
            case.schema_id
        );
    }
}

#[test]
fn opaque_pointer_restoration_handles_escaped_and_numeric_object_keys() {
    let schema_id = "Tooling.ExecuteTool.input.ToolingExecuteToolRequest";
    let mut input = accepted_input(schema_id);
    let parent = input
        .pointer_mut("/arguments")
        .and_then(Value::as_object_mut)
        .expect("arguments fixture should be an object");
    let opaque = opaque_probe_value();
    parent.insert("slash/key~part".to_owned(), opaque.clone());
    parent.insert("0".to_owned(), opaque.clone());

    let normalized = normalize_generated_contract(schema_id, input)
        .expect("opaque values with pointer-special keys should remain valid");
    assert_eq!(
        normalized.pointer("/arguments/slash~1key~0part"),
        Some(&opaque)
    );
    assert_eq!(normalized.pointer("/arguments/0"), Some(&opaque));
}

#[test]
fn typed_fields_still_fail_schema_validation_before_opaque_dto_decode() {
    let schema_id = "Tooling.ExecuteTool.input.ToolingExecuteToolRequest";
    let mut input = accepted_input(schema_id);
    input["tool_name"] = json!({ "$serde_json::private::Number": "1" });

    let error =
        normalize_generated_contract(schema_id, input).expect_err("typed field must reject object");
    assert!(matches!(&error, ContractParseError::Validation { .. }));
    assert!(!error.to_string().contains("private::Number"));
}

#[test]
fn nullable_opaque_data_preserves_non_null_kinds_and_null_omission() {
    let schema_id = "Tooling.ExecuteTool.output.ToolingExecuteToolResponse";
    for opaque in [
        json!({"nested": [1, true, "text"]}),
        json!([{"nested": "array"}, 2]),
        json!(true),
        json!(false),
        json!(0),
        json!(1.25),
        json!("ordinary string"),
    ] {
        let mut input = accepted_input(schema_id);
        input["data"] = opaque.clone();
        let normalized = normalize_generated_contract(schema_id, input)
            .expect("non-null opaque data should remain valid");
        assert_eq!(normalized.get("data"), Some(&opaque));
    }

    let mut missing = accepted_input(schema_id);
    missing
        .as_object_mut()
        .expect("response fixture should be an object")
        .remove("data");
    let normalized_missing = normalize_generated_contract(schema_id, missing)
        .expect("missing optional data should retain its existing behavior");
    assert!(normalized_missing.get("data").is_none());

    let mut explicit_null = accepted_input(schema_id);
    explicit_null["data"] = Value::Null;
    let normalized_null = normalize_generated_contract(schema_id, explicit_null)
        .expect("explicit null opaque data should remain valid");
    assert!(normalized_null.get("data").is_none());
}

#[test]
fn referenced_tool_state_preserves_nested_opaque_fields() {
    let schema_id = "Orchestrator.Response.event.AssistantStreamEvent";
    let opaque = opaque_probe_value();
    let mut input = accepted_input(schema_id);
    input["kind"] = json!("tool.failed");
    input["tool"] = json!({
        "status": "failed",
        "tool_call_id": "call-1",
        "tool_name": "example",
        "error_details": { "opaque": opaque.clone() },
        "result_preview": { "opaque": opaque.clone() }
    });

    let normalized = normalize_generated_contract(schema_id, input)
        .expect("referenced tool state with opaque JSON should normalize");
    assert_eq!(
        normalized.pointer("/tool/error_details/opaque"),
        Some(&opaque)
    );
    assert_eq!(
        normalized.pointer("/tool/result_preview/opaque"),
        Some(&opaque)
    );
}
