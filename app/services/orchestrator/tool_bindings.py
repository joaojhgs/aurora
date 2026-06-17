"""Tool binding helpers for orchestrator-safe Tooling discovery metadata."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import Field, create_model


ToolBinding = dict[str, Any]


def build_tool_bindings(
    tool_schemas: list[dict[str, Any]],
) -> tuple[list[StructuredTool], dict[str, ToolBinding]]:
    """Build LLM-bindable tools and hidden execution bindings.

    Tooling discovery already decides what a provider advertises. The
    orchestrator adds one more safety layer: remote tools that require
    confirmation or are marked sensitive/dangerous are not bound for automatic
    model selection. Safe remote tools keep a model-visible namespaced name,
    while execution uses the hidden global provider/tool identity.
    """

    tools: list[StructuredTool] = []
    bindings: dict[str, ToolBinding] = {}

    for schema in tool_schemas:
        if not _is_safe_to_bind(schema):
            continue

        try:
            bindable_name = _unique_tool_name(
                str(schema.get("name") or "unknown_tool"), bindings
            )
            tool = _structured_tool_from_schema(schema, bindable_name)
            tools.append(tool)
            bindings[bindable_name] = _execution_binding(schema, bindable_name)
        except Exception:
            continue

    return tools, bindings


def _is_safe_to_bind(schema: dict[str, Any]) -> bool:
    """Return whether a discovered tool may be advertised to the LLM."""

    is_remote = _is_remote_tool(schema)
    if not is_remote:
        return True

    safety_class = schema.get("safety_class") or "standard"
    confirmation_required = bool(schema.get("confirmation_required"))
    return safety_class == "standard" and not confirmation_required


def _is_remote_tool(schema: dict[str, Any]) -> bool:
    return (
        schema.get("execution_location") == "remote"
        or schema.get("source_type") == "mesh_peer"
    )


def _unique_tool_name(candidate: str, existing: dict[str, ToolBinding]) -> str:
    """Return a deterministic collision-safe LLM-visible tool name."""

    if candidate not in existing:
        return candidate

    suffix = 2
    while f"{candidate}_{suffix}" in existing:
        suffix += 1
    return f"{candidate}_{suffix}"


def _structured_tool_from_schema(
    schema: dict[str, Any], bindable_name: str
) -> StructuredTool:
    args_schema = _args_model_from_json_schema(
        bindable_name, schema.get("args_schema") or schema.get("schema") or {}
    )
    description = str(schema.get("description") or "")
    if _is_remote_tool(schema):
        display_name = schema.get("display_name") or bindable_name
        provider_peer_id = schema.get("provider_peer_id") or "remote"
        description = (
            f"Remote tool from {provider_peer_id} as {display_name}. {description}"
        ).strip()

    def _bus_only_tool(**kwargs: Any) -> None:
        raise NotImplementedError(
            f"Tool {bindable_name} should be executed via message bus, not directly"
        )

    return StructuredTool(
        name=bindable_name,
        description=description,
        func=_bus_only_tool,
        args_schema=args_schema,
    )


def _args_model_from_json_schema(bindable_name: str, args_schema: dict[str, Any]) -> type:
    if not isinstance(args_schema, dict) or "properties" not in args_schema:
        return create_model(f"{_model_name_segment(bindable_name)}Args")

    properties = args_schema.get("properties") or {}
    required_fields = set(args_schema.get("required") or [])
    field_defs: dict[str, tuple[type, Any]] = {}

    for field_name, field_info in properties.items():
        if not isinstance(field_info, dict):
            field_info = {}
        field_type = _json_schema_type_to_python(field_info.get("type", "string"))
        field_description = field_info.get("description", "")

        if field_name in required_fields:
            field_default = (
                Field(..., description=field_description)
                if field_description
                else ...
            )
        else:
            field_default = (
                Field(default=None, description=field_description)
                if field_description
                else None
            )
        field_defs[field_name] = (field_type, field_default)

    return create_model(f"{_model_name_segment(bindable_name)}Args", **field_defs)


def _json_schema_type_to_python(json_type: str) -> type:
    type_mapping = {
        "string": str,
        "number": float,
        "integer": int,
        "boolean": bool,
        "array": list,
        "object": dict,
    }
    return type_mapping.get(json_type, str)


def _model_name_segment(tool_name: str) -> str:
    segment = "".join(char if char.isalnum() else "_" for char in tool_name)
    segment = "".join(part.capitalize() for part in segment.split("_") if part)
    return segment or "Tool"


def _execution_binding(schema: dict[str, Any], bindable_name: str) -> ToolBinding:
    is_remote = _is_remote_tool(schema)
    local_name = str(schema.get("local_name") or schema.get("name") or bindable_name)
    global_tool_id = schema.get("global_tool_id")
    provider_peer_id = schema.get("provider_peer_id")
    provider_service_instance_id = schema.get("provider_service_instance_id")

    binding: ToolBinding = {
        "bindable_name": bindable_name,
        "tool_name": global_tool_id if is_remote and global_tool_id else local_name,
        "local_name": local_name,
        "global_tool_id": global_tool_id,
        "provider_peer_id": provider_peer_id,
        "provider_service_instance_id": provider_service_instance_id,
        "execution_location": schema.get("execution_location") or "local",
        "source_type": schema.get("source_type") or "local",
        "safety_class": schema.get("safety_class") or "standard",
        "confirmation_required": bool(schema.get("confirmation_required")),
    }

    if is_remote:
        binding["mesh_selector"] = {
            "peer_id": provider_peer_id,
            "provider_id": provider_peer_id,
            "service_instance_id": provider_service_instance_id,
            "tool_id": global_tool_id,
        }

    return binding
