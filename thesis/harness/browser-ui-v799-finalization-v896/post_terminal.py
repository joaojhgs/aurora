"""One-shot finalization of the existing browser V799 run; never launches a workload.

Default invocation refuses before reading run data or writing. Root may invoke
with --execute-finalization only after natural terminal and owner retirement.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path("/tmp/aurora-root-padded-browser900-v799")
EXPORT = ROOT / "export-v888"
FROZEN_SHA = "e67f8f98830ef0ceb978590bbe6b8b496ada2ad4ddd05bc34fb22248c65c10b8"
CONTROLLER_PID = 3418365
CONTROLLER_START_TICKS = 74502600
WAV_SHA = "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
WAV_BYTES = 219794
COHORT = "aurora-normal-ui-padded-file-mic-full-audio-v799"
WARMUPS = 15
MEASURED = 900
LOCK_PATHS = (Path("/tmp/aurora-global-build.lock"), Path("/tmp/aurora-desktop-gpu-baseline.lock"))
ARCHIVE_NAME = "aurora-browser-normal-ui-padded-full-audio-v799.zip"
SENSITIVE_NAMES = {"fixture.private.json", "launch-config.json", "config.json", "absent.env"}
PRIVATE_LOG_NAMES = {"backend.private.log", "web.private.log", "driver.private.log", "controller.private.log"}
STAGES = ("stt", "llm", "tts")


class AuditError(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def regular(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def no_symlink_components(path: Path) -> bool:
    absolute = Path(os.path.abspath(path))
    return all(not item.is_symlink() for item in (absolute, *absolute.parents))


def binding(path: Path) -> dict:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": file_sha(path)}


def write_once(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def type7(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def add_tree(base: Path, selected: list[tuple[Path, str]], *, omit: set[str] | None = None) -> None:
    omit = omit or set()
    if not base.exists():
        return
    if base.is_symlink():
        raise AuditError("selected_tree_is_symlink")
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(ROOT).as_posix()
        if any(part in {"__pycache__", "node_modules", "profile", "generic-cache", "hf-cache", "uv-cache", "backups", "data"} for part in path.parts):
            continue
        if path.is_symlink():
            raise AuditError("symlink_in_selected_tree")
        if not path.is_file() or path.name in omit or path.name in SENSITIVE_NAMES or path.name in PRIVATE_LOG_NAMES:
            continue
        selected.append((path, rel))


def selected_files() -> tuple[list[tuple[Path, str]], list[dict]]:
    selected: list[tuple[Path, str]] = []
    omissions: list[dict] = []
    explicit = (
        "spawn.json", "frozen-manifest.json", "candidate-manifest.json", "candidate-input.wav",
        "pilot-input.json", "controller.py", "bootstrap.py", "gate.py", "voice-flow.mjs",
        "expected-provider-identity.json",
    )
    for name in explicit:
        path = ROOT / name
        if path.exists():
            if not regular(path):
                raise AuditError("required_harness_file_not_regular")
            selected.append((path, name))
    for name in ("input", "hook", "browser900"):
        add_tree(ROOT / name, selected, omit={"launch-config.json"})
    runtime = ROOT / "runtime"
    if runtime.exists():
        if runtime.is_symlink():
            raise AuditError("runtime_root_is_symlink")
        for path in sorted(runtime.iterdir()):
            if path.is_symlink():
                raise AuditError("runtime_entry_is_symlink")
            if path.is_file() and path.name not in SENSITIVE_NAMES | PRIVATE_LOG_NAMES and path.suffix in {".json", ".jsonl"}:
                selected.append((path, path.relative_to(ROOT).as_posix()))
    output: list[tuple[Path, str]] = []
    seen: set[str] = set()
    for path, rel in selected:
        if rel in seen:
            raise AuditError("duplicate_archive_path")
        seen.add(rel)
        output.append((path, rel))
    for name, reason in (
        ("fixture.private.json", "private login fixture withheld"),
        ("input/launch-config.json", "private launch configuration withheld"),
        ("runtime/config.json", "private runtime configuration withheld"),
        ("runtime/absent.env", "private environment file withheld"),
        ("runtime/data", "private runtime database/data withheld"),
        ("runtime/backups", "private database backups withheld"),
        ("runtime/backend.private.log", "raw private backend log withheld"),
        ("web.private.log", "raw private service log withheld"),
        ("driver.private.log", "raw private driver log withheld"),
        ("controller.private.log", "raw private controller log withheld"),
    ):
        path = ROOT / name
        if path.exists() and not path.is_symlink():
            record = {"path": name, "reason": reason}
            if path.is_file():
                record.update(bytes=path.stat().st_size, sha256=file_sha(path))
            else:
                record["bytes"] = None
                record["contentHash"] = None
            omissions.append(record)
    return output, omissions


def retire_after_natural_terminal() -> tuple[dict, list[int]]:
    if os.uname().nodename != "personal.skyron-server":
        raise AuditError("wrong_finalization_host")
    if ROOT.is_symlink() or not ROOT.is_dir() or not no_symlink_components(ROOT):
        raise AuditError("campaign_root_missing_or_symlinked")
    if EXPORT.exists() or EXPORT.is_symlink():
        raise AuditError("existing_export_must_be_reconciled_not_replayed")
    retirement_path = ROOT / "runtime/retirement-v888.json"
    if retirement_path.exists() or retirement_path.is_symlink():
        raise AuditError("existing_retirement_must_be_reconciled_not_replayed")
    frozen_path = ROOT / "frozen-manifest.json"
    terminal_path = ROOT / "runtime/terminal.json"
    launch_path = ROOT / "runtime/launch.json"
    driver_terminal_path = ROOT / "browser900/campaign-terminal.json"
    for path in (frozen_path, terminal_path, launch_path, driver_terminal_path):
        if not regular(path) or not no_symlink_components(path):
            raise AuditError("natural_terminal_input_missing_or_symlinked")
    frozen_raw = frozen_path.read_bytes()
    if digest(frozen_raw) != FROZEN_SHA:
        raise AuditError("frozen_v799_manifest_mismatch")
    frozen = json.loads(frozen_raw)
    if (frozen.get("schema") != "aurora.browser900.frozen.v799" or frozen.get("cohortId") != COHORT
            or frozen.get("plan") != {"warmups": 15, "measured": 900, "conditionCapSeconds": 57600,
                                      "caseCapSeconds": 180, "setupCapSeconds": 180, "outerCapSeconds": 57840}
            or frozen.get("input", {}).get("sha256") != WAV_SHA or frozen.get("input", {}).get("bytes") != WAV_BYTES):
        raise AuditError("frozen_v799_contract_mismatch")
    launch = json.loads(launch_path.read_bytes())
    terminal = json.loads(terminal_path.read_bytes())
    driver_terminal = json.loads(driver_terminal_path.read_bytes())
    if (launch.get("controllerPid") != CONTROLLER_PID or launch.get("frozenManifestSHA256") != FROZEN_SHA
            or terminal.get("controllerPid") != CONTROLLER_PID or terminal.get("frozenManifestSHA256") != FROZEN_SHA
            or terminal.get("processPresentAfterWait") is not False or terminal.get("finishedAt") is None
            or terminal.get("reservationRetirementBlocked") is True
            or terminal.get("ownedProcessesStillPresent") not in ([], None)
            or terminal.get("driverTerminalMissing") is True
            or terminal.get("driverTerminal", {}).get("frozenManifestSHA256") != FROZEN_SHA
            or driver_terminal.get("schema") != "aurora.browser900.campaign.v799"
            or driver_terminal.get("frozenManifestSHA256") != FROZEN_SHA):
        raise AuditError("natural_terminal_receipt_mismatch")
    if Path(f"/proc/{CONTROLLER_PID}").exists():
        raise AuditError("original_controller_still_live")
    pids: set[int] = {CONTROLLER_PID}
    child_rows = terminal.get("children")
    identities = terminal.get("ownedProcessIdentities")
    if not isinstance(child_rows, list) or not isinstance(identities, list):
        raise AuditError("owned_child_identity_receipt_missing")
    for identity in identities:
        if (not isinstance(identity, dict)
                or type(identity.get("pid")) is not int or identity["pid"] <= 1
                or type(identity.get("startTicks")) is not int or identity["startTicks"] <= 0):
            raise AuditError("owned_process_start_identity_invalid")
        pids.add(identity["pid"])
    identity_by_pid = {row.get("pid"): row for row in identities if isinstance(row, dict)}
    for child in child_rows:
        if not isinstance(child, dict) or child.get("name") not in {"web", "backend", "driver"}:
            raise AuditError("owned_child_identity_invalid")
        pid = child.get("pid")
        if type(pid) is not int or pid <= 1 or child.get("processPresentAfterWait") is not False:
            raise AuditError("owned_child_not_naturally_absent")
        identity = identity_by_pid.get(pid)
        if not isinstance(identity, dict) or identity.get("startTicks") is None:
            raise AuditError("owned_child_start_identity_missing")
        pids.add(pid)
    if {row.get("name") for row in child_rows} != {"web", "backend", "driver"}:
        raise AuditError("owned_child_set_incomplete")
    if any(Path(f"/proc/{pid}").exists() for pid in pids):
        raise AuditError("owned_process_still_live_do_not_finalize")
    if not regular(ROOT / "spawn.json"):
        raise AuditError("controller_spawn_identity_missing")
    spawn = json.loads((ROOT / "spawn.json").read_bytes())
    if (spawn.get("pid") != CONTROLLER_PID
            or str(spawn.get("startTicks")) != str(CONTROLLER_START_TICKS)
            or spawn.get("frozenManifestSHA256") != FROZEN_SHA):
        raise AuditError("controller_spawn_identity_mismatch")
    return {"frozen": frozen, "terminalPath": terminal_path, "terminal": terminal,
            "launchPath": launch_path, "launch": launch, "driverTerminalPath": driver_terminal_path,
            "driverTerminal": driver_terminal, "spawn": spawn}, sorted(pids)


def pair_native_stages(raw: bytes, measured_ids: set[str], backend_pid: int) -> tuple[dict, dict]:
    starts: dict[tuple, dict] = {}
    spans: dict[str, dict[str, list[dict]]] = collections.defaultdict(lambda: {stage: [] for stage in STAGES})
    counts = collections.Counter()
    for line in raw.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("record_kind") != "invocation_span_boundary":
            continue
        case_id = row.get("harness_case_id")
        if case_id not in measured_ids or row.get("stage") not in STAGES:
            continue
        key = tuple(row.get(key) for key in ("receiver_pid", "recorder_process_id", "clock_domain", "stage", "span_id", "correlation_id"))
        if row.get("event") == "span_start":
            if key in starts:
                counts["duplicate_start"] += 1
            else:
                starts[key] = row
            continue
        if row.get("event") != "span_end":
            continue
        begin = starts.pop(key, None)
        if begin is None:
            counts["end_without_start"] += 1
            continue
        try:
            end_ns, start_ns = int(row["monotonic_ns"]), int(begin["monotonic_ns"])
        except (KeyError, TypeError, ValueError):
            counts["invalid_boundary"] += 1
            continue
        good = (row.get("outcome") == "completed" and row.get("receiver_pid") == backend_pid
                and begin.get("receiver_pid") == backend_pid
                and row.get("clock_domain") == begin.get("clock_domain") == "python_process_monotonic"
                and row.get("span_id") and row.get("span_id") == begin.get("span_id")
                and row.get("correlation_id") == begin.get("correlation_id")
                and row.get("harness_case_id") == begin.get("harness_case_id") == case_id
                and end_ns >= start_ns >= 0)
        if not good:
            counts["invalid_boundary"] += 1
            continue
        spans[case_id][row["stage"]].append({
            "durationMs": (end_ns - start_ns) / 1_000_000,
            "handler": row.get("handler"), "spanId": row.get("span_id"),
            "operationId": row.get("operation_id"), "attemptId": row.get("attempt_id"),
            "requestId": row.get("request_id"), "sessionId": row.get("session_id"),
            "correlationId": row.get("correlation_id"), "receiverPid": backend_pid,
            "recorderProcessId": row.get("recorder_process_id"),
            "clockDomain": row.get("clock_domain"),
        })
    counts["unmatched_start"] = len(starts)
    history = {case_id: spans.get(case_id, {stage: [] for stage in STAGES}) for case_id in sorted(measured_ids)}
    metrics = []
    handlers = sorted({(stage, item.get("handler")) for case in history.values()
                       for stage, rows in case.items() for item in rows if isinstance(item.get("handler"), str)})
    for stage, handler in handlers:
        durations = []
        missing = multiple = invalid = 0
        for case in history.values():
            matches = [item for item in case.get(stage, []) if item.get("handler") == handler]
            if not matches:
                missing += 1
            elif len(matches) != 1:
                multiple += 1
            elif math.isfinite(matches[0]["durationMs"]) and matches[0]["durationMs"] >= 0:
                durations.append(matches[0]["durationMs"])
            else:
                invalid += 1
        metrics.append({"stage": stage, "handler": handler, "attemptedMeasuredCases": len(measured_ids),
                        "validOneSpanCases": len(durations), "missingCases": missing,
                        "multipleSpanCases": multiple, "invalidBoundaryCases": invalid,
                        "p90_ms": type7(durations, .9), "p95_ms": type7(durations, .95),
                        "scope": "single completed native span, exact handler, same backend process/clock and case/span/correlation; no sums"})
    return history, {"metrics": metrics, "pairingCounts": dict(counts),
                     "unknowns": {"queue": None, "TTFT": None, "streamedFirstAudio": None,
                                  "physicalMicrophone": None, "physicalAcousticCapture": None,
                                  "physicalSpeakerOutput": None}}


def audit_archive(archive: Path, manifest: dict) -> dict:
    with zipfile.ZipFile(archive) as saved:
        names = saved.namelist()
        if len(names) != len(set(names)):
            raise AuditError("duplicate_archive_members")
        listed = {row["path"]: row for row in manifest["files"]}
        expected_names = set(listed) | {"ARCHIVE-MANIFEST.json"}
        if set(names) != expected_names:
            raise AuditError("archive_member_inventory_mismatch")
        for name, row in listed.items():
            data = saved.read(name)
            if len(data) != row["exportBytes"] or digest(data) != row["exportSHA256"]:
                raise AuditError("archive_member_hash_mismatch")
        if digest(saved.read("ARCHIVE-MANIFEST.json")) != digest(json_bytes(manifest)):
            raise AuditError("archive_manifest_member_mismatch")
        cases = {}
        for name in sorted(n for n in names if re.fullmatch(r"browser900/attempts/browser-audio-v799-\d{4}/case\.json", n)):
            row = json.loads(saved.read(name))
            cid, ordinal = row.get("harness_case_id"), row.get("ordinal")
            if (row.get("schema") != "aurora.browser900.case.v799" or not isinstance(cid, str)
                    or cid in cases or not isinstance(ordinal, int) or cid != f"browser-audio-v799-{ordinal:04d}"
                    or row.get("frozen_manifest_sha256") != FROZEN_SHA
                    or row.get("phase") != ("warmup" if ordinal <= WARMUPS else "measured")
                    or row.get("outcome") not in {"passed", "incorrect", "failed"}):
                raise AuditError("case_record_identity_or_status_invalid")
            cases[cid] = row
        events_raw = saved.read("browser900/attempts.jsonl")
        if events_raw and not events_raw.endswith(b"\n"):
            raise AuditError("attempt_event_log_truncated")
        starts: dict[str, dict] = {}
        terminals: set[str] = set()
        for line in events_raw.splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            cid = event.get("harness_case_id")
            if event.get("type") == "case_started":
                if cid in starts:
                    raise AuditError("duplicate_case_start")
                starts[cid] = event
            elif event.get("type") == "case_terminal":
                if cid in terminals:
                    raise AuditError("duplicate_case_terminal")
                terminals.add(cid)
        if set(cases) - set(starts) or set(terminals) - set(starts):
            raise AuditError("case_log_and_case_files_disagree")
        if any(row.get("phase") != starts[cid].get("phase") or row.get("ordinal") != starts[cid].get("ordinal") for cid, row in cases.items()):
            raise AuditError("case_file_start_event_mismatch")
        all_started = set(starts)
        if len(all_started) != len(starts):
            raise AuditError("duplicate_started_case_id")
        for cid, event in starts.items():
            ordinal = event.get("ordinal")
            if (not isinstance(ordinal, int) or cid != f"browser-audio-v799-{ordinal:04d}"
                    or event.get("phase") != ("warmup" if ordinal <= WARMUPS else "measured")
                    or not 1 <= ordinal <= WARMUPS + MEASURED):
                raise AuditError("started_case_ordinal_invalid")
        if len({row.get("ordinal") for row in starts.values()}) != len(starts):
            raise AuditError("duplicate_case_ordinal")
        missing_terminal = all_started - terminals
        interrupted = all_started - set(cases)
        if not interrupted.issubset(missing_terminal):
            raise AuditError("missing_case_file_not_marked_interrupted")

        def phase_counts(phase: str, planned: int) -> dict:
            ids = {cid for cid, event in starts.items() if event.get("phase") == phase}
            rows = [cases[cid] for cid in ids if cid in cases]
            complete_correct = sum(row["outcome"] == "passed" for row in rows)
            incorrect = sum(row["outcome"] == "incorrect" for row in rows)
            timeout_codes = {"case_deadline_exceeded", "assistant_terminal_timeout", "warmup_gate_timeout", "capture_write_timeout"}
            timeouts = sum(row.get("failureName") == "TimeoutError" or row.get("failureCode") in timeout_codes for row in rows)
            failed = sum(row["outcome"] == "failed" and not (row.get("failureName") == "TimeoutError" or row.get("failureCode") in timeout_codes) for row in rows)
            interrupted_count = sum(cid in interrupted for cid in ids)
            return {"planned": planned, "attempted": len(ids), "completed_correct": complete_correct,
                    "completed_incorrect": incorrect, "failed_non_timeout": failed, "timeouts": timeouts,
                    "interrupted": interrupted_count, "unattempted": planned - len(ids)}

        warm = phase_counts("warmup", WARMUPS)
        measured = phase_counts("measured", MEASURED)
        terminal_campaign = json.loads(saved.read("browser900/campaign-terminal.json"))
        counts = terminal_campaign.get("counts", {})
        comparisons = {
            "attemptedWarmups": warm["attempted"], "passedWarmups": warm["completed_correct"],
            "unattemptedWarmups": warm["unattempted"], "attemptedMeasured": measured["attempted"],
            "passedMeasured": measured["completed_correct"], "incorrectMeasured": measured["completed_incorrect"],
            "failedMeasured": measured["failed_non_timeout"] + measured["timeouts"],
            "unattemptedMeasured": measured["unattempted"],
        }
        if any(counts.get(key) != value for key, value in comparisons.items()):
            raise AuditError("campaign_terminal_counts_do_not_match_raw_attempts")
        passed_measured = [row for row in cases.values() if row.get("phase") == "measured" and row.get("outcome") == "passed"]
        durations = [row.get("clocks", {}).get("processElapsedMs") for row in passed_measured]
        if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0 for value in durations):
            raise AuditError("successful_full_flow_duration_invalid")
        measured_ids = {cid for cid, event in starts.items() if event.get("phase") == "measured"}
        stages_raw = saved.read("runtime/voice-stages.jsonl") if "runtime/voice-stages.jsonl" in listed else b""
        launch = json.loads(saved.read("runtime/launch.json"))
        backend_pid = launch.get("backendPid")
        if type(backend_pid) is not int:
            raise AuditError("backend_pid_missing_from_launch_receipt")
        history, native = pair_native_stages(stages_raw, measured_ids, backend_pid)
        return {
            "savedZipIntegrityHashesAndOutcomeAuditPassed": True,
            "frozenManifestSha256": FROZEN_SHA,
            "cohortId": COHORT,
            "phaseDenominators": {"warmup_excluded": warm, "measured": measured},
            "rawOutcomeCounts": dict(collections.Counter(
                "interrupted" if cid in interrupted else cases[cid]["outcome"] for cid in all_started)),
            "driverCampaignOutcome": terminal_campaign.get("outcome"),
            "driverFatalStop": terminal_campaign.get("fatalStop"),
            "driverCountComparison": comparisons,
            "interruptedCaseIds": sorted(interrupted),
            "terminalEventMissingCaseIds": sorted(missing_terminal),
            "successfulFullFlowElapsedType7Ms": {
                "population": "measured outcome=passed only; per-case Node performance clock from runAttempt start through completed STT, visible correct reply, valid TTS WAV and connected playback end",
                "denominator": len(durations), "p90": type7(durations, .9), "p95": type7(durations, .95),
            },
            "nativeStageMetrics": native,
            "nativeStageCaseHistory": history,
            "unknownMetrics": {"queue": None, "TTFT": None, "streamedFirstAudio": None,
                               "physicalMicrophone": None, "physicalAcousticCapture": None,
                               "physicalSpeakerOutput": None},
            "scope": "normal browser file microphone -> actual STT -> visible LLM reply -> normal TTS WAV -> software-connected playback; no physical acoustic claim",
        }


def finalize() -> None:
    if os.uname().nodename != "personal.skyron-server":
        raise AuditError("wrong_finalization_host")
    evidence, pids = retire_after_natural_terminal()
    for path in LOCK_PATHS:
        if path.is_symlink() or not regular(path):
            raise AuditError("existing_owner_lock_missing_or_symlinked")
    locks = []
    try:
        for path in LOCK_PATHS:
            handle = path.open("r+")
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.close()
                raise AuditError("owner_lock_busy") from None
            locks.append(handle)
        if any(Path(f"/proc/{pid}").exists() for pid in pids):
            raise AuditError("owned_process_reappeared_before_retirement")
        if not regular(ROOT / "candidate-input.wav") or (ROOT / "candidate-input.wav").stat().st_size != WAV_BYTES or file_sha(ROOT / "candidate-input.wav") != WAV_SHA:
            raise AuditError("padded_audio_input_binding_mismatch")
        files, omissions = selected_files()
        raw_bytes = sum(path.stat().st_size for path, _ in files)
        if shutil.disk_usage(ROOT).free < raw_bytes + 20_000_000:
            raise AuditError("temporary_volume_archive_reserve_not_met")
        EXPORT.mkdir(mode=0o700, exist_ok=False)
        retirement = {
            "schema": "aurora.browser900.retirement.v888", "at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "host": "personal.skyron-server", "controllerPid": CONTROLLER_PID,
            "controllerStartTicks": CONTROLLER_START_TICKS, "ownedPidsAbsent": pids,
            "ownedProcessStartIdentities": evidence["terminal"].get("ownedProcessIdentities"),
            "locksObservedFreeThenHeldForFinalization": True, "noProcessesSignalledOrTerminated": True,
            "frozenManifestSha256": FROZEN_SHA, "terminal": binding(evidence["terminalPath"]),
            "driverTerminal": binding(evidence["driverTerminalPath"]),
        }
        retirement_path = ROOT / "runtime/retirement-v888.json"
        write_once(retirement_path, json_bytes(retirement))
        files.append((retirement_path, "runtime/retirement-v888.json"))
        manifest_files = []
        archive = EXPORT / ARCHIVE_NAME
        with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as saved:
            for source, name in sorted(files, key=lambda item: item[1]):
                raw = source.read_bytes()
                saved.writestr(name, raw)
                manifest_files.append({"path": name, "sourceBytes": len(raw), "sourceSHA256": digest(raw),
                                       "exportBytes": len(raw), "exportSHA256": digest(raw), "credentialRedacted": False})
            manifest = {
                "schema": "aurora.browser900.raw-custody.v888", "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "host": "personal.skyron-server", "cohortId": COHORT, "frozenManifestSha256": FROZEN_SHA,
                "controller": {"pid": CONTROLLER_PID, "startTicks": CONTROLLER_START_TICKS},
                "warmupsExcluded": WARMUPS, "measuredPlanned": MEASURED, "rawOriginalsPreserved": True,
                "modelsCopied": False, "files": manifest_files, "omissions": omissions,
                "publication": {"status": "not_copied", "futureWorkerCustodyRequiresActualArchiveBytesPlus80000000BytesReserve": True},
                "scope": "one post-terminal archive/audit; partial, incorrect, failed and interrupted records remain included; no workload rerun",
            }
            saved.writestr("ARCHIVE-MANIFEST.json", json_bytes(manifest))
        write_once(EXPORT / "ARCHIVE-MANIFEST.json", json_bytes(manifest))
        try:
            audit = audit_archive(archive, manifest)
            write_once(EXPORT / "NATIVE-STAGE-CASE-HISTORY.json", json_bytes(audit.pop("nativeStageCaseHistory")))
            status = {"savedZipIntegrityHashesAndOutcomeAuditPassed": True, "audit": audit}
        except Exception as exc:
            status = {"savedZipIntegrityHashesAndOutcomeAuditPassed": False,
                      "auditErrorClass": type(exc).__name__,
                      "auditErrorCode": str(exc)[:160] if isinstance(exc, AuditError) else "audit_failed"}
        receipt = {
            "schema": "aurora.browser900.finalization.v888", "host": "personal.skyron-server",
            "archive": binding(archive), "archiveMemberCount": len(manifest_files) + 1,
            "manifest": binding(EXPORT / "ARCHIVE-MANIFEST.json"), "retirement": binding(retirement_path),
            "sourceTerminal": binding(evidence["terminalPath"]), "driverTerminal": binding(evidence["driverTerminalPath"]),
            "rawOriginalsPreserved": True, "publication": {"status": "not_copied", "laterWorkerCustodyRequiresActualArchiveBytesPlus80000000BytesReserve": True},
            **status,
        }
        write_once(EXPORT / "audit-verification.json", json_bytes(receipt))
    finally:
        for handle in reversed(locks):
            fcntl.flock(handle, fcntl.LOCK_UN)
            handle.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-finalization", action="store_true")
    args = parser.parse_args()
    if not args.execute_finalization:
        parser.error("Refusing: Root must explicitly pass --execute-finalization after natural terminal and owner absence.")
    finalize()


if __name__ == "__main__":
    main()
