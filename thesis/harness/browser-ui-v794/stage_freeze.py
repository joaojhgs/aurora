"""Root-only staging/freezing for the reviewed V794 normal-browser condition.

This command is intentionally not run during source preparation. It is usable
only on the admitted personal desktop after V692, V735, and V745 have natural
terminal, exact retirement, and successful one-time export-audit receipts.
It creates ROOT/input only; the approved controller creates runtime and the
private fixture at launch. It never starts Aurora, Next, Chrome, or a model.
"""
from __future__ import annotations

import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sys

PROJECT = Path("/home/developer/projects/aurora")
IMPORT = PROJECT / ".git/aurora-handoff-import-20261006"
ROOT = Path("/tmp/aurora-root-padded-browser900-v794")
SHORT_TMP = Path("/tmp/.ab794")
SOURCE = IMPORT / "http-full-audio-v497/source"
WEB = PROJECT / ".git/aurora-web-tts-v472/source/apps/aurora-web"
WEB_BUILD_TARGET = Path("/dev/shm/aurora-root-accurate-base-v443/web-next-output-v472")
PARENT_HTTP = Path("/tmp/aurora-root-padded-http900-v692")
V675 = PROJECT / "docs/experiments/tcc-20261013-submission-20261030/root/ui-full-audio-readiness-v675"
V675_SHA = "b36d6585b8f7fb4b87b54dceda813eaa42b0bd03c62ee3209bed1e0755a26ae3"
INPUT_SHA = "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
EXPECTED_PROVIDER_SHA = "bbfe63686818717d1ecf709b49603590679a2a1e5e179d2aaa33ba14c12a1aed"
EXPECTED_PROVIDER_FILE_SHA = "6a73785e32a79c0d82296e7f05e2f9a44d2a727bfc73cb99f15ddbcde5d34f77"
PARENT_HTTP_FROZEN_SHA = "81c25bd59323b1d515d20f9ea154868640e0f0d55b04cb39e77e88fb414aa78f"
DRIVER = IMPORT / "browser-launch-api-prep-v794/voice-flow.mjs"
CONTROLLER = IMPORT / "browser-launch-api-prep-v794/controller.py"
BOOTSTRAP = IMPORT / "browser-launch-api-prep-v794/bootstrap.py"
GATE = IMPORT / "browser-launch-api-prep-v794/gate.py"
HOOK = IMPORT / "browser-launch-api-prep-v794/hook"
EXPECTED_PROVIDER = IMPORT / "browser-launch-api-prep-v794/expected-provider-identity.json"
NODE = Path("/home/developer/.asdf/installs/nodejs/24.19.0/bin/node")
CHROME = Path("/usr/bin/google-chrome")
PYTHON = Path("/tmp/aurora-root-voice-primary-v426/env/bin/python")
PLAYWRIGHT = Path("/tmp/aurora-root-voice-primary-v426/env/lib/python3.11/site-packages/playwright/driver/package/index.mjs")
DIST = ".next-voice-v472"
BUILD_ID = "hrxU1EH9eftYmJl3tw_eR"
RETAINED_DATA = PROJECT / ".git/aurora-real-ui-audio-v474/runtime/data"
RETAINED_DB_SHA = "911f10f5808a312ad7712daefab7b47a404966ae58a14c7e95090408fc40d52e"
WORKER_MIN_FREE = 120_000_000
WORKER_OBSERVATION = Path("/tmp/aurora-browser-worker-custody-v794.json")
DESTINATION = "/home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-browser900-v794"
MIN_TMP_FREE = 3_000_000_000
MIN_SHM_FREE = 500_000_000
MIN_RAM = 5_000_000_000
PRED = (
    {
        "rawRoot": Path("/tmp/aurora-root-padded-http900-v692"),
        "pids": [3116872, 3116892],
        "frozenSha": "81c25bd59323b1d515d20f9ea154868640e0f0d55b04cb39e77e88fb414aa78f",
        "frozenRelative": "input/frozen-http-manifest.json",
        "exportDir": "export-v715",
        "archiveName": "aurora-desktop-gpu-padded-http900-v692.zip",
        "planned": 900,
        "attempted": 900,
        "warmups": 15,
        "kind": "http_full",
    },
    {
        "rawRoot": Path("/tmp/aurora-root-padded-local900-v735"),
        "pids": [3295193, 3295224],
        "frozenSha": "be108882b3024b33545f1484da00a56dccc5993e5c441b3eb3854102e7f14ac5",
        "frozenRelative": "input/frozen-local-manifest.json",
        "exportDir": "export-v744",
        "archiveName": "aurora-desktop-gpu-padded-local900-v735.zip",
        "planned": 900,
        "attempted": 274,
        "warmups": 15,
        "kind": "local_partial",
    },
    {
        "rawRoot": Path("/tmp/aurora-root-padded-local900-v745"),
        "pids": [3312910, 3312941],
        "frozenSha": "31dea74bf4587e7bef60c44ef28c2b3f7a2da73a69891df27bc318b9819d505d",
        "frozenRelative": "input/frozen-local-manifest.json",
        "exportDir": "export-v751",
        "archiveName": "aurora-desktop-gpu-padded-local900-v745.zip",
        "planned": 626,
        "attempted": 626,
        "warmups": 15,
        "kind": "local_segment",
    },
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def entry(path: Path, *, executable: bool = False) -> dict[str, object]:
    if not path.is_absolute():
        raise RuntimeError("binding_path_must_be_absolute")
    target = path.resolve(strict=True) if executable else path
    if path.is_symlink() and not executable:
        raise RuntimeError("unexpected_symlink_binding")
    if not target.is_file() or target.is_symlink() or not no_symlink_components(target):
        raise RuntimeError("binding_not_regular_file")
    value: dict[str, object] = {"path": str(path), "bytes": target.stat().st_size, "sha256": file_digest(target)}
    if executable:
        value["resolvedPath"] = str(target)
    return value


def checked_entry(raw: dict[str, object], expected_path: Path | None = None) -> Path:
    path = Path(str(raw["path"]))
    if not path.is_absolute() or path.is_symlink():
        raise RuntimeError("manifest_path_not_absolute_regular")
    if expected_path is not None and path != expected_path:
        raise RuntimeError("manifest_path_mismatch")
    current = entry(path)
    if current["bytes"] != raw["bytes"] or current["sha256"] != raw["sha256"]:
        raise RuntimeError("manifest_file_changed")
    return path


def no_symlink_components(path: Path) -> bool:
    absolute = Path(os.path.abspath(path))
    return all(not part.is_symlink() for part in (absolute, *absolute.parents))


def read_json(path: Path) -> dict:
    if not path.is_file() or path.is_symlink() or not no_symlink_components(path):
        raise RuntimeError("required_receipt_missing_or_symlinked")
    return json.loads(path.read_text())


def predecessor(spec: dict[str, object]) -> dict[str, object]:
    root = spec["rawRoot"]
    assert isinstance(root, Path)
    pids = spec["pids"]
    assert isinstance(pids, list)
    for pid in pids:
        if Path(f"/proc/{pid}").exists():
            raise RuntimeError("predecessor_process_still_live")
    frozen_path = root / str(spec["frozenRelative"])
    frozen_binding = entry(frozen_path)
    if frozen_binding["sha256"] != spec["frozenSha"]:
        raise RuntimeError("predecessor_frozen_manifest_mismatch")
    terminal_path = root / "runtime/terminal.json"
    retirement_path = root / "runtime/retirement.json"
    export_root = root / str(spec["exportDir"])
    receipt_path = export_root / "audit-verification.json"
    archive_manifest_path = export_root / "ARCHIVE-MANIFEST.json"
    terminal_binding = entry(terminal_path)
    retirement_binding = entry(retirement_path)
    receipt_binding = entry(receipt_path)
    archive_manifest_binding = entry(archive_manifest_path)
    terminal = read_json(terminal_path)
    retirement = read_json(retirement_path)
    receipt = read_json(receipt_path)
    archived = read_json(archive_manifest_path)
    if not terminal.get("finishedAt") or terminal.get("processPresentAfterWait") is not False:
        raise RuntimeError("predecessor_not_naturally_terminal")
    if retirement.get("pidsAbsent") != pids or retirement.get("noProcessesTerminatedByRetirement") is not True:
        raise RuntimeError("predecessor_retirement_pid_binding_mismatch")
    if retirement.get("locksObservedFreeThenHeldForExport") is not True:
        raise RuntimeError("predecessor_retirement_lock_binding_missing")
    if retirement.get("frozenManifestSHA256") != spec["frozenSha"] or retirement.get("terminal") != terminal_binding:
        raise RuntimeError("predecessor_retirement_receipt_binding_mismatch")
    if retirement.get("retainedDBSHA256Now") != RETAINED_DB_SHA:
        raise RuntimeError("predecessor_retained_database_binding_mismatch")
    if receipt.get("savedZipIntegrityHashesAndOutcomeAuditPassed") is not True:
        raise RuntimeError("predecessor_export_audit_not_passed")
    if receipt.get("frozenManifestSHA256") != spec["frozenSha"] or receipt.get("retirement") != retirement_binding:
        raise RuntimeError("predecessor_export_receipt_binding_mismatch")
    if receipt.get("rawOriginalsPreserved") is not True or archived.get("originalsPreserved") is not True:
        raise RuntimeError("predecessor_original_custody_not_confirmed")
    if archived.get("frozenManifestSHA256") != spec["frozenSha"]:
        raise RuntimeError("predecessor_archive_manifest_mismatch")
    archive = receipt.get("archive")
    archive_path = export_root / str(spec["archiveName"])
    if not isinstance(archive, dict) or Path(str(archive.get("path", ""))) != archive_path:
        raise RuntimeError("predecessor_archive_binding_missing")
    if not archive_path.is_file() or archive_path.is_symlink() or archive_path.stat().st_size != archive.get("bytes"):
        raise RuntimeError("predecessor_archive_custody_size_mismatch")
    phase = receipt.get("phaseDenominators", {})
    measured = phase.get("measured", {}) if isinstance(phase, dict) else {}
    warmup = phase.get("warmup_excluded", {}) if isinstance(phase, dict) else {}
    if measured.get("planned") != spec["planned"] or measured.get("attempted") != spec["attempted"]:
        raise RuntimeError("predecessor_measured_denominator_mismatch")
    if warmup.get("planned") != 15 or warmup.get("attempted") != spec["warmups"]:
        raise RuntimeError("predecessor_warmup_denominator_mismatch")
    outcomes = receipt.get("rawOutcomeCounts", {})
    if spec["kind"] == "http_full" and receipt.get("fullMeasuredCountReached") is not True:
        raise RuntimeError("http_predecessor_full_count_not_audited")
    if spec["kind"] == "local_partial":
        if sum(outcomes.values()) != 274 or outcomes.get("interrupted") != 1:
            raise RuntimeError("original_partial_outcome_not_preserved")
        if measured.get("unattempted") != 626:
            raise RuntimeError("original_partial_denominator_mismatch")
    if spec["kind"] == "local_segment":
        if (receipt.get("fullSegmentMeasuredCountReached") is not True
                or receipt.get("previousMeasuredAttemptsRetained") != 274
                or receipt.get("conditionTotalPlanned") != 900):
            raise RuntimeError("continuation_segment_not_complete")
    return {
        "rawRoot": str(root), "ownedPids": pids,
        "expectedFrozenManifestSHA256": spec["frozenSha"],
        "frozenManifest": frozen_binding, "terminal": terminal_binding,
        "retirement": retirement_binding, "exportReceipt": receipt_binding,
        "exportManifest": archive_manifest_binding,
    }


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def all_regular_files(root: Path) -> dict[str, dict[str, object]]:
    if not root.is_dir() or root.is_symlink() or not no_symlink_components(root):
        raise RuntimeError("inventory_root_missing_or_symlinked")
    files: dict[str, dict[str, object]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("symlink_in_frozen_tree")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = entry(path)
    return files


def acquire_and_release(path: Path) -> None:
    handle = path.open("a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("required_build_lock_busy") from None
    finally:
        try:
            fcntl.flock(handle, fcntl.LOCK_UN)
        finally:
            handle.close()


def read_mem_available() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("mem_available_unavailable")


def validate_assets(parent: dict, readiness: dict) -> None:
    expected = {row["sha256"]: row["bytes"] for row in readiness["actualAssetHashChecks"]}
    models = parent["models"]
    actual = [*models["stt"]["weightFiles"], models["llm"]["weights"],
              models["tts"]["weights"], models["tts"]["voiceConfig"]]
    found = {row["sha256"]: row["bytes"] for row in actual}
    if any(found.get(sha) != size for sha, size in expected.items()):
        raise RuntimeError("parent_model_assets_differ_from_V675_qualified_assets")


def validate_harness_sources() -> None:
    expected = {
        "controller.py": "11a0f3aa4df927af88e2b94fb879dfe4ca70d5d90dfd33b4c73618536ba22676",
        "bootstrap.py": "9920c1d8ddc358d7e28a19b4c2ace882552f5a1ac39a14e933467521017dbec9",
        "gate.py": "5647de41533d0b3a198b0ba95eca88717c364a995c2df5985164a08de52f945e",
        "voice-flow.mjs": "aafc4b2471d01160bf86f43d1d23fd56c488e1ae37c32a3a5d9a66f2de1c2741",
        "hook/bindings.py": "d4a2ee4b9419b3be9713c55c5ffbdb3cdf29847f7a4be44e22ae64458d2471e0",
        "hook/observer.py": "ce614d6e00bfd425a966eb3165f8b75e3269b956ef288c15f0cf31fd96e4e51a",
        "hook/aurora_voice_telemetry_v430.py": "9c6eccc91edb5136c95982b6b04fd770ee78ca365558fe347a25908f5818bc6d",
    }
    paths = {
        "controller.py": CONTROLLER,
        "bootstrap.py": BOOTSTRAP,
        "gate.py": GATE,
        "voice-flow.mjs": DRIVER,
        "hook/bindings.py": HOOK / "bindings.py",
        "hook/observer.py": HOOK / "observer.py",
        "hook/aurora_voice_telemetry_v430.py": HOOK / "aurora_voice_telemetry_v430.py",
    }
    for name, expected_sha in expected.items():
        if entry(paths[name])["sha256"] != expected_sha:
            raise RuntimeError("reviewed_browser_harness_pin_mismatch")


def main() -> int:
    os.umask(0o077)
    if os.uname().nodename != "personal.skyron-server":
        raise RuntimeError("personal_desktop_only")
    if ROOT.exists() or ROOT.is_symlink() or SHORT_TMP.exists() or SHORT_TMP.is_symlink():
        raise RuntimeError("fresh_campaign_roots_required")
    if not no_symlink_components(ROOT.parent) or not no_symlink_components(SHORT_TMP.parent):
        raise RuntimeError("campaign_parent_symlinked")
    if read_mem_available() < MIN_RAM or shutil.disk_usage("/tmp").free < MIN_TMP_FREE:
        raise RuntimeError("fresh_ram_or_tmp_admission_failed")
    if shutil.disk_usage("/dev/shm").free < MIN_SHM_FREE:
        raise RuntimeError("fresh_shm_admission_failed")
    worker_bytes = WORKER_OBSERVATION.read_bytes()
    worker_binding = entry(WORKER_OBSERVATION)
    worker = json.loads(worker_bytes)
    if (worker.get("schema") != "aurora.worker-archive-capacity-observation.v1"
            or worker.get("host") != "code-worker" or worker.get("project") != str(PROJECT)
            or worker.get("destinationPath") != DESTINATION
            or type(worker.get("freeBytes")) is not int or worker["freeBytes"] < WORKER_MIN_FREE):
        raise RuntimeError("fresh_actual_worker_archive_capacity_required")
    observed_at = datetime.datetime.fromisoformat(worker["observedAt"])
    if observed_at.tzinfo is None or not -10 <= (datetime.datetime.now(datetime.timezone.utc)-observed_at).total_seconds() <= 300:
        raise RuntimeError("worker_archive_observation_not_fresh")
    for lock in (Path("/tmp/aurora-global-build.lock"), Path("/tmp/aurora-desktop-gpu-baseline.lock")):
        acquire_and_release(lock)

    priors = [predecessor(spec) for spec in PRED]
    parent_path = PARENT_HTTP / "input/frozen-http-manifest.json"
    parent_binding = entry(parent_path)
    if parent_binding["sha256"] != PARENT_HTTP_FROZEN_SHA:
        raise RuntimeError("parent_http_frozen_manifest_pin_mismatch")
    parent = json.loads(parent_path.read_text())
    checked_entry(parent["launchConfig"])
    readiness_path = V675 / "qualified-manifest.json"
    readiness_bytes = readiness_path.read_bytes()
    if digest(readiness_bytes) != V675_SHA:
        raise RuntimeError("V675_qualification_manifest_pin_mismatch")
    readiness = json.loads(readiness_bytes)
    if readiness.get("status") != "QUALIFIED_SINGLE_READINESS_ONLY":
        raise RuntimeError("V675_readiness_status_changed")
    validate_assets(parent, readiness)
    if parent["runtimeVersions"]["packages"] != readiness["actualVersions"]:
        raise RuntimeError("parent_runtime_versions_differ_from_V675")
    if parent["sourceFiles"].get("app/services/gateway/fastapi_app.py") is None:
        raise RuntimeError("approved_production_source_inventory_missing")
    source_files: dict[str, dict[str, object]] = {}
    for relative, pinned in parent["sourceFiles"].items():
        path = SOURCE / relative
        current = entry(path)
        if current["bytes"] != pinned["bytes"] or current["sha256"] != pinned["sha256"]:
            raise RuntimeError("approved_source400_pin_mismatch")
        source_files[relative] = current

    validate_harness_sources()

    browser_expected = json.loads(EXPECTED_PROVIDER.read_text())
    if (browser_expected.get("sha256") != EXPECTED_PROVIDER_SHA
            or entry(EXPECTED_PROVIDER)["sha256"] != EXPECTED_PROVIDER_FILE_SHA):
        raise RuntimeError("V675_actual_provider_identity_pin_mismatch")
    llm_identity = readiness["models"]["llm"]
    if (llm_identity["sha256"] != parent["models"]["llm"]["weights"]["sha256"]
            or llm_identity["observedBackendOffload"] != "25/25 layers"):
        raise RuntimeError("V675_GPU_provider_binding_mismatch")
    actual_constructor = parent["models"]["llm"]["actualConstructor"]
    for key, value in browser_expected["llm"]["effective_wrapper_settings"].items():
        if actual_constructor.get(key) != value:
            raise RuntimeError("V675_LLM_constructor_settings_mismatch")

    build_alias = WEB / DIST
    try:
        build_root = build_alias.resolve(strict=True)
    except OSError:
        raise RuntimeError("approved_web_build_alias_unresolvable") from None
    if build_root != WEB_BUILD_TARGET or build_root.is_symlink() or not build_root.is_dir():
        raise RuntimeError("approved_web_build_alias_target_mismatch")
    build_id_path = build_root / "BUILD_ID"
    if build_id_path.read_text().strip() != BUILD_ID:
        raise RuntimeError("approved_V472_build_id_mismatch")
    web_files = all_regular_files(build_root)
    if "BUILD_ID" not in web_files:
        raise RuntimeError("web_build_id_file_missing")
    prerender_path = build_root / "prerender-manifest.json"
    prerender = json.loads(prerender_path.read_text())
    if prerender["routes"]["/"]["initialRevalidateSeconds"] is not False or prerender["dynamicRoutes"] != {}:
        raise RuntimeError("fixed_static_browser_workload_required")
    browser = {
        "node": entry(NODE, executable=True),
        "chrome": entry(CHROME, executable=True),
        "playwright": entry(PLAYWRIGHT, executable=True),
        "nextCLI": entry(WEB / "node_modules/next/dist/bin/next", executable=True),
        "webPort": free_port(),
        "readOnlyBuildMetadata": {"nextConfig":entry(WEB / "next.config.mjs"),
                                  "prerenderManifest":entry(prerender_path)},
        "webBuild": {"root": str(WEB), "distDirectory": DIST, "resolvedBuildRoot": str(build_root),
                     "buildId": BUILD_ID, "files": web_files},
    }
    api_port = free_port()
    while api_port == browser["webPort"]:
        api_port = free_port()
    parent_config_path = PARENT_HTTP / "input/launch-config.json"
    parent_config = json.loads(parent_config_path.read_text())
    config = json.loads(json.dumps(parent_config))
    api = config["services"]["gateway"]["api"]
    if api.get("host") != "127.0.0.1":
        raise RuntimeError("parent_gateway_not_loopback")
    api["port"] = api_port
    api["cors"]["origins"] = [f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{browser['webPort']}"]

    harness_sources = {
        "controller.py": CONTROLLER,
        "bootstrap.py": BOOTSTRAP,
        "gate.py": GATE,
        "voice-flow.mjs": DRIVER,
        "hook/bindings.py": HOOK / "bindings.py",
        "hook/observer.py": HOOK / "observer.py",
        "hook/aurora_voice_telemetry_v430.py": HOOK / "aurora_voice_telemetry_v430.py",
    }
    harness_files: dict[str, dict[str, object]] = {}
    for relative, source in harness_sources.items():
        staged = ROOT / relative
        harness_files[relative] = {**entry(source), "path": str(staged)}

    input_source = V675 / "candidate-input.wav"
    input_entry = entry(input_source)
    if input_entry["sha256"] != INPUT_SHA or input_entry["bytes"] != 219794:
        raise RuntimeError("fixed_browser_input_mismatch")
    launch_path = ROOT / "input/launch-config.json"
    launch_bytes = json.dumps(config, sort_keys=True, indent=2).encode() + b"\n"
    frozen: dict[str, object] = {
        "schema": "aurora.browser900.frozen.v794",
        "cohortId": "aurora-normal-ui-padded-file-mic-full-audio-v794",
        "plan": {"warmups": 15, "measured": 900, "conditionCapSeconds": 57600,
                 "caseCapSeconds": 180, "setupCapSeconds": 180, "outerCapSeconds": 57840},
        "strictTranscript": "What is the capital of France? Answer with only the city name.",
        "strictReplyWords": ["paris"],
        "sourcePins": {"driverSHA256": harness_files["voice-flow.mjs"]["sha256"],
                       "stageFreezerSHA256": entry(Path(__file__))["sha256"],
                       "parentHttpFrozenManifestSHA256": parent_binding["sha256"],
                       "V675QualifiedManifestSHA256": V675_SHA},
        "input": {"path": str(ROOT / "candidate-input.wav"), "bytes": 219794, "sha256": INPUT_SHA},
        "sourceFiles": source_files,
        "models": parent["models"],
        "pythonEnvironment": parent["pythonEnvironment"],
        "runtimeVersions": parent["runtimeVersions"],
        "expectedActualProviderIdentity": browser_expected,
        "harnessFiles": harness_files,
        "browserRuntime": browser,
        "launchConfig": {"path": str(launch_path), "bytes": len(launch_bytes), "sha256": digest(launch_bytes)},
        "parentLaunchConfig": entry(parent_config_path),
        "serialPredecessors": priors,
        "archiveCustody": {"mode":"existing_orca_saved_archive_to_worker_docs", "destinationHost":"code-worker",
            "destinationPath":DESTINATION, "actualWorkerObservationFile":{
                "path":str(ROOT/"input/worker-custody-admission.json"),"bytes":len(worker_bytes),"sha256":digest(worker_bytes)}},
        "readinessManifest": {"path": str(readiness_path), "bytes": len(readiness_bytes), "sha256": V675_SHA,
                              "classification": readiness["classification"], "measuredRequests": 0},
        "admission": {"host": os.uname().nodename, "memAvailableBytes": read_mem_available(),
                      "tmpFreeBytes": shutil.disk_usage("/tmp").free,
                      "shmFreeBytes": shutil.disk_usage("/dev/shm").free,
                      "projectFreeBytes": shutil.disk_usage(PROJECT).free,
                      "locksProbedFree": True, "capturedAtEpochNs": __import__("time").time_ns()},
    }

    ROOT.mkdir(mode=0o700)
    os.chmod(ROOT, 0o700)
    (ROOT / "input").mkdir(mode=0o700)
    os.chmod(ROOT / "input", 0o700)
    with (ROOT / "input/worker-custody-admission.json").open("xb") as stream:
        stream.write(worker_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    for relative, source in harness_sources.items():
        target = ROOT / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        os.chmod(target, 0o600)
        if entry(target)["sha256"] != harness_files[relative]["sha256"]:
            raise RuntimeError("staged_harness_hash_mismatch")
    shutil.copyfile(input_source, ROOT / "candidate-input.wav")
    os.chmod(ROOT / "candidate-input.wav", 0o600)
    with launch_path.open("xb") as stream:
        stream.write(launch_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(launch_path, 0o600)
    frozen_path = ROOT / "frozen-manifest.json"
    frozen_bytes = json.dumps(frozen, sort_keys=True, indent=2).encode() + b"\n"
    with frozen_path.open("xb") as stream:
        stream.write(frozen_bytes)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(frozen_path, 0o600)
    print(json.dumps({"marker": "AURORA_BROWSER_V768_FROZEN", "root": str(ROOT),
                      "frozenManifestSHA256": digest(frozen_bytes), "inputSHA256": INPUT_SHA,
                      "predecessors": len(priors), "warmups": 15, "measured": 900,
                      "runtimeAndFixtureCreated": False}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"marker": "AURORA_BROWSER_V768_STAGE_REFUSED",
                          "errorClass": type(exc).__name__, "errorCode": str(exc)[:120]}, sort_keys=True), file=sys.stderr)
        raise SystemExit(2)
