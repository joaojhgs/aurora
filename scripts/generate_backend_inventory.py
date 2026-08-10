#!/usr/bin/env python3
"""Generate Aurora backend contract, route, permission, and exposure inventory."""

from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import importlib
import inspect
import json
import pkgutil
import re
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, get_args, get_origin
from urllib.parse import quote

from fastapi import FastAPI
from pydantic import BaseModel, ValidationError
from pydantic.version import VERSION as PYDANTIC_VERSION

from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.registry import (
    MethodContract,
    all_contracts,
    clear_registry,
    get_implementation,
    list_modules,
)

try:
    from scripts.sdk_zod_codegen import (
        BOUNDED_NONBLANK_STRING_SET_MARKER,
        GENERATOR_FORMAT_VERSION,
        JSON_VALUE_MARKER,
        LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER,
        PROJECTION_IDENTITY_MARKER,
        PROJECTION_PAGE_TERMINATION_MARKER,
        ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER,
        ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER,
        ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER,
        SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER,
        SPEECH_LANGUAGE_AUTO_NULL_MARKER,
        SPEECH_LANGUAGE_REQUIREMENT_MARKER,
        SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER,
        SPEECH_LOCALE_FALLBACK_MARKER,
        SPEECH_METHOD_CONSTRAINTS_MARKER,
        STRING_NON_BLANK_MARKER,
        STRING_TRIMMED_MARKER,
        STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER,
        TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
        TTS_CAPABILITIES_INVARIANT_MARKER,
        TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER,
        TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER,
        TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER,
        TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER,
        TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER,
        TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER,
        TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER,
        TTS_OPERATION_ID_MARKER,
        TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER,
        TTS_PROFILE_LIST_INVARIANT_MARKER,
        TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
        TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER,
        TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER,
        TTS_VOICE_LIST_INVARIANT_MARKER,
        UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
        canonical_json,
        normalize_schema,
        render_zod_module,
        sha256_json,
        sha256_text,
    )
except ModuleNotFoundError:  # pragma: no cover - direct script execution
    from sdk_zod_codegen import (
        BOUNDED_NONBLANK_STRING_SET_MARKER,
        GENERATOR_FORMAT_VERSION,
        JSON_VALUE_MARKER,
        LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER,
        PROJECTION_IDENTITY_MARKER,
        PROJECTION_PAGE_TERMINATION_MARKER,
        ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER,
        ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER,
        ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER,
        SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER,
        SPEECH_LANGUAGE_AUTO_NULL_MARKER,
        SPEECH_LANGUAGE_REQUIREMENT_MARKER,
        SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER,
        SPEECH_LOCALE_FALLBACK_MARKER,
        SPEECH_METHOD_CONSTRAINTS_MARKER,
        STRING_NON_BLANK_MARKER,
        STRING_TRIMMED_MARKER,
        STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER,
        TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
        TTS_CAPABILITIES_INVARIANT_MARKER,
        TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER,
        TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER,
        TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER,
        TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER,
        TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER,
        TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER,
        TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER,
        TTS_OPERATION_ID_MARKER,
        TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER,
        TTS_PROFILE_LIST_INVARIANT_MARKER,
        TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
        TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER,
        TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER,
        TTS_VOICE_LIST_INVARIANT_MARKER,
        UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
        canonical_json,
        normalize_schema,
        render_zod_module,
        sha256_json,
        sha256_text,
    )

REPO_ROOT = Path(__file__).resolve().parents[1]
UI_FIXTURE_PATH = REPO_ROOT / "modules/ui-mock-reference/lib/aurora/data.ts"
SECURITY_SURFACE_INVENTORY_PATH = REPO_ROOT / "docs/security/mesh-security-surface-inventory.json"
DEFAULT_SDK_SCHEMA_OUTPUT = (
    REPO_ROOT / "packages/aurora-sdk/src/generated/backend-contracts.schema.json"
)
DEFAULT_SDK_ZOD_OUTPUT = REPO_ROOT / "packages/aurora-sdk/src/generated/backend-contracts.zod.ts"
DEFAULT_SDK_MANIFEST_OUTPUT = (
    REPO_ROOT / "packages/aurora-sdk/src/generated/backend-contracts.manifest.json"
)
DEFAULT_SDK_TOOLING_PROVIDER_OUTPUT = (
    REPO_ROOT / "packages/aurora-sdk/src/generated/tooling-local-provider-v1.json"
)

SDK_TOOLING_PROVIDER_CONTRACT_ALLOWLIST: tuple[str, ...] = (
    "Tooling.GetTools",
    "Tooling.GetExportCatalog",
    "Tooling.PrepareExecution",
    "Tooling.ExecuteTool",
)
SDK_CONTRACT_ALLOWLIST: tuple[str, ...] = (
    *SDK_TOOLING_PROVIDER_CONTRACT_ALLOWLIST,
    "Gateway.ExplainRoute",
    "Orchestrator.ExternalUserInput",
    "Orchestrator.Interrupt",
    "TTS.GetCapabilities",
    "TTS.ListVoices",
    "TTS.ListVoiceProfiles",
    "TTS.GetVoiceProfile",
    "TTS.UpdateVoiceProfile",
    "TTS.InstallVoiceProfile",
    "TTS.RemoveVoiceProfile",
    "TTS.SetDefaultVoice",
    "TTS.VoiceImportStart",
    "TTS.VoiceImportChunk",
    "TTS.VoiceImportEnd",
    "TTS.VoiceImportAbort",
    "TTS.CreateVoiceProfile",
    "TTS.DeleteVoiceProfile",
    "TTS.Request",
    "TTS.StreamStart",
    "TTS.StreamChunk",
    "TTS.StreamEnd",
    "TTS.Synthesize",
    "STTCoordinator.Listen",
    "STTCoordinator.StopListening",
    "STTCoordinator.CapturePrepare",
    "STTCoordinator.CaptureRelease",
    "STTCoordinator.CaptureStatus",
    "WakeWord.ProcessAudio",
    "WakeWord.Detect",
    "Transcription.ProcessAudio",
    "Transcription.Transcribe",
)
TOOLING_PROVIDER_PEER_ID = "aurora-sdk-local-provider-v1"
TOOLING_PROVIDER_SERVICE_INSTANCE_ID = f"local:{quote(TOOLING_PROVIDER_PEER_ID, safe='')}:Tooling"
SDK_PROVIDER_REQUIRED_PERMISSION_OVERRIDES = {
    "Tooling.GetExportCatalog": "Tooling.GetTools",
    "Tooling.PrepareExecution": "Tooling.ExecuteTool",
}
SDK_EVENT_ALLOWLIST: tuple[str, ...] = (
    "Orchestrator.Response",
    "Orchestrator.Interrupted",
    "TTS.AudioChunk",
)
SDK_ENVELOPE_ALLOWLIST: tuple[str, ...] = ("Aurora.EventStream",)

SERVICE_CLASSES: tuple[tuple[str, str, str], ...] = (
    ("Config", "app.services.config.service", "ConfigService"),
    ("DB", "app.services.db.service", "DBService"),
    ("Auth", "app.services.auth.service", "AuthService"),
    ("Tooling", "app.services.tooling.service", "ToolingService"),
    ("Scheduler", "app.services.scheduler.service", "SchedulerService"),
    ("STTCoordinator", "app.services.stt_coordinator.service", "STTCoordinatorService"),
    ("WakeWord", "app.services.stt_wakeword.service", "WakeWordService"),
    ("Transcription", "app.services.stt_transcription.service", "TranscriptionService"),
    ("TTS", "app.services.tts.service", "TTSService"),
    ("Orchestrator", "app.services.orchestrator.service", "OrchestratorService"),
    ("Gateway", "app.services.gateway.service", "GatewayService"),
    ("Supervisor", "app.services.supervisor", "Supervisor"),
)

SERVICE_SOURCES: tuple[Path, ...] = tuple(
    REPO_ROOT / (module_path.replace(".", "/") + ".py") for _, module_path, _ in SERVICE_CLASSES
) + (REPO_ROOT / "app/services/gateway/audio_session.py",)

STATIC_ONLY_SERVICES = {"Config"}
SKIP_FIXTURE_COVERAGE = {"planned", "missing_contract", "internal_only", "mock_only"}


@dataclass(frozen=True)
class FixtureMethod:
    name: str | None
    bus_topic: str
    exposure: str
    backend_coverage: str
    route_path: str | None


def _rel(path: str | Path | None) -> str | None:
    if path is None:
        return None
    with contextlib.suppress(ValueError):
        return str(Path(path).resolve().relative_to(REPO_ROOT))
    return str(path)


def _model_name(model: Any) -> str | None:
    if isinstance(model, str):
        return model
    return getattr(model, "__name__", None) if model is not None else None


@dataclass(frozen=True)
class ValidatorDiscovery:
    method_id: str
    direction: str
    model: type[BaseModel]
    validator_name: str
    validator_kind: str
    fields: tuple[str, ...]
    model_pointer: str
    pointer: str

    @property
    def model_name(self) -> str:
        return self.model.__name__

    def error_context(self) -> str:
        return (
            f"{self.method_id} {self.direction} {self.model_name} "
            f"{self.pointer}: Pydantic validator {self.validator_name}"
        )


def _validator_names(model: Any) -> set[str]:
    decorators = getattr(model, "__pydantic_decorators__", None)
    if decorators is None:
        return set()
    names: set[str] = set()
    for attr in ("field_validators", "model_validators"):
        values = getattr(decorators, attr, {}) or {}
        names.update(str(name) for name in values)
    return names


def _field_validator_fields(decorator: Any) -> tuple[str, ...]:
    fields = getattr(getattr(decorator, "info", None), "fields", ()) or ()
    return tuple(str(field) for field in fields)


def _model_pointer(
    model: type[BaseModel], root_model: type[BaseModel], schema: dict[str, Any]
) -> str:
    if model is root_model:
        return "#"
    defs = schema.get("$defs")
    if isinstance(defs, dict) and model.__name__ in defs:
        return f"#/$defs/{model.__name__}"
    return f"#/$defs/{model.__name__}"


def _walk_annotation_models(annotation: Any, collected: set[type[BaseModel]]) -> None:
    if annotation is Any:
        return
    if isinstance(annotation, str):
        return
    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
        _collect_transitive_models(annotation, collected)
        return
    origin = get_origin(annotation)
    if origin is None:
        return
    if (
        origin in {types.UnionType, list, tuple, set, frozenset, dict}
        or str(origin) == "typing.Union"
    ):
        for arg in get_args(annotation):
            _walk_annotation_models(arg, collected)
        return
    for arg in get_args(annotation):
        _walk_annotation_models(arg, collected)


def _collect_transitive_models(
    model: type[BaseModel], collected: set[type[BaseModel]] | None = None
) -> set[type[BaseModel]]:
    if collected is None:
        collected = set()
    if model in collected:
        return collected
    collected.add(model)
    with contextlib.suppress(Exception):
        model.model_rebuild()
    for field in getattr(model, "model_fields", {}).values():
        _walk_annotation_models(field.annotation, collected)
    return collected


def _discover_validator_entries(
    *,
    method_id: str,
    direction: str,
    root_model: type[BaseModel],
    schema: dict[str, Any],
) -> list[ValidatorDiscovery]:
    entries: list[ValidatorDiscovery] = []
    for model in sorted(_collect_transitive_models(root_model), key=lambda item: item.__name__):
        decorators = getattr(model, "__pydantic_decorators__", None)
        if decorators is None:
            continue
        model_pointer = _model_pointer(model, root_model, schema)
        for name, decorator in (getattr(decorators, "field_validators", {}) or {}).items():
            fields = _field_validator_fields(decorator)
            pointer = f"{model_pointer}/properties/{fields[0]}" if fields else model_pointer
            entries.append(
                ValidatorDiscovery(
                    method_id=method_id,
                    direction=direction,
                    model=model,
                    validator_name=str(name),
                    validator_kind="field",
                    fields=fields,
                    model_pointer=model_pointer,
                    pointer=pointer,
                )
            )
        for name in getattr(decorators, "model_validators", {}) or {}:
            entries.append(
                ValidatorDiscovery(
                    method_id=method_id,
                    direction=direction,
                    model=model,
                    validator_name=str(name),
                    validator_kind="model",
                    fields=(),
                    model_pointer=model_pointer,
                    pointer=model_pointer,
                )
            )
        for name in getattr(decorators, "root_validators", {}) or {}:
            entries.append(
                ValidatorDiscovery(
                    method_id=method_id,
                    direction=direction,
                    model=model,
                    validator_name=str(name),
                    validator_kind="root",
                    fields=(),
                    model_pointer=model_pointer,
                    pointer=model_pointer,
                )
            )
    return entries


def _resolve_schema_pointer(schema: dict[str, Any], pointer: str) -> Any:
    if pointer == "#":
        return schema
    current: Any = schema
    for raw_token in pointer.removeprefix("#/").split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or token not in current:
            return None
        current = current[token]
    return current


def _string_options(schema: Any) -> list[dict[str, Any]]:
    if not isinstance(schema, dict):
        return []
    if schema.get("type") == "string":
        return [schema]
    options = schema.get("anyOf") or schema.get("oneOf") or []
    return [
        option for option in options if isinstance(option, dict) and option.get("type") == "string"
    ]


def _validator_field_schemas(
    entry: ValidatorDiscovery, schema: dict[str, Any]
) -> list[dict[str, Any]]:
    model_schema = _resolve_schema_pointer(schema, entry.model_pointer)
    if not isinstance(model_schema, dict):
        raise ValueError(f"{entry.error_context()}: missing model schema")
    properties = model_schema.get("properties")
    if not isinstance(properties, dict):
        raise ValueError(f"{entry.error_context()}: missing model properties")
    field_schemas: list[dict[str, Any]] = []
    for field in entry.fields:
        field_schema = properties.get(field)
        if not isinstance(field_schema, dict):
            raise ValueError(f"{entry.error_context()}: missing schema for field {field}")
        field_schemas.append(field_schema)
    return field_schemas


def _assert_mesh_non_blank(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            option.get(STRING_NON_BLANK_MARKER) is True for option in _string_options(field_schema)
        ):
            raise ValueError(f"{entry.error_context()}: missing {STRING_NON_BLANK_MARKER}")


def _assert_tooling_legacy_ids(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    field_schemas = _validator_field_schemas(entry, schema)
    if len(field_schemas) != 1:
        raise ValueError(f"{entry.error_context()}: expected one legacy ID array field")
    field_schema = field_schemas[0]
    items = field_schema.get("items") if isinstance(field_schema, dict) else None
    if (
        not isinstance(field_schema, dict)
        or field_schema.get(UNIQUE_STRING_ARRAY_NORMALIZE_MARKER) is not True
        or not isinstance(items, dict)
        or items.get("minLength") != 1
        or items.get("maxLength") != 512
    ):
        raise ValueError(f"{entry.error_context()}: missing legacy ID normalization extension")


def _assert_lowercase_digest(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            option.get("pattern") == "^[0-9a-f]{64}$" for option in _string_options(field_schema)
        ):
            raise ValueError(f"{entry.error_context()}: missing lowercase digest pattern")


def _assert_trimmed_cursor(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            option.get(STRING_TRIMMED_MARKER) is True for option in _string_options(field_schema)
        ):
            raise ValueError(f"{entry.error_context()}: missing {STRING_TRIMMED_MARKER}")


def _assert_projection_page_termination(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    model_schema = _resolve_schema_pointer(schema, entry.model_pointer)
    if (
        not isinstance(model_schema, dict)
        or model_schema.get(PROJECTION_PAGE_TERMINATION_MARKER) is not True
    ):
        raise ValueError(f"{entry.error_context()}: missing {PROJECTION_PAGE_TERMINATION_MARKER}")


def _assert_projection_identity(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    model_schema = _resolve_schema_pointer(schema, entry.model_pointer)
    if (
        not isinstance(model_schema, dict)
        or model_schema.get(PROJECTION_IDENTITY_MARKER) is not True
    ):
        raise ValueError(f"{entry.error_context()}: missing {PROJECTION_IDENTITY_MARKER}")


def _assert_model_marker(marker: str):
    def verifier(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
        model_schema = _resolve_schema_pointer(schema, entry.model_pointer)
        if not isinstance(model_schema, dict) or model_schema.get(marker) is not True:
            raise ValueError(f"{entry.error_context()}: missing {marker}")

    return verifier


def _assert_field_pattern(pattern: str):
    def verifier(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
        for field_schema in _validator_field_schemas(entry, schema):
            if not any(
                option.get("pattern") == pattern for option in _string_options(field_schema)
            ):
                raise ValueError(f"{entry.error_context()}: missing {pattern}")

    return verifier


def _assert_string_field_non_blank(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        direct_marker = (
            field_schema.get("type") == "string"
            and field_schema.get(STRING_NON_BLANK_MARKER) is True
        )
        nested_marker = any(
            option.get(STRING_NON_BLANK_MARKER) is True for option in _string_options(field_schema)
        )
        if not direct_marker and not nested_marker:
            raise ValueError(f"{entry.error_context()}: missing {STRING_NON_BLANK_MARKER}")


def _assert_sorted_unique_string_array(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            array_schema.get(UNIQUE_STRING_ARRAY_NORMALIZE_MARKER) is True
            for array_schema in _array_schema_options(field_schema)
        ):
            raise ValueError(
                f"{entry.error_context()}: missing {UNIQUE_STRING_ARRAY_NORMALIZE_MARKER}"
            )


def _assert_bounded_nonblank_string_set(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            array_schema.get(BOUNDED_NONBLANK_STRING_SET_MARKER) is True
            for array_schema in _array_schema_options(field_schema)
        ):
            raise ValueError(
                f"{entry.error_context()}: missing {BOUNDED_NONBLANK_STRING_SET_MARKER}"
            )


def _assert_speech_language_array(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            array_schema.get(SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER) is True
            for array_schema in _array_schema_options(field_schema)
        ):
            raise ValueError(
                f"{entry.error_context()}: missing {SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER}"
            )


def _assert_logical_voice_array(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            array_schema.get(LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER) is True
            for array_schema in _array_schema_options(field_schema)
        ):
            raise ValueError(
                f"{entry.error_context()}: missing {LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER}"
            )


def _assert_speech_language_string(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if field_schema.get(SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER) is not True:
            raise ValueError(
                f"{entry.error_context()}: missing {SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER}"
            )


def _assert_operation_id_marker(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if not any(
            option.get(TTS_OPERATION_ID_MARKER) is True for option in _string_options(field_schema)
        ):
            raise ValueError(f"{entry.error_context()}: missing {TTS_OPERATION_ID_MARKER}")


def _assert_named_model_invariant(marker: str):
    def verifier(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
        model_schema = _resolve_schema_pointer(schema, entry.model_pointer)
        if not isinstance(model_schema, dict) or model_schema.get(marker) is not True:
            raise ValueError(f"{entry.error_context()}: missing {marker}")

    return verifier


def _assert_all(*verifiers: Any):
    def verifier(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
        for assert_extension in verifiers:
            assert_extension(entry, schema)

    return verifier


def _assert_language_field(entry: ValidatorDiscovery, schema: dict[str, Any]) -> None:
    for field_schema in _validator_field_schemas(entry, schema):
        if (
            field_schema.get(SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER) is not True
            and field_schema.get(SPEECH_LANGUAGE_AUTO_NULL_MARKER) is not True
        ):
            raise ValueError(f"{entry.error_context()}: missing speech language normalization")


VALIDATOR_EXTENSION_VERIFIERS = {
    ("MeshAddressSelector", "_non_blank"): _assert_mesh_non_blank,
    ("ToolingToolInfo", "_bounded_unique_legacy_ids"): _assert_tooling_legacy_ids,
    ("ToolingGetExportCatalogResponse", "_lowercase_digest"): _assert_lowercase_digest,
    ("ToolingGetExportCatalogResponse", "_trimmed_cursor"): _assert_trimmed_cursor,
    ("ToolingGetExportCatalogResponse", "_final_checksum_only_on_complete"): (
        _assert_projection_page_termination
    ),
    ("ToolingGetExportCatalogResponse", "_validate_page_termination"): (
        _assert_projection_page_termination
    ),
    ("ToolingGetExportCatalogResponse", "_validate_projection_identity"): (
        _assert_projection_identity
    ),
    ("RouteExplainRequest", "_reject_raw_payload_fields"): _assert_model_marker(
        ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER
    ),
    ("RouteExplainRequest", "_reject_unknown_selector_fields"): _assert_model_marker(
        ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER
    ),
    ("RouteExplainRequest", "_reject_raw_speech_payload_fields"): _assert_model_marker(
        ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER
    ),
    ("SpeechLanguageRequirement", "_normalize_language"): _assert_speech_language_string,
    ("SpeechLanguageRequirement", "_normalize_candidates"): _assert_speech_language_array,
    ("SpeechLanguageRequirement", "_normalize_digest"): _assert_lowercase_digest,
    ("SpeechLanguageRequirement", "_validate_shape_and_digest"): _assert_model_marker(
        SPEECH_LANGUAGE_REQUIREMENT_MARKER
    ),
    ("SpeechLocaleFallback", "_normalize_language"): _assert_speech_language_string,
    ("SpeechLocaleFallback", "_validate_declared_fallback"): _assert_model_marker(
        SPEECH_LOCALE_FALLBACK_MARKER
    ),
    ("SpeechMethodConstraints", "_normalize_language_set"): _assert_speech_language_array,
    ("SpeechMethodConstraints", "_normalize_voice_ids"): _assert_logical_voice_array,
    ("SpeechMethodConstraints", "_normalize_locale_fallbacks"): _assert_model_marker(
        SPEECH_METHOD_CONSTRAINTS_MARKER
    ),
    ("SpeechMethodConstraints", "_normalize_resident_digest"): _assert_lowercase_digest,
    ("SpeechMethodConstraints", "_validate_constraints"): _assert_model_marker(
        SPEECH_METHOD_CONSTRAINTS_MARKER
    ),
    ("SpeechRouteBinding", "_non_blank"): _assert_mesh_non_blank,
    ("SpeechRouteBinding", "_normalize_digest"): _assert_lowercase_digest,
}

for _model, _validator in (
    ("TTSRequest", "_normalize_language"),
    ("TTSSynthesizeRequest", "_normalize_language"),
    ("TTSStreamStartRequest", "_normalize_language"),
    ("TTSListVoicesRequest", "_normalize_language"),
    ("TTSCreateVoiceProfileRequest", "_normalize_language"),
    ("TranscribeAudioRequest", "_normalize_language"),
):
    VALIDATOR_EXTENSION_VERIFIERS[(_model, _validator)] = _assert_language_field

for _model, _validator in (
    ("TTSResidentLanguagePack", "_normalize_languages"),
    ("TTSCapabilities", "_normalize_languages"),
    ("TranscribeAudioRequest", "_normalize_candidates"),
):
    VALIDATOR_EXTENSION_VERIFIERS[(_model, _validator)] = _assert_speech_language_array

for _model, _validator in (
    ("TTSCapabilities", "_nonblank_pack_ids"),
    ("TTSVoiceDescriptor", "_normalize_language_pack_ids"),
    ("TTSVoiceProfileDescriptor", "_normalize_language_pack_ids"),
    ("TTSVoiceProfileDescriptor", "_normalize_peer_ids"),
    ("TTSUpdateVoiceProfileRequest", "_normalize_peer_ids"),
):
    VALIDATOR_EXTENSION_VERIFIERS[(_model, _validator)] = _assert_bounded_nonblank_string_set

for _model, _validator in (
    ("TTSRequest", "_validate_voice_id"),
    ("TTSSynthesizeRequest", "_validate_voice_id"),
    ("TTSStreamStartRequest", "_validate_voice_id"),
    ("TTSVoiceDescriptor", "_validate_voice_id"),
    ("TTSVoiceProfileDescriptor", "_validate_voice_id"),
    ("TTSGetVoiceProfileRequest", "_validate_voice_id"),
    ("TTSUpdateVoiceProfileRequest", "_validate_voice_id"),
    ("TTSInstallVoiceProfileRequest", "_validate_voice_id"),
    ("TTSRemoveVoiceProfileRequest", "_validate_voice_id"),
    ("TTSSetDefaultVoiceRequest", "_validate_voice_id"),
    ("TTSSetDefaultVoiceResponse", "_validate_voice_id"),
    ("TTSUpdateVoiceProfileResponse", "_validate_voice_id"),
    ("TTSInstallVoiceProfileResponse", "_validate_voice_id"),
    ("TTSRemoveVoiceProfileResponse", "_validate_voice_id"),
    ("TTSCreateVoiceProfileResponse", "_validate_voice_id"),
    ("TTSDeleteVoiceProfileRequest", "_validate_voice_id"),
    ("TTSDeleteVoiceProfileResponse", "_validate_voice_id"),
):
    VALIDATOR_EXTENSION_VERIFIERS[(_model, _validator)] = _assert_field_pattern(
        __import__(
            "app.shared.contracts.models.speech",
            fromlist=["LOGICAL_VOICE_ID_PATTERN"],
        ).LOGICAL_VOICE_ID_PATTERN
    )

VALIDATOR_EXTENSION_VERIFIERS[("TTSCreateVoiceProfileResponse", "_validate_voice_id")] = (
    _assert_all(
        VALIDATOR_EXTENSION_VERIFIERS[("TTSCreateVoiceProfileResponse", "_validate_voice_id")],
        _assert_named_model_invariant(TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER),
    )
)
VALIDATOR_EXTENSION_VERIFIERS[("TTSDeleteVoiceProfileResponse", "_validate_voice_id")] = (
    _assert_all(
        VALIDATOR_EXTENSION_VERIFIERS[("TTSDeleteVoiceProfileResponse", "_validate_voice_id")],
        _assert_named_model_invariant(TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER),
    )
)

for _model, _validator in (
    ("TTSCreateVoiceProfileRequest", "_validate_expected_revision"),
    ("TTSDeleteVoiceProfileRequest", "_validate_expected_revision"),
    ("TTSInstallVoiceProfileRequest", "_validate_expected_revision"),
    ("TTSRemoveVoiceProfileRequest", "_validate_expected_revision"),
    ("TTSSetDefaultVoiceRequest", "_validate_expected_revision"),
    ("TTSUpdateVoiceProfileRequest", "_validate_expected_revision"),
    ("TTSVoiceImportAbortRequest", "_validate_expected_revision"),
    ("TTSVoiceImportChunkRequest", "_validate_expected_revision"),
    ("TTSVoiceImportEndRequest", "_validate_expected_revision"),
    ("TTSVoiceImportStartRequest", "_validate_expected_revision"),
    ("TTSCreateVoiceProfileRequest", "_validate_nonblank"),
    ("TTSUpdateVoiceProfileRequest", "_validate_label"),
    ("TTSVoiceDescriptor", "_validate_nonblank"),
    ("TTSVoiceProfileDescriptor", "_validate_nonblank"),
    ("TTSVoiceImportAbortRequest", "_validate_upload_id"),
    ("TTSVoiceImportChunkRequest", "_validate_upload_id"),
    ("TTSVoiceImportEndRequest", "_validate_upload_id"),
    ("TTSVoiceImportEndResponse", "_validate_nonblank"),
    ("TTSVoiceImportStartResponse", "_validate_nonblank"),
    ("TTSResidentLanguagePack", "_validate_pack_id"),
):
    VALIDATOR_EXTENSION_VERIFIERS[(_model, _validator)] = _assert_string_field_non_blank

for _model, _validator in (
    ("TTSCreateVoiceProfileRequest", "_validate_operation_id"),
    ("TTSDeleteVoiceProfileRequest", "_validate_operation_id"),
    ("TTSInstallVoiceProfileRequest", "_validate_operation_id"),
    ("TTSRemoveVoiceProfileRequest", "_validate_operation_id"),
    ("TTSSetDefaultVoiceRequest", "_validate_operation_id"),
    ("TTSUpdateVoiceProfileRequest", "_validate_operation_id"),
    ("TTSVoiceImportAbortRequest", "_validate_operation_id"),
    ("TTSVoiceImportChunkRequest", "_validate_operation_id"),
    ("TTSVoiceImportEndRequest", "_validate_operation_id"),
    ("TTSVoiceImportStartRequest", "_validate_operation_id"),
):
    VALIDATOR_EXTENSION_VERIFIERS[(_model, _validator)] = _assert_operation_id_marker

for _model, _validator in (
    ("TTSVoiceImportStartRequest", "_validate_sha256"),
    ("TTSVoiceImportChunkRequest", "_validate_chunk_sha256"),
    ("TTSVoiceImportEndRequest", "_validate_final_sha256"),
    ("TTSVoiceImportEndResponse", "_validate_final_sha256"),
):
    VALIDATOR_EXTENSION_VERIFIERS[(_model, _validator)] = _assert_lowercase_digest

VALIDATOR_EXTENSION_VERIFIERS[("TTSCreateVoiceProfileRequest", "_validate_sealed_audio_ref")] = (
    _assert_field_pattern("^voice-import:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
)

_MODEL_INVARIANT_VERIFIERS = {
    ("TTSCapabilities", "_validate_capabilities"): TTS_CAPABILITIES_INVARIANT_MARKER,
    ("TTSCapabilities", "_validate_sample_rates"): TTS_CAPABILITIES_INVARIANT_MARKER,
    ("TTSVoiceDescriptor", "_validate_ready_voice"): TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER,
    ("TTSListVoicesResponse", "_validate_use_safe_voices"): TTS_VOICE_LIST_INVARIANT_MARKER,
    ("TTSVoiceProfileDescriptor", "_validate_profile_state"): (
        TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER
    ),
    ("TTSListVoiceProfilesResponse", "_validate_unique_profiles"): (
        TTS_PROFILE_LIST_INVARIANT_MARKER
    ),
    ("TTSGetVoiceProfileResponse", "_validate_found_profile"): (
        TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSUpdateVoiceProfileRequest", "_validate_patch"): (
        TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER
    ),
    ("TTSCreateVoiceProfileResponse", "_validate_result_revision"): (
        TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSDeleteVoiceProfileRequest", "_validate_clone_id"): (
        TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER
    ),
    ("TTSUpdateVoiceProfileResponse", "_validate_revision"): (
        TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSInstallVoiceProfileResponse", "_validate_revision"): (
        TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSRemoveVoiceProfileResponse", "_validate_revision"): (
        TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSDeleteVoiceProfileResponse", "_validate_revision"): (
        TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSVoiceImportStartResponse", "_validate_capacity"): (
        TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSVoiceImportChunkRequest", "_validate_chunk"): (TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER),
    ("TTSVoiceImportChunkResponse", "_validate_acknowledgement"): (
        TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER
    ),
    ("TTSAudioChunkEvent", "_validate_audio_payload"): TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
    ("TranscribeAudioRequest", "_validate_language_shape"): STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER,
}
for _key, _marker in _MODEL_INVARIANT_VERIFIERS.items():
    VALIDATOR_EXTENSION_VERIFIERS[_key] = _assert_named_model_invariant(_marker)


def _assert_validator_extension_coverage(
    *,
    method_id: str,
    direction: str,
    root_model: type[BaseModel],
    schema: dict[str, Any],
) -> None:
    discovered = _discover_validator_entries(
        method_id=method_id,
        direction=direction,
        root_model=root_model,
        schema=schema,
    )
    for entry in discovered:
        key = (entry.model_name, entry.validator_name)
        verifier = VALIDATOR_EXTENSION_VERIFIERS.get(key)
        if verifier is None:
            raise ValueError(f"{entry.error_context()} has no SDK schema extension mapping")
        verifier(entry, schema)


def _assert_no_unbounded_integer_schema(schema: Any, *, context: str, pointer: str = "#") -> None:
    if isinstance(schema, list):
        for index, item in enumerate(schema):
            _assert_no_unbounded_integer_schema(item, context=context, pointer=f"{pointer}/{index}")
        return
    if not isinstance(schema, dict):
        return
    if (
        schema.get("type") == "integer"
        and "enum" not in schema
        and "const" not in schema
        and (
            ("minimum" not in schema and "exclusiveMinimum" not in schema)
            or ("maximum" not in schema and "exclusiveMaximum" not in schema)
        )
    ):
        raise ValueError(f"{context} {pointer}: integer schema must declare minimum and maximum")
    for key, item in schema.items():
        escaped = str(key).replace("~", "~0").replace("/", "~1")
        _assert_no_unbounded_integer_schema(item, context=context, pointer=f"{pointer}/{escaped}")


def _model_schema(model: Any) -> dict[str, Any] | None:
    if model is None or isinstance(model, str):
        return None
    with contextlib.suppress(Exception):
        return model.model_json_schema()
    return None


def _speech_constraints_value(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return value
    return None


def _method_route_path(module: str, method_name: str, exposure: str) -> str | None:
    if exposure not in {"external", "both"}:
        return None
    return f"/api/{module}/{method_name}"


def _load_contract_namespace() -> dict[str, Any]:
    namespace: dict[str, Any] = {}
    package = importlib.import_module("app.shared.contracts.models")
    for module_info in pkgutil.iter_modules(package.__path__):
        module = importlib.import_module(f"{package.__name__}.{module_info.name}")
        for name, value in vars(module).items():
            if not name.startswith("_"):
                namespace[name] = value
    for module_name in ("app.services.config.messages",):
        module = importlib.import_module(module_name)
        for name, value in vars(module).items():
            if not name.startswith("_"):
                namespace[name] = value
    return namespace


def _eval_ast_node(node: ast.AST, namespace: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [_eval_ast_node(item, namespace) for item in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_ast_node(item, namespace) for item in node.elts)
    if isinstance(node, ast.Name):
        return namespace.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        return getattr(_eval_ast_node(node.value, namespace), node.attr)
    raise ValueError(f"Unsupported decorator expression: {ast.dump(node)}")


def _is_method_contract_decorator(decorator: ast.AST) -> ast.Call | None:
    if not isinstance(decorator, ast.Call):
        return None
    func = decorator.func
    if isinstance(func, ast.Name) and func.id == "method_contract":
        return decorator
    if isinstance(func, ast.Attribute) and func.attr == "method_contract":
        return decorator
    return None


def _static_contracts_from_source(
    path: Path,
    namespace: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    tree = ast.parse(path.read_text(), filename=str(path))
    contracts: dict[str, dict[str, Any]] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            call = _is_method_contract_decorator(decorator)
            if call is None:
                continue
            kwargs = {kw.arg: _eval_ast_node(kw.value, namespace) for kw in call.keywords if kw.arg}
            if call.args and "method_id" not in kwargs:
                kwargs["method_id"] = _eval_ast_node(call.args[0], namespace)
            method_id = kwargs["method_id"]
            module, method_name = method_id.split(".", 1)
            input_model = kwargs.get("input_model")
            output_model = kwargs.get("output_model")
            contracts[method_id] = {
                "module": module,
                "name": method_name,
                "summary": kwargs.get("summary", ""),
                "bus_topic": method_id,
                "exposure": kwargs.get("exposure", "internal"),
                "method_type": kwargs.get("method_type", "use"),
                "required_perms": list(kwargs.get("required_perms", [])),
                "callable_feature_ids": list(kwargs.get("callable_feature_ids", [])),
                "speech_constraints": _speech_constraints_value(kwargs.get("speech_constraints")),
                "public_infrastructure": bool(kwargs.get("public_infrastructure", False)),
                "input_model": _model_name(input_model),
                "output_model": _model_name(output_model),
                "input_schema": _model_schema(input_model),
                "output_schema": _model_schema(output_model),
                "source_file": f"{_rel(path)}:{call.lineno}",
                "source": "static_contract",
            }
    return contracts


def _instantiate_services() -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    for module_name, module_path, class_name in SERVICE_CLASSES:
        if module_name in STATIC_ONLY_SERVICES:
            continue
        try:
            module = importlib.import_module(module_path)
            service_cls = getattr(module, class_name)
            service_cls()
        except Exception as exc:  # pragma: no cover - exercised by local optional deps
            errors.append(
                {
                    "module": module_name,
                    "class": f"{module_path}.{class_name}",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return errors


def _live_contract_to_inventory(contract: MethodContract) -> dict[str, Any]:
    impl = get_implementation(contract.bus_topic or "")
    source_file = None
    if impl is not None:
        with contextlib.suppress(OSError, TypeError):
            source_path = inspect.getsourcefile(impl)
            _, line_no = inspect.getsourcelines(impl)
            source_file = f"{_rel(source_path)}:{line_no}"
    return {
        "module": contract.module,
        "name": contract.name,
        "summary": contract.summary,
        "bus_topic": contract.bus_topic,
        "routePath": _method_route_path(contract.module, contract.name, contract.exposure),
        "route_kind": "dynamic" if contract.exposure in {"external", "both"} else "internal_bus",
        "exposure": contract.exposure,
        "method_type": contract.method_type,
        "required_perms": list(contract.required_perms),
        "callable_feature_ids": list(contract.callable_feature_ids),
        "callable_features": [
            feature.model_dump(mode="json") for feature in contract.callable_features
        ],
        "speech_constraints": _speech_constraints_value(contract.speech_constraints),
        "public_infrastructure": contract.public_infrastructure,
        "input_model": _model_name(contract.input_model),
        "output_model": _model_name(contract.output_model),
        "input_schema": _model_schema(contract.input_model),
        "output_schema": _model_schema(contract.output_model),
        "source_file": source_file,
        "source": "live_registry",
    }


def _static_contract_to_inventory(contract: dict[str, Any]) -> dict[str, Any]:
    return {
        **contract,
        "routePath": _method_route_path(contract["module"], contract["name"], contract["exposure"]),
        "route_kind": "dynamic" if contract["exposure"] in {"external", "both"} else "internal_bus",
    }


def build_method_inventory() -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    clear_registry()
    import_errors = _instantiate_services()
    methods_by_topic = {
        topic: _live_contract_to_inventory(contract)
        for topic, contract in sorted(all_contracts().items())
    }

    namespace = _load_contract_namespace()
    for source_path in SERVICE_SOURCES:
        for topic, contract in _static_contracts_from_source(source_path, namespace).items():
            methods_by_topic.setdefault(topic, _static_contract_to_inventory(contract))

    return (
        sorted(methods_by_topic.values(), key=lambda item: (item["module"], item["name"])),
        import_errors,
    )


class _EmptyRegistry:
    def on_registry_change(self, _callback: Any) -> None:
        return None

    async def get_external_methods(self) -> list[tuple[str, MethodInfo]]:
        return []

    async def get_services(self) -> list[Any]:
        return []

    async def get_registry_export(self) -> dict[str, Any]:
        return {"modules": [], "digest": "", "service_count": 0, "method_count": 0}

    async def get_service(self, _module_name: str) -> None:
        return None


def build_gateway_builtins() -> list[dict[str, Any]]:
    from app.services.gateway.fastapi_app import create_gateway_app

    app: FastAPI = create_gateway_app(bus=object(), registry=_EmptyRegistry())
    builtins: list[dict[str, Any]] = []
    for route in app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api/"):
            continue
        methods = sorted((getattr(route, "methods", None) or set()) - {"HEAD", "OPTIONS"})
        if not methods:
            continue
        required_perms = ["Auth.manage"] if path.startswith("/api/admin/peers") else []
        builtins.append(
            {
                "name": getattr(route, "name", ""),
                "summary": getattr(route, "summary", "") or "",
                "routePath": path,
                "http_methods": methods,
                "route_kind": "gateway_builtin",
                "exposure": "gateway_builtin",
                "method_type": "manage" if required_perms else "gateway",
                "required_perms": required_perms,
            }
        )
    return sorted(builtins, key=lambda item: (item["routePath"], item["http_methods"]))


def build_gateway_openapi() -> dict[str, Any]:
    from app.services.gateway.fastapi_app import create_gateway_app

    app: FastAPI = create_gateway_app(bus=object(), registry=_EmptyRegistry())
    schema = app.openapi()
    return {
        "openapi": schema.get("openapi"),
        "info": schema.get("info", {}),
        "paths": schema.get("paths", {}),
    }


def _extract_ts_string(obj: str, field: str) -> str | None:
    match = re.search(rf"{field}\s*:\s*'([^']*)'", obj)
    return match.group(1) if match else None


def parse_ui_fixture_methods(path: Path = UI_FIXTURE_PATH) -> list[FixtureMethod]:
    if not path.exists():
        return []
    text = path.read_text()
    methods: list[FixtureMethod] = []
    for match in re.finditer(r"\{[^{}]*busTopic\s*:\s*'[^']+'[^{}]*\}", text, re.DOTALL):
        obj = match.group(0)
        bus_topic = _extract_ts_string(obj, "busTopic")
        if not bus_topic:
            continue
        methods.append(
            FixtureMethod(
                name=_extract_ts_string(obj, "name"),
                bus_topic=bus_topic,
                exposure=_extract_ts_string(obj, "exposure") or "",
                backend_coverage=_extract_ts_string(obj, "backendCoverage") or "",
                route_path=_extract_ts_string(obj, "routePath"),
            )
        )
    return methods


def validate_ui_fixture_references(
    methods: list[dict[str, Any]],
    gateway_builtins: list[dict[str, Any]],
    fixture_path: Path = UI_FIXTURE_PATH,
) -> dict[str, Any]:
    fixture_methods = parse_ui_fixture_methods(fixture_path)
    method_by_topic = {method["bus_topic"]: method for method in methods}
    builtin_paths = {route["routePath"] for route in gateway_builtins}
    errors: list[dict[str, Any]] = []

    for item in fixture_methods:
        if item.backend_coverage in SKIP_FIXTURE_COVERAGE:
            continue
        if item.exposure == "gateway_builtin":
            if not item.route_path or item.route_path not in builtin_paths:
                errors.append(
                    {
                        "bus_topic": item.bus_topic,
                        "routePath": item.route_path,
                        "error": "missing_gateway_builtin_route",
                    }
                )
            continue

        backend_method = method_by_topic.get(item.bus_topic)
        if backend_method is None:
            errors.append({"bus_topic": item.bus_topic, "error": "missing_backend_method"})
            continue
        if backend_method["exposure"] in {"external", "both"}:
            expected_route = backend_method["routePath"]
            if item.route_path != expected_route:
                errors.append(
                    {
                        "bus_topic": item.bus_topic,
                        "routePath": item.route_path,
                        "expected_routePath": expected_route,
                        "error": "route_path_mismatch",
                    }
                )

    return {
        "fixture_path": _rel(fixture_path),
        "checked": len(fixture_methods),
        "errors": errors,
        "ok": not errors,
    }


def _schema_extra_behavior(schema: dict[str, Any]) -> str:
    additional = schema.get("additionalProperties")
    if additional is False:
        return "forbid"
    if additional is True or isinstance(additional, dict):
        return "preserve"
    return "strip"


def _annotate_schema(schema: Any) -> Any:
    if isinstance(schema, list):
        return [_annotate_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    if schema == {}:
        return {JSON_VALUE_MARKER: True}

    annotated = {
        key: (value if key == "properties" and value == {} else _annotate_schema(value))
        for key, value in schema.items()
    }
    if (
        annotated.get("type") == "object"
        and not annotated.get("properties")
        and annotated.get("additionalProperties") is True
    ):
        annotated["additionalProperties"] = {JSON_VALUE_MARKER: True}
    if annotated.get("type") == "object" or "properties" in annotated:
        annotated.setdefault("x-aurora-extra-behavior", _schema_extra_behavior(annotated))
    return annotated


def _contract_schema_id(method_id: str, direction: str, model_name: str) -> str:
    return f"{method_id}.{direction}.{model_name}"


def _event_schema_id(event_topic: str, model_name: str) -> str:
    return f"{event_topic}.event.{model_name}"


def _envelope_schema_id(envelope_topic: str, model_name: str) -> str:
    return f"{envelope_topic}.envelope.{model_name}"


def _streaming_shape(method_id: str) -> dict[str, Any]:
    if method_id in {"TTS.StreamStart", "TTS.StreamChunk", "TTS.StreamEnd"}:
        return {
            "rpc_kind": "unary",
            "ordered_command_group": "tts_text_stream",
            "request_stream": False,
            "response_stream": False,
            "event_topic": "TTS.AudioChunk",
        }
    if method_id in {"WakeWord.ProcessAudio", "Transcription.ProcessAudio"}:
        return {
            "rpc_kind": "unary",
            "ordered_command_group": None,
            "request_stream": False,
            "response_stream": False,
            "event_topic": None,
        }
    return {
        "rpc_kind": "unary",
        "ordered_command_group": None,
        "request_stream": False,
        "response_stream": False,
        "event_topic": None,
    }


def _model_wire_schema(model: Any, *, mode: str) -> dict[str, Any]:
    schema = model.model_json_schema(mode=mode)
    return normalize_schema(
        _annotate_lossless_model_schema(_model_name(model) or str(model), _annotate_schema(schema))
    )


def _tool_info_fixture() -> dict[str, Any]:
    from app.services.tooling.identity import canonical_tool_global_id

    tool_contract_id = "core.memory.upsert"
    global_tool_id = canonical_tool_global_id(TOOLING_PROVIDER_PEER_ID, tool_contract_id)
    return {
        "name": "memory.upsert",
        "local_name": "upsert_memory",
        "global_tool_id": global_tool_id,
        "tool_id_scheme": "aurora-tool",
        "tool_id_version": 1,
        "tool_contract_id": tool_contract_id,
        "share_group_id": "core:memory",
        "share_group_label": "Memory",
        "legacy_global_tool_ids": ["legacy-z", "legacy-a", "legacy-z"],
        "exportable": True,
        "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
        "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
        "namespace": "core.memory",
        "display_name": "Memory",
        "aliases": ["remember"],
        "description": "Store a memory",
        "args_schema": {"type": "object", "properties": {"text": {"type": "string"}}},
        "schema": {"type": "object", "properties": {"text": {"type": "string"}}},
        "argument_visibility": {},
        "source_type": "local",
        "source": "core",
        "source_id": "core:memory",
        "trust_tier": "trusted",
        "capability_class": "write",
        "resource_scope": [],
        "execution_location": "local",
        "safety_class": "standard",
        "risk_class": "standard",
        "data_egress": False,
        "mutating": True,
        "external": False,
        "admin": False,
        "required_permissions": ["Tooling.ExecuteTool"],
        "confirmation_required": False,
        "privacy_hints": [],
        "provenance": {
            "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
            "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
            "provider_kind": "local",
            "source": "core",
            "advertised_name": "upsert_memory",
            "stable_source_id": "core:memory",
            "provider_tool_id": "upsert_memory",
        },
    }


def _annotate_lossless_model_schema(model_name: str, schema: dict[str, Any]) -> dict[str, Any]:
    _annotate_mesh_address_selector_schemas(schema)
    _annotate_tooling_tool_info_schemas(schema)
    _annotate_speech_model_schemas(schema)
    if model_name == "ToolingGetExportCatalogResponse":
        schema[PROJECTION_PAGE_TERMINATION_MARKER] = True
        schema[PROJECTION_IDENTITY_MARKER] = True
        properties = schema.get("properties")
        if isinstance(properties, dict):
            digest_pattern = "^[0-9a-f]{64}$"
            for field_name in ("projection_digest", "page_hash"):
                field_schema = properties.get(field_name)
                if isinstance(field_schema, dict):
                    field_schema.setdefault("pattern", digest_pattern)
            next_cursor = properties.get("next_cursor")
            if isinstance(next_cursor, dict):
                for option in next_cursor.get("anyOf") or ():
                    if isinstance(option, dict) and option.get("type") == "string":
                        option[STRING_TRIMMED_MARKER] = True
            final_checksum = properties.get("final_checksum")
            if isinstance(final_checksum, dict):
                for option in final_checksum.get("anyOf") or ():
                    if isinstance(option, dict) and option.get("type") == "string":
                        option.setdefault("pattern", digest_pattern)
    if model_name == "RouteExplainRequest":
        schema[ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER] = True
        schema[ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER] = True
        schema[ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER] = True
    return schema


def _annotate_speech_model_schemas(schema: Any) -> None:
    if isinstance(schema, list):
        for item in schema:
            _annotate_speech_model_schemas(item)
        return
    if not isinstance(schema, dict):
        return
    title = schema.get("title")
    properties = schema.get("properties")
    if title == "SpeechLanguageRequirement":
        schema[SPEECH_LANGUAGE_REQUIREMENT_MARKER] = True
        if isinstance(properties, dict):
            language = properties.get("language")
            if isinstance(language, dict):
                language[SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER] = True
            candidates = properties.get("auto_language_candidates")
            if isinstance(candidates, dict):
                for array_schema in _array_schema_options(candidates):
                    array_schema[SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER] = True
            digest = properties.get("digest")
            if isinstance(digest, dict):
                _annotate_optional_string_pattern(digest, "^[0-9a-f]{64}$")
    elif title == "SpeechLocaleFallback":
        schema[SPEECH_LOCALE_FALLBACK_MARKER] = True
        if isinstance(properties, dict):
            for field_name in ("requested_language", "served_language"):
                field_schema = properties.get(field_name)
                if isinstance(field_schema, dict):
                    field_schema[SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER] = True
    elif title == "SpeechMethodConstraints":
        schema[SPEECH_METHOD_CONSTRAINTS_MARKER] = True
        if isinstance(properties, dict):
            for field_name in ("exact_languages", "auto_detect_languages"):
                field_schema = properties.get(field_name)
                if isinstance(field_schema, dict):
                    for array_schema in _array_schema_options(field_schema):
                        array_schema[SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER] = True
            ready_voice_ids = properties.get("ready_voice_ids")
            if isinstance(ready_voice_ids, dict):
                for array_schema in _array_schema_options(ready_voice_ids):
                    array_schema[LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER] = True
            digest = properties.get("resident_model_identity_digest")
            if isinstance(digest, dict):
                _annotate_optional_string_pattern(digest, "^[0-9a-f]{64}$")
    elif title == "SpeechRouteBinding" and isinstance(properties, dict):
        for field_name in ("projection_digest", "requirement_digest"):
            field_schema = properties.get(field_name)
            if isinstance(field_schema, dict):
                field_schema.setdefault("pattern", "^[0-9a-f]{64}$")
        for field_name in ("service_instance_id", "projection_revision", "provider_lease_epoch"):
            field_schema = properties.get(field_name)
            if isinstance(field_schema, dict):
                field_schema.setdefault("minLength", 1)
                field_schema[STRING_NON_BLANK_MARKER] = True
    if isinstance(title, str) and (title.startswith("TTS") or title in {"TranscribeAudioRequest"}):
        _annotate_tts_validator_fields(title, schema)
    for item in schema.values():
        _annotate_speech_model_schemas(item)


def _annotate_optional_string_pattern(schema: dict[str, Any], pattern: str) -> None:
    if schema.get("type") == "string":
        schema.setdefault("pattern", pattern)
        return
    for option in schema.get("anyOf") or ():
        if isinstance(option, dict) and option.get("type") == "string":
            option.setdefault("pattern", pattern)


def _annotate_optional_string_marker(schema: dict[str, Any], marker: str) -> None:
    if schema.get("type") == "string":
        schema[marker] = True
        return
    for option in schema.get("anyOf") or ():
        if isinstance(option, dict) and option.get("type") == "string":
            option[marker] = True


def _annotate_tts_validator_fields(title: str, schema: dict[str, Any]) -> None:
    from app.shared.contracts.models.speech import LOGICAL_VOICE_ID_PATTERN

    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return
    invariant_markers = {
        "TTSCapabilities": TTS_CAPABILITIES_INVARIANT_MARKER,
        "TTSVoiceDescriptor": TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER,
        "TTSListVoicesResponse": TTS_VOICE_LIST_INVARIANT_MARKER,
        "TTSVoiceProfileDescriptor": TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER,
        "TTSListVoiceProfilesResponse": TTS_PROFILE_LIST_INVARIANT_MARKER,
        "TTSGetVoiceProfileResponse": TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER,
        "TTSUpdateVoiceProfileRequest": TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER,
        "TTSCreateVoiceProfileResponse": TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER,
        "TTSDeleteVoiceProfileRequest": TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER,
        "TTSInstallVoiceProfileResponse": TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
        "TTSRemoveVoiceProfileResponse": TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
        "TTSUpdateVoiceProfileResponse": TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
        "TTSDeleteVoiceProfileResponse": TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
        "TTSVoiceImportStartResponse": TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER,
        "TTSVoiceImportChunkRequest": TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER,
        "TTSVoiceImportChunkResponse": TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER,
        "TTSAudioChunkEvent": TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
        "TranscribeAudioRequest": STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER,
    }
    marker = invariant_markers.get(title)
    if marker is not None:
        schema[marker] = True
    if title == "TTSDeleteVoiceProfileResponse":
        schema[TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER] = True
    for field_name in ("voice_id", "voice"):
        field_schema = properties.get(field_name)
        if isinstance(field_schema, dict):
            _annotate_optional_string_pattern(field_schema, LOGICAL_VOICE_ID_PATTERN)
    for field_name in ("sha256", "chunk_sha256", "final_sha256"):
        field_schema = properties.get(field_name)
        if isinstance(field_schema, dict):
            _annotate_optional_string_pattern(field_schema, "^[0-9a-f]{64}$")
    operation_id = properties.get("operation_id")
    if isinstance(operation_id, dict):
        _annotate_optional_string_marker(operation_id, TTS_OPERATION_ID_MARKER)
    sealed_audio_ref = properties.get("sealed_audio_ref")
    if title == "TTSCreateVoiceProfileRequest" and isinstance(sealed_audio_ref, dict):
        sealed_audio_ref.setdefault("pattern", "^voice-import:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
    nonblank_fields_by_title = {
        "TTSResidentLanguagePack": ("pack_id",),
        "TTSVoiceDescriptor": ("display_name", "revision"),
        "TTSVoiceProfileDescriptor": ("display_name", "revision"),
        "TTSUpdateVoiceProfileRequest": ("expected_revision", "display_name"),
        "TTSInstallVoiceProfileRequest": ("expected_revision",),
        "TTSRemoveVoiceProfileRequest": ("expected_revision",),
        "TTSSetDefaultVoiceRequest": ("expected_revision",),
        "TTSVoiceImportStartRequest": ("expected_revision",),
        "TTSVoiceImportChunkRequest": ("expected_revision", "upload_id"),
        "TTSVoiceImportEndRequest": ("expected_revision", "upload_id"),
        "TTSVoiceImportAbortRequest": ("expected_revision", "upload_id"),
        "TTSCreateVoiceProfileRequest": (
            "operation_id",
            "expected_revision",
            "display_name",
            "sealed_audio_ref",
        ),
        "TTSDeleteVoiceProfileRequest": ("expected_revision",),
        "TTSVoiceImportStartResponse": ("upload_id", "expires_at"),
        "TTSVoiceImportEndResponse": ("sealed_audio_ref", "expires_at"),
    }
    for field_name in nonblank_fields_by_title.get(title, ()):
        field_schema = properties.get(field_name)
        if isinstance(field_schema, dict):
            _annotate_optional_string_marker(field_schema, STRING_NON_BLANK_MARKER)
    for field_name in ("language",):
        field_schema = properties.get(field_name)
        if isinstance(field_schema, dict):
            field_schema[
                SPEECH_LANGUAGE_AUTO_NULL_MARKER
                if title == "TranscribeAudioRequest"
                else SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER
            ] = True
    for field_name in ("ready_languages", "auto_language_candidates"):
        field_schema = properties.get(field_name)
        if isinstance(field_schema, dict):
            for array_schema in _array_schema_options(field_schema):
                array_schema[SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER] = True
    for field_name in (
        "supported_language_pack_ids",
        "installed_language_pack_ids",
        "resident_language_pack_ids",
        "compatible_language_pack_ids",
        "allowed_peer_ids",
    ):
        field_schema = properties.get(field_name)
        if isinstance(field_schema, dict):
            for array_schema in _array_schema_options(field_schema):
                array_schema[BOUNDED_NONBLANK_STRING_SET_MARKER] = True
                items = array_schema.get("items")
                if (
                    isinstance(items, dict)
                    and items.get("type") == "string"
                    and "enum" not in items
                ):
                    items.setdefault("minLength", 1)
                    items.setdefault("maxLength", 256)


def _array_schema_options(schema: dict[str, Any]) -> list[dict[str, Any]]:
    if schema.get("type") == "array":
        return [schema]
    return [
        option
        for option in schema.get("anyOf") or ()
        if isinstance(option, dict) and option.get("type") == "array"
    ]


def _annotate_mesh_address_selector_schemas(schema: Any) -> None:
    if isinstance(schema, list):
        for item in schema:
            _annotate_mesh_address_selector_schemas(item)
        return
    if not isinstance(schema, dict):
        return
    if schema.get("title") == "MeshAddressSelector":
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for field_schema in properties.values():
                if isinstance(field_schema, dict):
                    for option in field_schema.get("anyOf") or ():
                        if isinstance(option, dict) and option.get("type") == "string":
                            option[STRING_NON_BLANK_MARKER] = True
    for item in schema.values():
        _annotate_mesh_address_selector_schemas(item)


def _annotate_tooling_tool_info_schemas(schema: Any) -> None:
    if isinstance(schema, list):
        for item in schema:
            _annotate_tooling_tool_info_schemas(item)
        return
    if not isinstance(schema, dict):
        return
    if schema.get("title") == "ToolingToolInfo":
        properties = schema.get("properties")
        if isinstance(properties, dict):
            legacy_ids = properties.get("legacy_global_tool_ids")
            if isinstance(legacy_ids, dict):
                legacy_ids[UNIQUE_STRING_ARRAY_NORMALIZE_MARKER] = True
                items = legacy_ids.get("items")
                if isinstance(items, dict):
                    items.setdefault("minLength", 1)
                    items.setdefault("maxLength", 512)
    for item in schema.values():
        _annotate_tooling_tool_info_schemas(item)


def _positive_fixture(model_name: str) -> Any | None:
    tool_info = _tool_info_fixture()
    fixtures: dict[str, Any] = {
        "AuroraEventStreamEvent": {
            "event_id": "evt-assistant-1",
            "topic": "Orchestrator.Response",
            "kind": "assistant.delta",
            "category": "assistant",
            "action": "Response",
            "status": "streaming",
            "severity": "info",
            "timestamp": "2026-08-07T00:00:00Z",
            "correlation_id": "corr-assistant-1",
            "principal_id": "principal-1",
            "payload": {
                "kind": "assistant.delta",
                "delta": "hel",
                "session_id": "session-1",
                "request_id": "request-1",
                "correlation_id": "corr-assistant-1",
                "sequence": 1,
            },
            "redacted_payload": {
                "kind": "assistant.delta",
                "delta": {"redacted": True, "sha256": "a" * 64},
                "session_id": "session-1",
                "request_id": "request-1",
                "correlation_id": "corr-assistant-1",
                "sequence": 1,
            },
            "payload_sha256": "b" * 64,
            "unexpected": "stripped",
        },
        "AssistantStreamEvent": {
            "kind": "assistant.delta",
            "delta": "hel",
            "session_id": "session-1",
            "request_id": "request-1",
            "correlation_id": "corr-assistant-1",
            "message_id": "message-1",
            "sequence": 1,
            "metadata": {"source": "native", "stream": True},
            "unexpected": "stripped",
        },
        "OrchestratorInterruptedEvent": {
            "interrupt_id": "interrupt-1",
            "status": "cancelled",
            "requested_scopes": ["generation", "tts_playback"],
            "results": [
                {
                    "scope": "generation",
                    "status": "cancelled",
                    "message": "Cancelled 1 active generation task",
                    "cancelled_count": 1,
                }
            ],
            "session_id": "session-1",
            "request_id": "request-1",
            "reason": "user_interrupt",
            "principal_id": "principal-1",
            "audit_event": "orchestrator.interrupt.requested",
            "secrets_redacted": True,
            "unexpected": "stripped",
        },
        "OrchestratorInterruptRequest": {
            "scopes": ["generation", "tts_playback"],
            "session_id": "session-1",
            "request_id": "request-1",
            "reason": "user_interrupt",
            "unexpected": "stripped",
        },
        "OrchestratorInterruptResponse": {
            "interrupt_id": "interrupt-1",
            "status": "cancelled",
            "requested_scopes": ["generation", "tts_playback"],
            "results": [
                {
                    "scope": "generation",
                    "status": "cancelled",
                    "message": "Cancelled 1 active generation task",
                    "cancelled_count": 1,
                }
            ],
            "session_id": "session-1",
            "request_id": "request-1",
            "event_topic": "Orchestrator.Interrupted",
            "audit_event": "orchestrator.interrupt.requested",
            "idempotent": True,
            "secrets_redacted": True,
            "unexpected": "stripped",
        },
        "OrchestratorProcessRequest": {
            "text": "turn on the kitchen lights",
            "source": "native",
            "session_id": "session-1",
            "request_id": "request-1",
            "correlation_id": "corr-assistant-1",
            "stream": True,
            "client_tts_playback": True,
            "unexpected": "stripped",
        },
        "OrchestratorResponse": {
            "text": "The kitchen lights are on.",
            "session_id": "session-1",
            "request_id": "request-1",
            "correlation_id": "corr-assistant-1",
            "metadata": {"source": "native", "stream": False},
            "unexpected": "stripped",
        },
        "ToolingExecuteToolRequest": {
            "tool_name": "echo",
            "arguments": {"message": "hello", "unicode": "snowman \u2603"},
            "confirmed": False,
            "dry_run": True,
            "caller_peer_id": TOOLING_PROVIDER_PEER_ID,
            "unexpected": "stripped",
        },
        "ToolingExecuteToolResponse": {
            "ok": True,
            "data": {"result": "hello"},
            "status": "success",
            "correlation_id": "corr-tooling-1",
            "display_args_preview": {"message": "hello"},
        },
        "ToolingGetToolsRequest": {
            "query": "echo",
            "top_k": 2**53 - 1,
            "unexpected": "stripped",
        },
        "ToolingGetToolsResponse": {
            "tools": [tool_info],
            "count": 1,
            "unexpected": "stripped",
        },
        "ToolingGetExportCatalogRequest": {
            "protocol_tier": "projection_v1",
            "page_size": 1,
            "last_projection_digest": "0" * 64,
            "unexpected": "stripped",
        },
        "ToolingGetExportCatalogResponse": {
            "ok": True,
            "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
            "service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
            "authority_revision": {
                "catalog_revision": 1,
                "export_policy_revision": 1,
                "auth_grant_revision": 1,
                "manifest_revision": 1,
                "switch_revision": 1,
                "protocol_revision": 1,
            },
            "projection_revision": "projection-1",
            "projection_digest": "1" * 64,
            "page_index": 0,
            "page_size": 1,
            "page_hash": "2" * 64,
            "tools": [tool_info],
            "blocked_tools": [],
            "retirements": [],
            "complete": True,
            "total_count": 1,
            "final_checksum": "3" * 64,
            "unexpected": "stripped",
        },
        "ToolingPrepareExecutionRequest": {
            "tool_name": "echo",
            "arguments": {"message": "hello"},
            "dry_run": True,
            "caller_peer_id": TOOLING_PROVIDER_PEER_ID,
            "unexpected": "stripped",
        },
        "ToolingPrepareExecutionResponse": {
            "ok": True,
            "policy_decision": {
                "allowed": True,
                "share": True,
                "approval_required": False,
                "approval_mode": "approve_all_local_safe",
                "decision_id": "decision-1",
            },
            "args_hash": "a" * 64,
            "resource_selector_hash": "b" * 64,
            "route_decision_id": "route-1",
            "correlation_id": "corr-prepare-1",
            "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
            "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
            "global_tool_id": f"aurora-tool:v1:{TOOLING_PROVIDER_SERVICE_INSTANCE_ID}:echo",
            "local_tool_name": "echo",
            "display_args_preview": {"message": "hello"},
            "secrets_redacted": True,
            "resource_scope": [],
            "argument_visibility": {},
            "unexpected": "stripped",
        },
        "TTSAudioChunkEvent": {
            "stream_id": "stream-1",
            "sequence": 0,
            "audio_data": "AA==",
            "format": "raw",
            "sample_rate": 24000,
            "channels": 1,
            "duration_ms": 12.5,
            "text": "hello",
            "source_sequence": 0,
            "is_final": False,
            "reason": None,
            "correlation_id": "corr-tts-1",
        },
    }
    return fixtures.get(model_name)


def _negative_fixture(model_name: str) -> Any | None:
    tool_info = _tool_info_fixture()
    bad_legacy_tool = {**tool_info, "legacy_global_tool_ids": [" not-trimmed "]}
    fixtures: dict[str, Any] = {
        "AuroraEventStreamEvent": {
            "event_id": "evt-assistant-1",
            "topic": "Orchestrator.Response",
            "kind": "assistant.delta",
            "category": "assistant",
            "payload": {f"k{i}": i for i in range(65)},
            "redacted_payload": {},
        },
        "AssistantStreamEvent": {
            "kind": "assistant.delta",
            "delta": "hel",
            "sequence": 2**53,
        },
        "OrchestratorInterruptedEvent": {
            "interrupt_id": "interrupt-1",
            "status": "cancelled",
            "requested_scopes": ["generation"],
            "results": [
                {
                    "scope": "generation",
                    "status": "cancelled",
                    "cancelled_count": 2**53,
                }
            ],
        },
        "OrchestratorInterruptRequest": {
            "scopes": ["generation", "tool_call", "tts_playback", "session", "generation"],
            "reason": "user_interrupt",
        },
        "OrchestratorInterruptResponse": {
            "interrupt_id": "interrupt-1",
            "status": "cancelled",
            "requested_scopes": ["generation"],
            "results": [
                {
                    "scope": "generation",
                    "status": "cancelled",
                    "cancelled_count": 2**53,
                }
            ],
        },
        "OrchestratorProcessRequest": {
            "text": "",
            "source": "native",
        },
        "OrchestratorResponse": {
            "text": "x" * 120_001,
        },
        "ToolingExecuteToolRequest": {
            "tool_name": 12,
            "arguments": {},
        },
        "ToolingExecuteToolResponse": {
            "status": "success",
        },
        "ToolingGetToolsRequest": {
            "top_k": "one",
        },
        "ToolingGetToolsResponse": {
            "count": 1,
            "tools": [bad_legacy_tool],
        },
        "ToolingGetExportCatalogRequest": {
            "protocol_tier": "projection_v1",
            "page_size": 0,
        },
        "ToolingGetExportCatalogResponse": {
            "ok": True,
            "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
            "service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
            "authority_revision": {
                "catalog_revision": 1,
                "export_policy_revision": 1,
                "auth_grant_revision": 1,
                "manifest_revision": 1,
                "switch_revision": 1,
                "protocol_revision": 1,
            },
            "projection_revision": "projection-1",
            "projection_digest": "ABC",
            "page_index": 0,
            "page_size": 1,
            "page_hash": "2" * 64,
            "complete": True,
            "total_count": 0,
            "final_checksum": "3" * 64,
        },
        "ToolingPrepareExecutionRequest": {
            "tool_name": 12,
            "arguments": {},
        },
        "ToolingPrepareExecutionResponse": {
            "ok": True,
            "args_hash": "a" * 64,
        },
        "TTSAudioChunkEvent": {
            "stream_id": "stream-1",
            "sequence": 2**53,
            "audio_data": "AA==",
            "format": "raw",
            "sample_rate": 24000,
            "channels": 1,
            "duration_ms": 12.5,
        },
    }
    return fixtures.get(model_name)


def _negative_fixtures(model_name: str) -> list[Any]:
    first = _negative_fixture(model_name)
    cases = [] if first is None else [first]
    if model_name == "ToolingGetExportCatalogResponse":
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.extend(
                [
                    {
                        **base,
                        "next_cursor": " not-trimmed ",
                        "complete": False,
                        "total_count": None,
                        "final_checksum": None,
                    },
                    {**base, "complete": False, "total_count": None},
                    {
                        **base,
                        "complete": False,
                        "next_cursor": None,
                        "total_count": None,
                        "final_checksum": None,
                    },
                    {
                        **base,
                        "provider_peer_id": f" {TOOLING_PROVIDER_PEER_ID} ",
                    },
                    {
                        **base,
                        "service_instance_id": "remote:other-peer:Tooling",
                    },
                    {
                        **base,
                        "tools": [
                            {
                                **base["tools"][0],
                                "global_tool_id": "not-canonical",
                            }
                        ],
                    },
                    {
                        **base,
                        "tools": [
                            {
                                **base["tools"][0],
                                "legacy_global_tool_ids": [
                                    f"legacy-{index:02d}" for index in range(17)
                                ],
                            }
                        ],
                    },
                ]
            )
    if model_name == "ToolingGetToolsRequest":
        cases.extend(
            [
                {"mesh_selector": {"peer_id": " "}},
                {"top_k": 2**53},
                {"top_k": -(2**53)},
            ]
        )
    if model_name == "ToolingGetToolsResponse":
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.append(
                {
                    **base,
                    "tools": [
                        {
                            **base["tools"][0],
                            "legacy_global_tool_ids": [
                                f"legacy-{index:02d}" for index in range(17)
                            ],
                        }
                    ],
                }
            )
    if model_name == "TTSAudioChunkEvent":
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.extend(
                [
                    {**base, "audio_data": ""},
                    {**base, "source_sequence": 2**53},
                    {**base, "sample_rate": 192001},
                    {**base, "channels": 0},
                ]
            )
    if model_name == "AssistantStreamEvent":
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.extend(
                [
                    {**base, "metadata": {f"k{i}": i for i in range(65)}},
                    {**base, "delta": "x" * 16_385},
                ]
            )
    if model_name == "AuroraEventStreamEvent":
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.extend(
                [
                    {**base, "event_id": ""},
                    {**base, "redacted_payload": {f"k{i}": i for i in range(65)}},
                ]
            )
    if model_name == "OrchestratorInterruptRequest":
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.append({**base, "reason": ""})
    if model_name in {"OrchestratorInterruptResponse", "OrchestratorInterruptedEvent"}:
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.append({**base, "requested_scopes": ["generation"] * 5})
    return cases


def _positive_fixtures(model_name: str) -> list[Any]:
    first = _positive_fixture(model_name)
    cases = [] if first is None else [first]
    if model_name == "AssistantStreamEvent":
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.extend(
                [
                    {
                        **base,
                        "kind": "assistant.completed",
                        "text": "The kitchen lights are on.",
                        "delta": "",
                        "sequence": 2,
                        "is_final": True,
                    },
                    {
                        **base,
                        "kind": "assistant.failed",
                        "text": "Aurora could not complete that request.",
                        "delta": "",
                        "sequence": 3,
                        "is_final": True,
                        "metadata": {"source": "native", "error": True},
                    },
                ]
            )
    if model_name in {"ToolingGetToolsResponse", "ToolingGetExportCatalogResponse"}:
        base = _positive_fixture(model_name)
        if isinstance(base, dict):
            cases.append(
                {
                    **base,
                    "tools": [
                        {
                            **base["tools"][0],
                            "legacy_global_tool_ids": ["legacy-a"] * 20 + ["legacy-b"] * 20,
                        }
                    ],
                }
            )
    return cases


def _validation_vectors(model: Any, *, method_id: str, direction: str) -> dict[str, Any]:
    model_name = _model_name(model) or str(model)
    positive_cases = _positive_fixtures(model_name)
    positive = positive_cases[0] if positive_cases else None
    negative_cases = _negative_fixtures(model_name)
    vectors: dict[str, Any] = {}
    if positive is not None:
        parsed = model.model_validate(positive)
        normalized = parsed.model_dump(mode="json", by_alias=True)
        vectors["positive"] = {
            "accepted": True,
            "input": positive,
            "normalized": normalized,
            "normalized_hash": sha256_json(normalized),
        }
    for positive_case in positive_cases[1:]:
        parsed = model.model_validate(positive_case)
        normalized = parsed.model_dump(mode="json", by_alias=True)
        vectors.setdefault("positive_cases", []).append(
            {
                "accepted": True,
                "input": positive_case,
                "normalized": normalized,
                "normalized_hash": sha256_json(normalized),
            }
        )
    for index, negative in enumerate(negative_cases):
        try:
            model.model_validate(negative)
        except ValidationError as exc:
            first = exc.errors()[0]
            vector = {
                "accepted": False,
                "input": negative,
                "issue_path": "$" + "".join(f".{part}" for part in first.get("loc", ())),
                "issue_category": first.get("type"),
            }
            if index == 0:
                vectors["negative"] = vector
            vectors.setdefault("negative_cases", []).append(vector)
        else:
            raise ValueError(
                f"{method_id} {direction} {model_name}: negative fixture unexpectedly passed"
            )
    return vectors


def build_sdk_contract_schema() -> dict[str, Any]:
    methods, _import_errors = build_method_inventory()
    method_inventory = {method["bus_topic"]: method for method in methods}
    contracts = all_contracts()
    schemas: list[dict[str, Any]] = []
    method_descriptors: list[dict[str, Any]] = []
    event_descriptors: list[dict[str, Any]] = []
    from app.shared.contracts.models.aurora import AuroraEventStreamEvent
    from app.shared.contracts.models.orchestrator import (
        AssistantStreamEvent,
        OrchestratorInterruptedEvent,
    )
    from app.shared.contracts.models.tooling import (
        ToolingExecuteToolRequest,
        ToolingExecuteToolResponse,
        ToolingGetExportCatalogRequest,
        ToolingGetExportCatalogResponse,
        ToolingGetToolsRequest,
        ToolingGetToolsResponse,
        ToolingPrepareExecutionRequest,
        ToolingPrepareExecutionResponse,
    )
    from app.shared.contracts.models.tts import TTSAudioChunkEvent

    static_models = {
        "Tooling.ExecuteTool": (ToolingExecuteToolRequest, ToolingExecuteToolResponse),
        "Tooling.GetExportCatalog": (
            ToolingGetExportCatalogRequest,
            ToolingGetExportCatalogResponse,
        ),
        "Tooling.GetTools": (ToolingGetToolsRequest, ToolingGetToolsResponse),
        "Tooling.PrepareExecution": (
            ToolingPrepareExecutionRequest,
            ToolingPrepareExecutionResponse,
        ),
    }
    event_models = {
        "Orchestrator.Response": {
            "module": "Orchestrator",
            "name": "Response",
            "topic": "Orchestrator.Response",
            "model": AssistantStreamEvent,
            "required_permission": "Orchestrator.use",
            "bounded": True,
            "authorized": True,
            "ordered_event_group": "assistant_stream",
            "remote_raw_audio_route": False,
        },
        "Orchestrator.Interrupted": {
            "module": "Orchestrator",
            "name": "Interrupted",
            "topic": "Orchestrator.Interrupted",
            "model": OrchestratorInterruptedEvent,
            "required_permission": "Orchestrator.use",
            "bounded": True,
            "authorized": True,
            "ordered_event_group": "assistant_interrupt",
            "remote_raw_audio_route": False,
        },
        "TTS.AudioChunk": {
            "module": "TTS",
            "name": "AudioChunk",
            "topic": "TTS.AudioChunk",
            "model": TTSAudioChunkEvent,
            "required_permission": "TTS.use",
            "bounded": True,
            "authorized": True,
            "ordered_event_group": "tts_text_stream",
            "remote_raw_audio_route": False,
        },
    }
    envelope_models = {
        "Aurora.EventStream": {
            "module": "Aurora",
            "name": "EventStream",
            "topic": "Aurora.EventStream",
            "model": AuroraEventStreamEvent,
            "required_permissions_broad": ["Gateway.manage"],
            "required_permissions_scoped": ["Orchestrator.use"],
            "scoped_topics": ["Orchestrator.Response", "TTS.AudioChunk"],
            "scoped_categories": ["assistant"],
            "requires_correlation_id": True,
            "bounded": True,
            "authorized": True,
            "route_path": "/api/events/stream",
            "route_kind": "gateway_sse_builtin",
            "descriptor_kind": "sse_envelope",
        }
    }
    method_metadata: dict[str, dict[str, Any]] = {}
    for method_id in SDK_CONTRACT_ALLOWLIST:
        contract = contracts.get(method_id)
        inventory_item = method_inventory.get(method_id)
        exposure = (
            contract.exposure if contract is not None else (inventory_item or {}).get("exposure")
        )
        if exposure not in {"external", "both"}:
            raise ValueError(f"Allowlisted contract is not externally visible: {method_id}")
        if contract is not None:
            input_model = contract.input_model
            output_model = contract.output_model
        else:
            if method_id not in static_models:
                raise ValueError(f"Allowlisted contract is not registered: {method_id}")
            input_model, output_model = static_models[method_id]
        module, name = method_id.split(".", 1)
        metadata_source = inventory_item or {}
        method_metadata[method_id] = {
            "method_id": method_id,
            "module": contract.module
            if contract is not None
            else metadata_source.get("module", module),
            "name": contract.name if contract is not None else metadata_source.get("name", name),
            "topic": contract.bus_topic if contract is not None else method_id,
            "bus_topic": contract.bus_topic if contract is not None else method_id,
            "route_path": (
                metadata_source.get("routePath")
                or metadata_source.get("route_path")
                or _method_route_path(module, name, exposure)
            ),
            "route_kind": metadata_source.get(
                "route_kind", "dynamic" if exposure in {"external", "both"} else "internal_bus"
            ),
            "exposure": exposure,
            "method_type": (
                contract.method_type
                if contract is not None
                else metadata_source.get("method_type", "use")
            ),
            "required_perms": (
                list(contract.required_perms)
                if contract is not None
                else list(metadata_source.get("required_perms", []))
            ),
            "callable_feature_ids": (
                list(contract.callable_feature_ids)
                if contract is not None
                else list(metadata_source.get("callable_feature_ids", []))
            ),
            "callable_features": (
                [feature.model_dump(mode="json") for feature in contract.callable_features]
                if contract is not None
                else list(metadata_source.get("callable_features", []))
            ),
            "input_model": _model_name(input_model),
            "output_model": _model_name(output_model),
            "streaming": _streaming_shape(method_id),
            "speech_constraints": (
                _speech_constraints_value(contract.speech_constraints)
                if contract is not None
                else metadata_source.get("speech_constraints")
            ),
        }
        for direction, mode, model in (
            ("input", "validation", input_model),
            ("output", "serialization", output_model),
        ):
            if model is None or isinstance(model, str):
                continue
            model_name = _model_name(model) or str(model)
            schema = _model_wire_schema(model, mode=mode)
            schema_id = _contract_schema_id(method_id, direction, model_name)
            _assert_validator_extension_coverage(
                method_id=method_id,
                direction=direction,
                root_model=model,
                schema=schema,
            )
            _assert_no_unbounded_integer_schema(schema, context=schema_id)
            schemas.append(
                {
                    "schema_id": schema_id,
                    "method_id": method_id,
                    "direction": direction,
                    "pydantic_mode": mode,
                    "model_name": model_name,
                    "schema": schema,
                    "schema_hash": sha256_json(schema),
                    "vectors": _validation_vectors(model, method_id=method_id, direction=direction),
                }
            )

    schema_by_method_direction = {(item["method_id"], item["direction"]): item for item in schemas}
    for method_id in SDK_CONTRACT_ALLOWLIST:
        descriptor = dict(method_metadata[method_id])
        input_schema = schema_by_method_direction.get((method_id, "input"))
        output_schema = schema_by_method_direction.get((method_id, "output"))
        descriptor.update(
            {
                "input_schema_id": input_schema["schema_id"] if input_schema else None,
                "output_schema_id": output_schema["schema_id"] if output_schema else None,
                "input_schema_hash": input_schema["schema_hash"] if input_schema else None,
                "output_schema_hash": output_schema["schema_hash"] if output_schema else None,
            }
        )
        method_descriptors.append(descriptor)

    for event_topic in SDK_EVENT_ALLOWLIST:
        metadata = event_models.get(event_topic)
        if metadata is None:
            raise ValueError(
                f"Allowlisted event is not registered for SDK generation: {event_topic}"
            )
        model = metadata["model"]
        model_name = _model_name(model) or str(model)
        schema = _model_wire_schema(model, mode="serialization")
        schema_id = _event_schema_id(event_topic, model_name)
        _assert_validator_extension_coverage(
            method_id=event_topic,
            direction="event",
            root_model=model,
            schema=schema,
        )
        _assert_no_unbounded_integer_schema(schema, context=schema_id)
        schema_item = {
            "schema_id": schema_id,
            "method_id": event_topic,
            "direction": "event",
            "pydantic_mode": "serialization",
            "model_name": model_name,
            "schema": schema,
            "schema_hash": sha256_json(schema),
            "vectors": _validation_vectors(model, method_id=event_topic, direction="event"),
        }
        schemas.append(schema_item)
        event_descriptors.append(
            {
                "event_topic": event_topic,
                "module": metadata["module"],
                "name": metadata["name"],
                "topic": metadata["topic"],
                "model": model_name,
                "schema_id": schema_item["schema_id"],
                "schema_hash": schema_item["schema_hash"],
                "required_permission": metadata["required_permission"],
                "required_perms": [metadata["required_permission"]],
                "bounded": metadata["bounded"],
                "authorized": metadata["authorized"],
                "ordered_event_group": metadata["ordered_event_group"],
                "remote_raw_audio_route": metadata["remote_raw_audio_route"],
            }
        )

    envelope_descriptors: list[dict[str, Any]] = []
    for envelope_topic in SDK_ENVELOPE_ALLOWLIST:
        metadata = envelope_models.get(envelope_topic)
        if metadata is None:
            raise ValueError(
                f"Allowlisted envelope is not registered for SDK generation: {envelope_topic}"
            )
        model = metadata["model"]
        model_name = _model_name(model) or str(model)
        schema = _model_wire_schema(model, mode="serialization")
        schema_id = _envelope_schema_id(envelope_topic, model_name)
        _assert_validator_extension_coverage(
            method_id=envelope_topic,
            direction="envelope",
            root_model=model,
            schema=schema,
        )
        _assert_no_unbounded_integer_schema(schema, context=schema_id)
        schema_item = {
            "schema_id": schema_id,
            "method_id": envelope_topic,
            "direction": "envelope",
            "pydantic_mode": "serialization",
            "model_name": model_name,
            "schema": schema,
            "schema_hash": sha256_json(schema),
            "vectors": _validation_vectors(model, method_id=envelope_topic, direction="envelope"),
        }
        schemas.append(schema_item)
        envelope_descriptors.append(
            {
                "envelope_topic": envelope_topic,
                "module": metadata["module"],
                "name": metadata["name"],
                "topic": metadata["topic"],
                "model": model_name,
                "schema_id": schema_item["schema_id"],
                "schema_hash": schema_item["schema_hash"],
                "required_permissions_broad": metadata["required_permissions_broad"],
                "required_permissions_scoped": metadata["required_permissions_scoped"],
                "scoped_topics": metadata["scoped_topics"],
                "scoped_categories": metadata["scoped_categories"],
                "requires_correlation_id": metadata["requires_correlation_id"],
                "bounded": metadata["bounded"],
                "authorized": metadata["authorized"],
                "route_path": metadata["route_path"],
                "route_kind": metadata["route_kind"],
                "descriptor_kind": metadata["descriptor_kind"],
            }
        )

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "artifact": "aurora-sdk-backend-contracts",
        "schema_draft": "https://json-schema.org/draft/2020-12/schema",
        "generator_format_version": GENERATOR_FORMAT_VERSION,
        "allowlist": list(SDK_CONTRACT_ALLOWLIST),
        "allowlist_hash": sha256_json(list(SDK_CONTRACT_ALLOWLIST)),
        "tooling_provider_allowlist": list(SDK_TOOLING_PROVIDER_CONTRACT_ALLOWLIST),
        "tooling_provider_allowlist_hash": sha256_json(
            list(SDK_TOOLING_PROVIDER_CONTRACT_ALLOWLIST)
        ),
        "method_descriptors": method_descriptors,
        "event_descriptors": event_descriptors,
        "envelope_descriptors": envelope_descriptors,
        "schemas": sorted(schemas, key=lambda item: item["schema_id"]),
    }


def build_tooling_local_provider(contract_schema: dict[str, Any]) -> dict[str, Any]:
    from app.services.db.tooling_remote_catalog_store import (
        compute_projection_checksum,
        compute_projection_page_hash,
        compute_tool_schema_hash,
    )
    from app.services.gateway.mesh.provider_export import canonical_digest
    from app.services.tooling.identity import canonical_tool_global_id
    from app.shared.contracts.models.tooling import (
        ToolingGetExportCatalogResponse,
        ToolingProjectionAuthorityRevision,
        ToolingProjectionBlockedTool,
        ToolingProjectionRetirement,
        ToolingToolInfo,
    )

    schema_hashes = {
        (item["method_id"], item["direction"]): item["schema_hash"]
        for item in contract_schema["schemas"]
    }
    methods = []
    for method_id in SDK_TOOLING_PROVIDER_CONTRACT_ALLOWLIST:
        methods.append(
            {
                "method_id": method_id,
                "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
                "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
                "input_schema_hash": schema_hashes.get((method_id, "input")),
                "output_schema_hash": schema_hashes.get((method_id, "output")),
                "required_permission": SDK_PROVIDER_REQUIRED_PERMISSION_OVERRIDES.get(
                    method_id, method_id
                ),
            }
        )
    projection = {
        "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
        "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
        "methods": methods,
    }
    digest_tool = ToolingToolInfo.model_validate(_tool_info_fixture())
    alternate_tool = ToolingToolInfo.model_validate(
        {
            **_tool_info_fixture(),
            "name": "alpha.lookup",
            "local_name": "lookup_alpha",
            "global_tool_id": canonical_tool_global_id(
                TOOLING_PROVIDER_PEER_ID, "core.alpha.lookup"
            ),
            "tool_contract_id": "core.alpha.lookup",
            "share_group_id": "core:alpha",
            "share_group_label": "Alpha",
            "legacy_global_tool_ids": ["legacy-beta", "legacy-alpha"],
            "display_name": "Alpha lookup",
            "args_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "api_key": {"type": "string"},
                    "options": {
                        "type": "object",
                        "properties": {"limit": {"type": "integer", "minimum": 0, "maximum": 5}},
                    },
                },
            },
            "schema": {
                "type": "object",
                "properties": {
                    "result": {"type": "string"},
                    "metadata": {"type": "object", "properties": {}},
                },
            },
            "argument_visibility": {
                "query": "display",
                "api_key": "secret",
            },
            "source_id": "core:alpha",
            "capability_class": "read",
            "mutating": False,
            "provenance": {
                "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
                "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
                "provider_kind": "local",
                "source": "core",
                "advertised_name": "lookup_alpha",
                "stable_source_id": "core:alpha",
                "provider_tool_id": "lookup_alpha",
            },
        }
    )
    blocked_tool = ToolingProjectionBlockedTool(
        tool=alternate_tool,
        reason_code="recipient_missing_tool_permissions",
        missing_permissions=["Tooling.ExecuteTool", "Tooling.GetTools"],
    )
    retirement = ToolingProjectionRetirement(
        global_tool_id=canonical_tool_global_id(TOOLING_PROVIDER_PEER_ID, "core.retired.tool"),
        availability="removed",
        reason_code="removed_by_provider",
        last_schema_hash=compute_tool_schema_hash(alternate_tool),
    )
    digest_page_peer_id = "peer-\u2603"
    digest_page_service_instance_id = "local:peer-%E2%98%83:Tooling"
    digest_page_tool = digest_tool.model_copy(
        update={
            "global_tool_id": canonical_tool_global_id(
                digest_page_peer_id, digest_tool.tool_contract_id
            ),
            "provider_peer_id": digest_page_peer_id,
            "provider_service_instance_id": digest_page_service_instance_id,
            "provenance": digest_tool.provenance.model_copy(
                update={
                    "provider_peer_id": digest_page_peer_id,
                    "provider_service_instance_id": digest_page_service_instance_id,
                }
            ),
        }
    )
    page_final_checksum = compute_projection_checksum([digest_page_tool], [], [])
    digest_page = ToolingGetExportCatalogResponse(
        provider_peer_id=digest_page_peer_id,
        service_instance_id=digest_page_service_instance_id,
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=2,
            export_policy_revision=3,
            auth_grant_revision=5,
            manifest_revision=7,
            switch_revision=11,
            protocol_revision=13,
        ),
        projection_revision="projection-\u2603",
        projection_digest=page_final_checksum,
        page_index=0,
        page_size=1,
        page_hash="0" * 64,
        tools=[digest_page_tool],
        blocked_tools=[],
        retirements=[],
        complete=True,
        total_count=1,
        final_checksum=page_final_checksum,
    )
    digest_page = digest_page.model_copy(
        update={"page_hash": compute_projection_page_hash(digest_page)}
    )
    hostile_identity_cases = [
        ("peer/slash", "core.tool/slash"),
        ("peer space", "core.tool space"),
        ("peer \u2603", "core.tool \u2603"),
        ("peer%percent", "core.tool%percent"),
        ("peer!bang", "core.tool!bang"),
        ("peer'quote", "core.tool'quote"),
        ("peer(paren)", "core.tool(paren)"),
        ("peer*star", "core.tool*star"),
    ]
    digest_vectors = {
        "canonical_tool_identity": {
            "stable_peer_id": "peer \u2603",
            "tool_contract_id": "core.memory/upsert \u2603",
            "global_tool_id": canonical_tool_global_id("peer \u2603", "core.memory/upsert \u2603"),
        },
        "canonical_tool_identity_cases": [
            {
                "stable_peer_id": peer_id,
                "tool_contract_id": tool_contract_id,
                "global_tool_id": canonical_tool_global_id(peer_id, tool_contract_id),
            }
            for peer_id, tool_contract_id in hostile_identity_cases
        ],
        "canonical_digest_cases": [
            {
                "name": "reordered_nested",
                "canonical_a": {"zeta": [3, {"snow": "\u2603", "bang": "!"}], "alpha": {}},
                "canonical_b": {"alpha": {}, "zeta": [3, {"bang": "!", "snow": "\u2603"}]},
                "digest": canonical_digest(
                    {"zeta": [3, {"snow": "\u2603", "bang": "!"}], "alpha": {}}
                ),
            },
            {
                "name": "empty_projection",
                "canonical_a": {"tools": [], "blocked_tools": [], "retirements": []},
                "canonical_b": {"retirements": [], "tools": [], "blocked_tools": []},
                "digest": canonical_digest({"retirements": [], "tools": [], "blocked_tools": []}),
            },
        ],
        "identity_digest": {
            "reordered_json_a": (
                '{"provider_peer_id":"peer-\u2603",'
                '"service_instance_id":"local:peer-%E2%98%83:Tooling"}'
            ),
            "reordered_json_b": (
                '{"service_instance_id":"local:peer-%E2%98%83:Tooling",'
                '"provider_peer_id":"peer-\u2603"}'
            ),
            "canonical_a": {
                "provider_peer_id": "peer-\u2603",
                "service_instance_id": "local:peer-%E2%98%83:Tooling",
            },
            "canonical_b": {
                "service_instance_id": "local:peer-%E2%98%83:Tooling",
                "provider_peer_id": "peer-\u2603",
            },
            "digest": canonical_digest(
                {
                    "service_instance_id": "local:peer-%E2%98%83:Tooling",
                    "provider_peer_id": "peer-\u2603",
                }
            ),
        },
        "schema_digest": {
            "reordered_json_a": '{"type":"object","properties":{"\u2603":{"type":"string"}}}',
            "reordered_json_b": '{"properties":{"\u2603":{"type":"string"}},"type":"object"}',
            "canonical_a": {"type": "object", "properties": {"\u2603": {"type": "string"}}},
            "canonical_b": {"properties": {"\u2603": {"type": "string"}}, "type": "object"},
            "digest": canonical_digest(
                {"properties": {"\u2603": {"type": "string"}}, "type": "object"}
            ),
        },
        "tool_schema_hash": {
            "canonical_tool": digest_tool.model_dump(mode="json"),
            "digest": compute_tool_schema_hash(digest_tool),
        },
        "page_hash": {
            "canonical_page": digest_page.model_dump(mode="json"),
            "digest": compute_projection_page_hash(digest_page),
        },
        "final_checksum": {
            "canonical_tools": [digest_page_tool.model_dump(mode="json")],
            "canonical_retirements": [],
            "canonical_blocked_tools": [],
            "digest": page_final_checksum,
        },
        "order_independent_final_checksum": {
            "canonical_tools": [
                alternate_tool.model_dump(mode="json"),
                digest_tool.model_dump(mode="json"),
            ],
            "canonical_retirements": [retirement.model_dump(mode="json")],
            "canonical_blocked_tools": [blocked_tool.model_dump(mode="json")],
            "digest": compute_projection_checksum(
                [alternate_tool, digest_tool], [retirement], [blocked_tool]
            ),
        },
    }
    return {
        "artifact": "tooling_local_provider_v1",
        "version": 1,
        **projection,
        "canonical_digest_vectors": digest_vectors,
        "projection_page_hash": sha256_json(projection),
        "final_checksum": sha256_json({"version": 1, **projection}),
    }


def _sdk_zod_version() -> str:
    package_path = REPO_ROOT / "packages/aurora-sdk/package.json"
    package = json.loads(package_path.read_text())
    zod_version = (package.get("dependencies") or {}).get("zod")
    if not isinstance(zod_version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", zod_version):
        raise ValueError("packages/aurora-sdk must pin zod to an exact semver version")
    return zod_version


def _major_minor_version(value: str) -> str:
    match = re.match(r"^(\d+)\.(\d+)", value)
    if match is None:
        raise ValueError(f"Expected semantic major.minor version, got {value!r}")
    return f"{match.group(1)}.{match.group(2)}"


def _major_version(value: str) -> str:
    match = re.match(r"^(\d+)", value)
    if match is None:
        raise ValueError(f"Expected semantic major version, got {value!r}")
    return match.group(1)


def build_sdk_manifest(
    *,
    contract_schema: dict[str, Any],
    zod_source: str,
    provider_inventory: dict[str, Any],
) -> dict[str, Any]:
    source_paths = [
        REPO_ROOT / "scripts/generate_backend_inventory.py",
        REPO_ROOT / "scripts/sdk_zod_codegen.py",
    ]
    source_hash = sha256_json(
        {str(path.relative_to(REPO_ROOT)): sha256_text(path.read_text()) for path in source_paths}
    )
    content_hashes = {
        "backend-contracts.schema.json": sha256_json(contract_schema),
        "backend-contracts.zod.ts": sha256_text(zod_source),
        "tooling-local-provider-v1.json": sha256_json(provider_inventory),
    }
    return {
        "artifact": "aurora-sdk-backend-contracts-manifest",
        "schema_draft": contract_schema["schema_draft"],
        "python_version": _major_minor_version(sys.version.split()[0]),
        "pydantic_version": _major_version(PYDANTIC_VERSION),
        "zod_version": _sdk_zod_version(),
        "generator_format_version": GENERATOR_FORMAT_VERSION,
        "generator_source_hash": source_hash,
        "allowlist_hash": contract_schema["allowlist_hash"],
        "tooling_provider_allowlist_hash": contract_schema["tooling_provider_allowlist_hash"],
        "content_hashes": content_hashes,
        "final_checksum": sha256_json(content_hashes),
    }


def _replace_path(source: Path, target: Path) -> None:
    source.replace(target)


def _promotion_backup_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.bak")


def _promotion_tmp_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.tmp")


def _verify_staged_outputs(staged_outputs: list[tuple[Path, Path, str]]) -> None:
    for _target, tmp_path, expected_hash in staged_outputs:
        if sha256_text(tmp_path.read_text(encoding="utf-8")) != expected_hash:
            raise ValueError(f"staged output hash mismatch: {_rel(tmp_path)}")


def _promote_staged_outputs(staged_outputs: list[tuple[Path, Path, str]]) -> None:
    backups: list[tuple[Path, Path]] = []
    promoted: list[Path] = []
    cleanup_backups = False
    try:
        for target_path, tmp_path, _expected_hash in staged_outputs:
            backup_path = _promotion_backup_path(target_path)
            if backup_path.exists():
                raise FileExistsError(f"stale SDK generation backup exists: {_rel(backup_path)}")
            if target_path.exists():
                _replace_path(target_path, backup_path)
                backups.append((target_path, backup_path))
            _replace_path(tmp_path, target_path)
            promoted.append(target_path)
        for _target_path, backup_path in backups:
            with contextlib.suppress(FileNotFoundError):
                backup_path.unlink()
        cleanup_backups = True
    except Exception:
        rollback_complete = False
        for target_path in reversed(promoted):
            with contextlib.suppress(FileNotFoundError):
                target_path.unlink()
        for target_path, backup_path in reversed(backups):
            if backup_path.exists():
                _replace_path(backup_path, target_path)
        rollback_complete = True
        cleanup_backups = rollback_complete
        raise
    finally:
        for target_path, tmp_path, _expected_hash in staged_outputs:
            with contextlib.suppress(FileNotFoundError):
                tmp_path.unlink()
            if not cleanup_backups:
                continue
            backup_path = _promotion_backup_path(target_path)
            with contextlib.suppress(FileNotFoundError):
                backup_path.unlink()


def write_sdk_contract_outputs(
    *,
    schema_output: Path,
    zod_output: Path,
    manifest_output: Path,
    tooling_provider_output: Path,
) -> None:
    contract_schema = build_sdk_contract_schema()
    zod_source = render_zod_module(contract_schema)
    provider_inventory = build_tooling_local_provider(contract_schema)
    manifest = build_sdk_manifest(
        contract_schema=contract_schema,
        zod_source=zod_source,
        provider_inventory=provider_inventory,
    )
    outputs = (
        (
            schema_output,
            json.dumps(contract_schema, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        ),
        (zod_output, zod_source),
        (
            manifest_output,
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        ),
        (
            tooling_provider_output,
            json.dumps(provider_inventory, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        ),
    )
    staged_outputs: list[tuple[Path, Path, str]] = []
    try:
        for path, source in outputs:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = _promotion_tmp_path(path)
            tmp_path.write_text(source, encoding="utf-8")
            staged_outputs.append((path, tmp_path, sha256_text(source)))
        _verify_staged_outputs(staged_outputs)
        _promote_staged_outputs(staged_outputs)
    finally:
        for _target_path, tmp_path, _expected_hash in staged_outputs:
            with contextlib.suppress(FileNotFoundError):
                tmp_path.unlink()


def build_inventory() -> dict[str, Any]:
    methods, import_errors = build_method_inventory()
    gateway_builtins = build_gateway_builtins()
    gateway_openapi = build_gateway_openapi()
    return {
        "generated_by": "scripts/generate_backend_inventory.py",
        "method_count": len(methods),
        "gateway_builtin_count": len(gateway_builtins),
        "methods": methods,
        "gateway_builtins": gateway_builtins,
        "gateway_openapi": gateway_openapi,
        "gateway_openapi_paths": sorted(gateway_openapi["paths"].keys()),
        "import_errors": import_errors,
        "ui_fixture_validation": validate_ui_fixture_references(methods, gateway_builtins),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write inventory JSON to this path")
    parser.add_argument(
        "--sdk-schema-output",
        type=Path,
        help="Write normalized SDK backend contract schema JSON",
    )
    parser.add_argument(
        "--sdk-zod-output",
        type=Path,
        help="Write generated SDK Zod contract module",
    )
    parser.add_argument(
        "--sdk-manifest-output",
        type=Path,
        help="Write generated SDK backend contract manifest JSON",
    )
    parser.add_argument(
        "--sdk-tooling-provider-output",
        type=Path,
        help="Write generated local Tooling provider inventory JSON",
    )
    parser.add_argument(
        "--fail-on-ui-fixture-errors",
        action="store_true",
        help="Exit non-zero when UI fixture references are missing or mismatched",
    )
    args = parser.parse_args()

    if args.output and args.output.resolve() == SECURITY_SURFACE_INVENTORY_PATH.resolve():
        parser.error(
            "the mesh security surface inventory uses a different checked schema; "
            "update it through its dedicated contract workflow"
        )

    inventory = build_inventory()
    rendered = json.dumps(inventory, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(rendered + "\n")
    else:
        print(rendered)

    sdk_outputs = [
        args.sdk_schema_output,
        args.sdk_zod_output,
        args.sdk_manifest_output,
        args.sdk_tooling_provider_output,
    ]
    if any(sdk_outputs):
        write_sdk_contract_outputs(
            schema_output=args.sdk_schema_output or DEFAULT_SDK_SCHEMA_OUTPUT,
            zod_output=args.sdk_zod_output or DEFAULT_SDK_ZOD_OUTPUT,
            manifest_output=args.sdk_manifest_output or DEFAULT_SDK_MANIFEST_OUTPUT,
            tooling_provider_output=args.sdk_tooling_provider_output
            or DEFAULT_SDK_TOOLING_PROVIDER_OUTPUT,
        )

    if args.fail_on_ui_fixture_errors and not inventory["ui_fixture_validation"]["ok"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
