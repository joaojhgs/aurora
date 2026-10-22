"""Fail-closed future launcher for the existing authenticated Gateway TTS receiver.

This draft never selects a listener, route, credential, model, or config. Root
must stage and independently admit every binding before invoking it.
"""
from __future__ import annotations

import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import runpy
import shutil
import signal
import socket
import stat
import subprocess
import time
from urllib.parse import urlsplit

os.umask(0o077)
ROOT = pathlib.Path(os.environ.get("AURORA_K1_PROVIDER_ROOT", ""))
INPUT = ROOT / "input"
HOOK = ROOT / "hook"
RUN = ROOT / "runtime"
MANIFEST = INPUT / "provider-manifest.json"
CONFIG = INPUT / "launch-config.json"
ENV_FILE = INPUT / "existing-private.env"
IDENTITY_FILE = RUN / "receiver-identity.json"
OUTER_CAP = 57_840
RAM_FLOOR = 2_000_000_000
DISK_FLOOR = 500_000_000
RAW_CAP = 512_000_000
API_KEY_ENV = "AURORA_HOSTED_PEER_GATEWAY_API_KEY"

child: subprocess.Popen[bytes] | None = None
lock_handles: list[object] = []
start = time.monotonic()
record: dict[str, object] = {
    "schema": "aurora.distributed_k1_gateway_receiver_control.v1",
    "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "measurement_started": False,
    "credential_value_logged": False,
    "listener_selected_by_controller": False,
}


def _regular(path: pathlib.Path) -> bool:
    return not path.is_symlink() and path.is_file()


def _no_symlink(path: pathlib.Path) -> bool:
    absolute = pathlib.Path(os.path.abspath(path))
    return not any(parent.is_symlink() for parent in (absolute, *absolute.parents))


def _sha(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _mem_available() -> int:
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("memory_admission_unavailable")


def _raw_bytes() -> int:
    total = 0
    for path in RUN.rglob("*"):
        try:
            entry = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(entry.st_mode):
            total += entry.st_size
    return total


def _write_json(path: pathlib.Path, value: object, *, exclusive: bool = False) -> None:
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _stop_owned() -> None:
    if child is None or child.poll() is not None:
        return
    for sig, timeout in ((signal.SIGINT, 15), (signal.SIGTERM, 8), (signal.SIGKILL, 3)):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            continue


def _terminate(signum: int, frame: object) -> None:
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, _terminate)


def _check_file_entry(entry: object, *, root: pathlib.Path | None = None) -> pathlib.Path:
    if not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"}:
        raise RuntimeError("frozen_file_entry_invalid")
    raw, size, expected_sha = entry["path"], entry["bytes"], entry["sha256"]
    if (not isinstance(raw, str) or isinstance(size, bool) or not isinstance(size, int)
            or not isinstance(expected_sha, str) or len(expected_sha) != 64):
        raise RuntimeError("frozen_file_metadata_invalid")
    path = pathlib.Path(raw)
    if root is not None:
        rel = pathlib.PurePosixPath(raw)
        if rel.is_absolute() or ".." in rel.parts:
            raise RuntimeError("source_inventory_path_invalid")
        path = root.joinpath(*rel.parts)
    if not path.is_absolute() or not _no_symlink(path) or not _regular(path):
        raise RuntimeError("frozen_file_unavailable_or_symlinked")
    if path.stat().st_size != size or _sha(path) != expected_sha:
        raise RuntimeError("frozen_file_hash_or_size_mismatch")
    return path


def _verify_admission(manifest: dict[str, object]) -> dict[str, object]:
    admission = manifest.get("admission_receipt")
    if not isinstance(admission, dict):
        raise RuntimeError("independent_predecessor_resource_admission_missing")
    receipt_path = pathlib.Path(str(admission.get("path", "")))
    if not receipt_path.is_absolute() or not _regular(receipt_path) or not _no_symlink(receipt_path):
        raise RuntimeError("independent_admission_receipt_unavailable")
    data = receipt_path.read_bytes()
    if hashlib.sha256(data).hexdigest() != admission.get("sha256"):
        raise RuntimeError("independent_admission_receipt_hash_mismatch")
    receipt = json.loads(data)
    if (not isinstance(receipt, dict) or receipt.get("status") != "admitted"
            or receipt.get("retired_predecessors_verified") is not True
            or receipt.get("approved_private_gateway_binding_verified") is not True
            or not isinstance(receipt.get("gateway_endpoint_sha256"), str)
            or len(receipt["gateway_endpoint_sha256"]) != 64
            or not isinstance(receipt.get("gateway_bind_host"), str)
            or type(receipt.get("gateway_bind_port")) is not int):
        raise RuntimeError("independent_admission_receipt_not_approved")
    pids = receipt.get("predecessor_pids")
    if (not isinstance(pids, list) or not pids
            or any(type(pid) is not int or pid <= 0 for pid in pids)):
        raise RuntimeError("predecessor_pid_receipt_invalid")
    if any(pathlib.Path(f"/proc/{pid}").exists() for pid in pids):
        raise RuntimeError("predecessor_process_still_live")
    locks = receipt.get("required_free_lock_paths")
    if (not isinstance(locks, list) or not locks
            or "/tmp/aurora-global-build.lock" not in locks):
        raise RuntimeError("admitted_lock_receipt_missing")
    for raw in locks:
        if (not isinstance(raw, str) or not pathlib.Path(raw).is_absolute()
                or not _no_symlink(pathlib.Path(raw))):
            raise RuntimeError("admitted_lock_path_invalid")
        handle = pathlib.Path(raw).open("a")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            raise RuntimeError("required_predecessor_lock_not_free") from None
        lock_handles.append(handle)
    return {"receipt_sha256": hashlib.sha256(data).hexdigest(),
            "predecessor_pids_absent": len(pids), "locks_acquired": len(locks),
            "gateway_endpoint_sha256": receipt["gateway_endpoint_sha256"],
            "gateway_bind_host": receipt["gateway_bind_host"],
            "gateway_bind_port": receipt["gateway_bind_port"]}


def main() -> int:
    global child
    try:
        if (not ROOT.is_absolute() or ROOT.is_symlink() or not ROOT.is_dir()
                or not _no_symlink(ROOT) or RUN.exists() or RUN.is_symlink()
                or not INPUT.is_dir() or not _no_symlink(INPUT)
                or not HOOK.is_dir() or not _no_symlink(HOOK)):
            raise RuntimeError("private_provider_root_unavailable_or_runtime_not_fresh")
        if (not _regular(MANIFEST) or not _no_symlink(MANIFEST)
                or not _regular(CONFIG) or not _no_symlink(CONFIG)
                or not _regular(ENV_FILE) or not _no_symlink(ENV_FILE)):
            raise RuntimeError("staged_provider_input_missing_or_symlinked")
        expected_manifest_sha = os.environ.get("AURORA_K1_PROVIDER_MANIFEST_SHA256", "")
        if len(expected_manifest_sha) != 64 or _sha(MANIFEST) != expected_manifest_sha:
            raise RuntimeError("independent_provider_manifest_pin_missing_or_mismatch")
        manifest = json.loads(MANIFEST.read_bytes())
        if not isinstance(manifest, dict) or manifest.get("schema") != "aurora.distributed_k1_gateway_receiver.v1":
            raise RuntimeError("provider_manifest_schema_invalid")
        harness_files = (ROOT / "bootstrap.py", ROOT / "resource_sample.py", HOOK / "bindings.py", HOOK / "observer.py",
                         HOOK / "aurora_voice_telemetry_v430.py")
        if any(not _regular(path) or not _no_symlink(path) for path in harness_files):
            raise RuntimeError("provider_observer_source_missing_or_symlinked")
        if manifest.get("implementation") != {
            "controller_sha256": _sha(pathlib.Path(__file__)),
            "bootstrap_sha256": _sha(ROOT / "bootstrap.py"),
            "resource_sampler_sha256": _sha(ROOT / "resource_sample.py"),
            "bindings_sha256": _sha(HOOK / "bindings.py"),
            "observer_sha256": _sha(HOOK / "observer.py"),
            "telemetry_sha256": _sha(HOOK / "aurora_voice_telemetry_v430.py"),
        }:
            raise RuntimeError("provider_harness_source_pin_mismatch")
        sample_resources = runpy.run_path(str(ROOT / "resource_sample.py"))["sample_resources"]
        admission = _verify_admission(manifest)

        source = manifest.get("source")
        if not isinstance(source, dict):
            raise RuntimeError("provider_source_binding_missing")
        source_root = pathlib.Path(str(source.get("root", "")))
        inventory_path = pathlib.Path(str(source.get("inventory_path", "")))
        if (not source_root.is_absolute() or not source_root.is_dir() or source_root.is_symlink()
                or not _no_symlink(source_root) or not _regular(inventory_path)
                or not _no_symlink(inventory_path)
                or _sha(inventory_path) != source.get("inventory_sha256")):
            raise RuntimeError("provider_source_inventory_binding_invalid")
        inventory = json.loads(inventory_path.read_bytes())
        if not isinstance(inventory, list) or not inventory:
            raise RuntimeError("provider_source_inventory_empty")
        source_main = False
        for entry in inventory:
            checked = _check_file_entry(entry, root=source_root)
            if entry.get("path") == "main.py":
                source_main = True
        if not source_main:
            raise RuntimeError("real_main_entrypoint_not_in_source_inventory")

        runtime = manifest.get("runtime")
        if not isinstance(runtime, dict):
            raise RuntimeError("provider_python_binding_missing")
        venv = pathlib.Path(str(runtime.get("venv_root", "")))
        python = pathlib.Path(str(runtime.get("venv_executable", "")))
        resolved = pathlib.Path(str(runtime.get("resolved_interpreter", "")))
        if (not venv.is_absolute() or not python.is_absolute() or not resolved.is_absolute()
                or python != venv / "bin/python" or not venv.is_dir() or venv.is_symlink()
                or not _no_symlink(venv) or not python.exists()
                or python.resolve(strict=True) != resolved or not _regular(resolved)
                or _sha(resolved) != runtime.get("resolved_interpreter_sha256")
                or not _regular(venv / "pyvenv.cfg")):
            raise RuntimeError("admitted_python_environment_mismatch")

        config_binding = manifest.get("launch_config")
        if (not isinstance(config_binding, dict) or config_binding.get("path") != str(CONFIG)
                or CONFIG.stat().st_size != config_binding.get("bytes")
                or _sha(CONFIG) != config_binding.get("sha256")):
            raise RuntimeError("existing_private_config_pin_mismatch")
        env_binding = manifest.get("existing_env_file")
        if (not isinstance(env_binding, dict) or env_binding.get("path") != str(ENV_FILE)
                or ENV_FILE.stat().st_size != env_binding.get("bytes")
                or _sha(ENV_FILE) != env_binding.get("sha256")):
            raise RuntimeError("existing_private_env_file_pin_mismatch")
        if not os.environ.get(API_KEY_ENV):
            raise RuntimeError("existing_gateway_api_key_process_binding_missing")

        gateway = manifest.get("gateway")
        provider = manifest.get("remoteTtsReceiver")
        if not isinstance(gateway, dict) or not isinstance(provider, dict):
            raise RuntimeError("approved_gateway_or_receiver_identity_missing")
        endpoint = gateway.get("endpoint")
        endpoint_sha = gateway.get("endpoint_sha256")
        if (not isinstance(endpoint, str) or hashlib.sha256(endpoint.encode()).hexdigest() != endpoint_sha):
            raise RuntimeError("independently_admitted_gateway_endpoint_missing")
        parsed = urlsplit(endpoint)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.path != "/api/TTS/Synthesize"
                or parsed.query or parsed.fragment):
            raise RuntimeError("admitted_gateway_tts_endpoint_invalid")
        if (gateway.get("auth_binding") != "existing_gateway_api_key"
                or gateway.get("auth_env_name") != API_KEY_ENV
                or gateway.get("approved_interface_receipt") != admission["receipt_sha256"]):
            raise RuntimeError("gateway_route_authority_binding_mismatch")

        config = json.loads(CONFIG.read_bytes())
        services = config.get("services", {}) if isinstance(config, dict) else {}
        gateway_config = services.get("gateway", {}) if isinstance(services, dict) else {}
        api = gateway_config.get("api", {}) if isinstance(gateway_config, dict) else {}
        auth = services.get("auth", {}) if isinstance(services, dict) else {}
        bind = gateway.get("bind", {})
        if (gateway_config.get("enabled") is not True or api.get("enabled", True) is not True
                or auth.get("enabled") is not True or not isinstance(bind, dict)
                or api.get("host") != bind.get("host") or api.get("port") != bind.get("port")
                or type(api.get("port")) is not int or not 1 <= api["port"] <= 65535
                or bind.get("approved_private_interface") is not True
                or isinstance(api.get("request_timeout_s"), bool)
                or not isinstance(api.get("request_timeout_s"), (int, float))
                or api["request_timeout_s"] < 180):
            raise RuntimeError("existing_authenticated_gateway_config_not_admitted")
        if (admission["gateway_endpoint_sha256"] != endpoint_sha
                or admission["gateway_bind_host"] != bind["host"]
                or admission["gateway_bind_port"] != bind["port"]):
            raise RuntimeError("approved_route_admission_binding_mismatch")
        parsed_port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if parsed.hostname != gateway.get("endpoint_host") or parsed_port != gateway.get("endpoint_port"):
            raise RuntimeError("endpoint_host_port_admission_mismatch")

        file_receipt_binding = manifest.get("actual_provider_file_receipt")
        if not isinstance(file_receipt_binding, dict):
            raise RuntimeError("independent_actual_provider_file_receipt_missing")
        file_receipt_path = pathlib.Path(str(file_receipt_binding.get("path", "")))
        if (not file_receipt_path.is_absolute() or not _regular(file_receipt_path)
                or not _no_symlink(file_receipt_path)
                or _sha(file_receipt_path) != file_receipt_binding.get("sha256")):
            raise RuntimeError("actual_provider_file_receipt_pin_mismatch")
        file_receipt_bytes = file_receipt_path.read_bytes()
        file_receipt = json.loads(file_receipt_bytes)
        actual_files = file_receipt.get("actual_provider_files") if isinstance(file_receipt, dict) else None
        if not isinstance(actual_files, dict):
            raise RuntimeError("actual_provider_file_receipt_schema_invalid")
        for kind, expected_key in (("model", "model_sha256"), ("config", "config_sha256")):
            item = actual_files.get(kind)
            expected_hash = provider.get(expected_key)
            if (not isinstance(item, dict) or item.get("sha256") != expected_hash
                    or not isinstance(item.get("canonical_path"), str)
                    or not pathlib.Path(item["canonical_path"]).is_absolute()):
                raise RuntimeError("actual_provider_file_hash_binding_mismatch")
        identity = {
            "schema": "aurora.distributed_k1_receiver_identity.v1",
            "receiver_pid": None,
            "provider": provider,
            "actual_provider_files": {
                "source_receipt_sha256": hashlib.sha256(file_receipt_bytes).hexdigest(),
                "model": {key: actual_files["model"][key] for key in ("canonical_path", "sha256")},
                "config": {key: actual_files["config"][key] for key in ("canonical_path", "sha256")},
            },
            "manifest_sha256": expected_manifest_sha,
            "authority_receipt_sha256": admission["receipt_sha256"],
            "credential_value_logged": False,
        }

        source_ids = manifest.get("runtime_versions")
        if not isinstance(source_ids, dict) or not isinstance(source_ids.get("packages"), dict):
            raise RuntimeError("frozen_runtime_versions_missing")
        model_hashes = manifest.get("models")
        if not isinstance(model_hashes, dict) or model_hashes.get("tts") != provider.get("model_sha256"):
            raise RuntimeError("tts_model_identity_not_frozen")

        if _mem_available() < RAM_FLOOR or shutil.disk_usage(ROOT).free < DISK_FLOOR:
            raise RuntimeError("provider_resource_admission_floor_not_met")
        RUN.mkdir(mode=0o700, exist_ok=False)
        (RUN / "data").mkdir(mode=0o700)
        (RUN / "backups").mkdir(mode=0o700)
        runtime_config = RUN / "config.json"
        with runtime_config.open("xb") as stream:
            config_bytes = CONFIG.read_bytes()
            stream.write(config_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(runtime_config, 0o600)
        if runtime_config.read_bytes() != config_bytes:
            raise RuntimeError("private_runtime_config_copy_mismatch")

        stage = RUN / "voice-stages.jsonl"
        bindings = RUN / "actual-provider-bindings.jsonl"
        for path in (stage, bindings, RUN / "backend.private.log", RUN / "resources.jsonl",
                     RUN / "launch.json", RUN / "terminal.json", IDENTITY_FILE):
            if path.exists() or path.is_symlink():
                raise RuntimeError("provider_output_collision")
        env = os.environ.copy()
        env.update({
            "PYTHONDONTWRITEBYTECODE": "1",
            "AURORA_CONFIG_FILE": str(runtime_config),
            "AURORA_ENV_FILE": str(ENV_FILE),
            "AURORA_DATA_DIR": str(RUN / "data"),
            "AURORA_BACKUP_DIR": str(RUN / "backups"),
            "AURORA_ARCHITECTURE_MODE": "threads",
            "AURORA_VOICE_TELEMETRY_V430": "1",
            "AURORA_V409_OBSERVER_PATH": str(HOOK / "observer.py"),
            "AURORA_VOICE_STAGE_OUTPUT": str(stage),
            "AURORA_VOICE_STAGE_HOST_ID": str(manifest.get("host_id_pseudonym", "")),
            "AURORA_K1_PROVIDER_ROOT": str(ROOT),
            "AURORA_K1_SOURCE_ROOT": str(source_root),
            "AURORA_K1_PROVIDER_FROZEN_MANIFEST": str(MANIFEST),
            "PYTHONPATH": str(HOOK) + os.pathsep + str(source_root),
            "VIRTUAL_ENV": str(venv),
            "PATH": str(venv / "bin") + os.pathsep + os.environ.get("PATH", ""),
            "TMPDIR": str(RUN / "tmp"),
            "TMP": str(RUN / "tmp"),
            "TEMP": str(RUN / "tmp"),
        })
        if not env["AURORA_VOICE_STAGE_HOST_ID"]:
            raise RuntimeError("predeclared_receiver_host_id_missing")
        (RUN / "tmp").mkdir(mode=0o700)
        launch = {
            "schema": "aurora.distributed_k1_gateway_receiver_launch.v1",
            "controller_pid": os.getpid(),
            "cohort_manifest_sha256": expected_manifest_sha,
            "config_sha256": config_binding["sha256"],
            "source_inventory_sha256": source["inventory_sha256"],
            "runtime_versions_pinned": True,
            "gateway_endpoint_logged": False,
            "credential_value_logged": False,
            "resource_floors": {"memory_available_bytes": RAM_FLOOR, "disk_free_bytes": DISK_FLOOR},
            "admission": {key: admission[key] for key in (
                "receipt_sha256", "predecessor_pids_absent", "locks_acquired"
            )},
        }
        _write_json(RUN / "launch.json", launch, exclusive=True)
        with (RUN / "backend.private.log").open("xb") as log, (RUN / "resources.jsonl").open("xb") as resources:
            os.chmod(RUN / "backend.private.log", 0o600)
            os.chmod(RUN / "resources.jsonl", 0o600)
            child = subprocess.Popen(
                [str(python), str(ROOT / "bootstrap.py")], cwd=source_root, env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            launch["receiver_pid"] = child.pid
            _write_json(RUN / "launch.json", launch)
            record.update(receiver_pid=child.pid, manifest_sha256=expected_manifest_sha)
            deadline = start + OUTER_CAP
            ready_deadline = min(start + 180, deadline)
            ready = False
            bind_host, bind_port = bind["host"], bind["port"]
            while child.poll() is None and time.monotonic() < ready_deadline:
                try:
                    with socket.create_connection((bind_host, bind_port), timeout=1):
                        ready = True
                        break
                except OSError:
                    time.sleep(0.5)
            if not ready:
                raise RuntimeError("gateway_listener_not_ready_within_bound")
            identity["receiver_pid"] = child.pid
            _write_json(IDENTITY_FILE, identity, exclusive=True)
            _write_json(RUN / "ready.json", {
                "status": "tcp_listener_ready", "receiver_pid": child.pid,
                "manifest_sha256": expected_manifest_sha,
                "identity_sha256": _sha(IDENTITY_FILE),
            }, exclusive=True)
            while child.poll() is None and time.monotonic() < deadline:
                sample = {
                    "monotonic_ns": time.monotonic_ns(),
                    "mem_available_bytes": _mem_available(),
                    "runtime_free_bytes": shutil.disk_usage(ROOT).free,
                    "raw_artifact_bytes": _raw_bytes(),
                    "child_pid": child.pid,
                    "child_present": pathlib.Path(f"/proc/{child.pid}").exists(),
                }
                sample["resource_context"] = sample_resources(child.pid)
                resources.write((json.dumps(sample, sort_keys=True) + "\n").encode())
                resources.flush()
                if (sample["mem_available_bytes"] < RAM_FLOOR
                        or sample["runtime_free_bytes"] < DISK_FLOOR
                        or sample["raw_artifact_bytes"] > RAW_CAP):
                    record["stop_reason"] = "resource_floor"
                    _stop_owned()
                    break
                time.sleep(1)
            if child.poll() is None:
                record["stop_reason"] = "receiver_outer_deadline"
                _stop_owned()
            record["exit_code"] = child.returncode
    except BaseException as exc:
        code = exc.args[0] if isinstance(exc, RuntimeError) and exc.args else "unclassified"
        if not isinstance(code, str) or not code.isascii() or not code.replace("_", "").isalnum():
            code = "unclassified"
        record.update(error_class=type(exc).__name__, error_code=code, setup_failed=True)
        _stop_owned()
        return 1
    finally:
        for handle in lock_handles:
            try:
                handle.close()
            except OSError:
                pass
        record.update(
            finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            elapsed_seconds=time.monotonic() - start,
            process_present_after_wait=bool(child and pathlib.Path(f"/proc/{child.pid}").exists()),
            exit_code=child.returncode if child else None,
        )
        if RUN.is_dir() and not RUN.is_symlink() and not (RUN / "terminal.json").exists():
            _write_json(RUN / "terminal.json", record, exclusive=True)
    return 0 if child and child.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
