import json
from pathlib import Path

import pytest

from scripts import generate_backend_inventory
from scripts.sdk_zod_codegen import (
    CompileContext,
    UnsupportedSchemaError,
    ZodCompiler,
    canonical_json,
    render_zod_module,
    sha256_json,
)


def test_zod_codegen_rejects_unsupported_tuple_with_contract_context() -> None:
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "array",
        "prefixItems": [{"type": "string"}, {"type": "string"}],
    }

    compiler = ZodCompiler(
        schema,
        ctx=CompileContext("Tooling.ExecuteTool", "input", "TupleModel"),
        symbol_prefix="TupleModel",
    )

    with pytest.raises(UnsupportedSchemaError) as exc_info:
        compiler.compile_root()

    message = str(exc_info.value)
    assert "Tooling.ExecuteTool input TupleModel #" in message
    assert "tuple arrays are unsupported" in message


def test_zod_codegen_maps_extra_modes_without_weakened_fallbacks() -> None:
    contract_schema = {
        "schemas": [
            {
                "schema_id": "Example.Input.ExampleRequest",
                "method_id": "Example.Input",
                "direction": "input",
                "model_name": "ExampleRequest",
                "schema": {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "x-aurora-extra-behavior": "forbid",
                    "additionalProperties": False,
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
            },
            {
                "schema_id": "Example.Output.ExampleResponse",
                "method_id": "Example.Output",
                "direction": "output",
                "model_name": "ExampleResponse",
                "schema": {
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    "type": "object",
                    "x-aurora-extra-behavior": "preserve",
                    "additionalProperties": {"type": "string"},
                    "properties": {},
                },
            },
        ]
    }

    rendered = render_zod_module(contract_schema)

    assert "z.strictObject" in rendered
    assert ".catchall(z.string())" in rendered
    assert "z.any(" not in rendered
    assert "z.unknown(" not in rendered


def test_generated_contract_outputs_are_deterministic_and_hashed(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"

    for output_dir in (first, second):
        generate_backend_inventory.write_sdk_contract_outputs(
            schema_output=output_dir / "backend-contracts.schema.json",
            zod_output=output_dir / "backend-contracts.zod.ts",
            manifest_output=output_dir / "backend-contracts.manifest.json",
            tooling_provider_output=output_dir / "tooling-local-provider-v1.json",
        )

    first_files = {path.name: path.read_text() for path in first.iterdir()}
    second_files = {path.name: path.read_text() for path in second.iterdir()}
    assert first_files == second_files

    schema = json.loads(first_files["backend-contracts.schema.json"])
    manifest = json.loads(first_files["backend-contracts.manifest.json"])
    provider = json.loads(first_files["tooling-local-provider-v1.json"])

    assert manifest["content_hashes"]["backend-contracts.schema.json"] == sha256_json(schema)
    assert manifest["content_hashes"]["tooling-local-provider-v1.json"] == sha256_json(provider)
    assert "generated_at" not in canonical_json(manifest)
    assert provider["provider_service_instance_id"] == "local:aurora-sdk-local-provider-v1:Tooling"
    assert {item["method_id"] for item in provider["methods"]} == set(
        generate_backend_inventory.SDK_CONTRACT_ALLOWLIST
    )


def test_generated_vectors_capture_strip_and_reject_semantics() -> None:
    schema = generate_backend_inventory.build_sdk_contract_schema()
    by_model = {item["model_name"]: item for item in schema["schemas"]}

    stats_vector = by_model["ToolingGetStatsResponse"]["vectors"]["positive"]
    assert stats_vector["normalized"] == {
        "core_tools": 1,
        "mcp_tools_loaded": 1,
        "plugin_tools": 0,
        "total_tools": 2,
    }

    execute_negative = by_model["ToolingExecuteToolRequest"]["vectors"]["negative"]
    assert execute_negative["accepted"] is False
    assert execute_negative["issue_path"] == "$.tool_name"
