import json
from pathlib import Path

import pytest
from pydantic import Field, ValidationError, field_validator

from scripts import generate_backend_inventory
from scripts.sdk_zod_codegen import (
    BOUNDED_NONBLANK_STRING_SET_MARKER,
    JSON_VALUE_MARKER,
    PROJECTION_IDENTITY_MARKER,
    PROJECTION_PAGE_TERMINATION_MARKER,
    SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER,
    STRING_NON_BLANK_MARKER,
    STRING_TRIMMED_MARKER,
    TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
    TTS_CLONE_STATE_BUNDLE_INVARIANT_MARKER,
    TTS_EXPORT_PROFILE_REQUEST_INVARIANT_MARKER,
    TTS_EXPORT_PROFILE_RESPONSE_INVARIANT_MARKER,
    TTS_IMPORT_PROFILE_RESPONSE_INVARIANT_MARKER,
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
            "contract_version": "1.0.0",
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
                for fmt in ("duration", "hostname", "ipv4", "ipv6", "binary")
            ],
        }
    )

    assert "z.iso.duration()" in rendered
    assert "z.hostname()" in rendered
    assert "z.ipv4()" in rendered
    assert "z.ipv6()" in rendered
    assert '.meta({"format":"binary"})' in rendered


def test_sdk_contract_integer_guard_rejects_one_sided_bounds() -> None:
    for schema in (
        {"type": "integer", "minimum": 0},
        {"type": "integer", "maximum": 10},
        {"type": "integer", "exclusiveMinimum": 0},
        {"type": "integer", "exclusiveMaximum": 10},
    ):
        with pytest.raises(ValueError, match="minimum and maximum"):
            generate_backend_inventory._assert_no_unbounded_integer_schema(
                schema, context="Example.Bounds"
            )

    generate_backend_inventory._assert_no_unbounded_integer_schema(
        {"type": "integer", "minimum": 0, "maximum": 10}, context="Example.Bounds"
    )
    generate_backend_inventory._assert_no_unbounded_integer_schema(
        {"type": "integer", "enum": [1, 2]}, context="Example.Bounds"
    )


@pytest.mark.parametrize(
    "schema",
    (
        {"type": "integer", "minimum": 0},
        {"type": "integer", "maximum": 10},
        {"type": "integer", "exclusiveMinimum": 0},
        {"type": "integer", "exclusiveMaximum": 10},
    ),
)
def test_zod_codegen_rejects_one_sided_integer_bounds(schema: dict[str, object]) -> None:
    compiler = ZodCompiler(
        {"$schema": "https://json-schema.org/draft/2020-12/schema", **schema},
        ctx=CompileContext("Example.Bounds", "input", "BoundedInteger"),
        symbol_prefix="BoundedInteger",
    )

    with pytest.raises(
        UnsupportedSchemaError, match="integer schema must declare minimum and maximum bounds"
    ):
        compiler.compile_root()


def test_zod_codegen_rejects_unsafe_regex_refs_literals_numbers_and_unions() -> None:
    cases = [
        (
            {"type": "array", "items": {"type": "string"}, "uniqueItems": True},
            "unsupported schema keyword 'uniqueItems'",
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
            {
                "type": "array",
                "items": {"type": "integer"},
                BOUNDED_NONBLANK_STRING_SET_MARKER: True,
            },
            "only applies to string arrays",
        ),
        (
            {
                "type": "array",
                "items": {"type": "integer"},
                SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER: True,
            },
            "only applies to string arrays",
        ),
        (
            {"type": "string", PROJECTION_PAGE_TERMINATION_MARKER: True},
            "only applies to export page objects",
        ),
        (
            {"type": "string", PROJECTION_IDENTITY_MARKER: True},
            "only applies to export page objects",
        ),
        (
            {
                "type": "object",
                "properties": {
                    "provider_peer_id": {"type": "string"},
                    "service_instance_id": {"type": "string"},
                    "tools": {"type": "array", "items": {"type": "object"}},
                    "blocked_tools": {"type": "array", "items": {"type": "object"}},
                },
                PROJECTION_IDENTITY_MARKER: False,
            },
            "must be literal true",
        ),
        (
            {"type": "object", STRING_NON_BLANK_MARKER: False},
            "must be literal true",
        ),
        (
            {
                "anyOf": [{"type": "string"}, {"type": "null"}],
                STRING_NON_BLANK_MARKER: True,
            },
            "only applies to string schemas",
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
        "contract_version": "1.0.0",
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
        ],
    }

    rendered = render_zod_module(contract_schema)

    assert "z.strictObject" in rendered
    assert ".catchall(z.string())" in rendered
    assert "z.any(" not in rendered
    assert "z.unknown(" not in rendered


def test_zod_codegen_uses_unicode_code_point_string_bounds() -> None:
    compiler = ZodCompiler(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
        },
        ctx=CompileContext("Tooling.GetExportCatalog", "output", "UnicodeBounded"),
        symbol_prefix="UnicodeBounded",
    )

    expression = compiler.compile_root()[1]

    assert "codePointLength(value) >= 1" in expression
    assert "codePointLength(value) <= 160" in expression
    assert '.meta({"minLength":1})' in expression
    assert '.meta({"maxLength":160})' in expression
    assert ".min(" not in expression
    assert ".max(" not in expression


def test_zod_codegen_uses_unicode_code_point_legacy_id_bounds() -> None:
    compiler = ZodCompiler(
        {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "array",
            "items": {"type": "string"},
            UNIQUE_STRING_ARRAY_NORMALIZE_MARKER: True,
        },
        ctx=CompileContext("Tooling.GetTools", "output", "LegacyIds"),
        symbol_prefix="LegacyIds",
    )

    expression = compiler.compile_root()[1]

    assert "codePointLength(item) === 0" in expression
    assert "codePointLength(item) > 512" in expression
    assert "item.length" not in expression


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
        generate_backend_inventory.SDK_TOOLING_PROVIDER_CONTRACT_ALLOWLIST
    )
    provider_methods = {item["method_id"]: item for item in provider["methods"]}
    assert provider_methods["Tooling.GetExportCatalog"]["required_permission"] == "Tooling.GetTools"
    assert (
        provider_methods["Tooling.PrepareExecution"]["required_permission"] == "Tooling.ExecuteTool"
    )
    assert schema["allowlist"] == list(generate_backend_inventory.SDK_CONTRACT_ALLOWLIST)
    assert schema["tooling_provider_allowlist"] == (
        list(generate_backend_inventory.SDK_TOOLING_PROVIDER_CONTRACT_ALLOWLIST)
    )
    assert len(schema["allowlist"]) == 38
    assert len(schema["schemas"]) == 80
    assert len(schema["method_descriptors"]) == 38
    assert len(schema["event_descriptors"]) == 3
    assert len(schema["envelope_descriptors"]) == 1
    assert len(provider["methods"]) == 4
    descriptors = {item["method_id"]: item for item in schema["method_descriptors"]}
    descriptor_ids = set(descriptors)
    assert descriptor_ids == set(generate_backend_inventory.SDK_CONTRACT_ALLOWLIST)
    assert "Gateway.ExplainRoute" in descriptor_ids
    assert "TTS.Synthesize" in descriptor_ids
    assert "STTCoordinator.Listen" in descriptor_ids
    assert "STTCoordinator.CapturePrepare" in descriptor_ids
    assert "STTCoordinator.CaptureRelease" in descriptor_ids
    assert "STTCoordinator.CaptureStatus" in descriptor_ids
    assert "Orchestrator.ExternalUserInput" in descriptor_ids
    assert "Orchestrator.Interrupt" in descriptor_ids
    assert "Aurora.EventStream" not in descriptor_ids
    assert all(not method_id.startswith("AudioSession.") for method_id in descriptor_ids)
    assert descriptors["TTS.CreateVoiceProfile"]["method_type"] == "manage"
    assert descriptors["TTS.CreateVoiceProfile"]["required_perms"] == ["TTS.manage"]
    assert descriptors["TTS.ExportVoiceProfile"]["method_type"] == "manage"
    assert descriptors["TTS.ExportVoiceProfile"]["required_perms"] == ["TTS.manage"]
    assert descriptors["TTS.ImportVoiceProfile"]["method_type"] == "manage"
    assert descriptors["TTS.ImportVoiceProfile"]["required_perms"] == ["TTS.manage"]
    event_descriptors = {item["event_topic"]: item for item in schema["event_descriptors"]}
    assert set(event_descriptors) == {
        "TTS.AudioChunk",
        "Orchestrator.Response",
        "Orchestrator.Interrupted",
    }
    assert event_descriptors["TTS.AudioChunk"] == {
        "event_topic": "TTS.AudioChunk",
        "module": "TTS",
        "name": "AudioChunk",
        "topic": "TTS.AudioChunk",
        "model": "TTSAudioChunkEvent",
        "schema_id": "TTS.AudioChunk.event.TTSAudioChunkEvent",
        "schema_hash": event_descriptors["TTS.AudioChunk"]["schema_hash"],
        "required_permission": "TTS.use",
        "required_perms": ["TTS.use"],
        "bounded": True,
        "authorized": True,
        "ordered_event_group": "tts_text_stream",
        "remote_raw_audio_route": False,
    }
    assert event_descriptors["Orchestrator.Response"]["schema_id"] == (
        "Orchestrator.Response.event.AssistantStreamEvent"
    )
    assert event_descriptors["Orchestrator.Response"]["required_perms"] == ["Orchestrator.use"]
    assert event_descriptors["Orchestrator.Response"]["ordered_event_group"] == "assistant_stream"
    assert event_descriptors["Orchestrator.Interrupted"]["schema_id"] == (
        "Orchestrator.Interrupted.event.OrchestratorInterruptedEvent"
    )
    envelope = schema["envelope_descriptors"][0]
    assert envelope["envelope_topic"] == "Aurora.EventStream"
    assert envelope["descriptor_kind"] == "sse_envelope"
    assert envelope["required_permissions_broad"] == ["Gateway.manage"]
    assert envelope["required_permissions_scoped"] == ["Orchestrator.use"]
    assert envelope["scoped_topics"] == ["Orchestrator.Response", "TTS.AudioChunk"]
    assert envelope["scoped_categories"] == ["assistant"]
    assert envelope["requires_correlation_id"] is True
    assert event_descriptors["TTS.AudioChunk"]["schema_hash"] == next(
        item["schema_hash"]
        for item in schema["schemas"]
        if item["schema_id"] == "TTS.AudioChunk.event.TTSAudioChunkEvent"
    )
    event_schema = next(
        item
        for item in schema["schemas"]
        if item["schema_id"] == "TTS.AudioChunk.event.TTSAudioChunkEvent"
    )
    assert event_schema["schema"][TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER] is True
    schema_by_id = {item["schema_id"]: item["schema"] for item in schema["schemas"]}
    assert (
        schema_by_id["TTS.ExportVoiceProfile.input.TTSExportVoiceProfileRequest"][
            TTS_EXPORT_PROFILE_REQUEST_INVARIANT_MARKER
        ]
        is True
    )
    assert (
        schema_by_id["TTS.ExportVoiceProfile.output.TTSExportVoiceProfileResponse"][
            TTS_EXPORT_PROFILE_RESPONSE_INVARIANT_MARKER
        ]
        is True
    )
    export_bundle = schema_by_id["TTS.ExportVoiceProfile.output.TTSExportVoiceProfileResponse"][
        "$defs"
    ]["TTSCloneVoiceStateBundle"]
    assert export_bundle[TTS_CLONE_STATE_BUNDLE_INVARIANT_MARKER] is True
    assert export_bundle["properties"]["artifact_sha256"]["pattern"] == "^[0-9a-f]{64}$"
    assert (
        schema_by_id["TTS.ImportVoiceProfile.output.TTSImportVoiceProfileResponse"][
            TTS_IMPORT_PROFILE_RESPONSE_INVARIANT_MARKER
        ]
        is True
    )
    assert any(
        vector["issue_path"] == "$"
        and vector["input"]["audio_data"] == ""
        and vector["input"]["is_final"] is False
        for vector in event_schema["vectors"]["negative_cases"]
    )
    for method_id in ("TTS.StreamStart", "TTS.StreamChunk", "TTS.StreamEnd"):
        assert descriptors[method_id]["streaming"] == {
            "event_topic": "TTS.AudioChunk",
            "ordered_command_group": "tts_text_stream",
            "request_stream": False,
            "response_stream": False,
            "rpc_kind": "unary",
        }
    assert descriptors["Transcription.ProcessAudio"]["streaming"] == {
        "event_topic": None,
        "ordered_command_group": None,
        "request_stream": False,
        "response_stream": False,
        "rpc_kind": "unary",
    }
    assert all(
        descriptor["input_schema_id"]
        and descriptor["output_schema_id"]
        and descriptor["input_schema_hash"]
        and descriptor["output_schema_hash"]
        for descriptor in descriptors.values()
    )
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


def test_sdk_contract_outputs_preserve_backup_after_incomplete_rollback(
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

    def fail_with_recovery_backup(staged_outputs: list[tuple[Path, Path, str]]) -> None:
        target, _tmp, _hash = staged_outputs[0]
        target.replace(generate_backend_inventory._promotion_backup_path(target))
        raise RuntimeError("rollback interrupted")

    monkeypatch.setattr(
        generate_backend_inventory,
        "_promote_staged_outputs",
        fail_with_recovery_backup,
    )

    with pytest.raises(RuntimeError, match="rollback interrupted"):
        generate_backend_inventory.write_sdk_contract_outputs(**paths)

    backup = generate_backend_inventory._promotion_backup_path(paths["schema_output"])
    assert backup.read_text(encoding="utf-8") == "old"


@pytest.mark.parametrize(
    "schema",
    [
        {"type": "integer", "minimum": 0},
        {"type": "integer", "maximum": 10},
        {"type": "integer"},
    ],
)
def test_sdk_contract_schema_rejects_one_sided_or_unbounded_integers(
    schema: dict[str, object],
) -> None:
    with pytest.raises(ValueError, match="must declare minimum and maximum"):
        generate_backend_inventory._assert_no_unbounded_integer_schema(
            schema,
            context="Example.Integer",
        )


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
    normalized_tool = get_tools_response["normalized"]["tools"][0]
    assert normalized_tool["legacy_global_tool_ids"] == [
        "legacy-a",
        "legacy-z",
    ]
    assert normalized_tool["share_group_id"] == "core:memory"
    assert normalized_tool["share_group_label"] == "Memory"
    assert normalized_tool["exportable"] is True
    assert normalized_tool["source_type"] == "local"

    assert normalized_tool["mutating"] is True

    get_tools_negative = by_model["ToolingGetToolsResponse"]["vectors"]["negative"]
    assert get_tools_negative["accepted"] is False
    assert get_tools_negative["issue_path"] == "$.tools.0.legacy_global_tool_ids"
    get_tools_duplicate_case = next(
        case
        for case in by_model["ToolingGetToolsResponse"]["vectors"]["positive_cases"]
        if case["normalized"]["tools"][0]["legacy_global_tool_ids"] == ["legacy-a", "legacy-b"]
    )
    assert len(get_tools_duplicate_case["input"]["tools"][0]["legacy_global_tool_ids"]) == 40
    assert any(
        case["issue_path"] == "$.tools.0.legacy_global_tool_ids"
        and len(case["input"]["tools"][0]["legacy_global_tool_ids"]) == 17
        for case in by_model["ToolingGetToolsResponse"]["vectors"]["negative_cases"]
    )

    export_duplicate_case = next(
        case
        for case in by_model["ToolingGetExportCatalogResponse"]["vectors"]["positive_cases"]
        if case["normalized"]["tools"][0]["legacy_global_tool_ids"] == ["legacy-a", "legacy-b"]
    )
    assert len(export_duplicate_case["input"]["tools"][0]["legacy_global_tool_ids"]) == 40
    assert any(
        case["issue_path"] == "$.tools.0.legacy_global_tool_ids"
        and len(case["input"]["tools"][0]["legacy_global_tool_ids"]) == 17
        for case in by_model["ToolingGetExportCatalogResponse"]["vectors"]["negative_cases"]
    )

    execute_negative = by_model["ToolingExecuteToolRequest"]["vectors"]["negative"]
    assert execute_negative["accepted"] is False
    assert execute_negative["issue_path"] == "$.tool_name"

    language_packs_negative_cases = by_model["TTSListLanguagePacksResponse"]["vectors"][
        "negative_cases"
    ]
    assert any(
        case["issue_path"] == "$.packs.0.voices.0"
        and case["input"]["packs"][0]["voices"][0]["default"] is True
        and case["input"]["packs"][0]["voices"][0]["ready"] is False
        for case in language_packs_negative_cases
    )
    assert any(
        case["issue_path"] == "$"
        and case["input"]["stale_default_voice_id"]
        == case["input"]["packs"][0]["voices"][0]["voice_id"]
        and case["input"]["packs"][0]["voices"][0]["ready"] is True
        for case in language_packs_negative_cases
    )
    assert any(
        case["normalized"]["stale_default_voice_id"]
        == case["normalized"]["packs"][0]["voices"][0]["voice_id"]
        and case["normalized"]["packs"][0]["voices"][0]["ready"] is False
        and case["normalized"]["packs"][0]["voices"][0]["default"] is False
        for case in by_model["TTSListLanguagePacksResponse"]["vectors"]["positive_cases"]
    )

    disallowed_methods = {"Tooling.GetStats", "Tooling.GetMCPStatus"}
    assert disallowed_methods.isdisjoint({item["method_id"] for item in schema["schemas"]})
    assert any(
        item == {JSON_VALUE_MARKER: True}
        for schema_item in schema["schemas"]
        for item in _walk_schema_objects(schema_item["schema"])
    )


def test_sdk_method_descriptors_preserve_callable_feature_contracts() -> None:
    schema = generate_backend_inventory.build_sdk_contract_schema()
    descriptors = {item["method_id"]: item for item in schema["method_descriptors"]}

    tooling_descriptor = descriptors["Tooling.GetTools"]
    assert tooling_descriptor["callable_feature_ids"] == ["catalog_discovery"]
    assert tooling_descriptor["callable_features"] == [
        {
            "feature_id": "catalog_discovery",
            "module": "Tooling",
            "label": "Catalog Discovery",
            "summary": "Read local and aggregate Tooling catalogs and status.",
            "method_ids": [
                "Tooling.GetTools",
                "Tooling.GetToolCatalog",
                "Tooling.GetExportCatalog",
                "Tooling.GetToolByName",
                "Tooling.GetStats",
                "Tooling.GetMCPStatus",
            ],
        }
    ]

    tts_descriptor = descriptors["TTS.UpdateVoiceProfile"]
    assert tts_descriptor["callable_feature_ids"] == ["speech_voice_management"]
    assert tts_descriptor["callable_features"][0]["feature_id"] == "speech_voice_management"
    assert tts_descriptor["callable_features"][0]["module"] == "TTS"
    assert "TTS.UpdateVoiceProfile" in tts_descriptor["callable_features"][0]["method_ids"]


def test_authoritative_python_contracts_reject_out_of_range_integers() -> None:
    from app.shared.contracts.models.tooling import ToolingGetToolsRequest

    ToolingGetToolsRequest.model_validate({"top_k": 2**53 - 1})
    with pytest.raises(ValidationError):
        ToolingGetToolsRequest.model_validate({"top_k": 2**53})
    with pytest.raises(ValidationError):
        ToolingGetToolsRequest.model_validate({"top_k": -(2**53)})


def test_authoritative_tts_audio_chunk_event_preserves_terminal_empty_audio_only() -> None:
    from app.shared.contracts.models.tts import TTSAudioChunkEvent

    terminal = {
        "stream_id": "stream-1",
        "sequence": 1,
        "source_sequence": 0,
        "audio_data": "",
        "format": "raw",
        "sample_rate": 0,
        "channels": 1,
        "duration_ms": 0,
        "is_final": True,
        "reason": "completed",
    }

    TTSAudioChunkEvent.model_validate(terminal)

    with pytest.raises(ValidationError, match="non-final audio chunk requires audio data"):
        TTSAudioChunkEvent.model_validate({**terminal, "is_final": False, "sample_rate": 24000})


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
