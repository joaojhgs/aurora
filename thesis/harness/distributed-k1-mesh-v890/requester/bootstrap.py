"""Pinned bootstrap for the private exact-peer K1 mesh condition."""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import runpy
import sys
import time
from pathlib import Path
from typing import Any


def _regular(path: Path) -> bool:
    return not path.is_symlink() and path.is_file()


def _sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_exclusive(path: Path, value: dict[str, Any]) -> None:
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())


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


def main() -> None:
    os.umask(0o077)
    root = Path(os.environ["AURORA_K1_CONTROL_ROOT"]).resolve(strict=True)
    runner = Path(os.environ["AURORA_K1_RUNNER_PATH"]).resolve(strict=True)
    bindings = Path(os.environ["AURORA_K1_BINDINGS_PATH"]).resolve(strict=True)
    telemetry = Path(os.environ["AURORA_K1_TELEMETRY_PATH"]).resolve(strict=True)
    observer = Path(os.environ["AURORA_K1_ROUTE_OBSERVER_PATH"]).resolve(strict=True)
    sink_module = Path(os.environ["AURORA_K1_ROUTE_SINK_PATH"]).resolve(strict=True)
    cohort_path = Path(os.environ["AURORA_FROZEN_MANIFEST"]).resolve(strict=True)
    candidate_path = Path(os.environ["AURORA_CANDIDATE_MANIFEST"]).resolve(strict=True)
    stage_output = Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"])
    observations_path = Path(os.environ["AURORA_K1_MESH_ROUTE_OBSERVATIONS"])
    status_path = Path(os.environ["AURORA_K1_MESH_ROUTE_SINK_STATUS"])
    runtime_receipt = Path(os.environ["AURORA_K1_MESH_ROUTE_RUNTIME_PINS"])

    for path in (runner, bindings, telemetry, observer, sink_module, cohort_path, candidate_path):
        if not _regular(path):
            raise SystemExit("k1_source_binding_unavailable")
    cohort_bytes = cohort_path.read_bytes()
    cohort = json.loads(cohort_bytes)
    if hashlib.sha256(cohort_bytes).hexdigest() != os.environ.get("AURORA_FROZEN_MANIFEST_SHA256"):
        raise SystemExit("frozen_manifest_hash_mismatch")
    expected_impl = cohort.get("implementation", {})
    if (_sha(observer) != expected_impl.get("routeObserverSha256")
            or _sha(sink_module) != expected_impl.get("routeSinkSha256")):
        raise SystemExit("mesh_route_observer_source_hash_mismatch")
    pins, pin_evidence = _read_runtime_pins(root, cohort)

    sys.path.insert(0, str(bindings.parent))
    import bindings as bindings_module  # noqa: PLC0415

    bindings_module.install()
    for module_name in ("aiortc.rtcpeerconnection", "aiortc.rtcicetransport", "aioice.ice"):
        importlib.import_module(module_name)
    _verify_loaded_modules(pins)
    sys.path.insert(0, str(root))
    import mesh_route_observer  # noqa: PLC0415
    from route_observation_sink import RouteObservationSink  # noqa: PLC0415
    from app.shared.contracts.models.tts import TTSMethods  # noqa: PLC0415
    from app.services.gateway.mesh.peer_bridge import PeerBridge  # noqa: PLC0415

    if (Path(mesh_route_observer.__file__).resolve() != observer
            or _sha(Path(mesh_route_observer.__file__)) != expected_impl.get("routeObserverSha256")
            or Path(sys.modules["route_observation_sink"].__file__).resolve() != sink_module
            or _sha(Path(sys.modules["route_observation_sink"].__file__)) != expected_impl.get("routeSinkSha256")):
        raise SystemExit("mesh_route_observer_import_path_mismatch")
    installed_route = {
        "schema": "aurora.mesh_route_runtime_install.v1",
        "status": "verified_before_observer_install",
        "frozen_manifest_sha256": hashlib.sha256(cohort_bytes).hexdigest(),
        "route_observer_sha256": _sha(observer),
        "route_sink_sha256": _sha(sink_module),
        "runtime_pins_sha256": pin_evidence["sha256"],
        "path_file_sha256": pin_evidence["path_file_sha256"],
        "runtime_prefix": sys.prefix,
        "packages": pins["packages"],
        "resolved_source_files": pin_evidence["resolved_files"],
        "observation_limit": "before_after_snapshots_all_pc_transports_no_pair_id_no_continuous_stability",
    }
    _write_exclusive(runtime_receipt, installed_route)

    sink = RouteObservationSink(observations_path, status_path)
    sink.start()
    run_error = False
    try:
        mesh_route_observer.install_peer_bridge_observer(
            PeerBridge, sink.write, topic_filter=TTSMethods.SYNTHESIZE)
        sys.path.insert(0, str(telemetry.parent))
        namespace = runpy.run_path(str(telemetry))
        install = namespace.get("install")
        if not callable(install):
            raise SystemExit("k1_observer_install_missing")
        install()
        stage_output.with_suffix(".installed.json").write_text(
            json.dumps({"pid": os.getpid(), "installed": True, "monotonic_ns": time.monotonic_ns(),
                        "route_runtime_pins_sha256": pin_evidence["sha256"]}) + "\n"
        )
        versions: dict[str, str | None] = {}
        for package in ("faster-whisper", "ctranslate2", "llama-cpp-python", "piper-tts", "onnxruntime", "numpy"):
            try:
                versions[package] = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                versions[package] = None
        versions["aiortc"] = pins["packages"]["aiortc"]["version"]
        versions["aioice"] = pins["packages"]["aioice"]["version"]
        _write_exclusive(stage_output.with_name("runtime-versions.json"), {
            "pid": os.getpid(), "packages": versions,
            "route_runtime_pins_sha256": pin_evidence["sha256"],
        })
        runpy.run_path(str(runner), run_name="__main__")
    except BaseException:
        run_error = True
        raise
    finally:
        complete = sink.close()
        if not complete and not run_error:
            raise SystemExit("mesh_route_observation_drain_incomplete")


if __name__ == "__main__":
    main()
