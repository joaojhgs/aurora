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
}
JSON_VALUE_MARKER = "x-aurora-json-value"
STRING_TRIMMED_MARKER = "x-aurora-string-trimmed"
STRING_NON_BLANK_MARKER = "x-aurora-string-non-blank"
PROJECTION_PAGE_TERMINATION_MARKER = "x-aurora-projection-page-termination"
UNIQUE_STRING_ARRAY_NORMALIZE_MARKER = "x-aurora-unique-string-array-normalize"
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
    UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
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
        for marker in (STRING_TRIMMED_MARKER, STRING_NON_BLANK_MARKER):
            if marker in schema:
                if schema.get(marker) is not True:
                    raise ctx.at(marker).unsupported(f"{marker} must be literal true")
                if schema.get("type") != "string":
                    raise ctx.at(marker).unsupported(f"{marker} only applies to string schemas")
        if UNIQUE_STRING_ARRAY_NORMALIZE_MARKER in schema:
            if schema.get(UNIQUE_STRING_ARRAY_NORMALIZE_MARKER) is not True:
                raise ctx.at(UNIQUE_STRING_ARRAY_NORMALIZE_MARKER).unsupported(
                    f"{UNIQUE_STRING_ARRAY_NORMALIZE_MARKER} must be literal true"
                )
            items = schema.get("items")
            if (
                schema.get("type") != "array"
                or not isinstance(items, dict)
                or items.get("type") != "string"
            ):
                raise ctx.at(UNIQUE_STRING_ARRAY_NORMALIZE_MARKER).unsupported(
                    f"{UNIQUE_STRING_ARRAY_NORMALIZE_MARKER} only applies to string arrays"
                )
        if PROJECTION_PAGE_TERMINATION_MARKER in schema:
            if schema.get(PROJECTION_PAGE_TERMINATION_MARKER) is not True:
                raise ctx.at(PROJECTION_PAGE_TERMINATION_MARKER).unsupported(
                    f"{PROJECTION_PAGE_TERMINATION_MARKER} must be literal true"
                )
            properties = schema.get("properties")
            required_fields = {
                "complete",
                "final_checksum",
                "next_cursor",
                "total_count",
            }
            if (
                schema.get("type") != "object"
                or not isinstance(properties, dict)
                or not required_fields.issubset(properties)
            ):
                raise ctx.at(PROJECTION_PAGE_TERMINATION_MARKER).unsupported(
                    f"{PROJECTION_PAGE_TERMINATION_MARKER} only applies to export page objects"
                )

    def _apply_default(self, expression: str, schema: dict[str, Any], ctx: CompileContext) -> str:
        if "default" in schema:
            default = schema["default"]
            if not _is_json_value(default):
                raise ctx.at("default").unsupported("default must be a finite JSON value")
            expression = f"{expression}.default({canonical_json(default)})"
        return self._apply_metadata(expression, schema)

    def _apply_metadata(self, expression: str, schema: dict[str, Any]) -> str:
        metadata = {
            key: schema[key]
            for key in (
                JSON_VALUE_MARKER,
                STRING_TRIMMED_MARKER,
                STRING_NON_BLANK_MARKER,
                PROJECTION_PAGE_TERMINATION_MARKER,
                UNIQUE_STRING_ARRAY_NORMALIZE_MARKER,
                "x-aurora-extra-behavior",
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
                " if (value.some((item) => item.length === 0 || item !== item.trim() || item.length > 512))"
                " ctx.addIssue({ code: 'custom', message: 'legacy IDs must be non-empty, trimmed, and bounded' });"
                "}).overwrite((value) => [...new Set(value)].sort())"
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
            expression = f"{expression}.min({schema['minLength']})"
        if "maxLength" in schema:
            if not _is_nonnegative_int(schema["maxLength"]):
                raise ctx.at("maxLength").unsupported("maxLength must be a nonnegative integer")
            expression = f"{expression}.max({schema['maxLength']})"
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
            expression = f"{expression}.regex(/^(?=.*\\S)[\\s\\S]*$/)"
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
        "import { z } from 'zod/v4'",
        "",
        "type JsonPrimitive = string | number | boolean | null",
        "type JsonValue = JsonPrimitive | { [key: string]: JsonValue | undefined } | JsonValue[]",
        "",
        "const auroraJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>",
        "  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(auroraJsonValueSchema), z.record(z.string(), auroraJsonValueSchema)])",
        ")",
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
