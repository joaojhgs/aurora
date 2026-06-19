#!/usr/bin/env python3
"""Generate Aurora backend contract, route, permission, and exposure inventory."""

from __future__ import annotations

import argparse
import ast
import contextlib
import importlib
import inspect
import json
import pkgutil
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.registry import (
    MethodContract,
    all_contracts,
    clear_registry,
    get_implementation,
    list_modules,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
UI_FIXTURE_PATH = REPO_ROOT / "modules/ui-mock-reference/lib/aurora/data.ts"

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
    REPO_ROOT / (module_path.replace(".", "/") + ".py")
    for _, module_path, _ in SERVICE_CLASSES
)

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
                "input_model": _model_name(input_model),
                "output_model": _model_name(output_model),
                "input_schema": _model_schema(input_model),
                "output_schema": _model_schema(output_model),
                "source_file": f"{_rel(path)}:{node.lineno}",
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


def build_inventory() -> dict[str, Any]:
    methods, import_errors = build_method_inventory()
    gateway_builtins = build_gateway_builtins()
    return {
        "generated_by": "scripts/generate_backend_inventory.py",
        "method_count": len(methods),
        "gateway_builtin_count": len(gateway_builtins),
        "methods": methods,
        "gateway_builtins": gateway_builtins,
        "import_errors": import_errors,
        "ui_fixture_validation": validate_ui_fixture_references(methods, gateway_builtins),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write inventory JSON to this path")
    parser.add_argument(
        "--fail-on-ui-fixture-errors",
        action="store_true",
        help="Exit non-zero when UI fixture references are missing or mismatched",
    )
    args = parser.parse_args()

    inventory = build_inventory()
    rendered = json.dumps(inventory, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(rendered + "\n")
    else:
        print(rendered)

    if args.fail_on_ui_fixture_errors and not inventory["ui_fixture_validation"]["ok"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
