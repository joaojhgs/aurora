"""Fail-closed private launcher for an admitted distributed K3 condition.

Root must stage the frozen files and set the documented environment. This
controller never creates credentials, chooses an endpoint, or edits config.
"""
from __future__ import annotations

import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import runpy
import shutil
import signal
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent
RUNNER = ROOT / "runner.py"
ADAPTER = ROOT / "mesh_stage_adapter.py"
COMPOSITION = ROOT / "k3_composition.py"
RECEIVER_PROOF = ROOT / "receiver_proof.py"
ROUTE_OBSERVER = ROOT / "mesh_route_observer.py"
ROUTE_SINK = ROOT / "route_observation_sink.py"
ROUTE_RUNTIME_PINS = ROOT / "route_runtime_pins.json"
BOOTSTRAP = pathlib.Path(__file__).with_name("bootstrap.py")
CANDIDATE = ROOT / "candidate-manifest.json"
CANDIDATE_SHA = "ce75b965ee5879ebece6ea7dfe133441547d20ccf89ecd5d66ea510bd9645e60"
WAV = ROOT / "candidate-input.wav"
WAV_SHA = "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
OUTER_CAP = 57_840
RAM_FLOOR = 2_500_000_000
DISK_FLOOR = 500_000_000


def digest(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def regular(path: pathlib.Path) -> bool:
    return not path.is_symlink() and path.is_file()


def mem_available() -> int:
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("memory_admission_unavailable")


def require_hash(path: pathlib.Path, expected: str, category: str) -> None:
    if not regular(path) or len(expected) != 64 or digest(path) != expected:
        raise ValueError(category)


def main() -> int:
    os.umask(0o077)
    output = pathlib.Path(os.environ.get("AURORA_OUTPUT_DIR", ""))
    cohort_path = pathlib.Path(os.environ.get("AURORA_FROZEN_MANIFEST", ""))
    candidate_path = CANDIDATE
    inventory_path = ROOT / "source-inventory.json"
    config_path = pathlib.Path(os.environ.get("AURORA_CONFIG_FILE", ""))
    wav_path = WAV
    source_root = pathlib.Path(os.environ.get("AURORA_K3_SOURCE_ROOT", ""))
    python = pathlib.Path(os.environ.get("AURORA_K3_PYTHON", ""))
    model_paths = {
        "stt": pathlib.Path(os.environ.get("AURORA_K3_STT_MODEL_PATH", "")),
        "llm": pathlib.Path(os.environ.get("AURORA_K3_LLM_MODEL_PATH", "")),
        "tts": pathlib.Path(os.environ.get("AURORA_K3_TTS_MODEL_PATH", "")),
        "tts_config": pathlib.Path(os.environ.get("AURORA_K3_TTS_CONFIG_PATH", "")),
    }
    control_sha = os.environ.get("AURORA_K3_CONTROLLER_SHA256", "")
    cohort_sha = os.environ.get("AURORA_FROZEN_MANIFEST_SHA256", "")
    candidate_sha = CANDIDATE_SHA
    runner_sha = os.environ.get("AURORA_K3_RUNNER_SHA256", "")
    adapter_sha = os.environ.get("AURORA_K3_ADAPTER_SHA256", "")
    composition_sha = os.environ.get("AURORA_K3_COMPOSITION_SHA256", "")
    receiver_proof_sha = os.environ.get("AURORA_K3_RECEIVER_PROOF_SHA256", "")
    stt_peer = os.environ.get("AURORA_K3_MESH_STT_PEER_ID", "")
    assistant_peer = os.environ.get("AURORA_K3_MESH_ASSISTANT_PEER_ID", "")
    tts_peer = os.environ.get("AURORA_K3_MESH_TTS_PEER_ID", "")
    route_observer_sha = os.environ.get("AURORA_K3_ROUTE_OBSERVER_SHA256", "")
    route_sink_sha = os.environ.get("AURORA_K3_ROUTE_SINK_SHA256", "")
    route_runtime_pins_sha = os.environ.get("AURORA_K3_ROUTE_RUNTIME_PINS_SHA256", "")

    if (not ROOT.is_absolute() or not ROOT.is_dir() or ROOT.is_symlink()
            or not regular(RUNNER) or not regular(ADAPTER) or not regular(COMPOSITION)
            or not regular(RECEIVER_PROOF)
            or not regular(BOOTSTRAP) or not regular(config_path)
            or not regular(ROUTE_OBSERVER) or not regular(ROUTE_SINK)
            or not regular(ROUTE_RUNTIME_PINS)
            or not regular(wav_path) or not regular(cohort_path)
            or source_root.is_symlink() or not source_root.is_dir()
            or source_root.resolve(strict=True) != source_root.absolute()
            or not python.is_file()
            or not regular(candidate_path) or not regular(inventory_path)):
        raise ValueError("required_staged_input_missing_or_symlinked")
    if output.is_symlink() or not output.is_absolute() or output.exists():
        raise ValueError("private_output_must_be_new_and_absolute")
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", stt_peer)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", assistant_peer)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", tts_peer)):
        raise ValueError("independently_admitted_exact_mesh_peers_required")
    require_hash(pathlib.Path(__file__), control_sha, "controller_hash_mismatch")
    require_hash(RUNNER, runner_sha, "runner_hash_mismatch")
    require_hash(ADAPTER, adapter_sha, "adapter_hash_mismatch")
    require_hash(RECEIVER_PROOF, receiver_proof_sha, "receiver_proof_hash_mismatch")
    require_hash(ROUTE_OBSERVER, route_observer_sha, "route_observer_hash_mismatch")
    require_hash(ROUTE_SINK, route_sink_sha, "route_sink_hash_mismatch")
    require_hash(ROUTE_RUNTIME_PINS, route_runtime_pins_sha, "route_runtime_pins_hash_mismatch")
    if (digest(candidate_path) != candidate_sha or digest(cohort_path) != cohort_sha
            or digest(wav_path) != WAV_SHA):
        raise ValueError("frozen_manifest_hash_mismatch")
    candidate = json.loads(candidate_path.read_bytes())
    cohort = json.loads(cohort_path.read_bytes())
    if (cohort.get("implementation", {}).get("runnerSha256") != runner_sha
            or cohort.get("implementation", {}).get("controllerSha256") != control_sha
            or cohort.get("implementation", {}).get("adapterSha256") != adapter_sha
            or cohort.get("implementation", {}).get("routeObserverSha256") != route_observer_sha
            or cohort.get("implementation", {}).get("routeSinkSha256") != route_sink_sha
            or cohort.get("implementation", {}).get("routeRuntimePinsSha256") != route_runtime_pins_sha
            or cohort.get("implementation", {}).get("k3CompositionSha256") != composition_sha
            or cohort.get("implementation", {}).get("receiverProofSha256") != receiver_proof_sha
            or composition_sha != digest(COMPOSITION)
            or cohort.get("implementation", {}).get("bootstrapSha256")
                != digest(BOOTSTRAP)
            or cohort.get("implementation", {}).get("bindingsSha256")
                != digest(ROOT / "bindings.py")
            or cohort.get("implementation", {}).get("observerSha256")
                != digest(ROOT / "observer.py")
            or cohort.get("implementation", {}).get("telemetrySha256")
                != digest(ROOT / "aurora_voice_telemetry_v430.py")
            or cohort.get("measurementPlan", {}).get("conditionOverallCapSeconds") != 57_600
            or cohort.get("meshSttPeerIdSha256") != hashlib.sha256(stt_peer.encode()).hexdigest()
            or cohort.get("meshAssistantPeerIdSha256") != hashlib.sha256(assistant_peer.encode()).hexdigest()
            or cohort.get("meshTtsPeerIdSha256") != hashlib.sha256(tts_peer.encode()).hexdigest()
            or cohort.get("meshAuthorityBinding") != "existing_authorized_peer_session"
            or cohort.get("sourceClosure", {}).get("equivalenceVerified") is not True
            or cohort.get("sourceClosure", {}).get("cpuSourceInventorySha256") != digest(inventory_path)
            or cohort.get("sourceClosure", {}).get("cpuSourceRoot") != str(source_root)
            or candidate.get("wavSHA256") != cohort.get("audio", {}).get("wavSha256")
            or digest(wav_path) != candidate.get("wavSHA256")
            or cohort.get("runtimeConfigSha256") != digest(config_path)):
        raise ValueError("frozen_condition_binding_mismatch")
    require_hash(ROOT / "resource_sample.py", cohort.get("implementation", {}).get("resourceSamplerSha256", ""), "resource_sampler_hash_mismatch")
    sample_resources = runpy.run_path(str(ROOT / "resource_sample.py"))["sample_resources"]
    receivers = cohort.get("remoteReceivers")
    if (not isinstance(receivers, dict) or set(receivers) != {"stt", "assistant", "tts"}
            or not isinstance(receivers.get("stt"), dict)
            or not isinstance(receivers.get("assistant"), dict)
            or not isinstance(receivers.get("tts"), dict)
            or receivers["stt"].get("peer_id_sha256") != hashlib.sha256(stt_peer.encode()).hexdigest()
            or receivers["assistant"].get("peer_id_sha256") != hashlib.sha256(assistant_peer.encode()).hexdigest()
            or receivers["tts"].get("peer_id_sha256") != hashlib.sha256(tts_peer.encode()).hexdigest()):
        raise ValueError("independent_remote_receiver_bindings_missing")
    model_hashes = cohort.get("models", {})
    expected_model_hashes = {
        "stt": model_hashes.get("stt"), "llm": model_hashes.get("llm"),
        "tts": model_hashes.get("tts"), "tts_config": model_hashes.get("ttsConfig"),
    }
    if any(not regular(path) or digest(path) != expected_model_hashes[name]
           for name, path in model_paths.items()):
        raise ValueError("frozen_model_binding_mismatch")
    runtime = cohort.get("runtime", {})
    if (str(python) != runtime.get("venvExecutable")
            or not (python.parent.parent / "pyvenv.cfg").is_file()
            or digest(python.resolve(strict=True)) != runtime.get("resolvedInterpreterSha256")):
        raise ValueError("admitted_python_environment_mismatch")
    route_pins = json.loads(ROUTE_RUNTIME_PINS.read_bytes())
    if (route_pins.get("schema") != "aurora.mesh_route_runtime_pins.v1"
            or route_pins.get("status") == "template_only_not_launchable"
            or route_pins.get("runtimePrefix") != str(python.parent.parent.resolve())
            or not isinstance(route_pins.get("pathFile"), dict)
            or not isinstance(route_pins.get("searchRoots"), list)
            or not isinstance(route_pins.get("packages"), dict)
            or not isinstance(route_pins.get("loadedModules"), dict)):
        raise ValueError("actual_mesh_runtime_pins_not_frozen")
    if mem_available() < RAM_FLOOR:
        raise ValueError("resource_admission_floor_not_met")

    inventory = json.loads(inventory_path.read_bytes())
    if not isinstance(inventory, list) or not inventory:
        raise ValueError("source_inventory_invalid")
    for item in inventory:
        if not isinstance(item, dict) or set(item) != {"path", "bytes", "sha256"}:
            raise ValueError("source_inventory_invalid")
        rel = pathlib.PurePosixPath(item["path"])
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError("source_inventory_path_invalid")
        source_file = source_root.joinpath(*rel.parts)
        if not regular(source_file) or source_file.stat().st_size != item["bytes"] or digest(source_file) != item["sha256"]:
            raise ValueError("source_file_drift")

    private_parent = ROOT.parent.resolve(strict=True)
    if (not output.is_absolute() or output.parent.resolve(strict=False) != output.parent
            or output.parent.parent != private_parent or output.parent.exists()):
        raise ValueError("run_directory_must_be_new_private_handoff_child")
    output.parent.mkdir(mode=0o700, parents=False, exist_ok=False)
    if shutil.disk_usage(output.parent).free < DISK_FLOOR:
        raise ValueError("run_volume_resource_floor_not_met")
    (output.parent / "data").mkdir(mode=0o700)
    (output.parent / "backups").mkdir(mode=0o700)
    absent_env = output.parent / "absent.env"
    absent_env.touch(mode=0o600, exist_ok=False)
    lock = pathlib.Path("/tmp/aurora-global-build.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    env = os.environ.copy()
    env.update({
        "AURORA_K3_CONTROL_ROOT": str(ROOT),
        "AURORA_K3_RUNNER_PATH": str(RUNNER),
        "AURORA_K3_BINDINGS_PATH": str(ROOT / "bindings.py"),
        "AURORA_K3_TELEMETRY_PATH": str(ROOT / "aurora_voice_telemetry_v430.py"),
        "AURORA_V409_OBSERVER_PATH": str(ROOT / "observer.py"),
        "AURORA_K3_RUNNER_SHA256": runner_sha,
        "AURORA_K3_CONTROLLER_SHA256": control_sha,
        "AURORA_K3_ADAPTER_SHA256": adapter_sha,
        "AURORA_K3_COMPOSITION_SHA256": composition_sha,
        "AURORA_K3_RECEIVER_PROOF_SHA256": receiver_proof_sha,
        "AURORA_K3_MESH_ASSISTANT_PEER_ID": assistant_peer,
        "AURORA_K3_MESH_STT_PEER_ID": stt_peer,
        "AURORA_K3_MESH_TTS_PEER_ID": tts_peer,
        "AURORA_K3_ROUTE_OBSERVER_PATH": str(ROUTE_OBSERVER),
        "AURORA_K3_ROUTE_SINK_PATH": str(ROUTE_SINK),
        "AURORA_K3_ROUTE_OBSERVER_SHA256": route_observer_sha,
        "AURORA_K3_ROUTE_SINK_SHA256": route_sink_sha,
        "AURORA_K3_ROUTE_RUNTIME_PINS_PATH": str(ROUTE_RUNTIME_PINS),
        "AURORA_K3_ROUTE_RUNTIME_PINS_SHA256": route_runtime_pins_sha,
        "AURORA_K3_MESH_ROUTE_OBSERVATIONS": str(output.parent / "mesh-route-observations.jsonl"),
        "AURORA_K3_MESH_ROUTE_SINK_STATUS": str(output.parent / "mesh-route-sink-status.json"),
        "AURORA_K3_MESH_ROUTE_RUNTIME_PINS": str(output.parent / "mesh-route-runtime-pins.json"),
        "AURORA_VOICE_FIXTURE_WAV": str(wav_path),
        "AURORA_K3_SOURCE_ROOT": str(source_root),
        "PYTHONPATH": str(ROOT) + os.pathsep + str(source_root),
        "AURORA_FROZEN_MANIFEST_SHA256": cohort_sha,
        "AURORA_CANDIDATE_MANIFEST_SHA256": candidate_sha,
        "AURORA_CANDIDATE_MANIFEST": str(candidate_path),
        "AURORA_OUTPUT_DIR": str(output),
        "AURORA_K3_REMOTE_WARMUP_PROOF": str(output / "remote-warmup-proof.json"),
        "AURORA_ENV_FILE": str(absent_env),
        "AURORA_DATA_DIR": str(output.parent / "data"),
        "AURORA_BACKUP_DIR": str(output.parent / "backups"),
        "AURORA_ARCHITECTURE_MODE": "threads",
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    launch_path = output.parent / "control-launch.json"
    log_path = output.parent / "backend.private.log"
    resources_path = output.parent / "resources.jsonl"
    if any(path.exists() or path.is_symlink() for path in (launch_path, log_path, resources_path)):
        raise ValueError("control_artifact_already_exists")
    launch = {
        "schema": "aurora.distributed_k3_controller_launch.v1",
        "controller_pid": os.getpid(),
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "cohort_manifest_sha256": cohort_sha,
        "candidate_manifest_sha256": candidate_sha,
        "runner_sha256": runner_sha,
        "adapter_sha256": adapter_sha,
        "k3_composition_sha256": composition_sha,
        "stt_peer_id_sha256": hashlib.sha256(stt_peer.encode()).hexdigest(),
        "assistant_peer_id_sha256": hashlib.sha256(assistant_peer.encode()).hexdigest(),
        "tts_peer_id_sha256": hashlib.sha256(tts_peer.encode()).hexdigest(),
        "source_inventory_sha256": digest(inventory_path),
        "planned_warmups": 15,
        "planned_measured": 900,
        "request_cap_seconds": 180,
        "condition_cap_seconds": 57_600,
        "surface": "code-worker requester; exact-peer production MeshBus STT, Assistant and TTS",
    }
    child: subprocess.Popen | None = None
    started = time.monotonic()
    stage_path = output.parent / "voice-stages.jsonl"
    for private_file in (stage_path, stage_path.with_suffix(".installed.json"),
                         stage_path.with_suffix(".status.json"),
                         output.parent / "runtime-versions.json"):
        if private_file.exists() or private_file.is_symlink():
            raise ValueError("private_stage_artifact_exists")
    env["AURORA_VOICE_STAGE_OUTPUT"] = str(stage_path)
    env["AURORA_VOICE_STAGE_HOST_ID"] = "code-worker-k3-http-tts"
    env["AURORA_VOICE_TELEMETRY_V430"] = "1"
    with log_path.open("xb") as log_stream, resources_path.open("xb") as resources:
        os.chmod(log_path, 0o600)
        os.chmod(resources_path, 0o600)
        child = subprocess.Popen(
            [str(python), str(BOOTSTRAP)],
            cwd=source_root, env=env,
            stdin=subprocess.DEVNULL, start_new_session=True,
            stdout=log_stream, stderr=subprocess.STDOUT,
        )
        launch["child_pid"] = child.pid
        try:
            _write_json(launch_path, launch, exclusive=True)
            while child.poll() is None and time.monotonic() - started < OUTER_CAP:
                sample = {"monotonic_ns": time.monotonic_ns(), "mem_available": mem_available(),
                          "campaign_volume_free": shutil.disk_usage(output.parent).free,
                          "child_pid": child.pid}
                sample["resource_context"] = sample_resources(child.pid)
                resources.write((json.dumps(sample, sort_keys=True) + "\n").encode("utf-8"))
                resources.flush()
                if sample["mem_available"] < RAM_FLOOR or sample["campaign_volume_free"] < DISK_FLOOR:
                    launch["stop_reason"] = "resource_floor"
                    _stop_owned(child)
                    break
                time.sleep(1)
            if child.poll() is None:
                launch["stop_reason"] = "outer_deadline"
                _stop_owned(child)
        except BaseException:
            if child.poll() is None:
                _stop_owned(child)
            raise
    if child.poll() is None:
        launch["stop_reason"] = launch.get("stop_reason", "owned_child_not_retired")
        launch["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        launch["exit_code"] = None
        launch["child_present_after_wait"] = True
        _write_json(launch_path, launch, exclusive=False)
        raise RuntimeError("owned_child_not_retired_within_cleanup_bound")
    launch.update({"finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "exit_code": child.returncode if child else None,
                   "child_present_after_wait": bool(child and pathlib.Path(f"/proc/{child.pid}").exists())})
    _write_json(launch_path, launch, exclusive=False)
    return int(child.returncode or 0)


def _write_json(path: pathlib.Path, value: dict[str, object], *, exclusive: bool) -> None:
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(temporary, flags, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    if exclusive:
        try:
            os.link(temporary, path, follow_symlinks=False)
        finally:
            temporary.unlink(missing_ok=True)
    else:
        os.replace(temporary, path)


def _stop_owned(child: subprocess.Popen) -> None:
    for sig, timeout in ((signal.SIGINT, 20), (signal.SIGTERM, 8), (signal.SIGKILL, 3)):
        if child.poll() is not None:
            return
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            continue


if __name__ == "__main__":
    raise SystemExit(main())
