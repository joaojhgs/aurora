import json
from pathlib import Path

import pytest
from pydantic import Field, ValidationError, field_validator

from scripts import generate_backend_inventory
from scripts.sdk_zod_codegen import (
    JSON_VALUE_MARKER,
    PROJECTION_PAGE_TERMINATION_MARKER,
    STRING_NON_BLANK_MARKER,
    STRING_TRIMMED_MARKER,
    UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
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
    assert "Tooling.ExecuteTool input TupleModel #/prefixItems" in message
    assert "unsupported schema keyword 'prefixItems'" in message


def test_zod_codegen_requires_explicit_json_value_marker() -> None:
    compiler = ZodCompiler(
        {"$schema": "https://json-schema.org/draft/2020-12/schema"},
        ctx=CompileContext("Tooling.ExecuteTool", "input", "EmptyModel"),
        symbol_prefix="EmptyModel",
    )

    with pytest.raises(UnsupportedSchemaError, match="bare empty schema"):
        compiler.compile_root()

    marked = ZodCompiler(
        {"$schema": "https://json-schema.org/draft/2020-12/schema", JSON_VALUE_MARKER: True},
        ctx=CompileContext("Tooling.ExecuteTool", "input", "JsonModel"),
        symbol_prefix="JsonModel",
    )
    assert marked.compile_root()[1] == ('auroraJsonValueSchema.meta({"x-aurora-json-value":true})')


def test_zod_codegen_maps_only_validated_string_formats() -> None:
    rendered = render_zod_module(
        {
            "schemas": [
                {
                    "schema_id": f"Example.Format.{fmt}",
                    "method_id": "Example.Format",
                    "direction": "input",
                    "model_name": "FormatModel",
                    "schema": {
                        "$schema": "https://json-schema.org/draft/2020-12/schema",
                        "type": "string",
                        "format": fmt,
                    },
                }
                for fmt in ("duration", "hostname", "ipv4", "ipv6")
            ]
        }
    )

    assert "z.iso.duration()" in rendered
    assert "z.hostname()" in rendered
    assert "z.ipv4()" in rendered
    assert "z.ipv6()" in rendered


def test_zod_codegen_rejects_unsafe_regex_refs_literals_numbers_and_unions() -> None:
    cases = [
        (
            {"type": "array", "items": {"type": "string"}, "uniqueItems": True},
            "unsupported schema keyword 'uniqueItems'",
        ),
        (
            {"type": "object", "minProperties": 1, "properties": {}},
            "unsupported schema keyword 'minProperties'",
        ),
        (
            {"type": "object", "patternProperties": {"^x": {"type": "string"}}},
            "unsupported schema keyword 'patternProperties'",
        ),
        (
            {"type": "string", "contentMediaType": "application/json"},
            "unsupported schema keyword 'contentMediaType'",
        ),
        (
            {"$defs": {"Name": {"type": "string"}}, "$ref": "#/$defs/Name", "minLength": 1},
            "unsupported schema keyword 'minLength'",
        ),
        (
            {"type": "string", "pattern": r"\Aabc"},
            "Python-only regex token",
        ),
        (
            {
                "$defs": {
                    "Node": {"type": "object", "properties": {"self": {"$ref": "#/$defs/Node"}}}
                },
                "$ref": "#/$defs/Node",
            },
            "recursive reference cycle",
        ),
        (
            {"const": {"not": "primitive"}},
            "literal value must be a finite JSON primitive",
        ),
        (
            {"enum": ["ok", {"not": "primitive"}]},
            "enum value must be a finite JSON primitive",
        ),
        (
            {"type": "number", "multipleOf": float("nan")},
            "multipleOf must be a finite positive number",
        ),
        (
            {"type": "string", "contentEncoding": "utf-8"},
            "unsupported contentEncoding",
        ),
        (
            {"type": "integer", "minimum": True},
            "numeric bound must be finite",
        ),
        (
            {"type": "object", JSON_VALUE_MARKER: True},
            "JSON value marker cannot be combined",
        ),
        (
            {"type": "object", STRING_TRIMMED_MARKER: True},
            "only applies to string schemas",
        ),
        (
            {
                "type": "array",
                "items": {"type": "integer"},
                UNIQUE_STRING_ARRAY_NORMALIZE_MARKER: True,
            },
            "only applies to string arrays",
        ),
        (
            {"type": "string", PROJECTION_PAGE_TERMINATION_MARKER: True},
            "only applies to export page objects",
        ),
        (
            {"type": "object", STRING_NON_BLANK_MARKER: False},
            "must be literal true",
        ),
        (
            {
                "oneOf": [
                    {
                        "type": "object",
                        "properties": {"kind": {"const": "a"}, "value": {"type": "string"}},
                        "required": ["value"],
                    }
                ],
                "discriminator": {"propertyName": "kind"},
            },
            "discriminator field must be required",
        ),
    ]

    for schema, message in cases:
        compiler = ZodCompiler(
            {"$schema": "https://json-schema.org/draft/2020-12/schema", **schema},
            ctx=CompileContext("Tooling.ExecuteTool", "input", "UnsafeModel"),
            symbol_prefix="UnsafeModel",
        )
        with pytest.raises(UnsupportedSchemaError, match=message):
            compiler.compile_root()


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
    assert manifest["zod_version"] == "4.4.3"
    assert provider["provider_service_instance_id"] == "local:aurora-sdk-local-provider-v1:Tooling"
    assert {item["method_id"] for item in provider["methods"]} == set(
        generate_backend_inventory.SDK_CONTRACT_ALLOWLIST
    )
    provider_methods = {item["method_id"]: item for item in provider["methods"]}
    assert provider_methods["Tooling.GetExportCatalog"]["required_permission"] == "Tooling.GetTools"
    assert schema["allowlist"] == [
        "Tooling.GetTools",
        "Tooling.GetExportCatalog",
        "Tooling.PrepareExecution",
        "Tooling.ExecuteTool",
    ]
    assert (
        provider["canonical_digest_vectors"]["identity_digest"]["reordered_json_a"]
        != provider["canonical_digest_vectors"]["identity_digest"]["reordered_json_b"]
    )
    assert (
        provider["canonical_digest_vectors"]["schema_digest"]["reordered_json_a"]
        != provider["canonical_digest_vectors"]["schema_digest"]["reordered_json_b"]
    )
    assert (
        provider["canonical_digest_vectors"]["identity_digest"]["digest"]
        == provider["canonical_digest_vectors"]["identity_digest"]["digest"].lower()
    )
    assert len(provider["canonical_digest_vectors"]["schema_digest"]["digest"]) == 64
    assert len(provider["canonical_digest_vectors"]["page_hash"]["digest"]) == 64
    assert len(provider["canonical_digest_vectors"]["final_checksum"]["digest"]) == 64


def test_sdk_contract_outputs_do_not_overwrite_on_render_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = {
        "schema_output": tmp_path / "backend-contracts.schema.json",
        "zod_output": tmp_path / "backend-contracts.zod.ts",
        "manifest_output": tmp_path / "backend-contracts.manifest.json",
        "tooling_provider_output": tmp_path / "tooling-local-provider-v1.json",
    }
    for path in paths.values():
        path.write_text("old", encoding="utf-8")

    def fail_render(_contract_schema: dict[str, object]) -> str:
        raise UnsupportedSchemaError("render failed")

    monkeypatch.setattr(generate_backend_inventory, "render_zod_module", fail_render)

    with pytest.raises(UnsupportedSchemaError, match="render failed"):
        generate_backend_inventory.write_sdk_contract_outputs(**paths)

    assert {path.read_text(encoding="utf-8") for path in paths.values()} == {"old"}


def test_validator_extension_audit_rejects_unmapped_nested_validator() -> None:
    from app.shared.contracts.registry import IOModel

    class NestedModel(IOModel):
        value: str

        @field_validator("value")
        @classmethod
        def _future_validator(cls, value: str) -> str:
            return value

    class RootModel(IOModel):
        nested: NestedModel

    schema = generate_backend_inventory._model_wire_schema(RootModel, mode="validation")

    with pytest.raises(
        ValueError,
        match=(
            r"Example.Method input NestedModel #/\$defs/NestedModel/properties/value: "
            r"Pydantic validator _future_validator has no SDK schema extension mapping"
        ),
    ):
        generate_backend_inventory._assert_validator_extension_coverage(
            method_id="Example.Method",
            direction="input",
            root_model=RootModel,
            schema=schema,
        )


def test_validator_extension_audit_accepts_schema_native_constraints() -> None:
    from app.shared.contracts.registry import IOModel

    class NestedNativeModel(IOModel):
        value: str = Field(min_length=1, max_length=5)

    class RootNativeModel(IOModel):
        nested: NestedNativeModel

    schema = generate_backend_inventory._model_wire_schema(RootNativeModel, mode="validation")

    generate_backend_inventory._assert_validator_extension_coverage(
        method_id="Example.Method",
        direction="input",
        root_model=RootNativeModel,
        schema=schema,
    )


def test_validator_extension_audit_catches_future_validator_mapping_regression(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delitem(
        generate_backend_inventory.VALIDATOR_EXTENSION_VERIFIERS,
        ("ToolingToolInfo", "_bounded_unique_legacy_ids"),
    )

    with pytest.raises(
        ValueError,
        match=(
            r"Tooling.GetTools output ToolingToolInfo "
            r"#/\$defs/ToolingToolInfo/properties/legacy_global_tool_ids: "
            r"Pydantic validator _bounded_unique_legacy_ids has no SDK schema extension mapping"
        ),
    ):
        generate_backend_inventory.build_sdk_contract_schema()


def test_staged_output_promotion_success_removes_temporary_files(tmp_path: Path) -> None:
    staged = []
    for index in range(4):
        target = tmp_path / f"artifact-{index}.txt"
        tmp = tmp_path / f".artifact-{index}.txt.tmp"
        target.write_text("old", encoding="utf-8")
        tmp.write_text("new", encoding="utf-8")
        staged.append((target, tmp, generate_backend_inventory.sha256_text("new")))

    generate_backend_inventory._verify_staged_outputs(staged)
    generate_backend_inventory._promote_staged_outputs(staged)

    assert [target.read_text(encoding="utf-8") for target, _tmp, _hash in staged] == ["new"] * 4
    for target, tmp, _hash in staged:
        assert not tmp.exists()
        assert not generate_backend_inventory._promotion_backup_path(target).exists()


def test_staged_output_promotion_failure_rolls_back_every_replace_position(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replace_call_count = 8
    for fail_on_call in range(1, replace_call_count + 1):
        case_dir = tmp_path / f"fail-{fail_on_call}"
        case_dir.mkdir()
        staged = []
        for index in range(4):
            target = case_dir / f"artifact-{index}.txt"
            tmp = case_dir / f".artifact-{index}.txt.tmp"
            target.write_text(f"old-{index}", encoding="utf-8")
            tmp.write_text(f"new-{index}", encoding="utf-8")
            staged.append((target, tmp, generate_backend_inventory.sha256_text(f"new-{index}")))

        calls = {"count": 0}

        def fail_replace(
            source: Path,
            target: Path,
            *,
            calls: dict[str, int] = calls,
            fail_on_call: int = fail_on_call,
        ) -> None:
            calls["count"] += 1
            if calls["count"] == fail_on_call:
                raise RuntimeError(f"fail replace {fail_on_call}")
            source.replace(target)

        monkeypatch.setattr(generate_backend_inventory, "_replace_path", fail_replace)

        with pytest.raises(RuntimeError, match=f"fail replace {fail_on_call}"):
            generate_backend_inventory._promote_staged_outputs(staged)

        assert [target.read_text(encoding="utf-8") for target, _tmp, _hash in staged] == [
            f"old-{index}" for index in range(4)
        ]
        for target, tmp, _hash in staged:
            assert not tmp.exists()
            assert not generate_backend_inventory._promotion_backup_path(target).exists()


def test_generated_vectors_capture_strip_and_reject_semantics() -> None:
    schema = generate_backend_inventory.build_sdk_contract_schema()
    by_model = {item["model_name"]: item for item in schema["schemas"]}

    export_vector = by_model["ToolingGetExportCatalogResponse"]["vectors"]["positive"]
    assert export_vector["normalized"]["provider_peer_id"] == "aurora-sdk-local-provider-v1"
    assert export_vector["normalized"]["service_instance_id"] == (
        "local:aurora-sdk-local-provider-v1:Tooling"
    )
    assert "unexpected" not in export_vector["normalized"]

    prepare_vector = by_model["ToolingPrepareExecutionResponse"]["vectors"]["positive"]
    assert prepare_vector["normalized"]["policy_decision"]["decision_id"] == "decision-1"
    assert prepare_vector["normalized"]["secrets_redacted"] is True

    get_tools_request = by_model["ToolingGetToolsRequest"]["vectors"]["positive"]
    assert get_tools_request["normalized"]["top_k"] == 2**53 - 1

    get_tools_response = by_model["ToolingGetToolsResponse"]["vectors"]["positive"]
    assert get_tools_response["normalized"]["tools"][0]["legacy_global_tool_ids"] == [
        "legacy-a",
        "legacy-z",
    ]

    execute_negative = by_model["ToolingExecuteToolRequest"]["vectors"]["negative"]
    assert execute_negative["accepted"] is False
    assert execute_negative["issue_path"] == "$.tool_name"

    disallowed_methods = {"Tooling.GetStats", "Tooling.GetMCPStatus"}
    assert disallowed_methods.isdisjoint({item["method_id"] for item in schema["schemas"]})
    assert any(
        item == {JSON_VALUE_MARKER: True}
        for schema_item in schema["schemas"]
        for item in _walk_schema_objects(schema_item["schema"])
    )


def test_authoritative_python_contracts_reject_out_of_range_integers() -> None:
    from app.shared.contracts.models.tooling import ToolingGetToolsRequest

    ToolingGetToolsRequest.model_validate({"top_k": 2**53 - 1})
    with pytest.raises(ValidationError):
        ToolingGetToolsRequest.model_validate({"top_k": 2**53})
    with pytest.raises(ValidationError):
        ToolingGetToolsRequest.model_validate({"top_k": -(2**53)})


def _walk_schema_objects(value: object) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    if isinstance(value, dict):
        found.append(value)
        for item in value.values():
            found.extend(_walk_schema_objects(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_walk_schema_objects(item))
    return found
