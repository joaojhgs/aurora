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
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI
from pydantic import ValidationError
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
        GENERATOR_FORMAT_VERSION,
        JS_SAFE_INTEGER_MAX,
        JS_SAFE_INTEGER_MIN,
        canonical_json,
        normalize_schema,
        render_zod_module,
        sha256_json,
        sha256_text,
    )
except ModuleNotFoundError:  # pragma: no cover - direct script execution
    from sdk_zod_codegen import (
        GENERATOR_FORMAT_VERSION,
        JS_SAFE_INTEGER_MAX,
        JS_SAFE_INTEGER_MIN,
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

SDK_CONTRACT_ALLOWLIST: tuple[str, ...] = (
    "Tooling.ExecuteTool",
    "Tooling.GetMCPStatus",
    "Tooling.GetStats",
    "Tooling.GetTools",
)
TOOLING_PROVIDER_PEER_ID = "aurora-sdk-local-provider-v1"
TOOLING_PROVIDER_SERVICE_INSTANCE_ID = f"local:{quote(TOOLING_PROVIDER_PEER_ID, safe='')}:Tooling"

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


def _model_schema(model: Any) -> dict[str, Any] | None:
    if model is None or isinstance(model, str):
        return None
    with contextlib.suppress(Exception):
        return model.model_json_schema()
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

    annotated = {key: _annotate_schema(value) for key, value in schema.items()}
    if annotated.get("type") == "object" or "properties" in annotated:
        annotated.setdefault("x-aurora-extra-behavior", _schema_extra_behavior(annotated))
    if annotated.get("type") == "integer":
        annotated.setdefault("minimum", JS_SAFE_INTEGER_MIN)
        annotated.setdefault("maximum", JS_SAFE_INTEGER_MAX)
    return annotated


def _contract_schema_id(method_id: str, direction: str, model_name: str) -> str:
    return f"{method_id}.{direction}.{model_name}"


def _model_wire_schema(model: Any, *, mode: str) -> dict[str, Any]:
    schema = model.model_json_schema(mode=mode)
    return normalize_schema(_annotate_schema(schema))


def _positive_fixture(model_name: str) -> Any | None:
    fixtures: dict[str, Any] = {
        "ToolingGetStatsRequest": {},
        "ToolingGetStatsResponse": {
            "total_tools": 2,
            "mcp_tools_loaded": 1,
            "core_tools": 1,
            "plugin_tools": 0,
            "unexpected": "stripped",
        },
        "ToolingGetMCPStatusRequest": {},
        "ToolingGetMCPStatusResponse": {
            "servers": [{"name": "local", "active": True}],
            "total_servers": 1,
            "active_servers": 1,
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
            "top_k": 1,
            "unexpected": "stripped",
        },
    }
    return fixtures.get(model_name)


def _negative_fixture(model_name: str) -> Any | None:
    fixtures: dict[str, Any] = {
        "ToolingGetStatsResponse": {
            "total_tools": "two",
            "mcp_tools_loaded": 1,
        },
        "ToolingGetMCPStatusResponse": {
            "servers": [],
            "total_servers": "one",
            "active_servers": 0,
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
    }
    return fixtures.get(model_name)


def _validation_vectors(model: Any, *, method_id: str, direction: str) -> dict[str, Any]:
    model_name = _model_name(model) or str(model)
    positive = _positive_fixture(model_name)
    negative = _negative_fixture(model_name)
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
    if negative is not None:
        try:
            model.model_validate(negative)
        except ValidationError as exc:
            first = exc.errors()[0]
            vectors["negative"] = {
                "accepted": False,
                "input": negative,
                "issue_path": "$" + "".join(f".{part}" for part in first.get("loc", ())),
                "issue_category": first.get("type"),
            }
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
    from app.shared.contracts.models.tooling import (
        ToolingExecuteToolRequest,
        ToolingExecuteToolResponse,
        ToolingGetMCPStatusRequest,
        ToolingGetMCPStatusResponse,
        ToolingGetStatsRequest,
        ToolingGetStatsResponse,
        ToolingGetToolsRequest,
        ToolingGetToolsResponse,
    )

    static_models = {
        "Tooling.ExecuteTool": (ToolingExecuteToolRequest, ToolingExecuteToolResponse),
        "Tooling.GetMCPStatus": (ToolingGetMCPStatusRequest, ToolingGetMCPStatusResponse),
        "Tooling.GetStats": (ToolingGetStatsRequest, ToolingGetStatsResponse),
        "Tooling.GetTools": (ToolingGetToolsRequest, ToolingGetToolsResponse),
    }
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
        for direction, mode, model in (
            ("input", "validation", input_model),
            ("output", "serialization", output_model),
        ):
            if model is None or isinstance(model, str):
                continue
            model_name = _model_name(model) or str(model)
            schema = _model_wire_schema(model, mode=mode)
            schema_id = _contract_schema_id(method_id, direction, model_name)
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

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "artifact": "aurora-sdk-backend-contracts",
        "schema_draft": "https://json-schema.org/draft/2020-12/schema",
        "generator_format_version": GENERATOR_FORMAT_VERSION,
        "allowlist": list(SDK_CONTRACT_ALLOWLIST),
        "allowlist_hash": sha256_json(list(SDK_CONTRACT_ALLOWLIST)),
        "schemas": sorted(schemas, key=lambda item: item["schema_id"]),
    }


def build_tooling_local_provider(contract_schema: dict[str, Any]) -> dict[str, Any]:
    schema_hashes = {
        (item["method_id"], item["direction"]): item["schema_hash"]
        for item in contract_schema["schemas"]
    }
    methods = []
    for method_id in SDK_CONTRACT_ALLOWLIST:
        methods.append(
            {
                "method_id": method_id,
                "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
                "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
                "input_schema_hash": schema_hashes.get((method_id, "input")),
                "output_schema_hash": schema_hashes.get((method_id, "output")),
                "required_permission": method_id,
                "tool_id": f"aurora-tool:v1:{TOOLING_PROVIDER_SERVICE_INSTANCE_ID}:{method_id}",
            }
        )
    projection = {
        "provider_peer_id": TOOLING_PROVIDER_PEER_ID,
        "provider_service_instance_id": TOOLING_PROVIDER_SERVICE_INSTANCE_ID,
        "methods": methods,
    }
    return {
        "artifact": "tooling_local_provider_v1",
        "version": 1,
        **projection,
        "projection_page_hash": sha256_json(projection),
        "final_checksum": sha256_json({"version": 1, **projection}),
    }


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
        "python_version": sys.version.split()[0],
        "pydantic_version": PYDANTIC_VERSION,
        "zod_version": "4.x",
        "generator_format_version": GENERATOR_FORMAT_VERSION,
        "generator_source_hash": source_hash,
        "allowlist_hash": contract_schema["allowlist_hash"],
        "content_hashes": content_hashes,
        "final_checksum": sha256_json(content_hashes),
    }


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
    for path, payload in (
        (schema_output, contract_schema),
        (manifest_output, manifest),
        (tooling_provider_output, provider_inventory),
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    zod_output.parent.mkdir(parents=True, exist_ok=True)
    zod_output.write_text(zod_source, encoding="utf-8")


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
