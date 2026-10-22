"""Exact retained helper functions; no historical runner/bootstrap entrypoint."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
from typing import Any


def _regular(path: Path) -> bool:
    return not path.is_symlink() and path.is_file()


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_runtime_pins(root: Path, cohort: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    pins_path = root / "route_runtime_pins.json"
    if not _regular(pins_path):
        raise SystemExit("mesh_route_runtime_pins_missing")
    pin_bytes = pins_path.read_bytes()
    pin_sha = hashlib.sha256(pin_bytes).hexdigest()
    implementation = cohort.get("implementation", {})
    if pin_sha != implementation.get("routeRuntimePinsSha256"):
        raise SystemExit("mesh_route_runtime_pins_hash_mismatch")
    pins = json.loads(pin_bytes)
    if (not isinstance(pins, dict) or pins.get("schema") != "aurora.mesh_route_runtime_pins.v1"
            or pins.get("runtimePrefix") != sys.prefix):
        raise SystemExit("mesh_route_runtime_prefix_mismatch")

    pth = pins.get("pathFile")
    if not isinstance(pth, dict):
        raise SystemExit("mesh_route_python_path_pin_missing")
    pth_path = Path(sys.prefix) / pth.get("relativePath", "")
    if (not _regular(pth_path) or pth_path.stat().st_size != pth.get("bytes")
            or _sha(pth_path) != pth.get("sha256")):
        raise SystemExit("mesh_route_python_path_pin_mismatch")
    try:
        declared_added = pth_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        raise SystemExit("mesh_route_python_path_file_unreadable") from None
    if declared_added != pth.get("addedPaths"):
        raise SystemExit("mesh_route_python_path_order_mismatch")

    search_roots = pins.get("searchRoots")
    if not isinstance(search_roots, list) or len(search_roots) != 3:
        raise SystemExit("mesh_route_search_roots_invalid")
    normalized_sys_path = [str(Path(item or ".").resolve()) for item in sys.path]
    root_positions: list[int] = []
    for item in search_roots:
        resolved = str(Path(item).resolve())
        if resolved not in normalized_sys_path:
            raise SystemExit("mesh_route_search_root_not_active")
        root_positions.append(normalized_sys_path.index(resolved))
    if root_positions != sorted(root_positions) or len(set(root_positions)) != 3:
        raise SystemExit("mesh_route_search_root_order_mismatch")

    first_root = Path(pins.get("firstLocatedRoot", "")).resolve()
    if str(first_root) != pins.get("firstLocatedRoot"):
        raise SystemExit("mesh_route_first_root_not_canonical")
    resolved_files: list[dict[str, Any]] = []
    packages = pins.get("packages")
    if not isinstance(packages, dict) or set(packages) != {"aiortc", "aioice"}:
        raise SystemExit("mesh_route_package_pins_invalid")
    for package_name, package in packages.items():
        if not isinstance(package, dict) or not isinstance(package.get("files"), list):
            raise SystemExit("mesh_route_package_files_invalid")
        metadata_rows = [row for row in package["files"] if ".dist-info/METADATA" in row.get("relativePath", "")]
        if len(metadata_rows) != 1:
            raise SystemExit("mesh_route_package_metadata_pin_invalid")
        metadata_row = metadata_rows[0]
        located_metadata: Path | None = None
        for candidate_root in map(Path, search_roots):
            candidate = candidate_root / metadata_row["relativePath"]
            if candidate.exists():
                located_metadata = candidate
                break
        if located_metadata is None or located_metadata.parent.parent.resolve() != first_root:
            raise SystemExit("mesh_route_package_metadata_resolution_mismatch")
        if (not _regular(located_metadata) or located_metadata.stat().st_size != metadata_row.get("bytes")
                or _sha(located_metadata) != metadata_row.get("sha256")):
            raise SystemExit("mesh_route_package_metadata_hash_mismatch")
        try:
            version_line = next(line for line in located_metadata.read_text(encoding="utf-8").splitlines()
                                if line.startswith("Version:"))
        except (OSError, UnicodeError, StopIteration):
            raise SystemExit("mesh_route_package_version_unavailable") from None
        if version_line.partition(":")[2].strip() != package.get("version"):
            raise SystemExit("mesh_route_package_version_mismatch")
        for row in package["files"]:
            relative = row.get("relativePath")
            if not isinstance(relative, str):
                raise SystemExit("mesh_route_package_path_invalid")
            resolved: Path | None = None
            resolved_root: Path | None = None
            for candidate_root in map(Path, search_roots):
                candidate = candidate_root / relative
                if candidate.exists():
                    resolved = candidate
                    resolved_root = candidate_root.resolve()
                    break
            if (resolved is None or resolved_root != first_root
                    or resolved.resolve() != (first_root / relative).resolve()
                    or not _regular(resolved) or resolved.stat().st_size != row.get("bytes")
                    or _sha(resolved) != row.get("sha256")):
                raise SystemExit("mesh_route_package_source_hash_mismatch")
            resolved_files.append({"package": package_name, "relative_path": relative,
                                   "resolved_path": str(resolved.resolve()),
                                   "bytes": row["bytes"], "sha256": row["sha256"]})
    return pins, {"sha256": pin_sha, "resolved_files": resolved_files, "path_file_sha256": _sha(pth_path)}


def _verify_loaded_modules(pins: dict[str, Any]) -> None:
    modules = pins.get("loadedModules")
    if not isinstance(modules, dict):
        raise SystemExit("mesh_route_loaded_module_pins_missing")
    for module_name, relative in modules.items():
        module = sys.modules.get(module_name)
        loaded_path = getattr(module, "__file__", None) if module is not None else None
        if not isinstance(loaded_path, str):
            raise SystemExit("mesh_route_runtime_module_not_loaded")
        expected = Path(pins["firstLocatedRoot"]) / relative
        actual = Path(loaded_path)
        if (actual.resolve() != expected.resolve() or not _regular(actual)
                or _sha(actual) != _expected_hash(pins, relative)):
            raise SystemExit("mesh_route_loaded_module_source_mismatch")


def _expected_hash(pins: dict[str, Any], relative: str) -> str:
    for package in pins["packages"].values():
        for row in package["files"]:
            if row["relativePath"] == relative:
                return row["sha256"]
    raise SystemExit("mesh_route_loaded_module_hash_missing")
