"""Root-owned normal UI campaign controller. Source preparation, not launch."""
from __future__ import annotations
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path("/tmp/aurora-root-padded-browser900-v704")
RUN = ROOT / "runtime"
SHORT_TMP = pathlib.Path("/tmp/.ab704")
PROJECT = pathlib.Path("/home/developer/projects/aurora")
SOURCE = PROJECT / ".git/aurora-handoff-import-20261006/http-full-audio-v497/source"
WEB = PROJECT / ".git/aurora-web-tts-v472/source/apps/aurora-web"
WEB_BUILD_TARGET = pathlib.Path("/dev/shm/aurora-root-accurate-base-v443/web-next-output-v472")
RETAINED_DATA = PROJECT / ".git/aurora-real-ui-audio-v474/runtime/data"
RETAINED_DB_SHA = "911f10f5808a312ad7712daefab7b47a404966ae58a14c7e95090408fc40d52e"
FROZEN = ROOT / "frozen-manifest.json"
INPUT_SHA = "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
DRIVER_SHA = "f1a9f9cf71dc4d2a775f657cd5b1cb9193800ba75d7e0e8fda3cdcfc4cddc456"
PYTHON = pathlib.Path("/tmp/aurora-root-voice-primary-v426/env/bin/python")
NODE = pathlib.Path("/home/developer/.asdf/installs/nodejs/24.19.0/bin/node")
CHROME = pathlib.Path("/usr/bin/google-chrome")
PLAYWRIGHT = pathlib.Path("/tmp/aurora-root-voice-primary-v426/env/lib/python3.11/site-packages/playwright/driver/package/index.mjs")
RAW_CAP = 2_000_000_000
TMP_RESERVE = 1_000_000_000
RAM_FLOOR = 2_000_000_000
OUTER_CAP = 57_840
ARCHIVE_DESTINATION_ADMISSION = 120_000_000
ARCHIVE_MAX_BYTES = 40_000_000
PROJECT_RESERVE = 80_000_000
counter_errors: list[dict[str, object]] = []

def _no_symlink_path(path: pathlib.Path) -> bool:
    absolute = pathlib.Path(os.path.abspath(path))
    for item in (absolute, *absolute.parents):
        try:
            if item.is_symlink():
                return False
        except OSError:
            return False
    return True

def _private_path(path: pathlib.Path, *, must_exist: bool = True) -> pathlib.Path:
    absolute = pathlib.Path(os.path.abspath(path))
    try:
        absolute.relative_to(ROOT)
    except ValueError:
        raise RuntimeError("private_path_outside_campaign_root") from None
    if not _no_symlink_path(absolute):
        raise RuntimeError("private_path_symlink_component")
    if must_exist and not absolute.exists():
        raise RuntimeError("required_private_path_missing")
    return absolute

def _sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def _mem_available() -> int:
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("mem_available_unavailable")

def _admit_gpu() -> list[dict[str, object]]:
    devices: list[dict[str, object]] = []
    for device in pathlib.Path("/sys/class/drm").glob("card*/device"):
        if _read_counter(device / "vendor") != "0x1002":
            continue
        identifier = _read_counter(device / "device")
        raw_vram = _read_counter(device / "mem_info_vram_total")
        try:
            vram = int(raw_vram) if raw_vram is not None else None
        except ValueError:
            vram = None
        devices.append({"device": identifier, "vramTotal": vram})
    if not any(item["device"] == "0x7480" and item["vramTotal"] == 8_573_157_376 for item in devices):
        raise RuntimeError("admitted_rx7600_gpu_identity_mismatch")
    return devices

def _read_counter(path: pathlib.Path) -> str | None:
    try:
        return path.read_text().strip() if path.exists() else None
    except OSError as exc:
        item = {"errorClass": type(exc).__name__, "errno": exc.errno}
        if item not in counter_errors and len(counter_errors) < 16:
            counter_errors.append(item)
        return None

def _admit_python_environment(frozen: dict[str, object]) -> tuple[pathlib.Path, pathlib.Path]:
    binding = frozen.get("pythonEnvironment")
    required = {"venvPath", "interpreterPath", "resolvedInterpreterPath", "resolvedInterpreterSHA256"}
    if not isinstance(binding, dict) or not required.issubset(binding):
        raise RuntimeError("frozen_python_environment_binding_missing")
    raw_venv = binding.get("venvPath")
    raw_python = binding.get("interpreterPath")
    raw_resolved = binding.get("resolvedInterpreterPath")
    expected_sha = binding.get("resolvedInterpreterSHA256")
    if not all(isinstance(value, str) and pathlib.Path(value).is_absolute() for value in (raw_venv, raw_python, raw_resolved)):
        raise RuntimeError("frozen_python_environment_path_invalid")
    if not isinstance(expected_sha, str) or len(expected_sha) != 64 or any(char not in "0123456789abcdef" for char in expected_sha):
        raise RuntimeError("frozen_python_interpreter_hash_invalid")
    venv = pathlib.Path(raw_venv)
    python = pathlib.Path(raw_python)
    resolved = pathlib.Path(raw_resolved)
    if python != venv / "bin/python" or not _no_symlink_path(venv) or not venv.is_dir():
        raise RuntimeError("admitted_shared_python_environment_invalid")
    if not python.exists() or python.resolve(strict=True) != resolved or not _no_symlink_path(resolved) or not resolved.is_file():
        raise RuntimeError("admitted_python_interpreter_resolution_mismatch")
    if _sha256_file(resolved) != expected_sha:
        raise RuntimeError("admitted_python_interpreter_hash_mismatch")
    return venv, python


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".pending")
    with temporary.open("x") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def verify_entry(entry, *, symlink_executable=False):
    path = pathlib.Path(entry["path"])
    target = path.resolve(strict=True) if symlink_executable else path
    if not path.is_absolute() or not _no_symlink_path(target) or not target.is_file():
        raise RuntimeError("frozen_file_unavailable")
    if symlink_executable and str(target) != entry["resolvedPath"]:
        raise RuntimeError("frozen_executable_resolution_mismatch")
    if target.stat().st_size != entry["bytes"] or _sha256_file(target) != entry["sha256"]:
        raise RuntimeError("frozen_file_bytes_or_hash_mismatch")
    return path


def verify_manifest(frozen):
    assert frozen["schema"] == "aurora.browser900.frozen.v704"
    assert frozen["cohortId"] == "aurora-normal-ui-padded-file-mic-full-audio-v704"
    assert frozen["plan"] == {
        "warmups": 15, "measured": 900, "conditionCapSeconds": 57600,
        "caseCapSeconds": 180, "setupCapSeconds": 180, "outerCapSeconds": OUTER_CAP,
    }, "frozen_ui_counts_or_caps_changed"
    assert frozen["strictTranscript"] == "What is the capital of France? Answer with only the city name."
    assert frozen["strictReplyWords"] == ["paris"]
    assert frozen["sourcePins"]["driverSHA256"] == DRIVER_SHA
    assert frozen["input"]["sha256"] == INPUT_SHA and frozen["input"]["bytes"] == 219794
    assert verify_entry(frozen["input"]) == ROOT / "candidate-input.wav"
    expected = {
        "controller.py", "bootstrap.py", "gate.py", "voice-flow.mjs",
        "hook/bindings.py", "hook/observer.py", "hook/aurora_voice_telemetry_v430.py",
    }
    assert set(frozen["harnessFiles"]) == expected, "frozen_harness_incomplete"
    for relative, entry in frozen["harnessFiles"].items():
        assert verify_entry(entry) == ROOT / relative
    assert frozen["harnessFiles"]["voice-flow.mjs"]["sha256"] == DRIVER_SHA
    for relative, entry in frozen["sourceFiles"].items():
        assert verify_entry(entry) == SOURCE / relative, "frozen_source_path_mismatch"
    assert "app/services/gateway/fastapi_app.py" in frozen["sourceFiles"]
    models = frozen["models"]
    for entry in [*models["stt"]["weightFiles"], models["llm"]["weights"],
                  models["tts"]["weights"], models["tts"]["voiceConfig"], models["tts"]["executable"]]:
        verify_entry(entry)
    assert _admit_python_environment(frozen)[1] == PYTHON
    assert set(frozen["runtimeVersions"]["packages"]) == {
        "faster-whisper", "ctranslate2", "llama-cpp-python", "piper-tts", "onnxruntime", "numpy",
    }
    browser = frozen["browserRuntime"]
    assert verify_entry(browser["node"], symlink_executable=True) == NODE
    assert verify_entry(browser["chrome"], symlink_executable=True) == CHROME
    assert verify_entry(browser["playwright"], symlink_executable=True) == PLAYWRIGHT
    build = browser["webBuild"]
    assert build["root"] == str(WEB) and build["distDirectory"] == ".next-voice-v472"
    assert build["buildId"] == "hrxU1EH9eftYmJl3tw_eR"
    build_alias = WEB / ".next-voice-v472"
    assert build["resolvedBuildRoot"] == str(WEB_BUILD_TARGET)
    assert build_alias.resolve(strict=True) == WEB_BUILD_TARGET
    for entry in build["files"].values():
        verify_entry(entry).relative_to(WEB_BUILD_TARGET)
    build_id_path = WEB_BUILD_TARGET / "BUILD_ID"
    assert str(build_id_path) in {entry["path"] for entry in build["files"].values()}
    assert build_id_path.read_text().strip() == build["buildId"]
    assert verify_entry(browser["nextCLI"], symlink_executable=True) == WEB / "node_modules/next/dist/bin/next"
    metadata = browser["readOnlyBuildMetadata"]
    assert verify_entry(metadata["nextConfig"]) == WEB / "next.config.mjs"
    prerender_path = verify_entry(metadata["prerenderManifest"])
    assert prerender_path == WEB_BUILD_TARGET / "prerender-manifest.json"
    prerender = json.loads(prerender_path.read_text())
    assert prerender["routes"]["/"]["initialRevalidateSeconds"] is False
    assert prerender["dynamicRoutes"] == {}, "fixed_static_browser_workload_required"
    return browser


def _admit_archive_custody(frozen: dict[str, object]) -> dict[str, object]:
    """Validate Root's fresh actual worker-disk observation, not a new access grant.

    Source/project files on this desktop are read inputs. All new runtime and
    archive bytes stay under the existing separate /tmp write volume; the
    approved existing Orca route copies the saved archive to worker project docs.
    Root must recheck actual destination size+80MB reserve before that later copy.
    """
    custody = frozen.get("archiveCustody")
    if not isinstance(custody, dict) or custody.get("mode") != "existing_orca_saved_archive_to_worker_docs":
        raise RuntimeError("frozen_worker_archive_custody_binding_missing")
    destination = "/home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-browser900-v704"
    if custody.get("destinationHost") != "code-worker" or custody.get("destinationPath") != destination:
        raise RuntimeError("worker_archive_destination_mismatch")
    binding = custody.get("actualWorkerObservationFile")
    path = _private_path(ROOT / "input/worker-custody-admission.json")
    raw = path.read_bytes()
    if (not isinstance(binding, dict) or binding.get("path") != str(path)
            or binding.get("bytes") != len(raw) or binding.get("sha256") != hashlib.sha256(raw).hexdigest()):
        raise RuntimeError("actual_worker_archive_observation_hash_mismatch")
    observation = json.loads(raw)
    if (observation.get("schema") != "aurora.worker-archive-capacity-observation.v1"
            or observation.get("host") != "code-worker"
            or observation.get("project") != str(PROJECT)
            or observation.get("destinationPath") != destination
            or type(observation.get("freeBytes")) is not int
            or observation["freeBytes"] < ARCHIVE_DESTINATION_ADMISSION):
        raise RuntimeError("worker_archive_capacity_below_admission")
    observed_at = datetime.datetime.fromisoformat(observation["observedAt"])
    if observed_at.tzinfo is None:
        raise RuntimeError("worker_archive_observation_timezone_required")
    age = (datetime.datetime.now(datetime.timezone.utc) - observed_at).total_seconds()
    if not -10 <= age <= 300:
        raise RuntimeError("worker_archive_observation_not_fresh_for_launch")
    return {"mode": custody["mode"], "destinationHost": "code-worker", "destinationPath": destination,
            "observation": binding, "observedFreeBytes": observation["freeBytes"],
            "observationAgeSecondsAtAdmission": age, "initialAdmissionBytes": ARCHIVE_DESTINATION_ADMISSION,
            "postTerminalMaxArchiveBytes": ARCHIVE_MAX_BYTES, "postTerminalDestinationReserveBytes": PROJECT_RESERVE,
            "laterCopyRequiresFreshActualSizeAndDestinationCapacity": True,
            "desktopProjectFree": "read_volume_observational_only; no archive writes here"}


def verify_predecessors(frozen):
    expected = {
        "/tmp/aurora-root-padded-http900-v692": {
            "pids": [3116872, 3116892],
            "manifest_sha": "81c25bd59323b1d515d20f9ea154868640e0f0d55b04cb39e77e88fb414aa78f",
            "manifest": "input/frozen-http-manifest.json",
            "export": "export-v715",
            "archive": "aurora-desktop-gpu-padded-http900-v692.zip",
            "measured": 900,
            "warmups": 15,
        },
        "/tmp/aurora-root-padded-local900-v735": {
            "pids": [3295193, 3295224],
            "manifest_sha": "be108882b3024b33545f1484da00a56dccc5993e5c441b3eb3854102e7f14ac5",
            "manifest": "input/frozen-local-manifest.json",
            "export": "export-v744",
            "archive": "aurora-desktop-gpu-padded-local900-v735.zip",
            "measured": 274,
            "warmups": 15,
        },
        "/tmp/aurora-root-padded-local900-v745": {
            "pids": [3312910, 3312941],
            "manifest_sha": "31dea74bf4587e7bef60c44ef28c2b3f7a2da73a69891df27bc318b9819d505d",
            "manifest": "input/frozen-local-manifest.json",
            "export": "export-v751",
            "archive": "aurora-desktop-gpu-padded-local900-v745.zip",
            "measured": 626,
            "warmups": 15,
        },
    }
    priors = frozen["serialPredecessors"]
    assert {prior["rawRoot"] for prior in priors} == set(expected) and len(priors) == len(expected)
    for prior in priors:
        spec = expected[prior["rawRoot"]]
        root = pathlib.Path(prior["rawRoot"])
        assert prior["ownedPids"] == spec["pids"], "predecessor_pid_binding_mismatch"
        assert prior["expectedFrozenManifestSHA256"] == spec["manifest_sha"], "predecessor_manifest_pin_mismatch"
        assert prior["frozenManifest"]["path"] == str(root / spec["manifest"])
        assert verify_entry(prior["frozenManifest"]) == root / spec["manifest"]
        assert prior["frozenManifest"]["sha256"] == spec["manifest_sha"]
        terminal_path = verify_entry(prior["terminal"])
        retirement_path = verify_entry(prior["retirement"])
        export_receipt_path = verify_entry(prior["exportReceipt"])
        export_manifest_path = verify_entry(prior["exportManifest"])
        assert terminal_path == root / "runtime/terminal.json"
        assert retirement_path == root / "runtime/retirement.json"
        assert export_receipt_path == root / spec["export"] / "audit-verification.json"
        assert export_manifest_path == root / spec["export"] / "ARCHIVE-MANIFEST.json"
        terminal = json.loads(terminal_path.read_text())
        retired = json.loads(retirement_path.read_text())
        audit = json.loads(export_receipt_path.read_text())
        archive_manifest = json.loads(export_manifest_path.read_text())
        assert terminal.get("finishedAt") and terminal.get("processPresentAfterWait") is False
        pids = spec["pids"]
        assert retired.get("pidsAbsent") == pids
        assert retired.get("noProcessesTerminatedByRetirement") is True
        assert retired.get("locksObservedFreeThenHeldForExport") is True
        assert retired.get("frozenManifestSHA256") == spec["manifest_sha"]
        assert retired.get("terminal") == prior["terminal"]
        assert all(not pathlib.Path(f"/proc/{pid}").exists() for pid in pids)
        assert retired["retainedDBSHA256Now"] == RETAINED_DB_SHA
        assert audit.get("savedZipIntegrityHashesAndOutcomeAuditPassed") is True
        assert audit.get("frozenManifestSHA256") == spec["manifest_sha"]
        assert audit.get("retirement") == prior["retirement"]
        assert audit.get("rawOriginalsPreserved") is True
        assert archive_manifest.get("frozenManifestSHA256") == spec["manifest_sha"]
        assert archive_manifest.get("originalsPreserved") is True
        archive = audit.get("archive")
        archive_path = root / spec["export"] / spec["archive"]
        assert isinstance(archive, dict) and pathlib.Path(archive.get("path", "")) == archive_path
        assert archive_path.is_file() and not archive_path.is_symlink()
        assert archive_path.stat().st_size == archive.get("bytes")
        phase = audit.get("phaseDenominators", {})
        measured = phase.get("measured", {})
        warmups = phase.get("warmup_excluded", {})
        assert measured.get("attempted") == spec["measured"]
        assert warmups.get("attempted") == spec["warmups"]
        expected_segment_plan = 626 if prior["rawRoot"].endswith("v745") else 900
        assert measured.get("planned") == expected_segment_plan
        assert warmups.get("planned") == 15
        assert warmups.get("completed_correct") == 15, "predecessor_normal_warmup_gate_not_complete"
        if prior["rawRoot"].endswith("v735"):
            assert audit.get("rawOutcomeCounts", {}).get("interrupted") == 1
            assert sum(audit.get("rawOutcomeCounts", {}).values()) == 274
        if prior["rawRoot"].endswith("v745"):
            assert audit.get("fullSegmentMeasuredCountReached") is True
            assert audit.get("previousMeasuredAttemptsRetained") == 274
            assert audit.get("conditionTotalPlanned") == 900
        assert archive.get("sha256") and len(archive["sha256"]) == 64
    assert _sha256_file(RETAINED_DATA / "aurora.db") == RETAINED_DB_SHA


def owned_bytes():
    total = 0
    for base in (ROOT, SHORT_TMP):
        for path in base.rglob("*"):
            try:
                if path.is_file() and not path.is_symlink():
                    total += path.stat().st_size
            except FileNotFoundError:
                pass  # Chrome may remove its own temporary file during sampling.
    return total


def sample_resources(children):
    sample = {
        "at": now(), "monotonicNs": time.monotonic_ns(),
        "memAvailable": _mem_available(), "tmpFree": shutil.disk_usage(ROOT).free,
        "projectFreeObservational": shutil.disk_usage(PROJECT).free,
        "shmFree": shutil.disk_usage("/dev/shm").free,
        "ownedRawAndBrowserTemporaryBytes": owned_bytes(),
        "hostCpuStat": _read_counter(pathlib.Path("/proc/stat")),
        "hostNetwork": _read_counter(pathlib.Path("/proc/net/dev")),
        "loadavg": _read_counter(pathlib.Path("/proc/loadavg")),
        "pressure": {name: _read_counter(pathlib.Path("/proc/pressure") / name) for name in ("cpu", "memory", "io")},
        "children": [], "gpu": [],
    }
    for name, child in children:
        sample["children"].append({"name": name, "pid": child.pid, "exitCode": child.poll(),
            "stat": _read_counter(pathlib.Path(f"/proc/{child.pid}/stat")),
            "status": _read_counter(pathlib.Path(f"/proc/{child.pid}/status"))})
    for device in pathlib.Path("/sys/class/drm").glob("card*/device"):
        if _read_counter(device / "vendor") == "0x1002":
            sample["gpu"].append({key: _read_counter(device / key) for key in ("device", "mem_info_vram_used", "gpu_busy_percent")})
    sample["counterErrors"] = list(counter_errors)
    return sample


def enforce_resources(sample):
    if (sample["tmpFree"] < TMP_RESERVE or sample["memAvailable"] < RAM_FLOOR
            or sample["ownedRawAndBrowserTemporaryBytes"] > RAW_CAP):
        raise RuntimeError("owned_campaign_resource_cap")


def process_identity(pid):
    try:
        fields = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "ppid": int(fields[1]), "pgid": int(fields[2]),
                "startTicks": int(fields[19])}
    except FileNotFoundError:
        return None


def same_process(expected):
    current = process_identity(expected["pid"])
    return current is not None and current["startTicks"] == expected["startTicks"]


def collect_owned(owners):
    # Discover descendants from actual live ancestry, independent of process
    # group. Keep start-time identities after reparenting; never claim reused PIDs.
    snapshot = {}
    for path in pathlib.Path("/proc").glob("[0-9]*"):
        value = process_identity(int(path.name))
        if value is not None:
            snapshot[value["pid"]] = value
    changed = True
    while changed:
        changed = False
        for pid, value in snapshot.items():
            parent = owners.get(value["ppid"])
            actual_parent = snapshot.get(value["ppid"])
            if (pid not in owners and parent is not None and actual_parent is not None
                    and parent["startTicks"] == actual_parent["startTicks"]):
                owners[pid] = {**value, "discoveredViaPid": value["ppid"]}
                changed = True
    return [value for pid, value in owners.items()
            if pid in snapshot and value["startTicks"] == snapshot[pid]["startTicks"]]


def retire_owned(owners, children):
    # Only exact, observed owned identities receive signals, including Chromium
    # in a separate PGID. No worker/session or unobserved group is targeted.
    collect_owned(owners)
    for sig, cap in ((signal.SIGINT, 20), (signal.SIGTERM, 8), (signal.SIGKILL, 3)):
        deadline = time.monotonic() + cap
        signalled = set()
        while True:
            for name, child in children:
                child.poll()
            alive = collect_owned(owners)
            if not alive:
                return []
            for value in alive:
                key = (value["pid"], value["startTicks"])
                if key not in signalled and same_process(value):
                    try:
                        os.kill(value["pid"], sig)
                    except ProcessLookupError:
                        pass
                    signalled.add(key)
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
    return collect_owned(owners)


def main():
    os.umask(0o077)
    start = time.monotonic()
    children, locks, owners = [], [], {}
    runtime_created = False
    state = {
        "schema": "aurora.browser900.controller.v704", "startedAt": now(),
        "controllerPid": os.getpid(), "host": os.uname().nodename,
        "plannedMeasured": 900, "excludedWarmups": 15, "outerCapSeconds": OUTER_CAP,
        "crossDeviceMeasuredAllowed": False,
        "physicalCaptureOrPlaybackVerified": False,
    }

    def launch(name, command, cwd, env):
        with (RUN / f"{name}.private.log").open("xb") as log:
            child = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
        children.append((name, child))
        identity = process_identity(child.pid)
        if identity is not None and child.poll() is None:
            assert identity["pgid"] == child.pid, "fresh_owned_child_group_required"
            owners[child.pid] = {**identity, "launchedByController": True, "name": name}
        state[name + "Pid"] = child.pid
        atomic_json(RUN / "launch.json", state)
        return child

    def terminated(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminated)
    try:
        assert os.uname().nodename == "personal.skyron-server", "personal_desktop_only"
        assert pathlib.Path(__file__).absolute() == ROOT / "controller.py"
        _private_path(ROOT)
        assert not RUN.exists() and not RUN.is_symlink(), "fresh_runtime_required"
        assert not SHORT_TMP.exists() and _no_symlink_path(SHORT_TMP), "fresh_browser_tmp_required"
        for path in ("/tmp/aurora-global-build.lock", "/tmp/aurora-desktop-gpu-baseline.lock"):
            lock = open(path, "a")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locks.append(lock)
        frozen_bytes = _private_path(FROZEN).read_bytes()
        frozen_sha = hashlib.sha256(frozen_bytes).hexdigest()
        assert frozen_sha == os.environ["AURORA_BROWSER_V704_EXPECTED_FROZEN_SHA256"], "independent_manifest_sha_mismatch"
        frozen = json.loads(frozen_bytes)
        browser = verify_manifest(frozen)
        verify_predecessors(frozen)
        archive_custody = _admit_archive_custody(frozen)
        _admit_gpu()
        initial = sample_resources(children)
        assert initial["tmpFree"] >= 3_000_000_000 and initial["memAvailable"] >= 5_000_000_000
        assert initial["shmFree"] >= 500_000_000
        RUN.mkdir(mode=0o700)
        runtime_created = True
        SHORT_TMP.mkdir(mode=0o700)
        assert ROOT.stat().st_dev == SHORT_TMP.stat().st_dev, "same_tmp_write_volume_required"
        for directory in ("temporary", "generic-cache", "backups", "hf-cache", "uv-cache"):
            (RUN / directory).mkdir(mode=0o700)
        state.update(frozenManifestSHA256=frozen_sha, initialResources=initial,
                     writeVolumeDevice=ROOT.stat().st_dev,
                     projectFreeDuringInference="observational_only",
                     archiveCustodyAdmission=archive_custody,
                     writeVolumePolicy={"version":"actual_write_volume_static_browser_v1",
                         "writeRoot":str(ROOT), "writeDevice":ROOT.stat().st_dev,
                         "readOnlyProductionSource":str(SOURCE), "readOnlyWebBuild":str(WEB),
                         "fixedWorkload":"prebuilt root shell; no automatic revalidation/dynamic routes; client voice APIs use Gateway",
                         "temporaryAndCacheRoots":[str(SHORT_TMP),str(RUN/"generic-cache"),str(RUN/"temporary")],
                         "scope":"workload-specific read inputs, not a universal Next filesystem claim"},
                     postTerminalArchive="owned_tmp_first;max40MB;actualbytes_plus80MB_worker_destination_reserve")
        config_path = verify_entry(frozen["launchConfig"])
        assert config_path == ROOT / "input/launch-config.json"
        config_bytes = config_path.read_bytes()
        config = json.loads(config_bytes)
        parent_config_path = verify_entry(frozen["parentLaunchConfig"])
        assert parent_config_path == pathlib.Path("/tmp/aurora-root-padded-http900-v692/input/launch-config.json")
        parent_config = json.loads(parent_config_path.read_text())
        api = config["services"]["gateway"]["api"]
        opts = config["services"]["orchestrator"]["llm"]["local"]["llama_cpp"]["options"]
        assert opts == frozen["models"]["llm"]["actualConstructor"]
        assert api["host"] == "127.0.0.1" and type(api["port"]) is int and 1 <= api["port"] <= 65535
        assert api["request_timeout_s"] >= 180
        assert config["services"]["gateway"]["enabled"] is True and api.get("enabled", True) is True
        assert config["services"]["auth"]["enabled"] is True
        web_port = browser["webPort"]
        assert type(web_port) is int and 1 <= web_port <= 65535 and web_port != api["port"]
        web_url, gateway_url = f"http://127.0.0.1:{web_port}", f"http://127.0.0.1:{api['port']}"
        assert api["cors"]["origins"] == [gateway_url, web_url]
        parent_config["services"]["gateway"]["api"]["port"] = api["port"]
        parent_config["services"]["gateway"]["api"]["cors"]["origins"] = [gateway_url, web_url]
        assert config == parent_config, "same_effective_config_except_frozen_loopback_ports_cors_required"
        for port in (api["port"], web_port):
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", port))
        shutil.copytree(RETAINED_DATA, RUN / "data")
        assert _sha256_file(RUN / "data/aurora.db") == RETAINED_DB_SHA
        with (RUN / "config.json").open("xb") as stream:
            stream.write(config_bytes)
        fixture = json.loads((PROJECT / ".git/aurora-real-ui-audio-v474/retained-fixture.private.json").read_text())
        fixture_path = ROOT / "fixture.private.json"
        assert not fixture_path.exists(), "fresh_private_fixture_required"
        atomic_json(fixture_path, {"username": fixture["username"], "password": fixture["password"],
                                  "webBaseUrl": web_url, "gatewayBaseUrl": gateway_url})
        env = os.environ.copy()
        for key in list(env):
            if key.startswith("NEXT_PUBLIC_"):
                del env[key]
        env.update(TMPDIR=str(SHORT_TMP), TMP=str(SHORT_TMP), TEMP=str(SHORT_TMP),
                   XDG_CACHE_HOME=str(RUN / "generic-cache"), PYTHONDONTWRITEBYTECODE="1")
        web_env = dict(env, PATH=str(NODE.parent) + os.pathsep + env.get("PATH", ""),
                       NODE_ENV="production", NEXT_DIST_DIR=".next-voice-v472", NEXT_TELEMETRY_DISABLED="1",
                       NODE_PATH=str(WEB / "node_modules") + os.pathsep + str(WEB.parent.parent / "node_modules"),
                       NODE_OPTIONS="--max-old-space-size=1024")
        web_child = launch("web", [str(NODE), str(browser["nextCLI"]["path"]), "start", "--hostname", "127.0.0.1", "--port", str(web_port)], WEB, web_env)
        backend_env = dict(env, VIRTUAL_ENV=str(PYTHON.parent.parent),
            PATH=str(PYTHON.parent) + os.pathsep + env.get("PATH", ""),
            AURORA_CONFIG_FILE=str(RUN / "config.json"), AURORA_DATA_DIR=str(RUN / "data"),
            AURORA_ENV_FILE=str(RUN / "absent.env"), AURORA_BACKUP_DIR=str(RUN / "backups"),
            AURORA_ARCHITECTURE_MODE="threads", AURORA_TOKEN_SECRET=api["token_secret"],
            HF_HOME=str(RUN / "hf-cache"), UV_CACHE_DIR=str(RUN / "uv-cache"),
            AURORA_STT_WHISPER_DOWNLOAD_ROOT="/dev/shm/aurora-root-accurate-base-v443/model",
            GGML_VK_VISIBLE_DEVICES="1", OMP_NUM_THREADS="2", OPENBLAS_NUM_THREADS="2", MKL_NUM_THREADS="2",
            AURORA_VOICE_TELEMETRY_V430="1", AURORA_V409_OBSERVER_PATH=str(ROOT / "hook/observer.py"),
            AURORA_VOICE_STAGE_OUTPUT=str(RUN / "voice-stages.jsonl"),
            AURORA_VOICE_STAGE_HOST_ID="personal-desktop-padded-browser900-v704",
            AURORA_BROWSER_HARNESS_CASE_FILE=str(RUN / "active-case.json"),
            AURORA_FROZEN_MANIFEST_SHA256=frozen_sha,
            PYTHONPATH=str(ROOT / "hook") + os.pathsep + str(SOURCE))
        backend = launch("backend", [str(PYTHON), str(ROOT / "bootstrap.py")], SOURCE, backend_env)
        setup_deadline = min(start + OUTER_CAP, time.monotonic() + 180)
        with (RUN / "resources.jsonl").open("x") as resource_stream:
            def sample():
                live_owners = collect_owned(owners)
                value = sample_resources(children)
                value["ownedProcessIdentities"] = live_owners
                resource_stream.write(json.dumps(value) + "\n")
                resource_stream.flush()
                enforce_resources(value)

            while time.monotonic() < setup_deadline:
                assert web_child.poll() is None and backend.poll() is None, "owned_service_exited_during_setup"
                sample()
                try:
                    with urllib.request.urlopen(gateway_url + "/api/health", timeout=2) as response:
                        health = json.load(response)
                    with urllib.request.urlopen(web_url, timeout=2) as response:
                        web_ready = response.status == 200
                    if health.get("status") == "healthy" and health.get("gateway") == "up" and web_ready:
                        break
                except (OSError, urllib.error.URLError, ValueError):
                    pass
                time.sleep(1)
            else:
                raise TimeoutError("normal_ui_services_setup_180s")
            guard = json.loads((RUN / "source-guard.json").read_text())
            assert guard["pid"] == backend.pid and guard["factoryCalledAndReturned"] is True
            versions = json.loads((RUN / "runtime-versions.json").read_text())
            assert versions["pid"] == backend.pid and versions["packages"] == frozen["runtimeVersions"]["packages"]
            state.update(readyAt=now(), webBaseUrl=web_url, gatewayBaseUrl=gateway_url)
            atomic_json(RUN / "ready.json", state)
            command = [str(NODE), str(ROOT / "voice-flow.mjs"), "--base-url", web_url,
                "--fixture-file", str(fixture_path), "--chrome-executable", str(CHROME),
                "--playwright-module", str(PLAYWRIGHT), "--wav", str(ROOT / "candidate-input.wav"),
                "--frozen-manifest", str(FROZEN), "--frozen-manifest-sha256", frozen_sha]
            driver = launch("driver", command, PROJECT, env)
            state["driverLaunchedAt"] = now()
            atomic_json(RUN / "launch.json", state)
            from gate import evaluate_warmups
            gate_written = False
            while driver.poll() is None:
                if time.monotonic() - start >= OUTER_CAP - 35:
                    raise TimeoutError("browser900_outer_cap")
                assert web_child.poll() is None and backend.poll() is None, "owned_service_exited_during_campaign"
                sample()
                if not gate_written and (ROOT / "browser900/attempts/browser-audio-v704-0015/case.json").exists():
                    gate = evaluate_warmups(ROOT, frozen, frozen_sha)
                    if gate is not None:
                        atomic_json(RUN / "warmup-gate.json", gate)
                        gate_written = True
                        state.update(nativeWarmupGatePassedAt=now(), measuredAdmissionGranted=True)
                        atomic_json(RUN / "launch.json", state)
                time.sleep(1)
            state["driverExitCode"] = driver.returncode
            terminal_path = ROOT / "browser900/campaign-terminal.json"
            if terminal_path.is_file():
                state["driverTerminal"] = json.loads(terminal_path.read_text())
            else:
                state["driverTerminalMissing"] = True
            # Driver terminal/case history owns denominators; Root never fills passes
            # or assumes an in-flight operation ended from an exit code alone.
    except BaseException as exc:
        state.update(errorClass=type(exc).__name__, errorCode=str(exc)[:160])
    finally:
        pending = retire_owned(owners, children)
        if pending and runtime_created:
            # Executable cleanup is finite. A surviving owner retains the locks;
            # this passive hold launches/signals nothing and is visible to Root's
            # existing monitor, until exact identities are absent.
            state["reservationRetirementBlocked"] = True
            atomic_json(RUN / "retirement-blocked.json", {
                "at": now(), "ownedProcessesStillPresent": pending,
                "locksRetained": True, "noFurtherExecutableWork": True,
            })
            while pending:
                time.sleep(5)
                for name, child in children:
                    child.poll()
                pending = collect_owned(owners)
        if runtime_created:
            state.update(finishedAt=now(), elapsedSeconds=time.monotonic() - start,
                         children=[{"name": name, "pid": child.pid, "exitCode": child.returncode,
                                    "processPresentAfterWait": pathlib.Path(f"/proc/{child.pid}").exists()}
                                   for name, child in children],
                         ownedProcessIdentities=list(owners.values()),
                         ownedProcessesStillPresent=pending,
                         processPresentAfterWait=bool(pending),
                         retainedDBSHA256Now=_sha256_file(RETAINED_DATA / "aurora.db"),
                         counterErrors=counter_errors)
            atomic_json(RUN / "terminal.json", state)
        else:
            # Admission failures still get a fresh receipt without touching old data.
            with (ROOT / "admission-failure.json").open("x") as stream:
                json.dump({**state, "finishedAt": now()}, stream, sort_keys=True)
        for lock in reversed(locks):
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()
    return 0 if state.get("driverExitCode") == 0 and "errorClass" not in state else 1


if __name__ == "__main__":
    raise SystemExit(main())
