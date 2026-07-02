#!/usr/bin/env python3
"""Validate generated backend inventory against the TypeScript SDK fixtures."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SDK_FIXTURE = REPO_ROOT / "packages/aurora-sdk/src/fixtures.ts"
DEFAULT_SDK_TYPES = REPO_ROOT / "packages/aurora-sdk/src/types.ts"
DEFAULT_EVIDENCE_DIR = REPO_ROOT / ".artifacts/sdk-backend-conformance"
DOC_ONLY_OPENAPI_PATHS = {"/api/docs", "/api/openapi.json", "/api/redoc"}
SDK_MOCK_ONLY_METHODS = {"Gateway.InternalOnly"}
SDK_TYPE_INTERFACES = (
    "BackendInventory",
    "BackendInventoryMethod",
    "GatewayBuiltinInventoryRoute",
)

SECRET_VALUE_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]{12,}"),
    re.compile(r"(?i)(password|api[_-]?key|secret)\s*=\s*[^&\s]{8,}"),
)


@dataclass(frozen=True)
class MethodDescriptor:
    bus_topic: str
    module: str
    name: str
    route_path: str | None
    route_kind: str
    exposure: str
    method_type: str
    required_perms: tuple[str, ...]
    input_model: str | None
    output_model: str | None


@dataclass(frozen=True)
class GatewayBuiltinDescriptor:
    route_path: str
    http_methods: tuple[str, ...]
    method_type: str
    required_perms: tuple[str, ...]


def _rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _read_json(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise TypeError(f"{path} must contain a JSON object")
    return data


def _find_assignment_object(text: str, name: str) -> str:
    marker = f"export const {name}"
    start = text.find(marker)
    if start < 0:
        raise ValueError(f"Could not find {name} export")
    brace = text.find("{", start)
    if brace < 0:
        raise ValueError(f"Could not find {name} object")
    return _balanced_span(text, brace, "{", "}")


def _find_field_array(obj: str, field: str) -> str:
    match = re.search(rf"\b{re.escape(field)}\s*:\s*\[", obj)
    if not match:
        return ""
    bracket = obj.find("[", match.start())
    return _balanced_span(obj, bracket, "[", "]")


def _balanced_span(text: str, start: int, opener: str, closer: str) -> str:
    depth = 0
    quote: str | None = None
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {"'", '"', "`"}:
            quote = char
            continue
        if char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    raise ValueError(f"Unclosed {opener} at offset {start}")


def _top_level_objects(array_text: str) -> list[str]:
    objects: list[str] = []
    index = 0
    while index < len(array_text):
        if array_text[index] == "{":
            item = _balanced_span(array_text, index, "{", "}")
            objects.append(item)
            index += len(item)
            continue
        index += 1
    return objects


def _string_field(obj: str, field: str) -> str | None:
    match = re.search(rf"\b{re.escape(field)}\s*:\s*'([^']*)'", obj)
    return match.group(1) if match else None


def _string_array_field(obj: str, field: str) -> tuple[str, ...]:
    match = re.search(rf"\b{re.escape(field)}\s*:\s*\[([^\]]*)\]", obj, re.DOTALL)
    if not match:
        return ()
    return tuple(re.findall(r"'([^']*)'", match.group(1)))


def _method_from_inventory(item: dict[str, Any]) -> MethodDescriptor:
    bus_topic = item.get("bus_topic")
    if not isinstance(bus_topic, str) or not bus_topic:
        raise ValueError(f"Inventory method is missing bus_topic: {item!r}")
    return MethodDescriptor(
        bus_topic=bus_topic,
        module=str(item.get("module") or ""),
        name=str(item.get("name") or ""),
        route_path=item.get("routePath") or item.get("route_path"),
        route_kind=str(item.get("route_kind") or ""),
        exposure=str(item.get("exposure") or ""),
        method_type=str(item.get("method_type") or ""),
        required_perms=tuple(item.get("required_perms") or ()),
        input_model=item.get("input_model"),
        output_model=item.get("output_model"),
    )


def _builtin_from_inventory(item: dict[str, Any]) -> GatewayBuiltinDescriptor | None:
    route_path = item.get("routePath") or item.get("route_path")
    if not isinstance(route_path, str) or not route_path:
        return None
    return GatewayBuiltinDescriptor(
        route_path=route_path,
        http_methods=tuple(item.get("http_methods") or ()),
        method_type=str(item.get("method_type") or ""),
        required_perms=tuple(item.get("required_perms") or ()),
    )


def _parse_sdk_fixture(
    path: Path,
) -> tuple[dict[str, MethodDescriptor], dict[str, GatewayBuiltinDescriptor]]:
    text = path.read_text()
    fixture = _find_assignment_object(text, "backendInventoryFixture")
    methods = {}
    for obj in _top_level_objects(_find_field_array(fixture, "methods")):
        bus_topic = _string_field(obj, "bus_topic")
        if not bus_topic:
            continue
        methods[bus_topic] = MethodDescriptor(
            bus_topic=bus_topic,
            module=_string_field(obj, "module") or "",
            name=_string_field(obj, "name") or "",
            route_path=_string_field(obj, "routePath"),
            route_kind=_string_field(obj, "route_kind") or "",
            exposure=_string_field(obj, "exposure") or "",
            method_type=_string_field(obj, "method_type") or "",
            required_perms=_string_array_field(obj, "required_perms"),
            input_model=_string_field(obj, "input_model"),
            output_model=_string_field(obj, "output_model"),
        )

    builtins = {}
    for obj in _top_level_objects(_find_field_array(fixture, "gateway_builtins")):
        route_path = _string_field(obj, "routePath")
        if not route_path:
            continue
        builtins[route_path] = GatewayBuiltinDescriptor(
            route_path=route_path,
            http_methods=_string_array_field(obj, "http_methods"),
            method_type=_string_field(obj, "method_type") or "",
            required_perms=_string_array_field(obj, "required_perms"),
        )
    return methods, builtins


def _parse_typescript_interface_fields(path: Path, interface_name: str) -> dict[str, bool]:
    text = path.read_text()
    match = re.search(rf"\bexport\s+interface\s+{re.escape(interface_name)}\b", text)
    if match is None:
        raise ValueError(f"Could not find {interface_name} interface in {path}")
    brace = text.find("{", match.end())
    if brace < 0:
        raise ValueError(f"Could not find {interface_name} interface body in {path}")
    body = _balanced_span(text, brace, "{", "}")

    fields: dict[str, bool] = {}
    for line in body[1:-1].splitlines():
        match = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:", line)
        if match:
            fields[match.group(1)] = "?" in line[: line.find(":")]
    return fields


def _parse_sdk_type_surface(path: Path) -> dict[str, dict[str, bool]]:
    return {
        interface_name: _parse_typescript_interface_fields(path, interface_name)
        for interface_name in SDK_TYPE_INTERFACES
    }


def _check_required_type_fields(
    item: dict[str, Any],
    fields: dict[str, bool],
    *,
    kind: str,
    item_id: str,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for field, optional in sorted(fields.items()):
        if not optional and field not in item:
            issues.append(
                {
                    "fatal": True,
                    "kind": f"{kind}_missing_sdk_required_field",
                    "field": field,
                    "item": item_id,
                }
            )
    return issues


def _check_unknown_type_fields(
    item: dict[str, Any],
    fields: dict[str, bool],
    *,
    kind: str,
    item_id: str,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for field in sorted(set(item) - set(fields)):
        issues.append(
            {
                "fatal": True,
                "kind": f"{kind}_field_missing_from_sdk_type",
                "field": field,
                "item": item_id,
            }
        )
    return issues


def _check_sdk_type_surface(
    inventory: dict[str, Any],
    sdk_types_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    surface = _parse_sdk_type_surface(sdk_types_path)
    issues: list[dict[str, Any]] = []

    inventory_fields = surface["BackendInventory"]
    method_fields = surface["BackendInventoryMethod"]
    builtin_fields = surface["GatewayBuiltinInventoryRoute"]

    issues.extend(
        _check_required_type_fields(
            inventory,
            inventory_fields,
            kind="backend_inventory",
            item_id="$",
        )
    )
    issues.extend(
        _check_unknown_type_fields(
            inventory,
            inventory_fields,
            kind="backend_inventory",
            item_id="$",
        )
    )

    for method in inventory.get("methods", []):
        if not isinstance(method, dict):
            issues.append(
                {"fatal": True, "kind": "backend_inventory_method_not_object", "item": repr(method)}
            )
            continue
        item_id = str(method.get("bus_topic") or method.get("name") or "<unknown>")
        issues.extend(
            _check_required_type_fields(
                method,
                method_fields,
                kind="backend_inventory_method",
                item_id=item_id,
            )
        )
        issues.extend(
            _check_unknown_type_fields(
                method,
                method_fields,
                kind="backend_inventory_method",
                item_id=item_id,
            )
        )

    for route in inventory.get("gateway_builtins", []):
        if not isinstance(route, dict):
            issues.append(
                {"fatal": True, "kind": "gateway_builtin_route_not_object", "item": repr(route)}
            )
            continue
        item_id = str(route.get("routePath") or route.get("route_path") or "<unknown>")
        issues.extend(
            _check_required_type_fields(
                route,
                builtin_fields,
                kind="gateway_builtin_route",
                item_id=item_id,
            )
        )
        issues.extend(
            _check_unknown_type_fields(
                route,
                builtin_fields,
                kind="gateway_builtin_route",
                item_id=item_id,
            )
        )

    evidence = {
        "sdk_types": _rel(sdk_types_path),
        "interfaces": {
            name: {
                "required": sorted(field for field, optional in fields.items() if not optional),
                "optional": sorted(field for field, optional in fields.items() if optional),
            }
            for name, fields in surface.items()
        },
        "checked": {
            "backend_inventory_fields": len(inventory),
            "backend_inventory_methods": len(inventory.get("methods", [])),
            "gateway_builtin_routes": len(inventory.get("gateway_builtins", [])),
            "issues": len(issues),
        },
    }
    return issues, evidence


def _inventory_descriptors(
    inventory: dict[str, Any],
) -> tuple[dict[str, MethodDescriptor], dict[str, GatewayBuiltinDescriptor]]:
    methods = {
        descriptor.bus_topic: descriptor
        for descriptor in (_method_from_inventory(item) for item in inventory.get("methods", []))
    }
    builtins = {
        descriptor.route_path: descriptor
        for descriptor in (
            _builtin_from_inventory(item) for item in inventory.get("gateway_builtins", [])
        )
        if descriptor is not None
    }
    return methods, builtins


def _compare_descriptors(
    live: dict[str, MethodDescriptor],
    sdk: dict[str, MethodDescriptor],
    *,
    strict_sdk_coverage: bool,
    strict_field_drift: bool,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for bus_topic in sorted(set(live) - set(sdk)):
        kind = "missing_sdk_fixture_method" if strict_sdk_coverage else "sdk_fixture_coverage_gap"
        issues.append({"fatal": strict_sdk_coverage, "kind": kind, "bus_topic": bus_topic})
    for bus_topic in sorted(set(sdk) - set(live)):
        if bus_topic in SDK_MOCK_ONLY_METHODS:
            issues.append({"fatal": False, "kind": "sdk_mock_only_method", "bus_topic": bus_topic})
            continue
        issues.append({"fatal": True, "kind": "stale_sdk_fixture_method", "bus_topic": bus_topic})
    for bus_topic in sorted(set(live) & set(sdk)):
        live_item = live[bus_topic]
        sdk_item = sdk[bus_topic]
        for field in (
            "module",
            "name",
            "route_path",
            "exposure",
            "input_model",
            "output_model",
        ):
            live_value = getattr(live_item, field)
            sdk_value = getattr(sdk_item, field)
            if (
                field in {"input_model", "output_model"}
                and live_value != sdk_value
                and not strict_field_drift
            ):
                issues.append(
                    {
                        "fatal": False,
                        "kind": "sdk_fixture_model_drift",
                        "bus_topic": bus_topic,
                        "field": field,
                        "live": live_value,
                        "sdk_fixture": sdk_value,
                    }
                )
                continue
            if live_value != sdk_value:
                issues.append(
                    {
                        "fatal": True,
                        "kind": "sdk_fixture_method_drift",
                        "bus_topic": bus_topic,
                        "field": field,
                        "live": live_value,
                        "sdk_fixture": sdk_value,
                    }
                )
        for field in ("route_kind", "method_type", "required_perms"):
            live_value = getattr(live_item, field)
            sdk_value = getattr(sdk_item, field)
            if live_value != sdk_value:
                issues.append(
                    {
                        "fatal": strict_field_drift,
                        "kind": "sdk_fixture_policy_exposure_drift",
                        "bus_topic": bus_topic,
                        "field": field,
                        "live": live_value,
                        "sdk_fixture": sdk_value,
                    }
                )
    return issues


def _compare_builtins(
    live: dict[str, GatewayBuiltinDescriptor],
    sdk: dict[str, GatewayBuiltinDescriptor],
    *,
    strict_sdk_coverage: bool,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for route_path in sorted(set(live) - set(sdk)):
        kind = (
            "missing_sdk_fixture_builtin"
            if strict_sdk_coverage
            else "sdk_fixture_builtin_coverage_gap"
        )
        issues.append({"fatal": strict_sdk_coverage, "kind": kind, "routePath": route_path})
    for route_path in sorted(set(sdk) - set(live)):
        issues.append({"fatal": True, "kind": "stale_sdk_fixture_builtin", "routePath": route_path})
    for route_path in sorted(set(live) & set(sdk)):
        live_item = live[route_path]
        sdk_item = sdk[route_path]
        for field in ("http_methods", "method_type", "required_perms"):
            live_value = getattr(live_item, field)
            sdk_value = getattr(sdk_item, field)
            if live_value != sdk_value:
                issues.append(
                    {
                        "fatal": True,
                        "kind": "sdk_fixture_builtin_drift",
                        "routePath": route_path,
                        "field": field,
                        "live": live_value,
                        "sdk_fixture": sdk_value,
                    }
                )
    return issues


def _check_inventory_metadata(
    inventory: dict[str, Any], *, strict_imports: bool
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    methods = inventory.get("methods", [])
    builtins = inventory.get("gateway_builtins", [])
    if inventory.get("generated_by") != "scripts/generate_backend_inventory.py":
        issues.append(
            {
                "fatal": True,
                "kind": "unexpected_generator",
                "generated_by": inventory.get("generated_by"),
            }
        )
    if inventory.get("method_count") != len(methods):
        issues.append(
            {
                "fatal": True,
                "kind": "method_count_mismatch",
                "declared": inventory.get("method_count"),
                "actual": len(methods),
            }
        )
    if inventory.get("gateway_builtin_count") != len(builtins):
        issues.append(
            {
                "fatal": True,
                "kind": "gateway_builtin_count_mismatch",
                "declared": inventory.get("gateway_builtin_count"),
                "actual": len(builtins),
            }
        )
    if inventory.get("import_errors"):
        issues.append(
            {
                "fatal": strict_imports,
                "kind": "backend_import_errors",
                "errors": inventory["import_errors"],
            }
        )
    fixture_validation = inventory.get("ui_fixture_validation") or {}
    if fixture_validation.get("ok") is not True:
        issues.append(
            {"fatal": True, "kind": "ui_fixture_validation_failed", "details": fixture_validation}
        )
    openapi_paths = set(inventory.get("gateway_openapi_paths") or [])
    for route in builtins:
        route_path = route.get("routePath") or route.get("route_path")
        if (
            route_path
            and route_path not in openapi_paths
            and route_path not in DOC_ONLY_OPENAPI_PATHS
        ):
            issues.append(
                {
                    "fatal": True,
                    "kind": "gateway_builtin_missing_from_openapi",
                    "routePath": route_path,
                }
            )
    return issues


def _find_secret_values(value: Any, path: str = "$") -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            findings.extend(_find_secret_values(item, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            findings.extend(_find_secret_values(item, f"{path}[{index}]"))
    elif isinstance(value, str):
        for pattern in SECRET_VALUE_PATTERNS:
            if pattern.search(value):
                findings.append(
                    {"fatal": True, "kind": "possible_unredacted_secret_value", "path": path}
                )
                break
    return findings


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def build_report(
    inventory_path: Path,
    sdk_fixture_path: Path,
    sdk_types_path: Path,
    *,
    strict_imports: bool,
    strict_sdk_coverage: bool,
    strict_field_drift: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    inventory = _read_json(inventory_path)
    live_methods, live_builtins = _inventory_descriptors(inventory)
    sdk_methods, sdk_builtins = _parse_sdk_fixture(sdk_fixture_path)

    issues = []
    issues.extend(_check_inventory_metadata(inventory, strict_imports=strict_imports))
    sdk_type_issues, sdk_type_surface = _check_sdk_type_surface(inventory, sdk_types_path)
    issues.extend(sdk_type_issues)
    issues.extend(
        _compare_descriptors(
            live_methods,
            sdk_methods,
            strict_sdk_coverage=strict_sdk_coverage,
            strict_field_drift=strict_field_drift,
        )
    )
    issues.extend(
        _compare_builtins(live_builtins, sdk_builtins, strict_sdk_coverage=strict_sdk_coverage)
    )
    issues.extend(_find_secret_values(inventory))
    fatal_issues = [issue for issue in issues if issue.get("fatal", True)]

    permission_exposure_matrix = [
        {
            "bus_topic": method.bus_topic,
            "module": method.module,
            "method": method.name,
            "routePath": method.route_path,
            "route_kind": method.route_kind,
            "exposure": method.exposure,
            "method_type": method.method_type,
            "required_perms": list(method.required_perms),
            "available_over_http": method.exposure in {"external", "both"},
        }
        for method in sorted(live_methods.values(), key=lambda item: item.bus_topic)
    ]
    evidence = {
        "backend_method_descriptors": [
            asdict(item) for item in sorted(live_methods.values(), key=lambda item: item.bus_topic)
        ],
        "gateway_builtin_descriptors": [
            asdict(item)
            for item in sorted(live_builtins.values(), key=lambda item: item.route_path)
        ],
        "permission_exposure_matrix": permission_exposure_matrix,
        "openapi_paths": inventory.get("gateway_openapi_paths") or [],
        "sdk_type_surface": sdk_type_surface,
    }
    report = {
        "ok": not fatal_issues,
        "owner": "aurora-engineer",
        "inventory": _rel(inventory_path),
        "sdk_fixture": _rel(sdk_fixture_path),
        "sdk_types": _rel(sdk_types_path),
        "checked": {
            "backend_methods": len(live_methods),
            "sdk_fixture_methods": len(sdk_methods),
            "gateway_builtins": len(live_builtins),
            "sdk_fixture_builtins": len(sdk_builtins),
            "openapi_paths": len(inventory.get("gateway_openapi_paths") or []),
            "sdk_type_surface_issues": len(sdk_type_issues),
            "fatal_issues": len(fatal_issues),
            "non_fatal_findings": len(issues) - len(fatal_issues),
        },
        "strict": {
            "imports": strict_imports,
            "sdk_coverage": strict_sdk_coverage,
            "field_drift": strict_field_drift,
        },
        "security_privacy_negative_cases": [
            "auth",
            "permission",
            "validation",
            "timeout",
            "unavailable_service",
            "unsupported_feature",
            "privacy_blocked",
            "native_permission_missing",
            "transport_loss",
            "possible_unredacted_secret_value",
        ],
        "issues": fatal_issues,
        "findings": issues,
    }
    return report, evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--inventory", type=Path, required=True, help="Generated backend inventory JSON"
    )
    parser.add_argument(
        "--sdk-fixture", type=Path, default=DEFAULT_SDK_FIXTURE, help="SDK fixtures.ts path"
    )
    parser.add_argument(
        "--sdk-types",
        type=Path,
        default=DEFAULT_SDK_TYPES,
        help="SDK types.ts path used to validate backend inventory type surface",
    )
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        default=DEFAULT_EVIDENCE_DIR,
        help="Directory for evidence artifacts",
    )
    parser.add_argument(
        "--strict-imports",
        action="store_true",
        help="Fail on optional backend service import errors",
    )
    parser.add_argument(
        "--strict-sdk-coverage",
        action="store_true",
        help="Require SDK fixture coverage for every backend method",
    )
    parser.add_argument(
        "--strict-field-drift",
        action="store_true",
        help="Fail on model, permission, and method-type fixture drift",
    )
    args = parser.parse_args()

    report, evidence = build_report(
        args.inventory,
        args.sdk_fixture,
        args.sdk_types,
        strict_imports=args.strict_imports,
        strict_sdk_coverage=args.strict_sdk_coverage,
        strict_field_drift=args.strict_field_drift,
    )
    args.evidence_dir.mkdir(parents=True, exist_ok=True)
    _write_json(args.evidence_dir / "conformance-report.json", report)
    _write_json(
        args.evidence_dir / "backend-method-descriptors.json",
        evidence["backend_method_descriptors"],
    )
    _write_json(
        args.evidence_dir / "gateway-builtin-descriptors.json",
        evidence["gateway_builtin_descriptors"],
    )
    _write_json(
        args.evidence_dir / "permission-exposure-matrix.json",
        evidence["permission_exposure_matrix"],
    )
    _write_json(args.evidence_dir / "openapi-paths.json", evidence["openapi_paths"])
    _write_json(args.evidence_dir / "sdk-type-surface.json", evidence["sdk_type_surface"])

    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
