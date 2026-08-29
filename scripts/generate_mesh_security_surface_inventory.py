#!/usr/bin/env python3
"""Generate the checked Aurora mesh security-surface inventory.

This generator is intentionally dedicated to
``docs/security/mesh-security-surface-inventory.json``. It emits only that
schema's fields and keeps curated security judgments in explicit constants below
instead of reading and rewriting the checked JSON as an input source.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import difflib
import importlib
import json
import pkgutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from app.shared.contracts.mesh_surface import (
    CALLABLE_FEATURES,
    MESH_CAPABLE_MODULES,
    all_callable_method_topics,
    feature_ids_for_topic,
    validate_taxonomy,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
INVENTORY_PATH = REPO_ROOT / "docs/security/mesh-security-surface-inventory.json"
SCHEMA_PATH = REPO_ROOT / "docs/security/mesh-security-surface-inventory.schema.json"

MODULE_CAPABILITIES: dict[str, list[str]] = {
    "DB": ["message_persistence", "cron_jobs", "rag_storage", "vector_search"],
    "Orchestrator": ["llm_processing", "agent_execution", "tool_use"],
    "Scheduler": ["cron_scheduling", "job_execution"],
    "STTCoordinator": ["audio_capture", "session_management", "stt_coordination"],
    "Transcription": ["audio_transcription", "vad", "whisper"],
    "WakeWord": ["wake_word_detection", "openwakeword", "porcupine"],
    "Tooling": ["tool_discovery", "tool_execution", "mcp_integration"],
    "TTS": ["speech_synthesis", "audio_playback"],
}

TOOLING_RULE_SELECTORS: dict[str, Any] = {
    "matching_semantics": "non_null_conjunctive_exact_match",
    "precedence": "first_match_wins",
    "selectors": [
        {
            "field": "tool_name",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_provider_local_tool_name",
        },
        {
            "field": "global_tool_id",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_current_name_derived_global_tool_id",
        },
        {
            "field": "execution_location",
            "value_type": "local|remote|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality",
        },
        {
            "field": "source_type",
            "value_type": "core|plugin|mcp|toolkit|mesh_peer|unknown|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": (
                "exact_equality; "
                "mesh_peer_is_runtime_valid_but_missing_from_schema_generated_config_enum"
            ),
        },
        {
            "field": "toolkit_name",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_best_effort_toolkit_or_server_name",
        },
        {
            "field": "safety_class",
            "value_type": "standard|sensitive|dangerous|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality",
        },
        {
            "field": "operation_class",
            "value_type": "read|write|external|admin|hardware|data-egress|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality",
        },
        {
            "field": "resource_namespace",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_resource_selector_then_mesh_selector",
        },
        {
            "field": "hardware_target",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_resource_selector_then_mesh_selector",
        },
        {
            "field": "data_scope",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_resource_selector_then_mesh_selector",
        },
        {
            "field": "caller_peer_id",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": (
                "exact_equality_against_request_payload; "
                "spoofable_until_authenticated_RPC_context_overwrites_it"
            ),
        },
        {
            "field": "caller_principal_id",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": (
                "exact_equality_against_request_payload; external_authority_binding_requires_audit"
            ),
        },
        {
            "field": "caller_device_id",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": (
                "exact_equality_against_request_payload; external_authority_binding_requires_audit"
            ),
        },
        {
            "field": "caller_permissions",
            "value_type": "array<string>|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": (
                "never_matches_when_non_null_because_policy_context_and_"
                "schema_generated_config_omit_this_field; "
                "exact_list_equality_would_be_order_sensitive"
            ),
        },
        {
            "field": "provider_peer_id",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_selected_provider_peer_id",
        },
        {
            "field": "provider_service_instance_id",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_selected_provider_service_instance_id",
        },
        {
            "field": "route_privacy_class",
            "value_type": "string|null",
            "null_semantics": "unset_is_wildcard",
            "match_semantics": "exact_equality_against_tool_metadata",
        },
    ],
}


@dataclass(frozen=True)
class SourceAnchor:
    file: str
    contains: str
    occurrence: int = 1


STABLE_IDENTITY: tuple[dict[str, Any], ...] = (
    {
        "field": "authenticated_peer_id",
        "scope": "mesh peer authorization and recipient policy",
        "stable": True,
        "derivation": (
            "RPC stable_peer_id_provider result, falling back to session peer_id only when unavailable"
        ),
        "persistence": (
            "Stable peer identity is owned by Auth peer records and used to overwrite forwarded "
            "Tooling provider identity."
        ),
        "gaps": [
            "Fallback session peer_id is not guaranteed durable when the stable provider is absent",
            "Tooling request caller_peer_id is still read directly by current policy context until G007 authority binding",
        ],
        "source_anchor": SourceAnchor(
            "app/services/gateway/webrtc/rpc.py", "def _authenticated_peer_id"
        ),
    },
    {
        "field": "provider_service_instance_id",
        "scope": "Tooling provider routing and remote snapshot partition",
        "stable": True,
        "derivation": (
            "stable contract namespace for durable identity; live service_instance_id is routing "
            "instance metadata only"
        ),
        "persistence": (
            "Stored with peer_id as the tooling_remote_catalog_snapshots primary key and in "
            "approval grants/tombstones."
        ),
        "gaps": [
            "String formula is not versioned",
            "Compatibility callers may construct service IDs before authenticated normalization",
        ],
        "source_anchor": SourceAnchor(
            "app/services/gateway/webrtc/rpc.py", 'normalized["service_instance_id"] ='
        ),
    },
    {
        "field": "global_tool_id",
        "scope": "durable per-tool grants, tombstones, policy selectors, and catalog identity",
        "stable": True,
        "derivation": "aurora-tool:v1:<stable-peer-id>:Tooling:<tool-contract-id>",
        "persistence": (
            "Stored in ToolingToolInfo, tooling_approval_grants, remote snapshot JSON, and "
            "tooling_remote_catalog_tombstones."
        ),
        "gaps": [
            "Tool rename changes identity",
            "Lossy safe_identifier can collapse distinct names",
            "No versioned canonical namespace",
            "No immutable tool_contract_id",
            "No durable legacy alias or transactional re-key map",
        ],
        "source_anchor": SourceAnchor("app/services/tooling/service.py", "def _global_tool_id"),
    },
    {
        "field": "bindable_tool_name",
        "scope": "LLM/UI callable presentation name for a remote tool",
        "stable": False,
        "derivation": "safe(peer display label)_safe(provider local tool name)",
        "persistence": "Serialized into cached remote ToolingToolInfo but should be treated as presentation only.",
        "gaps": [
            "Peer display-name rename changes the bindable name",
            "Only provider-local name is retained as an alias",
            "Must never key durable policy or grants",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/service.py", "def _namespaced_tool_name"
        ),
    },
    {
        "field": "remote_source_id",
        "scope": "per-source management grouping for mesh tools",
        "stable": True,
        "derivation": "mesh:<stable_peer_id>:<safe(normalized_service_instance_id)>",
        "persistence": "Serialized in ToolingToolInfo and copied into approval-grant metadata.",
        "gaps": [
            "Stability depends on authenticated peer normalization occurring before persistence",
            "No version marker",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/service.py", 'source_id = f"mesh:{peer_id}'
        ),
    },
    {
        "field": "local_core_source_id",
        "scope": "per-source management grouping for built-in tools",
        "stable": True,
        "derivation": "constant local:core",
        "persistence": "Serialized in ToolingToolInfo and used by source-wide approval grants.",
        "gaps": [
            "All core tools collapse into one group",
            "Cannot represent required core:scheduler, core:tts, core:pomodoro functional share groups",
            "A source-wide rule affects unrelated security domains",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/identity.py", 'stable_source_id="core"'
        ),
    },
    {
        "field": "plugin_source_id",
        "scope": "per-source management grouping for plugin tools",
        "stable": False,
        "derivation": (
            "local:plugin:<safe(explicit loader plugin marker or plugin/package/toolkit/module/name fallback)>"
        ),
        "persistence": "Serialized in ToolingToolInfo and used by source-wide approval grants.",
        "gaps": [
            "Only selected loaders stamp an explicit _aurora_plugin_id",
            "Module/name fallbacks can change across packaging or rename",
            "Lossy sanitization can collide",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/tools_manager.py", 'source_kind="plugin"'
        ),
    },
    {
        "field": "mcp_source_id",
        "scope": "per-source management grouping for MCP tools",
        "stable": True,
        "derivation": "persistent MCP source ID plus provider-declared tool ID",
        "persistence": (
            "Serialized when a tool is correctly classified as MCP and used by source-wide approval grants."
        ),
        "gaps": [
            "MultiServerMCPClient output is flattened without Aurora server identity stamping",
            "ToolsManager does not mark loaded MCP tools with source/server IDs",
            "Fallback to tool name prevents stable server grouping",
            "Two servers can collapse or tools can be misclassified unknown",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/mcp/mcp_client.py", 'source_kind="mcp"'
        ),
    },
    {
        "field": "remote_catalog_snapshot_key",
        "scope": "durable remote provider catalog snapshot",
        "stable": True,
        "derivation": "composite peer_id plus service_instance_id",
        "persistence": "PRIMARY KEY(peer_id, service_instance_id) in tooling_remote_catalog_snapshots.",
        "gaps": [
            "Snapshot-level shared_by_policy conflates provider catalog state and cannot express per-tool availability",
            "No recipient-specific export-policy revision in key",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/service.py", "PRIMARY KEY(peer_id, service_instance_id)"
        ),
    },
    {
        "field": "approval_grant_tool_key",
        "scope": "durable Tooling approval/refusal decision",
        "stable": False,
        "derivation": "provider_peer_id, provider_service_instance_id, and current global_tool_id columns",
        "persistence": "tooling_approval_grants table survives restart and unavailability.",
        "gaps": [
            "Inherits rename and collision defects from global_tool_id",
            "No schema hash bound directly to stable immutable tool contract ID",
            "No alias migration substrate",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/service.py", "CREATE TABLE IF NOT EXISTS tooling_approval_grants"
        ),
    },
    {
        "field": "local_rag_tool_key",
        "scope": "local loaded-tool search registry",
        "stable": False,
        "derivation": "tool.name",
        "persistence": "DB RAG namespace main.tools is synchronized by name.",
        "gaps": [
            "Rename is processed as deletion plus insertion",
            "No immutable identity or group metadata",
            "Cannot support durable aliases",
        ],
        "source_anchor": SourceAnchor(
            "app/services/tooling/tools_manager.py", "active_tools[tool.name]"
        ),
    },
    {
        "field": "tool_contract_id",
        "scope": "desired immutable provider-local tool identity",
        "stable": True,
        "derivation": "immutable provider-local tool contract ID persisted across rename and restart",
        "persistence": "Not persisted.",
        "gaps": [
            "ToolingToolInfo has no tool_contract_id",
            "Built-ins/plugins/MCP cannot retain policy identity across rename",
            "No versioned aurora-tool canonical key",
        ],
        "source_anchor": SourceAnchor(
            "app/shared/contracts/models/tooling.py", "class ToolingToolInfo"
        ),
    },
    {
        "field": "share_group_id",
        "scope": "desired functional tool export grouping",
        "stable": True,
        "derivation": "stable provider-declared functional sharing group ID",
        "persistence": "Not persisted.",
        "gaps": [
            "ToolingToolInfo has no share_group_id or share_group_label",
            "Core functional groups and MCP/plugin source groups cannot be represented independently from approval policy",
        ],
        "source_anchor": SourceAnchor(
            "app/shared/contracts/models/tooling.py", "class ToolingToolInfo"
        ),
    },
)

# Explicit metadata for mesh=True publisher sites. Empty today; a new mesh=True
# publisher must add an entry here or generation fails instead of dropping the site.
MESH_PUBLISHER_METADATA: dict[tuple[str, int], dict[str, Any]] = {}


@dataclass(frozen=True)
class StaticContract:
    module: str
    bus_topic: str
    handler: str
    source_file: str
    source_line: int
    exposure: str
    method_type: str
    required_perms: list[str]
    callable_feature_ids: list[str]


def _rel(path: Path) -> str:
    return str(path.resolve().relative_to(REPO_ROOT))


def _load_contract_namespace() -> dict[str, Any]:
    namespace: dict[str, Any] = {}
    package = importlib.import_module("app.shared.contracts.models")
    for module_info in pkgutil.iter_modules(package.__path__):
        module = importlib.import_module(f"{package.__name__}.{module_info.name}")
        namespace.update(
            {name: value for name, value in vars(module).items() if not name.startswith("_")}
        )
    for module_name in ("app.services.config.messages",):
        with contextlib.suppress(ModuleNotFoundError):
            module = importlib.import_module(module_name)
            namespace.update(
                {name: value for name, value in vars(module).items() if not name.startswith("_")}
            )
    return namespace


def _eval_ast_node(node: ast.AST, namespace: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [_eval_ast_node(item, namespace) for item in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_ast_node(item, namespace) for item in node.elts)
    if isinstance(node, ast.Set):
        return {_eval_ast_node(item, namespace) for item in node.elts}
    if isinstance(node, ast.Name):
        return namespace.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        value = _eval_ast_node(node.value, namespace)
        return getattr(value, node.attr) if not isinstance(value, str) else f"{value}.{node.attr}"
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in {"list", "tuple"}
    ):
        return list(_eval_ast_node(node.args[0], namespace)) if node.args else []
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


def _iter_static_contracts() -> list[StaticContract]:
    namespace = _load_contract_namespace()
    contracts: list[StaticContract] = []
    for path in sorted((REPO_ROOT / "app").rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                call = _is_method_contract_decorator(decorator)
                if call is None:
                    continue
                kwargs = {
                    kw.arg: _eval_ast_node(kw.value, namespace) for kw in call.keywords if kw.arg
                }
                if call.args and "method_id" not in kwargs:
                    kwargs["method_id"] = _eval_ast_node(call.args[0], namespace)
                method_id = str(kwargs["method_id"])
                module = method_id.split(".", 1)[0]
                contracts.append(
                    StaticContract(
                        module=module,
                        bus_topic=method_id,
                        handler=node.name,
                        source_file=_rel(path),
                        source_line=call.lineno,
                        exposure=str(kwargs.get("exposure", "internal")),
                        method_type=str(kwargs.get("method_type", "use")),
                        required_perms=list(kwargs.get("required_perms", [])),
                        callable_feature_ids=list(kwargs.get("callable_feature_ids", [])),
                    )
                )
    return contracts


def _build_methods() -> list[dict[str, Any]]:
    taxonomy_errors = validate_taxonomy()
    if taxonomy_errors:
        raise ValueError("mesh surface taxonomy is invalid: " + "; ".join(taxonomy_errors))

    callable_topics = set(all_callable_method_topics())
    static_contracts = _iter_static_contracts()
    unexpected_external = sorted(
        contract.bus_topic
        for contract in static_contracts
        if contract.module in MESH_CAPABLE_MODULES
        and contract.exposure in {"external", "both"}
        and contract.bus_topic not in callable_topics
    )
    if unexpected_external:
        raise ValueError(
            "external/both mesh-capable methods missing from mesh_surface taxonomy: "
            f"{unexpected_external}"
        )
    contracts_by_topic = {
        contract.bus_topic: contract
        for contract in static_contracts
        if contract.module in MESH_CAPABLE_MODULES
        and contract.exposure in {"external", "both"}
        and contract.bus_topic in callable_topics
    }
    missing = sorted(callable_topics - set(contracts_by_topic))
    if missing:
        raise ValueError(f"missing external/both @method_contract sites for: {missing}")

    extra_feature_mismatches: list[str] = []
    methods: list[dict[str, Any]] = []
    for contract in static_contracts:
        if contract.bus_topic not in contracts_by_topic:
            continue
        expected_features = list(feature_ids_for_topic(contract.bus_topic))
        if contract.callable_feature_ids != expected_features:
            extra_feature_mismatches.append(
                f"{contract.bus_topic}: expected={expected_features} "
                f"actual={contract.callable_feature_ids}"
            )
        methods.append(
            {
                "module": contract.module,
                "bus_topic": contract.bus_topic,
                "handler": contract.handler,
                "source": {"file": contract.source_file, "line": contract.source_line},
                "exposure": contract.exposure,
                "method_type": contract.method_type,
                "required_perms": contract.required_perms,
                "module_capabilities": MODULE_CAPABILITIES[contract.module],
                "proposed_feature_id": expected_features[0],
                "permission_status": "protected"
                if contract.required_perms
                else "ordinary_permissionless",
            }
        )
    if extra_feature_mismatches:
        raise ValueError("callable_feature_ids drift: " + "; ".join(extra_feature_mismatches))
    return methods


def _mesh_publish_call_sites() -> set[tuple[str, int]]:
    sites: set[tuple[str, int]] = set()
    for source_path in sorted((REPO_ROOT / "app").rglob("*.py")):
        source_file = _rel(source_path)
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if any(
                keyword.arg == "mesh"
                and isinstance(keyword.value, ast.Constant)
                and keyword.value.value is True
                for keyword in node.keywords
            ):
                sites.add((source_file, node.lineno))
    return sites


def _build_mesh_publishers() -> list[dict[str, Any]]:
    sites = _mesh_publish_call_sites()
    missing_metadata = sorted(sites - set(MESH_PUBLISHER_METADATA))
    stale_metadata = sorted(set(MESH_PUBLISHER_METADATA) - sites)
    if missing_metadata or stale_metadata:
        raise ValueError(
            "mesh publisher metadata drift: "
            f"missing_metadata={missing_metadata} stale_metadata={stale_metadata}"
        )
    publishers: list[dict[str, Any]] = []
    for file, line in sorted(sites):
        metadata = dict(MESH_PUBLISHER_METADATA[(file, line)])
        publishers.append({**metadata, "source": {"file": file, "line": line}})
    return publishers


def _line_for_anchor(anchor: SourceAnchor) -> int:
    lines = (REPO_ROOT / anchor.file).read_text(encoding="utf-8").splitlines()
    matches = [index for index, line in enumerate(lines, start=1) if anchor.contains in line]
    if len(matches) < anchor.occurrence:
        raise ValueError(f"source anchor not found: {anchor.file}: {anchor.contains!r}")
    return matches[anchor.occurrence - 1]


def _build_stable_identity() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for entry in STABLE_IDENTITY:
        item = dict(entry)
        anchor = item.pop("source_anchor")
        item["source"] = {"file": anchor.file, "line": _line_for_anchor(anchor)}
        entries.append(item)
    return entries


def build_inventory() -> dict[str, Any]:
    """Build the mesh security inventory document."""

    return {
        "schema_version": 1,
        "inventory_status": "complete",
        "mesh_capable_modules": list(MESH_CAPABLE_MODULES),
        "methods": _build_methods(),
        "mesh_publishers": _build_mesh_publishers(),
        "tooling_rule_selectors": TOOLING_RULE_SELECTORS,
        "stable_identity": _build_stable_identity(),
    }


def render_inventory(inventory: dict[str, Any] | None = None) -> str:
    """Return canonical JSON text for an inventory."""

    return json.dumps(inventory or build_inventory(), indent=2) + "\n"


def validate_inventory(inventory: dict[str, Any]) -> None:
    """Validate an inventory against the checked JSON Schema."""

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(inventory)


def _display_path(path: Path) -> Path:
    return path.relative_to(REPO_ROOT) if path.is_relative_to(REPO_ROOT) else path


def _check(target: Path, rendered: str) -> int:
    rel = _display_path(target)
    if not target.exists():
        print(
            f"{rel} is missing; regenerate with: "
            "uv run python scripts/generate_mesh_security_surface_inventory.py",
            file=sys.stderr,
        )
        return 1
    current = target.read_text(encoding="utf-8")
    if current == rendered:
        print(f"{rel} is up to date.")
        return 0
    print(
        f"{rel} is out of date; regenerate with: "
        "uv run python scripts/generate_mesh_security_surface_inventory.py",
        file=sys.stderr,
    )
    diff = difflib.unified_diff(
        current.splitlines(),
        rendered.splitlines(),
        fromfile=f"current/{rel}",
        tofile=f"generated/{rel}",
        lineterm="",
    )
    for line in list(diff)[:80]:
        print(line, file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate that the target inventory is already canonical; do not write it.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=INVENTORY_PATH,
        help="Inventory path to write/check (defaults to docs/security/mesh-security-surface-inventory.json).",
    )
    args = parser.parse_args(argv)

    inventory = build_inventory()
    validate_inventory(inventory)
    rendered = render_inventory(inventory)
    target = args.output.resolve()

    if args.check:
        return _check(target, rendered)

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered, encoding="utf-8")
    print(f"Wrote {_display_path(target)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
