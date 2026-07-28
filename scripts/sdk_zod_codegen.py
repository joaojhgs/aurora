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
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GENERATOR_FORMAT_VERSION = "aurora-sdk-zod-codegen-v1"
JS_SAFE_INTEGER_MIN = -(2**53 - 1)
JS_SAFE_INTEGER_MAX = 2**53 - 1
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

    def _compile(self, schema: Any, ctx: CompileContext) -> str:
        if not isinstance(schema, dict):
            raise ctx.unsupported("schema node must be an object")
        if "$ref" in schema:
            ref = schema["$ref"]
            if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
                raise ctx.unsupported(f"unsupported reference {ref!r}")
            symbol = self.def_symbols.get(ref)
            if symbol is None:
                raise ctx.unsupported(f"unknown reference {ref!r}")
            return symbol
        if schema == {}:
            return "auroraJsonValueSchema"
        if "const" in schema:
            return f"z.literal({_ts_string(schema['const']) if isinstance(schema['const'], str) else canonical_json(schema['const'])})"
        if "enum" in schema:
            return self._compile_enum(schema["enum"], ctx.at("enum"))
        for union_key in ("anyOf", "oneOf"):
            if union_key in schema:
                return self._compile_union(schema, union_key, ctx.at(union_key))
        schema_type = schema.get("type")
        if isinstance(schema_type, list):
            if len(schema_type) == 2 and "null" in schema_type:
                other = next(item for item in schema_type if item != "null")
                narrowed = {key: value for key, value in schema.items() if key != "type"}
                narrowed["type"] = other
                return f"{self._compile(narrowed, ctx)}.nullable()"
            raise ctx.unsupported(f"unsupported multi-type schema {schema_type!r}")
        if schema_type == "object" or "properties" in schema:
            return self._compile_object(schema, ctx)
        if schema_type == "array":
            return self._compile_array(schema, ctx)
        if schema_type == "string":
            return self._compile_string(schema, ctx)
        if schema_type == "integer":
            return self._compile_number(schema, ctx, integer=True)
        if schema_type == "number":
            return self._compile_number(schema, ctx, integer=False)
        if schema_type == "boolean":
            return "z.boolean()"
        if schema_type == "null":
            return "z.null()"
        raise ctx.unsupported(f"unsupported schema type {schema_type!r}")

    def _compile_enum(self, values: Any, ctx: CompileContext) -> str:
        if not isinstance(values, list) or not values:
            raise ctx.unsupported("enum must be a non-empty list")
        if all(isinstance(value, str) for value in values):
            return f"z.enum([{', '.join(_ts_string(value) for value in values)}])"
        literals = [
            f"z.literal({_ts_string(value) if isinstance(value, str) else canonical_json(value)})"
            for value in values
        ]
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
            compiled = ", ".join(
                self._compile(item, ctx.at(index)) for index, item in enumerate(options)
            )
            return f"z.discriminatedUnion({_ts_string(discriminator)}, [{compiled}])"
        raise ctx.unsupported(f"unsupported ambiguous {key}")

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
        return expression

    def _compile_array(self, schema: dict[str, Any], ctx: CompileContext) -> str:
        if isinstance(schema.get("prefixItems"), list):
            raise ctx.unsupported("tuple arrays are unsupported")
        items = schema.get("items")
        if not isinstance(items, dict):
            raise ctx.unsupported("array items must be a single schema")
        expression = f"z.array({self._compile(items, ctx.at('items'))})"
        if "minItems" in schema:
            expression = f"{expression}.min({int(schema['minItems'])})"
        if "maxItems" in schema:
            expression = f"{expression}.max({int(schema['maxItems'])})"
        return expression

    def _compile_string(self, schema: dict[str, Any], ctx: CompileContext) -> str:
        expression = "z.base64()" if schema.get("contentEncoding") == "base64" else "z.string()"
        if "minLength" in schema:
            expression = f"{expression}.min({int(schema['minLength'])})"
        if "maxLength" in schema:
            expression = f"{expression}.max({int(schema['maxLength'])})"
        if "pattern" in schema:
            pattern = schema["pattern"]
            if not isinstance(pattern, str):
                raise ctx.at("pattern").unsupported("pattern must be a string")
            expression = f"{expression}.regex(new RegExp({_ts_string(pattern)}))"
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
        return expression

    def _compile_number(self, schema: dict[str, Any], ctx: CompileContext, *, integer: bool) -> str:
        expression = "z.number().int()" if integer else "z.number()"
        expression = f"{expression}.finite()"
        if integer and "minimum" not in schema and "exclusiveMinimum" not in schema:
            schema = {**schema, "minimum": JS_SAFE_INTEGER_MIN}
        if integer and "maximum" not in schema and "exclusiveMaximum" not in schema:
            schema = {**schema, "maximum": JS_SAFE_INTEGER_MAX}
        bounds = (
            ("minimum", "min"),
            ("exclusiveMinimum", "gt"),
            ("maximum", "max"),
            ("exclusiveMaximum", "lt"),
        )
        for key, method in bounds:
            if key in schema:
                value = schema[key]
                if not isinstance(value, (int, float)):
                    raise ctx.at(key).unsupported("numeric bound must be finite")
                expression = f"{expression}.{method}({canonical_json(value)})"
        if "multipleOf" in schema:
            expression = f"{expression}.multipleOf({canonical_json(schema['multipleOf'])})"
        if integer:
            expression = f"{expression}.safe()"
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
