#!/usr/bin/env python3
"""Generate Aurora SDK Zod validators from normalized Pydantic JSON Schema.

The compiler is intentionally constrained. Unsupported constructs raise with
contract, direction, model, and JSON Pointer context instead of producing a
permissive fallback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import keyword
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GENERATOR_FORMAT_VERSION = "aurora-sdk-zod-codegen-v1"
SUPPORTED_STRING_FORMATS = {
    "date",
    "date-time",
    "time",
    "duration",
    "email",
    "hostname",
    "ipv4",
    "ipv6",
    "uri",
    "uuid",
    "binary",
}
JSON_VALUE_MARKER = "x-aurora-json-value"
STRING_TRIMMED_MARKER = "x-aurora-string-trimmed"
STRING_NON_BLANK_MARKER = "x-aurora-string-non-blank"
PROJECTION_PAGE_TERMINATION_MARKER = "x-aurora-projection-page-termination"
PROJECTION_IDENTITY_MARKER = "x-aurora-projection-identity"
UNIQUE_STRING_ARRAY_NORMALIZE_MARKER = "x-aurora-unique-string-array-normalize"
BOUNDED_NONBLANK_STRING_SET_MARKER = "x-aurora-bounded-nonblank-string-set-normalize"
SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER = "x-aurora-speech-language-string-normalize"
SPEECH_LANGUAGE_AUTO_NULL_MARKER = "x-aurora-speech-language-auto-null"
SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER = "x-aurora-speech-language-array-normalize"
LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER = "x-aurora-logical-voice-array-normalize"
TTS_OPERATION_ID_MARKER = "x-aurora-tts-operation-id"
ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER = "x-aurora-route-explain-no-raw-payload"
ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER = "x-aurora-route-explain-selector-fields"
ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER = "x-aurora-route-explain-speech-no-raw-payload"
SPEECH_LANGUAGE_REQUIREMENT_MARKER = "x-aurora-speech-language-requirement"
SPEECH_LOCALE_FALLBACK_MARKER = "x-aurora-speech-locale-fallback"
SPEECH_METHOD_CONSTRAINTS_MARKER = "x-aurora-speech-method-constraints"
TTS_CAPABILITIES_INVARIANT_MARKER = "x-aurora-tts-capabilities-invariant"
TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER = "x-aurora-tts-voice-descriptor-invariant"
TTS_VOICE_LIST_INVARIANT_MARKER = "x-aurora-tts-voice-list-invariant"
TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER = "x-aurora-tts-profile-descriptor-invariant"
TTS_PROFILE_LIST_INVARIANT_MARKER = "x-aurora-tts-profile-list-invariant"
TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER = "x-aurora-tts-get-profile-response-invariant"
TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER = "x-aurora-tts-update-profile-patch-invariant"
TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER = "x-aurora-tts-create-profile-response-invariant"
TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER = "x-aurora-tts-delete-profile-request-invariant"
TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER = "x-aurora-tts-delete-profile-response-invariant"
TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER = "x-aurora-tts-profile-mutation-response-invariant"
TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER = "x-aurora-tts-import-start-response-invariant"
TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER = "x-aurora-tts-import-chunk-request-invariant"
TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER = "x-aurora-tts-import-chunk-response-invariant"
TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER = "x-aurora-tts-audio-chunk-event-invariant"
STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER = "x-aurora-stt-transcribe-language-shape"
METADATA_KEYS = {
    "$schema",
    "title",
    "description",
    "default",
    "examples",
    JSON_VALUE_MARKER,
    STRING_TRIMMED_MARKER,
    STRING_NON_BLANK_MARKER,
    PROJECTION_PAGE_TERMINATION_MARKER,
    PROJECTION_IDENTITY_MARKER,
    UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
    BOUNDED_NONBLANK_STRING_SET_MARKER,
    SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER,
    SPEECH_LANGUAGE_AUTO_NULL_MARKER,
    SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER,
    LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER,
    TTS_OPERATION_ID_MARKER,
    ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER,
    ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER,
    ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER,
    SPEECH_LANGUAGE_REQUIREMENT_MARKER,
    SPEECH_LOCALE_FALLBACK_MARKER,
    SPEECH_METHOD_CONSTRAINTS_MARKER,
    TTS_CAPABILITIES_INVARIANT_MARKER,
    TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER,
    TTS_VOICE_LIST_INVARIANT_MARKER,
    TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER,
    TTS_PROFILE_LIST_INVARIANT_MARKER,
    TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER,
    TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER,
    TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER,
    TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER,
    TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER,
    TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
    TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER,
    TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER,
    TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER,
    TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
    STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER,
    "x-aurora-extra-behavior",
}
PYTHON_ONLY_REGEX_TOKENS = (
    r"\A",
    r"\Z",
    r"\G",
    "(?P<",
    "(?P=",
    "(?#",
    "(?(",
)


class UnsupportedSchemaError(ValueError):
    """Raised when a schema cannot be represented losslessly in generated Zod."""


@dataclass(frozen=True)
class CompileContext:
    method_id: str
    direction: str
    model_name: str
    pointer: str = "#"

    def at(self, token: str | int) -> CompileContext:
        escaped = str(token).replace("~", "~0").replace("/", "~1")
        return CompileContext(
            method_id=self.method_id,
            direction=self.direction,
            model_name=self.model_name,
            pointer=f"{self.pointer}/{escaped}",
        )

    def unsupported(self, reason: str) -> UnsupportedSchemaError:
        return UnsupportedSchemaError(
            f"{self.method_id} {self.direction} {self.model_name} {self.pointer}: {reason}"
        )


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_text(canonical_json(value))


def schema_symbol(schema_id: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", schema_id)
    stem = "".join(part[:1].upper() + part[1:] for part in parts if part)
    if not stem:
        stem = "Schema"
    if stem[0].isdigit():
        stem = f"Schema{stem}"
    return f"{stem}Schema"


def type_symbol(schema_id: str) -> str:
    symbol = schema_symbol(schema_id)
    return symbol[:-6] if symbol.endswith("Schema") else f"{symbol}Type"


def _identifier(name: str) -> str:
    candidate = re.sub(r"[^A-Za-z0-9_$]", "_", name)
    if not candidate or candidate[0].isdigit() or keyword.iskeyword(candidate):
        candidate = f"_{candidate}"
    return candidate


def _ts_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _is_json_primitive(value: Any) -> bool:
    return (
        isinstance(value, str)
        or type(value) is bool
        or value is None
        or (isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value))
    )


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _is_json_value(value: Any) -> bool:
    if _is_json_primitive(value):
        return True
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


def _is_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _literal(value: Any, ctx: CompileContext) -> str:
    if not _is_json_primitive(value):
        raise ctx.unsupported("literal value must be a finite JSON primitive")
    return f"z.literal({_ts_string(value) if isinstance(value, str) else canonical_json(value)})"


def _sorted_schema(value: Any) -> Any:
    if isinstance(value, dict):
        sorted_value = {key: _sorted_schema(value[key]) for key in sorted(value)}
        if isinstance(sorted_value.get("required"), list):
            sorted_value["required"] = sorted(sorted_value["required"])
        if isinstance(sorted_value.get("enum"), list):
            items = sorted_value["enum"]
            if all(isinstance(item, (str, int, float, bool, type(None))) for item in items):
                sorted_value["enum"] = sorted(items, key=lambda item: canonical_json(item))
        return sorted_value
    if isinstance(value, list):
        return [_sorted_schema(item) for item in value]
    return value


def normalize_schema(schema: dict[str, Any]) -> dict[str, Any]:
    normalized = _sorted_schema(schema)
    if not isinstance(normalized, dict):
        raise TypeError("schema must normalize to an object")
    normalized.setdefault("$schema", "https://json-schema.org/draft/2020-12/schema")
    return normalized


class ZodCompiler:
    def __init__(self, schema: dict[str, Any], *, ctx: CompileContext, symbol_prefix: str) -> None:
        self.schema = schema
        self.ctx = ctx
        self.def_symbols: dict[str, str] = {}
        for name in sorted(schema.get("$defs") or {}):
            self.def_symbols[f"#/$defs/{name}"] = f"{symbol_prefix}{schema_symbol(name)}Def"

    def compile_root(self) -> tuple[list[str], str]:
        self._validate_refs_and_cycles()
        lines: list[str] = []
        defs = self.schema.get("$defs") or {}
        for name in sorted(defs):
            ref = f"#/$defs/{name}"
            symbol = self.def_symbols[ref]
            expression = self._compile(defs[name], self.ctx.at("$defs").at(name))
            lines.append(f"const {symbol}: z.ZodType<JsonValue> = z.lazy(() => {expression})")
            lines.append("")
        root = {key: value for key, value in self.schema.items() if key not in {"$defs", "$schema"}}
        return lines, self._compile(root, self.ctx)

    def _validate_refs_and_cycles(self) -> None:
        defs = self.schema.get("$defs") or {}
        if not isinstance(defs, dict):
            raise self.ctx.at("$defs").unsupported("$defs must be an object")

        def walk(node: Any, ctx: CompileContext, stack: tuple[str, ...]) -> None:
            if isinstance(node, list):
                for index, item in enumerate(node):
                    walk(item, ctx.at(index), stack)
                return
            if not isinstance(node, dict):
                return
            ref = node.get("$ref")
            if ref is not None:
                if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
                    raise ctx.at("$ref").unsupported(f"unsupported reference {ref!r}")
                if ref not in self.def_symbols:
                    raise ctx.at("$ref").unsupported(f"unknown reference {ref!r}")
                if ref in stack:
                    cycle = " -> ".join((*stack, ref))
                    raise ctx.at("$ref").unsupported(f"recursive reference cycle {cycle}")
                name = ref.removeprefix("#/$defs/")
                walk(defs[name], self.ctx.at("$defs").at(name), (*stack, ref))
                return
            for key, value in node.items():
                walk(value, ctx.at(key), stack)

        for name in sorted(defs):
            ref = f"#/$defs/{name}"
            walk(defs[name], self.ctx.at("$defs").at(name), (ref,))
        root = {key: value for key, value in self.schema.items() if key not in {"$defs", "$schema"}}
        walk(root, self.ctx, ())

    def _compile(self, schema: Any, ctx: CompileContext) -> str:
        if not isinstance(schema, dict):
            raise ctx.unsupported("schema node must be an object")
        self._validate_supported_keywords(schema, ctx)
        if "$ref" in schema:
            ref = schema["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
                raise ctx.unsupported(f"unsupported reference {ref!r}")
            symbol = self.def_symbols.get(ref)
            if symbol is None:
                raise ctx.unsupported(f"unknown reference {ref!r}")
            return self._apply_default(symbol, schema, ctx)
        if schema.get(JSON_VALUE_MARKER) is True:
            if set(schema) != {JSON_VALUE_MARKER}:
                raise ctx.unsupported(
                    "JSON value marker cannot be combined with other schema keywords"
                )
            return self._apply_default("auroraJsonValueSchema", schema, ctx)
        if schema == {}:
            raise ctx.unsupported("bare empty schema requires explicit JSON value marker")
        if "const" in schema:
            return self._apply_default(_literal(schema["const"], ctx.at("const")), schema, ctx)
        if "enum" in schema:
            return self._apply_default(
                self._compile_enum(schema["enum"], ctx.at("enum")), schema, ctx
            )
        for union_key in ("anyOf", "oneOf"):
            if union_key in schema:
                return self._apply_default(
                    self._compile_union(schema, union_key, ctx.at(union_key)), schema, ctx
                )
        schema_type = schema.get("type")
        if isinstance(schema_type, list):
            if len(schema_type) == 2 and "null" in schema_type:
                other = next(item for item in schema_type if item != "null")
                narrowed = {key: value for key, value in schema.items() if key != "type"}
                narrowed["type"] = other
                return f"{self._compile(narrowed, ctx)}.nullable()"
            raise ctx.unsupported(f"unsupported multi-type schema {schema_type!r}")
        if schema_type == "object" or "properties" in schema:
            return self._apply_default(self._compile_object(schema, ctx), schema, ctx)
        if schema_type == "array":
            return self._apply_default(self._compile_array(schema, ctx), schema, ctx)
        if schema_type == "string":
            return self._apply_default(self._compile_string(schema, ctx), schema, ctx)
        if schema_type == "integer":
            return self._apply_default(self._compile_number(schema, ctx, integer=True), schema, ctx)
        if schema_type == "number":
            return self._apply_default(
                self._compile_number(schema, ctx, integer=False), schema, ctx
            )
        if schema_type == "boolean":
            return self._apply_default("z.boolean()", schema, ctx)
        if schema_type == "null":
            return self._apply_default("z.null()", schema, ctx)
        raise ctx.unsupported(f"unsupported schema type {schema_type!r}")

    def _validate_supported_keywords(self, schema: dict[str, Any], ctx: CompileContext) -> None:
        self._validate_marker_placement(schema, ctx)
        if schema.get(JSON_VALUE_MARKER) is True:
            allowed = {JSON_VALUE_MARKER}
        elif "$ref" in schema:
            allowed = {"$ref"}
        elif "const" in schema:
            allowed = {"const", "type"}
        elif "enum" in schema:
            allowed = {"enum", "type"}
        elif "anyOf" in schema or "oneOf" in schema:
            allowed = {"anyOf", "oneOf", "discriminator"}
        else:
            schema_type = schema.get("type")
            if isinstance(schema_type, list):
                allowed = {"type"}
            elif schema_type == "object" or "properties" in schema:
                allowed = {"type", "properties", "required", "additionalProperties"}
            elif schema_type == "array":
                allowed = {"type", "items", "minItems", "maxItems"}
            elif schema_type == "string":
                allowed = {
                    "type",
                    "minLength",
                    "maxLength",
                    "pattern",
                    "format",
                    "contentEncoding",
                }
            elif schema_type in {"integer", "number"}:
                allowed = {
                    "type",
                    "minimum",
                    "exclusiveMinimum",
                    "maximum",
                    "exclusiveMaximum",
                    "multipleOf",
                }
            elif schema_type in {"boolean", "null"}:
                allowed = {"type"}
            else:
                allowed = {"type"}
        unsupported = sorted(set(schema) - allowed - METADATA_KEYS)
        if unsupported:
            raise ctx.at(unsupported[0]).unsupported(
                f"unsupported schema keyword {unsupported[0]!r}"
            )

    def _validate_marker_placement(self, schema: dict[str, Any], ctx: CompileContext) -> None:
        if JSON_VALUE_MARKER in schema:
            if schema.get(JSON_VALUE_MARKER) is not True:
                raise ctx.at(JSON_VALUE_MARKER).unsupported(
                    "JSON value marker must be literal true"
                )
            if set(schema) != {JSON_VALUE_MARKER}:
                raise ctx.at(JSON_VALUE_MARKER).unsupported(
                    "JSON value marker cannot be combined with other schema keywords"
                )
            return
        for marker in (STRING_TRIMMED_MARKER, STRING_NON_BLANK_MARKER, TTS_OPERATION_ID_MARKER):
            if marker in schema:
                if schema.get(marker) is not True:
                    raise ctx.at(marker).unsupported(f"{marker} must be literal true")
                if schema.get("type") != "string":
                    raise ctx.at(marker).unsupported(f"{marker} only applies to string schemas")
        for marker in (
            SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER,
            SPEECH_LANGUAGE_AUTO_NULL_MARKER,
        ):
            if marker not in schema:
                continue
            if schema.get(marker) is not True:
                raise ctx.at(marker).unsupported(f"{marker} must be literal true")
            options = schema.get("anyOf") or schema.get("oneOf") or ()
            string_like = schema.get("type") == "string" or (
                isinstance(schema.get("enum"), list)
                and bool(schema["enum"])
                and all(isinstance(item, str) for item in schema["enum"])
            )
            nullable_string_like = bool(options) and any(
                isinstance(option, dict)
                and (
                    option.get("type") == "string"
                    or (
                        isinstance(option.get("enum"), list)
                        and bool(option["enum"])
                        and all(isinstance(item, str) for item in option["enum"])
                    )
                )
                for option in options
            )
            if not string_like and not nullable_string_like:
                raise ctx.at(marker).unsupported(
                    f"{marker} only applies to string or nullable string schemas"
                )
        for marker in (
            UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
            BOUNDED_NONBLANK_STRING_SET_MARKER,
            SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER,
            LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER,
        ):
            if marker not in schema:
                continue
            if schema.get(marker) is not True:
                raise ctx.at(marker).unsupported(f"{marker} must be literal true")
            items = schema.get("items")
            if (
                schema.get("type") != "array"
                or not isinstance(items, dict)
                or items.get("type") != "string"
            ):
                raise ctx.at(marker).unsupported(f"{marker} only applies to string arrays")
        for marker in (PROJECTION_PAGE_TERMINATION_MARKER, PROJECTION_IDENTITY_MARKER):
            if marker not in schema:
                continue
            if schema.get(marker) is not True:
                raise ctx.at(marker).unsupported(f"{marker} must be literal true")
            properties = schema.get("properties")
            required_fields = (
                {
                    "provider_peer_id",
                    "service_instance_id",
                    "tools",
                    "blocked_tools",
                }
                if marker == PROJECTION_IDENTITY_MARKER
                else {
                    "complete",
                    "final_checksum",
                    "next_cursor",
                    "total_count",
                }
            )
            if (
                schema.get("type") != "object"
                or not isinstance(properties, dict)
                or not required_fields.issubset(properties)
            ):
                raise ctx.at(marker).unsupported(f"{marker} only applies to export page objects")
        route_markers = (
            ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER,
            ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER,
            ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER,
            SPEECH_LANGUAGE_REQUIREMENT_MARKER,
            SPEECH_LOCALE_FALLBACK_MARKER,
            SPEECH_METHOD_CONSTRAINTS_MARKER,
            TTS_CAPABILITIES_INVARIANT_MARKER,
            TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER,
            TTS_VOICE_LIST_INVARIANT_MARKER,
            TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER,
            TTS_PROFILE_LIST_INVARIANT_MARKER,
            TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER,
            TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER,
            TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER,
            TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER,
            TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER,
            TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
            TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER,
            TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER,
            TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER,
            TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
            STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER,
        )
        for marker in route_markers:
            if marker not in schema:
                continue
            if schema.get(marker) is not True:
                raise ctx.at(marker).unsupported(f"{marker} must be literal true")
            if schema.get("type") != "object" or not isinstance(schema.get("properties"), dict):
                raise ctx.at(marker).unsupported(f"{marker} only applies to object schemas")

    def _apply_default(self, expression: str, schema: dict[str, Any], ctx: CompileContext) -> str:
        if "default" in schema:
            default = schema["default"]
            if not _is_json_value(default):
                raise ctx.at("default").unsupported("default must be a finite JSON value")
            expression = f"{expression}.prefault({canonical_json(default)})"
        options = schema.get("anyOf") or schema.get("oneOf") or ()
        nullable = any(
            isinstance(option, dict) and option.get("type") == "null" for option in options
        )
        if schema.get(SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER) is True:
            expression = (
                "z.preprocess((value) => normalizeSpeechLanguageValue(value, false, "
                f"{str(nullable).lower()}), {expression})"
            )
        if schema.get(SPEECH_LANGUAGE_AUTO_NULL_MARKER) is True:
            expression = (
                "z.preprocess((value) => normalizeSpeechLanguageValue(value, true, true), "
                f"{expression})"
            )
        return self._apply_metadata(expression, schema)

    def _apply_metadata(self, expression: str, schema: dict[str, Any]) -> str:
        metadata = {
            key: schema[key]
            for key in (
                "default",
                JSON_VALUE_MARKER,
                STRING_TRIMMED_MARKER,
                STRING_NON_BLANK_MARKER,
                PROJECTION_PAGE_TERMINATION_MARKER,
                UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
                BOUNDED_NONBLANK_STRING_SET_MARKER,
                SPEECH_LANGUAGE_STRING_NORMALIZE_MARKER,
                SPEECH_LANGUAGE_AUTO_NULL_MARKER,
                SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER,
                LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER,
                TTS_OPERATION_ID_MARKER,
                ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER,
                ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER,
                ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER,
                SPEECH_LANGUAGE_REQUIREMENT_MARKER,
                SPEECH_LOCALE_FALLBACK_MARKER,
                SPEECH_METHOD_CONSTRAINTS_MARKER,
                TTS_CAPABILITIES_INVARIANT_MARKER,
                TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER,
                TTS_VOICE_LIST_INVARIANT_MARKER,
                TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER,
                TTS_PROFILE_LIST_INVARIANT_MARKER,
                TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER,
                TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER,
                TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER,
                TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER,
                TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER,
                TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
                TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER,
                TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER,
                TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER,
                TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER,
                STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER,
                "x-aurora-extra-behavior",
                PROJECTION_IDENTITY_MARKER,
            )
            if key in schema
        }
        if not metadata:
            return expression
        return f"{expression}.meta({canonical_json(metadata)})"

    def _compile_enum(self, values: Any, ctx: CompileContext) -> str:
        if not isinstance(values, list) or not values:
            raise ctx.unsupported("enum must be a non-empty list")
        for index, value in enumerate(values):
            if not _is_json_primitive(value):
                raise ctx.at(index).unsupported("enum value must be a finite JSON primitive")
        if all(isinstance(value, str) for value in values):
            return f"z.enum([{', '.join(_ts_string(value) for value in values)}])"
        literals = [_literal(value, ctx.at(index)) for index, value in enumerate(values)]
        return f"z.union([{', '.join(literals)}])"

    def _compile_union(self, schema: dict[str, Any], key: str, ctx: CompileContext) -> str:
        options = schema[key]
        if not isinstance(options, list) or not options:
            raise ctx.unsupported(f"{key} must be a non-empty list")
        null_index = next(
            (
                index
                for index, item in enumerate(options)
                if isinstance(item, dict) and item.get("type") == "null"
            ),
            None,
        )
        if null_index is not None and len(options) == 2:
            other = options[1 - null_index]
            return f"{self._compile(other, ctx.at(1 - null_index))}.nullable()"
        if all(isinstance(item, dict) and "const" in item for item in options):
            return f"z.union([{', '.join(self._compile(item, ctx.at(index)) for index, item in enumerate(options))}])"
        discriminator = schema.get("discriminator", {}).get("propertyName")
        if discriminator:
            self._validate_discriminated_union_options(options, discriminator, ctx)
            compiled = ", ".join(
                self._compile(item, ctx.at(index)) for index, item in enumerate(options)
            )
            return f"z.discriminatedUnion({_ts_string(discriminator)}, [{compiled}])"
        raise ctx.unsupported(f"unsupported ambiguous {key}")

    def _validate_discriminated_union_options(
        self, options: list[Any], discriminator: Any, ctx: CompileContext
    ) -> None:
        if not isinstance(discriminator, str) or not discriminator:
            raise ctx.unsupported("discriminator propertyName must be a non-empty string")
        seen: set[Any] = set()
        for index, item in enumerate(options):
            option_ctx = ctx.at(index)
            if not isinstance(item, dict):
                raise option_ctx.unsupported("discriminated union option must be an object schema")
            if item.get("type") != "object" and "properties" not in item:
                raise option_ctx.unsupported("discriminated union option must be an object schema")
            required = item.get("required") or []
            if discriminator not in required:
                raise option_ctx.at("required").unsupported(
                    "discriminator field must be required in every option"
                )
            properties = item.get("properties") or {}
            if not isinstance(properties, dict) or discriminator not in properties:
                raise option_ctx.at("properties").unsupported(
                    "discriminator field must be declared in every option"
                )
            disc_schema = properties[discriminator]
            if not isinstance(disc_schema, dict):
                raise (
                    option_ctx.at("properties")
                    .at(discriminator)
                    .unsupported("discriminator schema must be an object")
                )
            raw_values = (
                [disc_schema["const"]]
                if "const" in disc_schema
                else disc_schema.get("enum")
                if "enum" in disc_schema
                else None
            )
            if not isinstance(raw_values, list) or not raw_values:
                raise (
                    option_ctx.at("properties")
                    .at(discriminator)
                    .unsupported("discriminator schema must use const or non-empty enum")
                )
            for value in raw_values:
                if not isinstance(value, str):
                    raise (
                        option_ctx.at("properties")
                        .at(discriminator)
                        .unsupported("discriminator values must be strings")
                    )
                if value in seen:
                    raise (
                        option_ctx.at("properties")
                        .at(discriminator)
                        .unsupported(f"duplicate discriminator value {value!r}")
                    )
                seen.add(value)

    def _compile_object(self, schema: dict[str, Any], ctx: CompileContext) -> str:
        properties = schema.get("properties") or {}
        if not isinstance(properties, dict):
            raise ctx.unsupported("object properties must be an object")
        additional = schema.get("additionalProperties")
        if not properties and (additional is True or additional == {}):
            return "z.record(z.string(), auroraJsonValueSchema)"
        required = schema.get("required") or []
        if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
            raise ctx.unsupported("object required must be a string list")
        required_set = set(required)
        undeclared_required = sorted(required_set - set(properties))
        if undeclared_required:
            raise ctx.at("required").unsupported(
                f"required key {undeclared_required[0]!r} is not declared in properties"
            )
        prop_lines: list[str] = []
        for name in sorted(properties):
            expression = self._compile(properties[name], ctx.at("properties").at(name))
            if name not in required_set:
                expression = f"{expression}.optional()"
            prop_lines.append(f"  {_ts_string(name)}: {expression}")
        body = "{\n" + ",\n".join(prop_lines) + "\n}"
        extra = schema.get("x-aurora-extra-behavior")
        if extra == "forbid" or additional is False:
            constructor = "z.strictObject"
        elif extra == "preserve" or additional is True:
            constructor = "z.looseObject"
        else:
            constructor = "z.object"
        expression = f"{constructor}({body})"
        if isinstance(additional, dict):
            expression = f"{expression}.catchall({self._compile(additional, ctx.at('additionalProperties'))})"
        if schema.get(PROJECTION_PAGE_TERMINATION_MARKER) is True:
            expression = (
                f"{expression}.superRefine((value, ctx) => {{"
                " let invalid = false;"
                " if (value.complete === true) {"
                " if (value.next_cursor !== null && value.next_cursor !== undefined) { invalid = true; ctx.addIssue({ code: 'custom', path: ['next_cursor'], message: 'complete pages cannot carry next_cursor' }); }"
                " if (value.total_count === null || value.total_count === undefined) { invalid = true; ctx.addIssue({ code: 'custom', path: ['total_count'], message: 'complete pages require total_count' }); }"
                " if (value.final_checksum === null || value.final_checksum === undefined) { invalid = true; ctx.addIssue({ code: 'custom', path: ['final_checksum'], message: 'complete pages require final_checksum' }); }"
                " } else {"
                " if (value.next_cursor === null || value.next_cursor === undefined) { invalid = true; ctx.addIssue({ code: 'custom', path: ['next_cursor'], message: 'partial pages require next_cursor' }); }"
                " if (value.total_count !== null && value.total_count !== undefined) { invalid = true; ctx.addIssue({ code: 'custom', path: ['total_count'], message: 'partial pages cannot carry total_count' }); }"
                " if (value.final_checksum !== null && value.final_checksum !== undefined) { invalid = true; ctx.addIssue({ code: 'custom', path: ['final_checksum'], message: 'partial pages cannot carry final_checksum' }); }"
                " }"
                " if (invalid) ctx.addIssue({ code: 'custom', message: 'projection page termination invalid' });"
                "})"
            )
        if schema.get(PROJECTION_IDENTITY_MARKER) is True:
            expression = (
                f"{expression}.superRefine((value, ctx) => {{"
                " const add = (path: Array<string | number>, message: string): void => {"
                " ctx.addIssue({ code: 'custom', path, message });"
                " ctx.addIssue({ code: 'custom', message: 'projection identity invalid' });"
                " };"
                " const providerPeerId = value.provider_peer_id;"
                " const serviceInstanceId = value.service_instance_id;"
                " if (typeof providerPeerId !== 'string' || providerPeerId.length === 0 || codePointLength(providerPeerId) > 160 || providerPeerId !== providerPeerId.trim() || hasControlCharacter(providerPeerId) || hasLoneSurrogate(providerPeerId)) { add(['provider_peer_id'], 'projection provider_peer_id invalid'); return; }"
                " if (typeof serviceInstanceId !== 'string' || serviceInstanceId.length === 0 || codePointLength(serviceInstanceId) > 256 || hasLoneSurrogate(serviceInstanceId)) { add(['service_instance_id'], 'projection service_instance_id invalid'); return; }"
                " const expectedLocal = `local:${percentEncodeRfc3986Utf8ForProjection(providerPeerId)}:Tooling`;"
                " const expectedRemote = `remote:${providerPeerId}:Tooling`;"
                " if (serviceInstanceId !== expectedLocal && serviceInstanceId !== expectedRemote) { add(['service_instance_id'], 'projection service_instance_id does not match provider identity'); return; }"
                " const visibleTools: unknown[] = Array.isArray(value.tools) ? value.tools : [];"
                " const blockedEntries: unknown[] = Array.isArray(value.blocked_tools) ? value.blocked_tools : [];"
                " for (const [index, tool] of visibleTools.entries()) {"
                " if (!isProjectionToolIdentity(tool, providerPeerId, serviceInstanceId)) add(['tools', index], 'projection tool identity invalid');"
                " }"
                " for (const [index, blocked] of blockedEntries.entries()) {"
                " const tool = blocked && typeof blocked === 'object' ? (blocked as Record<string, unknown>).tool : undefined;"
                " if (!isProjectionToolIdentity(tool, providerPeerId, serviceInstanceId)) add(['blocked_tools', index, 'tool'], 'projection tool identity invalid');"
                " }"
                "})"
            )
        if schema.get(ROUTE_EXPLAIN_NO_RAW_PAYLOAD_MARKER) is True:
            expression = (
                f"z.preprocess((value, ctx) => {{"
                " for (const issue of routeExplainRawPayloadIssues(value)) ctx.addIssue(issue);"
                f" return value"
                f"}}, {expression})"
            )
        if schema.get(ROUTE_EXPLAIN_SELECTOR_FIELDS_MARKER) is True:
            expression = (
                f"z.preprocess((value, ctx) => {{"
                " for (const issue of routeExplainSelectorIssues(value)) ctx.addIssue(issue);"
                f" return value"
                f"}}, {expression})"
            )
        if schema.get(ROUTE_EXPLAIN_SPEECH_NO_RAW_PAYLOAD_MARKER) is True:
            expression = (
                f"z.preprocess((value, ctx) => {{"
                " for (const issue of routeExplainSpeechRawPayloadIssues(value)) ctx.addIssue(issue);"
                f" return value"
                f"}}, {expression})"
            )
        if schema.get(SPEECH_LANGUAGE_REQUIREMENT_MARKER) is True:
            expression = (
                f"{expression}.superRefine((value, ctx) => {{"
                " const mode = value.mode;"
                " const language = value.language;"
                " const candidates = Array.isArray(value.auto_language_candidates) ? value.auto_language_candidates : [];"
                " if (mode === 'exact') {"
                " if (language === null || language === undefined) ctx.addIssue({ code: 'custom', path: ['language'], message: 'exact language requirement needs language' });"
                " if (candidates.length > 0) ctx.addIssue({ code: 'custom', path: ['auto_language_candidates'], message: 'exact language requirement cannot include auto candidates' });"
                " } else if (mode === 'auto') {"
                " if (language !== null && language !== undefined) ctx.addIssue({ code: 'custom', path: ['language'], message: 'auto language requirement cannot include exact language' });"
                " }"
                " if (!isSortedStringList(candidates)) ctx.addIssue({ code: 'custom', path: ['auto_language_candidates'], message: 'auto language candidates must be sorted' });"
                " const expectedDigest = speechLanguageRequirementDigest(value);"
                " if (value.digest !== null && value.digest !== undefined && value.digest !== expectedDigest) ctx.addIssue({ code: 'custom', path: ['digest'], message: 'language requirement digest mismatch' });"
                "})"
                ".overwrite((value) => { const normalized = { ...value, auto_language_candidates: Array.isArray(value.auto_language_candidates) ? value.auto_language_candidates : [] }; return { ...normalized, digest: speechLanguageRequirementDigest(normalized) } })"
            )
        if schema.get(SPEECH_LOCALE_FALLBACK_MARKER) is True:
            expression = (
                f"{expression}.superRefine((value, ctx) => {{"
                " if (!isDeclaredSpeechLocaleFallback(value.requested_language, value.served_language)) ctx.addIssue({ code: 'custom', message: 'locale fallback is not declared by the language table' });"
                "})"
            )
        if schema.get(SPEECH_METHOD_CONSTRAINTS_MARKER) is True:
            expression = (
                f"{expression}.overwrite((value) => ({{ ...value,"
                " exact_languages: Array.isArray(value.exact_languages) ? sortUniqueCodePointStrings(value.exact_languages) : value.exact_languages,"
                " auto_detect_languages: Array.isArray(value.auto_detect_languages) ? sortUniqueCodePointStrings(value.auto_detect_languages) : value.auto_detect_languages,"
                " ready_voice_ids: Array.isArray(value.ready_voice_ids) ? sortUniqueCodePointStrings(value.ready_voice_ids) : value.ready_voice_ids,"
                " locale_fallbacks: normalizeSpeechLocaleFallbacks(value.locale_fallbacks)"
                " }))"
                ".superRefine((value, ctx) => {"
                " const exact = Array.isArray(value.exact_languages) ? value.exact_languages : [];"
                " const auto = Array.isArray(value.auto_detect_languages) ? value.auto_detect_languages : [];"
                " const fallbacks = Array.isArray(value.locale_fallbacks) ? value.locale_fallbacks : [];"
                " const voices = Array.isArray(value.ready_voice_ids) ? value.ready_voice_ids : [];"
                " const exactSet = new Set(exact);"
                " if (new Set(exact).size !== exact.length || !isSortedStringList(exact)) ctx.addIssue({ code: 'custom', path: ['exact_languages'], message: 'exact languages must be unique and sorted' });"
                " if (new Set(auto).size !== auto.length || !isSortedStringList(auto)) ctx.addIssue({ code: 'custom', path: ['auto_detect_languages'], message: 'auto detect languages must be unique and sorted' });"
                " if (new Set(voices).size !== voices.length || !isSortedStringList(voices)) ctx.addIssue({ code: 'custom', path: ['ready_voice_ids'], message: 'ready voice ids must be unique and sorted' });"
                " if (value.supports_auto_detect === true) {"
                " if (auto.length < 2) ctx.addIssue({ code: 'custom', path: ['auto_detect_languages'], message: 'auto coverage must contain at least two languages' });"
                " for (const language of auto) if (!exactSet.has(language)) ctx.addIssue({ code: 'custom', path: ['auto_detect_languages'], message: 'auto coverage must be a subset of exact languages' });"
                " } else if (auto.length > 0) ctx.addIssue({ code: 'custom', path: ['auto_detect_languages'], message: 'auto coverage requires supports_auto_detect' });"
                " for (const [index, fallback] of fallbacks.entries()) {"
                " if (fallback && typeof fallback === 'object' && !exactSet.has((fallback as Record<string, unknown>).served_language as string)) ctx.addIssue({ code: 'custom', path: ['locale_fallbacks', index, 'served_language'], message: 'fallback served language must be exact-ready' });"
                " }"
                " if ((exact.length > 0 || fallbacks.length > 0 || voices.length > 0 || value.supports_auto_detect === true) && (value.resident_model_identity_digest === null || value.resident_model_identity_digest === undefined)) ctx.addIssue({ code: 'custom', path: ['resident_model_identity_digest'], message: 'ready speech constraints require a resident model identity' });"
                "})"
            )
        invariant_helpers = (
            (TTS_CAPABILITIES_INVARIANT_MARKER, "validateTtsCapabilitiesInvariant"),
            (TTS_VOICE_DESCRIPTOR_INVARIANT_MARKER, "validateTtsVoiceDescriptorInvariant"),
            (TTS_VOICE_LIST_INVARIANT_MARKER, "validateTtsVoiceListInvariant"),
            (TTS_PROFILE_DESCRIPTOR_INVARIANT_MARKER, "validateTtsProfileDescriptorInvariant"),
            (TTS_PROFILE_LIST_INVARIANT_MARKER, "validateTtsProfileListInvariant"),
            (TTS_GET_PROFILE_RESPONSE_INVARIANT_MARKER, "validateTtsGetProfileResponseInvariant"),
            (TTS_UPDATE_PROFILE_PATCH_INVARIANT_MARKER, "validateTtsUpdateProfilePatchInvariant"),
            (
                TTS_CREATE_PROFILE_RESPONSE_INVARIANT_MARKER,
                "validateTtsCreateProfileResponseInvariant",
            ),
            (
                TTS_DELETE_PROFILE_REQUEST_INVARIANT_MARKER,
                "validateTtsDeleteProfileRequestInvariant",
            ),
            (
                TTS_DELETE_PROFILE_RESPONSE_INVARIANT_MARKER,
                "validateTtsDeleteProfileResponseInvariant",
            ),
            (
                TTS_PROFILE_MUTATION_RESPONSE_INVARIANT_MARKER,
                "validateTtsProfileMutationResponseInvariant",
            ),
            (TTS_IMPORT_START_RESPONSE_INVARIANT_MARKER, "validateTtsImportStartResponseInvariant"),
            (TTS_IMPORT_CHUNK_REQUEST_INVARIANT_MARKER, "validateTtsImportChunkRequestInvariant"),
            (TTS_IMPORT_CHUNK_RESPONSE_INVARIANT_MARKER, "validateTtsImportChunkResponseInvariant"),
            (TTS_AUDIO_CHUNK_EVENT_INVARIANT_MARKER, "validateTtsAudioChunkEventInvariant"),
            (STT_TRANSCRIBE_LANGUAGE_SHAPE_MARKER, "validateSttTranscribeLanguageShape"),
        )
        if schema.get(TTS_CAPABILITIES_INVARIANT_MARKER) is True:
            expression = (
                f"{expression}.overwrite((value) => ({{ ...value,"
                " output_formats: Array.isArray(value.output_formats) ? value.output_formats : ['wav', 'raw'],"
                " sample_rates: Array.isArray(value.sample_rates) ? sortUniqueNumbers(value.sample_rates) : value.sample_rates"
                " }))"
            )
        for marker, helper in invariant_helpers:
            if schema.get(marker) is True:
                expression = f"{expression}.superRefine((value, ctx) => {helper}(value, ctx))"
        return expression

    def _compile_array(self, schema: dict[str, Any], ctx: CompileContext) -> str:
        if isinstance(schema.get("prefixItems"), list):
            raise ctx.unsupported("tuple arrays are unsupported")
        items = schema.get("items")
        if not isinstance(items, dict):
            raise ctx.unsupported("array items must be a single schema")
        expression = f"z.array({self._compile(items, ctx.at('items'))})"
        if "minItems" in schema:
            if not _is_nonnegative_int(schema["minItems"]):
                raise ctx.at("minItems").unsupported("minItems must be a nonnegative integer")
            expression = f"{expression}.min({schema['minItems']})"
        if "maxItems" in schema:
            if not _is_nonnegative_int(schema["maxItems"]):
                raise ctx.at("maxItems").unsupported("maxItems must be a nonnegative integer")
            expression = f"{expression}.max({schema['maxItems']})"
        if (
            "minItems" in schema
            and "maxItems" in schema
            and schema["minItems"] > schema["maxItems"]
        ):
            raise ctx.at("minItems").unsupported("minItems cannot exceed maxItems")
        if schema.get(UNIQUE_STRING_ARRAY_NORMALIZE_MARKER) is True:
            expression = (
                f"{expression}.superRefine((value, ctx) => {{"
                " if (value.some((item) => codePointLength(item) === 0 || item !== item.trim() || codePointLength(item) > 512))"
                " ctx.addIssue({ code: 'custom', message: 'legacy IDs must be non-empty, trimmed, and bounded' });"
                "}).overwrite((value) => sortUniqueCodePointStrings(value))"
            )
        if schema.get(BOUNDED_NONBLANK_STRING_SET_MARKER) is True:
            expression = (
                f"{expression}.superRefine((value, ctx) => {{"
                " if (value.some((item) => codePointLength(item) === 0 || item.trim().length === 0 || codePointLength(item) > 256))"
                " ctx.addIssue({ code: 'custom', message: 'string set items must be non-blank and bounded' });"
                "}).overwrite((value) => sortUniqueCodePointStrings(value))"
            )
        if schema.get(SPEECH_LANGUAGE_ARRAY_NORMALIZE_MARKER) is True:
            expression = (
                f"z.preprocess((value) => normalizeSpeechLanguageArrayValue(value), {expression})"
            )
        if schema.get(LOGICAL_VOICE_ARRAY_NORMALIZE_MARKER) is True:
            expression = (
                f"z.preprocess((value) => Array.isArray(value) && value.every((item) => typeof item === 'string')"
                f" ? sortUniqueCodePointStrings(value) : value, {expression})"
                ".overwrite((value) => sortUniqueCodePointStrings(value))"
            )
        return expression

    def _compile_string(self, schema: dict[str, Any], ctx: CompileContext) -> str:
        if "contentEncoding" in schema and schema["contentEncoding"] != "base64":
            raise ctx.at("contentEncoding").unsupported(
                f"unsupported contentEncoding {schema['contentEncoding']!r}"
            )
        expression = "z.base64()" if schema.get("contentEncoding") == "base64" else "z.string()"
        if "minLength" in schema:
            if not _is_nonnegative_int(schema["minLength"]):
                raise ctx.at("minLength").unsupported("minLength must be a nonnegative integer")
            expression = (
                f"{expression}.refine((value) => codePointLength(value) >= {schema['minLength']}, "
                f"{{ message: 'string must contain at least {schema['minLength']} Unicode code points' }})"
                f".meta({canonical_json({'minLength': schema['minLength']})})"
            )
        if "maxLength" in schema:
            if not _is_nonnegative_int(schema["maxLength"]):
                raise ctx.at("maxLength").unsupported("maxLength must be a nonnegative integer")
            expression = (
                f"{expression}.refine((value) => codePointLength(value) <= {schema['maxLength']}, "
                f"{{ message: 'string must contain at most {schema['maxLength']} Unicode code points' }})"
                f".meta({canonical_json({'maxLength': schema['maxLength']})})"
            )
        if (
            "minLength" in schema
            and "maxLength" in schema
            and schema["minLength"] > schema["maxLength"]
        ):
            raise ctx.at("minLength").unsupported("minLength cannot exceed maxLength")
        if "pattern" in schema:
            pattern = schema["pattern"]
            if not isinstance(pattern, str):
                raise ctx.at("pattern").unsupported("pattern must be a string")
            self._validate_js_regex(pattern, ctx.at("pattern"))
            expression = f"{expression}.regex(new RegExp({_ts_string(pattern)}))"
        if schema.get(STRING_TRIMMED_MARKER) is True:
            expression = f"{expression}.regex(/^(?!\\s)(?:[\\s\\S]*\\S)?$/)"
        if schema.get(STRING_NON_BLANK_MARKER) is True:
            if "pattern" in schema:
                expression = (
                    f"{expression}.refine((value) => value.trim().length > 0, "
                    "{ message: 'string must not be blank' })"
                )
            else:
                expression = f"{expression}.regex(/^(?=.*\\S)[\\s\\S]*$/)"
        if schema.get(TTS_OPERATION_ID_MARKER) is True:
            expression = (
                f"{expression}.superRefine((value, ctx) => {{"
                " const trimmed = value.trim();"
                " if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed))"
                " ctx.addIssue({ code: 'custom', message: 'operation_id must be a non-blank portable identifier' });"
                "}).overwrite((value) => value.trim())"
            )
        if "format" in schema:
            fmt = schema["format"]
            if fmt not in SUPPORTED_STRING_FORMATS:
                raise ctx.at("format").unsupported(f"unsupported string format {fmt!r}")
            if fmt == "date-time":
                expression = f"{expression}.datetime({{ offset: true }})"
            elif fmt == "date":
                expression = f"{expression}.date()"
            elif fmt == "time":
                expression = f"{expression}.time()"
            elif fmt == "email":
                expression = f"{expression}.email()"
            elif fmt == "uuid":
                expression = f"{expression}.uuid()"
            elif fmt == "uri":
                expression = f"{expression}.url()"
            elif fmt == "duration":
                expression = f"{expression}.pipe(z.iso.duration())"
            elif fmt == "hostname":
                expression = f"{expression}.pipe(z.hostname())"
            elif fmt == "ipv4":
                expression = f"{expression}.pipe(z.ipv4())"
            elif fmt == "ipv6":
                expression = f"{expression}.pipe(z.ipv6())"
            elif fmt == "binary":
                expression = f"{expression}.meta({canonical_json({'format': 'binary'})})"
        return expression

    def _validate_js_regex(self, pattern: str, ctx: CompileContext) -> None:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise ctx.unsupported(f"invalid Python regex: {exc}") from exc
        for token in PYTHON_ONLY_REGEX_TOKENS:
            if token in pattern:
                raise ctx.unsupported(f"Python-only regex token {token!r} is unsupported")

    def _compile_number(self, schema: dict[str, Any], ctx: CompileContext, *, integer: bool) -> str:
        expression = "z.number()"
        expression = f"{expression}.finite()"
        if integer:
            expression = f"{expression}.multipleOf(1)"
        bounds = (
            ("minimum", "min"),
            ("exclusiveMinimum", "gt"),
            ("maximum", "max"),
            ("exclusiveMaximum", "lt"),
        )
        for key, method in bounds:
            if key in schema:
                value = schema[key]
                if not _is_finite_number(value):
                    raise ctx.at(key).unsupported("numeric bound must be finite")
                expression = f"{expression}.{method}({canonical_json(value)})"
        if integer and "enum" not in schema and "const" not in schema:
            has_lower_bound = "minimum" in schema or "exclusiveMinimum" in schema
            has_upper_bound = "maximum" in schema or "exclusiveMaximum" in schema
            if not has_lower_bound or not has_upper_bound:
                raise ctx.unsupported("integer schema must declare minimum and maximum bounds")
        lower = schema.get("minimum", schema.get("exclusiveMinimum"))
        upper = schema.get("maximum", schema.get("exclusiveMaximum"))
        if _is_finite_number(lower) and _is_finite_number(upper) and lower > upper:
            raise ctx.at("minimum").unsupported("numeric minimum cannot exceed maximum")
        if "multipleOf" in schema:
            multiple = schema["multipleOf"]
            if not _is_finite_number(multiple) or multiple <= 0:
                raise ctx.at("multipleOf").unsupported(
                    "multipleOf must be a finite positive number"
                )
            expression = f"{expression}.multipleOf({canonical_json(multiple)})"
        return expression


def compile_schema(
    schema: dict[str, Any], *, method_id: str, direction: str, model_name: str
) -> str:
    _definitions, expression = ZodCompiler(
        schema,
        ctx=CompileContext(method_id, direction, model_name),
        symbol_prefix=schema_symbol(f"{method_id}.{direction}."),
    ).compile_root()
    return expression


def render_zod_module(contract_schema: dict[str, Any]) -> str:
    schemas = contract_schema["schemas"]
    lines = [
        "/* eslint-disable */",
        "// Generated by scripts/generate_backend_inventory.py. Do not edit by hand.",
        "import { sha256 } from '@noble/hashes/sha2.js'",
        "import { z } from 'zod/v4'",
        "",
        "type JsonPrimitive = string | number | boolean | null",
        "type JsonValue = JsonPrimitive | { [key: string]: JsonValue | undefined } | JsonValue[]",
        "type AuroraCustomIssue = { code: 'custom'; path?: Array<string | number>; message: string }",
        "type AuroraRefinementContext = { addIssue: (issue: AuroraCustomIssue) => void }",
        "",
        "const toolingProjectionTextEncoder = new TextEncoder()",
        "const TOOLING_PROJECTION_SAFE_BYTES = new Set([0x2D, 0x2E, 0x5F, 0x7E])",
        "const TOOLING_PROJECTION_HEX = '0123456789ABCDEF'",
        "",
        "const auroraJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>",
        "  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(auroraJsonValueSchema), z.record(z.string(), auroraJsonValueSchema)])",
        ")",
        "",
        "function codePointLength(value: string): number { return Array.from(value).length }",
        "function compareCodePointStrings(left: string, right: string): number {",
        "  const leftPoints = Array.from(left)",
        "  const rightPoints = Array.from(right)",
        "  const count = Math.min(leftPoints.length, rightPoints.length)",
        "  for (let index = 0; index < count; index += 1) {",
        "    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0",
        "    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0",
        "    if (leftPoint !== rightPoint) return leftPoint - rightPoint",
        "  }",
        "  return leftPoints.length - rightPoints.length",
        "}",
        "function sortUniqueCodePointStrings<T extends string>(value: T[]): T[] { return [...new Set(value)].sort(compareCodePointStrings) }",
        "function sortUniqueNumbers(value: number[]): number[] { return [...new Set(value)].sort((left, right) => left - right) }",
        "function normalizeSpeechLanguageValue(value: unknown, autoAsNull = false, blankAsNull = false): unknown { if (typeof value !== 'string') return value; const normalized = value.trim().replaceAll('_', '-').toLowerCase(); if ((blankAsNull && normalized.length === 0) || (autoAsNull && normalized === 'auto')) return null; return normalized }",
        "function normalizeSpeechLanguageArrayValue(value: unknown): unknown { if (!Array.isArray(value)) return value; const normalized = value.map((item) => normalizeSpeechLanguageValue(item)); return normalized.every((item): item is string => typeof item === 'string') ? sortUniqueCodePointStrings(normalized) : normalized }",
        "function normalizeSpeechLocaleFallbacks(value: unknown): unknown { if (!Array.isArray(value)) return value; const byKey = new Map<string, Record<string, unknown>>(); for (const item of value) { if (!item || typeof item !== 'object' || Array.isArray(item)) return value; const fallback = item as Record<string, unknown>; byKey.set(`${String(fallback.requested_language)}\\u0000${String(fallback.served_language)}`, fallback) } return [...byKey.entries()].sort(([left], [right]) => compareCodePointStrings(left, right)).map(([, fallback]) => fallback) }",
        "function bytesToHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('') }",
        "function base64ToBytes(value: string): Uint8Array { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid base64'); const decoded = atob(value); const bytes = new Uint8Array(decoded.length); for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index); return bytes }",
        "function canonicalJson(value: unknown): string {",
        "  if (value === null || typeof value !== 'object') return JSON.stringify(value)",
        "  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`",
        "  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareCodePointStrings(left, right))",
        "  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`",
        "}",
        "function speechLanguageRequirementDigest(value: Record<string, unknown>): string {",
        "  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson({ auto_language_candidates: Array.isArray(value.auto_language_candidates) ? value.auto_language_candidates : [], language: value.language ?? null, mode: value.mode, table_revision: typeof value.table_revision === 'string' ? value.table_revision : 'aurora-speech-language-v1' }))))",
        "}",
        "",
        "function hasControlCharacter(value: string): boolean {",
        "  for (const character of value) {",
        "    const codePoint = character.codePointAt(0) ?? 0",
        "    if (codePoint < 0x20 || codePoint === 0x7F) return true",
        "  }",
        "  return false",
        "}",
        "",
        "function hasLoneSurrogate(value: string): boolean {",
        "  for (let index = 0; index < value.length; index += 1) {",
        "    const code = value.charCodeAt(index)",
        "    if (code >= 0xD800 && code <= 0xDBFF) {",
        "      const next = value.charCodeAt(index + 1)",
        "      if (next < 0xDC00 || next > 0xDFFF) return true",
        "      index += 1",
        "    } else if (code >= 0xDC00 && code <= 0xDFFF) {",
        "      return true",
        "    }",
        "  }",
        "  return false",
        "}",
        "",
        "function percentEncodeRfc3986Utf8ForProjection(value: string): string {",
        "  let encoded = ''",
        "  for (const byte of toolingProjectionTextEncoder.encode(value)) {",
        "    if ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || TOOLING_PROJECTION_SAFE_BYTES.has(byte)) encoded += String.fromCharCode(byte)",
        "    else encoded += `%${TOOLING_PROJECTION_HEX[(byte >> 4) & 0xF]}${TOOLING_PROJECTION_HEX[byte & 0xF]}`",
        "  }",
        "  return encoded",
        "}",
        "",
        "function isProjectionToolIdentity(tool: unknown, providerPeerId: string, serviceInstanceId: string): boolean {",
        "  if (!tool || typeof tool !== 'object') return false",
        "  const value = tool as Record<string, unknown>",
        "  const provenance = value.provenance",
        "  if (!provenance || typeof provenance !== 'object') return false",
        "  const prov = provenance as Record<string, unknown>",
        "  const toolContractId = value.tool_contract_id",
        "  const globalToolId = value.global_tool_id",
        "  if (value.tool_id_scheme !== 'aurora-tool' || value.tool_id_version !== 1) return false",
        "  if (value.provider_peer_id !== providerPeerId || value.provider_service_instance_id !== serviceInstanceId) return false",
        "  if (prov.provider_peer_id !== providerPeerId || prov.provider_service_instance_id !== serviceInstanceId) return false",
        "  if (typeof toolContractId !== 'string' || codePointLength(toolContractId) < 1 || codePointLength(toolContractId) > 160 || toolContractId !== toolContractId.trim() || hasControlCharacter(toolContractId) || hasLoneSurrogate(toolContractId)) return false",
        "  if (typeof globalToolId !== 'string' || codePointLength(globalToolId) < 1 || codePointLength(globalToolId) > 1024) return false",
        "  return globalToolId === `aurora-tool:v1:${percentEncodeRfc3986Utf8ForProjection(providerPeerId)}:Tooling:${percentEncodeRfc3986Utf8ForProjection(toolContractId)}`",
        "}",
        "",
        "const ROUTE_EXPLAIN_RAW_PAYLOAD_KEYS = new Set(['text', 'audio', 'audio_data', 'payload', 'message', 'messages', 'input', 'params'])",
        "const ROUTE_EXPLAIN_SELECTOR_FIELDS = new Set(['peer_id', 'provider_id', 'service_instance_id', 'resource_namespace', 'tool_id', 'hardware_target', 'data_scope'])",
        "const DECLARED_SPEECH_LOCALE_FALLBACKS = new Set<string>()",
        "",
        "function routeExplainRawPayloadIssues(value: unknown): AuroraCustomIssue[] {",
        "  const issues: AuroraCustomIssue[] = []",
        "  const visit = (item: unknown, path: Array<string | number>): void => {",
        "    if (Array.isArray(item)) { item.forEach((entry, index) => visit(entry, [...path, index])); return }",
        "    if (!item || typeof item !== 'object') return",
        "    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {",
        "      if (ROUTE_EXPLAIN_RAW_PAYLOAD_KEYS.has(key)) issues.push({ code: 'custom', path: [...path, key], message: 'route explanations must not include request payload fields' })",
        "      if (path.length === 0 && key === 'speech') continue",
        "      visit(child, [...path, key])",
        "    }",
        "  }",
        "  visit(value, [])",
        "  return issues",
        "}",
        "",
        "function routeExplainSelectorIssues(value: unknown): AuroraCustomIssue[] {",
        "  const issues: AuroraCustomIssue[] = []",
        "  if (!value || typeof value !== 'object' || Array.isArray(value)) return issues",
        "  const selector = (value as Record<string, unknown>).selector",
        "  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return issues",
        "  for (const key of Object.keys(selector as Record<string, unknown>)) {",
        "    if (!ROUTE_EXPLAIN_SELECTOR_FIELDS.has(key)) issues.push({ code: 'custom', path: ['selector', key], message: 'route explanation selectors must use typed selector fields' })",
        "  }",
        "  return issues",
        "}",
        "",
        "function routeExplainSpeechRawPayloadIssues(value: unknown): AuroraCustomIssue[] {",
        "  const issues: AuroraCustomIssue[] = []",
        "  if (!value || typeof value !== 'object' || Array.isArray(value)) return issues",
        "  const speech = (value as Record<string, unknown>).speech",
        "  if (!speech || typeof speech !== 'object' || Array.isArray(speech)) return issues",
        "  for (const key of Object.keys(speech as Record<string, unknown>)) {",
        "    if (ROUTE_EXPLAIN_RAW_PAYLOAD_KEYS.has(key)) issues.push({ code: 'custom', path: ['speech', key], message: 'speech route hints must not include request payload fields' })",
        "  }",
        "  return issues",
        "}",
        "",
        "function isSortedStringList(value: unknown[]): boolean {",
        "  return value.every((item, index) => typeof item === 'string' && (index === 0 || compareCodePointStrings(String(value[index - 1]), item) <= 0))",
        "}",
        "",
        "function isDeclaredSpeechLocaleFallback(requested: unknown, served: unknown): boolean {",
        "  return typeof requested === 'string' && typeof served === 'string' && DECLARED_SPEECH_LOCALE_FALLBACKS.has(`${requested}->${served}`)",
        "}",
        "",
        "function addInvariantIssue(ctx: AuroraRefinementContext, path: Array<string | number>, message: string): void { ctx.addIssue({ code: 'custom', path, message }) }",
        "function listIds(value: unknown, field: string): string[] { if (!value || typeof value !== 'object') return []; const raw = (value as Record<string, unknown>)[field]; return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [] }",
        "function optionalString(value: Record<string, unknown>, field: string): string | null | undefined { const raw = value[field]; return typeof raw === 'string' || raw === null || raw === undefined ? raw : undefined }",
        "function validateTtsCapabilitiesInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const supported = new Set(listIds(value, 'supported_language_pack_ids')); const installedIds = listIds(value, 'installed_language_pack_ids'); const installed = new Set(installedIds); const residentIds = listIds(value, 'resident_language_pack_ids'); const resident = new Set(residentIds); const bindings = Array.isArray(value.resident_language_packs) ? value.resident_language_packs as Record<string, unknown>[] : []; const bindingIds = bindings.map((binding) => binding.pack_id).filter((id): id is string => typeof id === 'string'); for (const id of installedIds) if (!supported.has(id)) addInvariantIssue(ctx, ['installed_language_pack_ids'], 'installed packs must be supported'); for (const id of residentIds) if (!installed.has(id)) addInvariantIssue(ctx, ['resident_language_pack_ids'], 'resident packs must be installed'); if (bindingIds.length !== new Set(bindingIds).size) addInvariantIssue(ctx, ['resident_language_packs'], 'resident language pack bindings must be unique'); if (bindingIds.length !== resident.size || bindingIds.some((id) => !resident.has(id))) addInvariantIssue(ctx, ['resident_language_packs'], 'resident language pack ids and bindings must match'); const boundReadyLanguages = new Set(bindings.flatMap((binding) => listIds(binding, 'ready_languages'))); const readyLanguages = new Set(listIds(value, 'ready_languages')); if (boundReadyLanguages.size !== readyLanguages.size || [...boundReadyLanguages].some((language) => !readyLanguages.has(language))) addInvariantIssue(ctx, ['ready_languages'], 'ready languages must match resident language pack bindings'); if (typeof value.resident_base_model_count === 'number' && typeof value.max_resident_base_models === 'number' && value.resident_base_model_count > value.max_resident_base_models) addInvariantIssue(ctx, ['resident_base_model_count'], 'resident base model count exceeds limit'); if (value.ready !== true && readyLanguages.size > 0) addInvariantIssue(ctx, ['ready_languages'], 'ready=false cannot advertise ready languages'); if (value.ready === true) { if (value.model_status !== 'ready' && value.model_status !== 'degraded') addInvariantIssue(ctx, ['model_status'], 'ready capability needs a usable model status'); if (readyLanguages.size === 0 || resident.size === 0) addInvariantIssue(ctx, ['ready_languages'], 'ready capability needs resident languages and packs'); if (value.resident_base_model_count !== undefined && value.resident_base_model_count !== null && Number(value.resident_base_model_count) < 1) addInvariantIssue(ctx, ['resident_base_model_count'], 'ready capability needs a resident base model'); if (listIds(value, 'output_formats').length === 0 || !Array.isArray(value.sample_rates) || value.sample_rates.length === 0) addInvariantIssue(ctx, ['output_formats'], 'ready capability needs output formats and sample rates'); } else if (value.model_status === 'ready') addInvariantIssue(ctx, ['model_status'], 'model_status=ready requires ready=true'); if (value.cloning === true) { if (listIds(value, 'accepted_clone_import_formats').length === 0) addInvariantIssue(ctx, ['accepted_clone_import_formats'], 'cloning needs at least one accepted import format'); if (Number(value.max_clone_import_bytes) < 1 || Number(value.max_clone_chunk_bytes) < 1) addInvariantIssue(ctx, ['max_clone_import_bytes'], 'cloning needs positive import limits'); } else if (listIds(value, 'accepted_clone_import_formats').length > 0 || Number(value.max_clone_import_bytes) !== 0 || Number(value.max_clone_chunk_bytes) !== 0) addInvariantIssue(ctx, ['cloning'], 'cloning=false cannot advertise clone import support'); }",
        "function validateTtsVoiceDescriptorInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const voiceId = optionalString(value, 'voice_id'); if (value.kind === 'standard' && (!voiceId || !voiceId.startsWith('standard:'))) addInvariantIssue(ctx, ['voice_id'], 'standard voice kind needs a standard logical voice id'); if (value.kind === 'cloned' && (!voiceId || !voiceId.startsWith('clone:'))) addInvariantIssue(ctx, ['voice_id'], 'cloned voice kind needs a clone logical voice id'); if (value.ready === true && listIds(value, 'compatible_language_pack_ids').length === 0) addInvariantIssue(ctx, ['compatible_language_pack_ids'], 'ready voice needs a compatible language pack'); }",
        "function validateTtsVoiceListInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const voices = Array.isArray(value.voices) ? value.voices as Record<string, unknown>[] : []; const ids = voices.map((voice) => voice.voice_id).filter((id): id is string => typeof id === 'string'); if (voices.some((voice) => voice.ready !== true)) addInvariantIssue(ctx, ['voices'], 'use-safe voice list cannot contain unready voices'); if (new Set(ids).size !== ids.length) addInvariantIssue(ctx, ['voices'], 'use-safe voice list cannot contain duplicate voices'); }",
        "function validateTtsProfileDescriptorInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const voiceId = optionalString(value, 'voice_id'); if (value.kind === 'standard' && (!voiceId || !voiceId.startsWith('standard:'))) addInvariantIssue(ctx, ['voice_id'], 'standard profile kind needs a standard logical voice id'); if (value.kind === 'cloned' && (!voiceId || !voiceId.startsWith('clone:'))) addInvariantIssue(ctx, ['voice_id'], 'cloned profile kind needs a clone logical voice id'); if (value.ready === true && value.installed !== true) addInvariantIssue(ctx, ['installed'], 'ready profile must be installed'); if ((value.default === true || value.active === true) && value.ready !== true) addInvariantIssue(ctx, ['ready'], 'default or active profile must be ready'); if (value.kind === 'standard' && value.retained_source === true) addInvariantIssue(ctx, ['retained_source'], 'standard profile cannot retain clone source'); if (value.visibility === 'private' && listIds(value, 'allowed_peer_ids').length > 0) addInvariantIssue(ctx, ['allowed_peer_ids'], 'private profile cannot expose allowed peers'); }",
        "function validateTtsProfileListInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const profiles = Array.isArray(value.profiles) ? value.profiles as Record<string, unknown>[] : []; const ids = profiles.map((profile) => profile.voice_id).filter((id): id is string => typeof id === 'string'); if (new Set(ids).size !== ids.length) addInvariantIssue(ctx, ['profiles'], 'voice profile list cannot contain duplicate profiles'); }",
        "function validateTtsGetProfileResponseInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { if (value.found === true && (value.profile === null || value.profile === undefined)) addInvariantIssue(ctx, ['profile'], 'found voice profile response requires profile'); if (value.found === false && value.profile !== null && value.profile !== undefined) addInvariantIssue(ctx, ['profile'], 'missing voice profile response cannot include profile'); }",
        "function validateTtsUpdateProfilePatchInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { if (value.display_name === undefined && value.enabled === undefined && value.visibility === undefined && value.allowed_peer_ids === undefined) addInvariantIssue(ctx, [], 'voice profile update must include a change'); if (value.visibility === 'private' && listIds(value, 'allowed_peer_ids').length > 0) addInvariantIssue(ctx, ['allowed_peer_ids'], 'private visibility cannot include allowed peers'); }",
        "function validateTtsCreateProfileResponseInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const ok = value.status === 'created' || value.status === 'queued' || value.status === 'ready'; const voiceId = optionalString(value, 'voice_id'); if ((ok && value.revision === null) || (ok && value.revision === undefined)) addInvariantIssue(ctx, ['revision'], 'successful create result needs revision'); if ((ok && value.voice_id === null) || (ok && value.voice_id === undefined)) addInvariantIssue(ctx, ['voice_id'], 'successful create result needs voice_id'); if (voiceId && !voiceId.startsWith('clone:')) addInvariantIssue(ctx, ['voice_id'], 'created profile must use a clone logical voice id'); }",
        "function validateTtsDeleteProfileRequestInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const voiceId = optionalString(value, 'voice_id'); if (!voiceId || !voiceId.startsWith('clone:')) addInvariantIssue(ctx, ['voice_id'], 'only cloned voice profiles can be deleted'); }",
        "function validateTtsDeleteProfileResponseInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const voiceId = optionalString(value, 'voice_id'); if (!voiceId || !voiceId.startsWith('clone:')) addInvariantIssue(ctx, ['voice_id'], 'deleted profile result must use a clone logical voice id'); }",
        "function validateTtsProfileMutationResponseInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { const status = value.status; if ((status !== 'rejected' && status !== 'not_found' && value.revision === null) || (status !== 'rejected' && status !== 'not_found' && value.revision === undefined)) addInvariantIssue(ctx, ['revision'], 'successful or conflicting mutation result needs revision'); }",
        "function validateTtsImportStartResponseInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { if (typeof value.max_chunk_bytes === 'number' && typeof value.max_chunks === 'number' && typeof value.accepted_total_bytes === 'number' && value.max_chunk_bytes * value.max_chunks < value.accepted_total_bytes) addInvariantIssue(ctx, ['accepted_total_bytes'], 'upload session capacity is below accepted total bytes'); }",
        "function validateTtsImportChunkRequestInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { let decoded: Uint8Array; if (typeof value.chunk_data !== 'string') return; try { decoded = base64ToBytes(value.chunk_data) } catch { addInvariantIssue(ctx, ['chunk_data'], 'chunk_data must be valid base64'); return } if (decoded.length === 0) addInvariantIssue(ctx, ['chunk_data'], 'decoded chunk must not be empty'); if (decoded.length > 49152) addInvariantIssue(ctx, ['chunk_data'], 'decoded chunk exceeds limit'); if (typeof value.chunk_sha256 === 'string' && bytesToHex(sha256(decoded)) !== value.chunk_sha256) addInvariantIssue(ctx, ['chunk_sha256'], 'chunk SHA-256 mismatch'); if (new TextEncoder().encode(JSON.stringify(value)).length > 131072) addInvariantIssue(ctx, [], 'voice import chunk request exceeds JSON limit'); }",
        "function validateTtsImportChunkResponseInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { if (typeof value.sequence === 'number' && value.next_sequence !== value.sequence + 1) addInvariantIssue(ctx, ['next_sequence'], 'next_sequence must acknowledge exactly one chunk'); if (value.status === 'duplicate' && value.idempotent !== true) addInvariantIssue(ctx, ['idempotent'], 'duplicate chunk acknowledgement must be idempotent'); if (value.status === 'accepted' && value.idempotent === true) addInvariantIssue(ctx, ['idempotent'], 'first chunk acknowledgement cannot be idempotent'); }",
        "function validateTtsAudioChunkEventInvariant(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { if (value.is_final !== true && value.audio_data === '') addInvariantIssue(ctx, [], 'non-final audio chunk requires audio data'); }",
        "function validateSttTranscribeLanguageShape(value: Record<string, unknown>, ctx: AuroraRefinementContext): void { if (value.language !== null && value.language !== undefined && listIds(value, 'auto_language_candidates').length > 0) addInvariantIssue(ctx, ['auto_language_candidates'], 'exact STT language cannot include auto candidates'); }",
        "",
    ]
    schema_exports: list[str] = []
    for item in schemas:
        schema_id = item["schema_id"]
        symbol = schema_symbol(schema_id)
        schema_exports.append(symbol)
        compiler = ZodCompiler(
            item["schema"],
            ctx=CompileContext(item["method_id"], item["direction"], item["model_name"]),
            symbol_prefix=schema_symbol(f"{schema_id}."),
        )
        definitions, expression = compiler.compile_root()
        lines.extend(definitions)
        lines.append(f"export const {symbol} = {expression}")
        lines.append(f"export type {type_symbol(schema_id)} = z.infer<typeof {symbol}>")
        lines.append("")
    lines.append("export const backendContractSchemas = {")
    for symbol in schema_exports:
        lines.append(f"  {symbol},")
    lines.append("} as const")
    lines.append("")
    lines.append("export const backendContractSchemaById = {")
    for item in schemas:
        lines.append(f"  {_ts_string(item['schema_id'])}: {schema_symbol(item['schema_id'])},")
    lines.append("} as const")
    lines.append("")
    method_descriptors = contract_schema.get("method_descriptors", [])
    lines.append(
        "export const backendContractMethodDescriptors = "
        f"{json.dumps(method_descriptors, ensure_ascii=False, indent=2)} as const"
    )
    lines.append("")
    lines.append("export const backendContractMethodDescriptorById = {")
    for item in method_descriptors:
        lines.append(f"  {_ts_string(item['method_id'])}: {json.dumps(item, ensure_ascii=False)},")
    lines.append("} as const")
    lines.append("")
    event_descriptors = contract_schema.get("event_descriptors", [])
    lines.append(
        "export const backendContractEventDescriptors = "
        f"{json.dumps(event_descriptors, ensure_ascii=False, indent=2)} as const"
    )
    lines.append("")
    lines.append("export const backendContractEventDescriptorByTopic = {")
    for item in event_descriptors:
        lines.append(
            f"  {_ts_string(item['event_topic'])}: {json.dumps(item, ensure_ascii=False)},"
        )
    lines.append("} as const")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("schema", type=Path, help="Normalized backend contract schema JSON")
    parser.add_argument("--output", type=Path, required=True, help="Generated Zod module output")
    args = parser.parse_args()
    contract_schema = json.loads(args.schema.read_text())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_zod_module(contract_schema), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
