"""Root-only, one-shot finalization for the already-frozen worker CPU V737 run.

This module is inert on import. Call ``main()`` only after the controller has
written a natural terminal record and both exact owners have retired. It never
starts or terminates a workload. Root owns terminal admission and custody; no model or workload is started.
"""

from __future__ import annotations

import argparse
import ast
import base64
import collections
import datetime
import fcntl
import hashlib
import io
import json
import math
import os
import re
import shutil
import wave
import zipfile
from pathlib import Path

ROOT = Path(
    "/home/developer/projects/aurora/.git/aurora-handoff-import-20261006/worker-padded900-prep-v737"
)
PROJECT = Path("/home/developer/projects/aurora")
EXPORT = ROOT / "export-v762"
DEST = (
    PROJECT
    / "docs/experiments/tcc-20261013-submission-20261030/root/worker-cpu-padded-local900-v737"
)
CONTROLLER_PID = 3038114
BACKEND_PID = 3038148
CONDITION_MANIFEST_SHA = "acbdc1d3827502513237220fcc3bf60cc3a007b7dc246b1a4b21b1a0ef8ce5fc"
HISTORICAL_MANIFEST_SHA = "364832a627e2f45b4b1c2b80ca05739f809132a28ff26511f0eda5e30f89127a"
PILOT_INPUT_SHA = "ce75b965ee5879ebece6ea7dfe133441547d20ccf89ecd5d66ea510bd9645e60"
WAV_SHA = "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
WAV_BYTES = 219794
COHORT = "aurora-full-audio-capital-v1-worker-cpu-padded-20261015"
REQUESTED_WARMUPS = 15
PLANNED_MEASURED = 900
MAX_ARCHIVE_BYTES = 40_000_000
PROJECT_RESERVE_BYTES = 80_000_000
TEMP_RESERVE_BYTES = 80_000_000
STAGES = ("stt", "llm", "tts")
SENSITIVE_KEY = re.compile(
    r"(api.?key|token|secret|password|credential|authorization|refresh)", re.I
)


class AuditError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def binding(path: Path) -> dict:
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": digest(raw)}


def write_once(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def type7(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lo, hi = math.floor(position), math.ceil(position)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo)


def normal_words(text: str) -> list[str]:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip().split()


def attempt_denominator(rows: list[dict], planned: int) -> dict:
    status_counts = collections.Counter(row.get("status", "missing_status") for row in rows)
    return {
        "planned": planned,
        "attempted": len(rows),
        "completed_correct": status_counts["completed_correct"],
        "completed_incorrect": status_counts["completed_incorrect"],
        "failed_or_interrupted": sum(
            n
            for status, n in status_counts.items()
            if status not in ("completed_correct", "completed_incorrect")
        ),
        "timeouts": sum(row.get("timeout") is True for row in rows),
        "unattempted": max(0, planned - len(rows)),
    }


def parse_jsonl_attempt(raw: bytes) -> dict:
    lines = [line for line in raw.splitlines() if line.strip()]
    if len(lines) != 1:
        raise AuditError("attempt_file_not_one_json_record")
    row = json.loads(lines[0])
    if not isinstance(row, dict):
        raise AuditError("attempt_record_not_object")
    return row


def sensitive_literals_from_ast(controller_bytes: bytes) -> set[bytes]:
    """Collect only literal values passed to sensitive controller keyword names."""
    tree = ast.parse(controller_bytes.decode("utf-8"))
    found: set[bytes] = set()

    def literals(node: ast.AST) -> None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) >= 4:
            found.add(node.value.encode("utf-8"))
        elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            for item in node.elts:
                literals(item)
        elif isinstance(node, ast.Dict):
            for item in node.values:
                literals(item)

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for keyword in node.keywords:
                if keyword.arg and SENSITIVE_KEY.search(keyword.arg):
                    literals(keyword.value)
    return found


def sensitive_values(root: Path) -> set[bytes]:
    values = sensitive_literals_from_ast((root / "controller.py").read_bytes())
    config = json.loads((root / "runtime/config.json").read_text(encoding="utf-8"))

    def visit(value: object, key: str = "") -> None:
        if isinstance(value, dict):
            for name, item in value.items():
                visit(item, str(name))
        elif isinstance(value, list):
            for item in value:
                visit(item, key)
        elif isinstance(value, str) and value and SENSITIVE_KEY.search(key) and len(value) >= 4:
            values.add(value.encode("utf-8"))

    visit(config)
    env_path = root / "runtime/absent.env"
    if env_path.is_file() and not env_path.is_symlink():
        for line in env_path.read_text(encoding="utf-8", errors="strict").splitlines():
            key, sep, value = line.partition("=")
            if sep and SENSITIVE_KEY.search(key) and len(value) >= 4:
                values.add(value.strip().strip("'\"").encode("utf-8"))
    if not values:
        raise RuntimeError("private_credential_redaction_values_unavailable")
    return values


def redact(raw: bytes, secrets: set[bytes], binary: bool = False) -> tuple[bytes, bool]:
    if binary:
        if any(secret in raw for secret in secrets):
            raise RuntimeError("private_credential_detected_in_binary_input")
        return raw, False
    data = raw
    for secret in sorted(secrets, key=len, reverse=True):
        data = data.replace(secret, b"[REDACTED_CREDENTIAL]")
    if any(secret in data for secret in secrets):
        raise RuntimeError("credential_redaction_incomplete")
    return data, data != raw


def regular_files(path: Path) -> list[Path]:
    if not path.exists():
        return []
    if path.is_symlink():
        raise RuntimeError("symlink_in_owned_campaign_tree")
    if path.is_file():
        return [path]
    found: list[Path] = []
    for child in sorted(path.iterdir()):
        if child.is_symlink():
            raise RuntimeError("symlink_in_owned_campaign_tree")
        if child.is_dir():
            if child.name == "__pycache__":
                continue
            found.extend(regular_files(child))
        elif child.is_file() and child.suffix != ".pyc":
            found.append(child)
    return found


def selected_files() -> tuple[list[tuple[Path, str]], list[dict]]:
    pairs: list[tuple[Path, str]] = []
    for name in (
        "measurement-admission.json",
        "source-inventory.json",
        "SOURCE-EQUIVALENCE-v734.json",
        "environment-resource-admission-v734.json",
        "fresh-resource-admission-v737.json",
        "candidate-manifest.json",
        "pilot-input.json",
        "candidate-input.wav",
        "bindings.py",
        "bootstrap.py",
        "stage_source.py",
        "launch-v737.py",
        "runner.py",
        "hook/observer.py",
        "hook/aurora_voice_telemetry_v430.py",
        "spawn.json",
        "runtime/launch.json",
        "runtime/terminal.json",
        "runtime/runtime-versions.json",
        "runtime/voice-stages.installed.json",
        "runtime/actual-provider-bindings.jsonl",
        "runtime/voice-stages.jsonl",
        "runtime/resources.jsonl",
        "runtime/campaign/summary.json",
        "runtime/campaign/progress.json",
    ):
        path = ROOT / name
        if path.exists():
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("required_export_input_not_regular_file")
            pairs.append((path, path.relative_to(ROOT).as_posix()))
    for path in regular_files(ROOT / "runtime/campaign/attempts"):
        pairs.append((path, path.relative_to(ROOT).as_posix()))
    for path in regular_files(ROOT / "runtime/campaign/audio"):
        pairs.append((path, path.relative_to(ROOT).as_posix()))

    history_manifest = ROOT.parent / "cpu-full-audio-v490/frozen-manifest-v1.json"
    if not history_manifest.is_file() or history_manifest.is_symlink():
        raise RuntimeError("historical_cpu_manifest_unavailable")
    if digest(history_manifest.read_bytes()) != HISTORICAL_MANIFEST_SHA:
        raise RuntimeError("historical_cpu_manifest_pin_mismatch")
    pairs.append((history_manifest, "provenance/cpu-v490-frozen-manifest-v1.json"))

    omitted: list[dict] = []
    for name, reason in (
        ("controller.py", "contains fixture credential literals; source withheld"),
        ("controller.private.log", "private controller log withheld"),
        ("runtime/backend.private.log", "raw backend log withheld"),
        ("runtime/config.json", "private runtime configuration withheld"),
        ("runtime/config.json.mesh-policy-rbac.json", "private policy/config sidecar withheld"),
        (
            "runtime/absent.env",
            "private environment file withheld; sensitive values used in-memory for redaction",
        ),
        ("runtime/data", "private runtime database and transient files withheld"),
        ("runtime/backups", "private database backups withheld"),
    ):
        path = ROOT / name
        if path.exists():
            if path.is_symlink():
                raise RuntimeError("omitted_private_path_is_symlink")
            for item in regular_files(path):
                stat = item.stat()
                record = {
                    "path": str(item.relative_to(ROOT)),
                    "bytes": stat.st_size,
                    "reason": reason,
                }
                if name not in ("runtime/data", "runtime/backups", "runtime/backend.private.log"):
                    record["sha256"] = digest(item.read_bytes())
                omitted.append(record)
    return pairs, omitted


def collect_attempt_rows(saved: zipfile.ZipFile) -> tuple[list[dict], list[dict]]:
    names = sorted(
        name
        for name in saved.namelist()
        if name.startswith("runtime/campaign/attempts/attempt-") and name.endswith(".jsonl")
    )
    if len(names) != len(set(names)):
        raise AuditError("duplicate_attempt_member_names")
    rows: list[dict] = []
    source_rows: list[dict] = []
    for name in names:
        raw = saved.read(name)
        row = parse_jsonl_attempt(raw)
        ordinal, phase = row.get("ordinal"), row.get("phase")
        if not isinstance(ordinal, int) or phase not in ("warmup", "measured"):
            raise AuditError("attempt_phase_or_ordinal_invalid")
        expected_phase = "warmup" if ordinal <= REQUESTED_WARMUPS else "measured"
        if (
            phase != expected_phase
            or row.get("harness_case_id") != f"audio-campaign-v737-{ordinal:04d}"
        ):
            raise AuditError("attempt_case_identity_mismatch")
        if row.get("input_wav_sha256") != WAV_SHA:
            raise AuditError("attempt_input_wav_hash_mismatch")
        if (phase == "warmup" and not 1 <= ordinal <= REQUESTED_WARMUPS) or (
            phase == "measured"
            and not REQUESTED_WARMUPS < ordinal <= REQUESTED_WARMUPS + PLANNED_MEASURED
        ):
            raise AuditError("attempt_ordinal_out_of_range")
        if row.get("status") not in (
            "completed_correct",
            "completed_incorrect",
            "failed",
            "interrupted",
            "system_failure",
        ):
            raise AuditError("unknown_attempt_status")
        if row.get("flow_duration_ms") is not None and (
            not isinstance(row["flow_duration_ms"], (int, float))
            or isinstance(row["flow_duration_ms"], bool)
            or not math.isfinite(row["flow_duration_ms"])
            or row["flow_duration_ms"] < 0
        ):
            raise AuditError("invalid_attempt_duration")
        row["_member"] = name
        row["_member_sha256"] = digest(raw)
        rows.append(row)
        source_rows.append(
            {
                "member": name,
                "bytes": len(raw),
                "sha256": digest(raw),
                "phase": phase,
                "ordinal": ordinal,
                "harness_case_id": row["harness_case_id"],
            }
        )
    if len({row["harness_case_id"] for row in rows}) != len(rows):
        raise AuditError("duplicate_attempt_case_id")
    for phase, first, cap in (
        ("warmup", 1, REQUESTED_WARMUPS),
        ("measured", REQUESTED_WARMUPS + 1, PLANNED_MEASURED),
    ):
        ordinals = sorted(row["ordinal"] for row in rows if row["phase"] == phase)
        if ordinals != list(range(first, first + len(ordinals))) or len(ordinals) > cap:
            raise AuditError("attempt_ordinals_not_contiguous")
    return rows, source_rows


def audit_denominators(rows: list[dict], summary: dict) -> dict:
    phases = summary.get("phase_denominators")
    if not isinstance(phases, dict):
        raise AuditError("campaign_phase_denominators_missing")
    result: dict[str, dict] = {}
    for phase, planned in (("warmup", REQUESTED_WARMUPS), ("measured", PLANNED_MEASURED)):
        phase_rows = [row for row in rows if row["phase"] == phase]
        calculated = attempt_denominator(phase_rows, planned)
        saved_phase = phases.get("warmup_excluded" if phase == "warmup" else "measured")
        if not isinstance(saved_phase, dict):
            raise AuditError("campaign_phase_denominator_missing")
        for key in (
            "planned",
            "attempted",
            "completed_correct",
            "completed_incorrect",
            "failed_or_interrupted",
            "timeouts",
            "unattempted",
        ):
            value = calculated[key]
            if saved_phase.get(key) != value:
                raise AuditError("campaign_raw_denominator_mismatch")
        result[phase] = calculated
    all_rows = rows
    all_calculated = attempt_denominator(all_rows, REQUESTED_WARMUPS + PLANNED_MEASURED)
    saved_all = phases.get("all")
    if isinstance(saved_all, dict):
        for key in (
            "planned",
            "attempted",
            "completed_correct",
            "completed_incorrect",
            "failed_or_interrupted",
            "timeouts",
            "unattempted",
        ):
            value = all_calculated[key]
            if saved_all.get(key) != value:
                raise AuditError("campaign_all_denominator_mismatch")
    return result


def audit_correctness(rows: list[dict], manifest: dict) -> None:
    reference = manifest.get("referenceTranscript")
    expected_reply = manifest.get("expectedReplyWords")
    if not isinstance(reference, str) or not isinstance(expected_reply, list):
        raise AuditError("pilot_input_correctness_contract_missing")
    expected_transcript_words = normal_words(reference)
    expected_reply_words = [word.casefold() for word in expected_reply]
    for row in rows:
        if row["status"] not in ("completed_correct", "completed_incorrect"):
            continue
        stages = row.get("stages", {})
        stt = stages.get("stt", {})
        assistant = stages.get("assistant", {})
        actual = (
            normal_words(stt.get("transcript", "")) == expected_transcript_words
            and normal_words(assistant.get("response", "")) == expected_reply_words
            and all(
                assistant.get(key) is True
                for key in ("session_id_matches", "request_id_matches", "correlation_id_matches")
            )
        )
        if actual != (row["status"] == "completed_correct"):
            raise AuditError("stored_correctness_outcome_inconsistent")


def native_stage_history(raw: bytes, rows: list[dict], receiver_pid: int) -> tuple[dict, dict]:
    starts: dict[tuple, dict] = {}
    paired: dict[str, dict[str, list[dict]]] = collections.defaultdict(
        lambda: {stage: [] for stage in STAGES}
    )
    pairing_counts = collections.Counter()
    correlations = {}
    for row in rows:
        corr = row.get("correlation")
        if isinstance(corr, dict) and isinstance(corr.get("correlation_id"), str):
            correlations[row["harness_case_id"]] = corr["correlation_id"]
    if len(set(correlations.values())) != len(correlations):
        raise AuditError("attempt_correlation_ids_not_unique")
    case_by_correlation = {correlation: case_id for case_id, correlation in correlations.items()}
    for line in raw.splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        if item.get("record_kind") != "invocation_span_boundary":
            continue
        key = tuple(
            item.get(name)
            for name in (
                "receiver_pid",
                "recorder_process_id",
                "clock_domain",
                "stage",
                "span_id",
                "correlation_id",
            )
        )
        if item.get("event") == "span_start":
            if key in starts:
                pairing_counts["duplicateStarts"] += 1
            else:
                starts[key] = item
            continue
        if item.get("event") != "span_end":
            continue
        begin = starts.pop(key, None)
        if begin is None:
            pairing_counts["endWithoutStart"] += 1
            continue
        if item.get("outcome") != "completed":
            pairing_counts["noncompletedEnds"] += 1
            continue
        case_id = case_by_correlation.get(item.get("correlation_id"))
        stage = item.get("stage")
        end_value, start_value = item.get("monotonic_ns"), begin.get("monotonic_ns")
        try:
            if (
                not isinstance(end_value, (str, int))
                or isinstance(end_value, bool)
                or not isinstance(start_value, (str, int))
                or isinstance(start_value, bool)
            ):
                raise ValueError("non_integer_monotonic_boundary")
            end_ns, start_ns = int(end_value), int(start_value)
        except (TypeError, ValueError):
            pairing_counts["invalidBoundaries"] += 1
            continue
        good = (
            case_id in correlations
            and stage in STAGES
            and item.get("receiver_pid") == receiver_pid
            and begin.get("receiver_pid") == receiver_pid
            and item.get("clock_domain") == begin.get("clock_domain") == "python_process_monotonic"
            and item.get("correlation_id")
            == begin.get("correlation_id")
            == correlations.get(case_id)
            and item.get("span_id")
            and item.get("span_id") == begin.get("span_id")
            and (item.get("harness_case_id") is None or item["harness_case_id"] == case_id)
            and (begin.get("harness_case_id") is None or begin["harness_case_id"] == case_id)
            and end_ns >= start_ns >= 0
        )
        if not good:
            pairing_counts["invalidBoundaries"] += 1
            continue
        paired[case_id][stage].append(
            {
                "durationMs": (end_ns - start_ns) / 1_000_000,
                "spanId": item.get("span_id"),
                "nativeOperationId": item.get("operation_id"),
                "nativeAttemptId": item.get("attempt_id"),
                "requestId": item.get("request_id"),
                "sessionId": item.get("session_id"),
                "correlationId": item.get("correlation_id"),
                "handler": item.get("handler"),
                "clockDomain": item.get("clock_domain"),
                "receiverPid": item.get("receiver_pid"),
                "nativeHarnessCaseId": item.get("harness_case_id"),
                "caseBindingSource": "unique_actual_correlation_id_to_attempt",
            }
        )
    pairing_counts["unmatchedStarts"] = len(starts)
    history = {
        row["harness_case_id"]: paired.get(row["harness_case_id"], {stage: [] for stage in STAGES})
        for row in rows
        if row["phase"] == "measured"
    }
    handler_keys = sorted(
        {
            (stage, span.get("handler"))
            for stages in history.values()
            for stage, spans in stages.items()
            for span in spans
            if isinstance(span.get("handler"), str) and span["handler"]
        }
    )
    metrics = []
    for stage, handler in handler_keys:
        durations: list[float] = []
        missing = multiple = invalid = missing_op = missing_attempt = missing_native_case = 0
        for stages in history.values():
            matches = [span for span in stages.get(stage, []) if span.get("handler") == handler]
            if not matches:
                missing += 1
            elif len(matches) != 1:
                multiple += 1
            elif (
                not isinstance(matches[0].get("durationMs"), (int, float))
                or not math.isfinite(matches[0]["durationMs"])
                or matches[0]["durationMs"] < 0
                or matches[0].get("receiverPid") != receiver_pid
                or matches[0].get("clockDomain") != "python_process_monotonic"
                or not matches[0].get("correlationId")
                or not matches[0].get("spanId")
            ):
                invalid += 1
            else:
                span = matches[0]
                durations.append(float(span["durationMs"]))
                missing_op += not bool(span.get("nativeOperationId"))
                missing_attempt += not bool(span.get("nativeAttemptId"))
                missing_native_case += span.get("nativeHarnessCaseId") is None
        metrics.append(
            {
                "stage": stage,
                "handler": handler,
                "attemptedMeasuredCases": sum(r["phase"] == "measured" for r in rows),
                "validOneSpanCases": len(durations),
                "missingCases": missing,
                "multipleSpanCases": multiple,
                "invalidBoundaryCases": invalid,
                "missingNativeOperationId": missing_op,
                "missingNativeAttemptId": missing_attempt,
                "missingNativeHarnessCaseId": missing_native_case,
                "p90_ms": type7(durations, 0.9),
                "p95_ms": type7(durations, 0.95),
                "scope": "completed paired span, same receiver process clock, case/correlation/span identity; exact handler only",
            }
        )
    return history, {"pairingCounts": dict(pairing_counts), "byExactStageAndHandler": metrics}


def audit_archive(archive: Path, manifest: dict, secrets: set[bytes]) -> tuple[dict, dict]:
    try:
        with zipfile.ZipFile(archive) as saved:
            if saved.testzip() is not None:
                raise AuditError("zip_crc_failure")
            for entry in manifest["files"]:
                if digest(saved.read(entry["path"])) != entry["exportSHA256"]:
                    raise AuditError("export_member_hash_mismatch")
            rows, sources = collect_attempt_rows(saved)
            summary = json.loads(saved.read("runtime/campaign/summary.json"))
            denominators = audit_denominators(rows, summary)
            candidate = json.loads(saved.read("pilot-input.json"))
            audit_correctness(rows, candidate)
            audio_count = 0
            for row in rows:
                audio = row.get("output_audio")
                if not audio:
                    continue
                member = "runtime/campaign/" + audio["file"]
                data = saved.read(member)
                if digest(data) != audio.get("sha256"):
                    raise AuditError("saved_audio_hash_mismatch")
                with wave.open(io.BytesIO(data), "rb") as wav:
                    pcm = wav.readframes(wav.getnframes())
                    valid = (
                        wav.getcomptype() == "NONE"
                        and wav.getsampwidth() == 2
                        and wav.getnchannels() == 1
                        and wav.getframerate() == 22050
                        and wav.getnframes() > 0
                        and len(pcm) == wav.getnframes() * 2
                        and any(pcm)
                    )
                if not valid:
                    raise AuditError("saved_audio_profile_invalid")
                audio_count += 1
            stage_bytes = saved.read("runtime/voice-stages.jsonl")
            measured = [row for row in rows if row["phase"] == "measured"]
            history, stage_summary = native_stage_history(stage_bytes, rows, BACKEND_PID)
            completed = [
                row
                for row in measured
                if row["status"] in ("completed_correct", "completed_incorrect")
                and isinstance(row.get("flow_duration_ms"), (int, float))
            ]
            correct = [
                row
                for row in measured
                if row["status"] == "completed_correct"
                and isinstance(row.get("flow_duration_ms"), (int, float))
            ]
            observed = [
                row for row in measured if isinstance(row.get("flow_duration_ms"), (int, float))
            ]
            expected_quantiles = {
                "successful_correct_latency_ms_r7": correct,
                "completed_flow_latency_ms_r7_including_incorrect": completed,
                "observed_measured_attempt_latency_ms_r7_including_failures": observed,
            }
            for summary_key, latency_rows in expected_quantiles.items():
                saved_quantiles = summary.get(summary_key)
                if not isinstance(saved_quantiles, dict):
                    raise AuditError("campaign_quantiles_missing")
                for percentile in ("p90", "p95"):
                    actual = type7(
                        [float(row["flow_duration_ms"]) for row in latency_rows],
                        int(percentile[1:]) / 100,
                    )
                    reported = saved_quantiles.get(percentile)
                    if actual is None and reported is None:
                        continue
                    if (
                        not isinstance(actual, (int, float))
                        or not isinstance(reported, (int, float))
                        or abs(actual - reported) >= 0.00001
                    ):
                        raise AuditError("campaign_quantile_mismatch")
            if summary.get("successful_correct_count") != len(correct) or summary.get(
                "completed_flow_count_including_incorrect"
            ) != len(completed):
                raise AuditError("campaign_latency_denominator_mismatch")
            observed_summary = {
                "measured": denominators["measured"],
                "warmupExcluded": denominators["warmup"],
                "rawOutcomeCounts": dict(collections.Counter(row["status"] for row in measured)),
                "flowDurationType7Ms": {
                    "completedIncludingIncorrect": {
                        "denominator": len(completed),
                        "p90": type7([r["flow_duration_ms"] for r in completed], 0.9),
                        "p95": type7([r["flow_duration_ms"] for r in completed], 0.95),
                    },
                    "correctOnly": {
                        "denominator": len(correct),
                        "p90": type7([r["flow_duration_ms"] for r in correct], 0.9),
                        "p95": type7([r["flow_duration_ms"] for r in correct], 0.95),
                    },
                    "observedAttemptsIncludingFailures": {
                        "denominator": len(observed),
                        "p90": type7([r["flow_duration_ms"] for r in observed], 0.9),
                        "p95": type7([r["flow_duration_ms"] for r in observed], 0.95),
                    },
                },
                "checkedSavedAudioFiles": audio_count,
                "nativeStageMetrics": stage_summary,
                "unknownMetrics": {
                    "queueWait": None,
                    "TTFT": None,
                    "firstStreamedAudio": None,
                    "playback": None,
                },
                "nativeStageCaseHistory": history,
                "selectedAttemptMemberBindings": sources,
                "summaryStatus": summary.get("status"),
                "summaryStopReason": summary.get("stop_reason"),
                "warmupInstrumentationGate": summary.get("warmup_instrumentation_gate"),
                "measuredFull900Reached": len(measured) == PLANNED_MEASURED,
            }
            # If any measured requests started, the runner's real normal warmup
            # gate must be preserved as passed; CPU zero-offload identity is not GPU proof.
            gate = summary.get("warmup_instrumentation_gate")
            if measured and (not isinstance(gate, dict) or gate.get("status") != "passed"):
                raise AuditError("measured_rows_without_passed_cpu_warmup_gate")
            return observed_summary, {
                "savedZipIntegrityHashesAndOutcomeAuditPassed": True,
                "auditErrorCode": None,
            }
    except Exception as exc:
        code = exc.code if isinstance(exc, AuditError) else type(exc).__name__
        return {}, {
            "savedZipIntegrityHashesAndOutcomeAuditPassed": False,
            "auditErrorClass": type(exc).__name__,
            "auditErrorCode": code[:120],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute-finalization", action="store_true")
    args = parser.parse_args()
    if not args.execute_finalization:
        parser.error(
            "Finalization requires explicit --execute-finalization after owned terminal reconciliation."
        )
    os.umask(0o077)
    if os.uname().nodename != "code-worker":
        raise RuntimeError("wrong_finalization_host")
    if EXPORT.exists() or EXPORT.is_symlink():
        raise RuntimeError("existing_export_must_be_reconciled_not_replayed")
    retirement_path = ROOT / "runtime/retirement-v762.json"
    if retirement_path.exists() or retirement_path.is_symlink():
        raise RuntimeError("existing_retirement_receipt_must_be_reconciled")

    if Path(f"/proc/{CONTROLLER_PID}").exists() or Path(f"/proc/{BACKEND_PID}").exists():
        raise RuntimeError("frozen_owner_still_live_do_not_finalize")
    terminal_path = ROOT / "runtime/terminal.json"
    terminal = json.loads(terminal_path.read_text(encoding="utf-8"))
    if (
        terminal.get("finishedAt") is None
        or terminal.get("processPresentAfterWait") is not False
        or terminal.get("controllerPid") != CONTROLLER_PID
        or terminal.get("pid") != BACKEND_PID
    ):
        raise RuntimeError("durable_terminal_does_not_match_frozen_owner_pair")
    condition_path = ROOT / "measurement-admission.json"
    condition_bytes = condition_path.read_bytes()
    if digest(condition_bytes) != CONDITION_MANIFEST_SHA:
        raise RuntimeError("frozen_cpu_condition_manifest_drift")
    condition = json.loads(condition_bytes)
    if (
        condition.get("cohortId") != COHORT
        or condition.get("measurementPlan", {}).get("plannedMeasuredPerApplicableNewCondition")
        != PLANNED_MEASURED
    ):
        raise RuntimeError("frozen_cpu_condition_identity_mismatch")
    impl = condition.get("implementation", {})
    if digest((ROOT / "runner.py").read_bytes()) != impl.get("runnerSha256"):
        raise RuntimeError("frozen_runner_identity_mismatch")
    if digest((ROOT / "controller.py").read_bytes()) != impl.get("controllerSha256"):
        raise RuntimeError("frozen_controller_identity_mismatch")
    if digest((ROOT / "source-inventory.json").read_bytes()) != condition.get(
        "sourceClosure", {}
    ).get("cpuSourceInventorySha256"):
        raise RuntimeError("frozen_source_inventory_identity_mismatch")
    candidate = json.loads((ROOT / "candidate-manifest.json").read_text(encoding="utf-8"))
    if (
        candidate.get("wavSHA256") != WAV_SHA
        or (ROOT / "candidate-input.wav").stat().st_size != WAV_BYTES
        or digest((ROOT / "candidate-input.wav").read_bytes()) != WAV_SHA
    ):
        raise RuntimeError("padded_input_identity_mismatch")
    if digest((ROOT / "pilot-input.json").read_bytes()) != PILOT_INPUT_SHA:
        raise RuntimeError("fixed_pilot_input_identity_mismatch")
    summary_path = ROOT / "runtime/campaign/summary.json"
    if not summary_path.is_file() or summary_path.is_symlink():
        raise RuntimeError("durable_campaign_summary_unavailable")

    lock_path = Path("/tmp/aurora-global-build.lock")
    if not lock_path.is_file() or lock_path.is_symlink():
        raise RuntimeError("existing_global_build_lock_unavailable")
    with lock_path.open("r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("global_build_lock_busy") from exc
        try:
            if Path(f"/proc/{CONTROLLER_PID}").exists() or Path(f"/proc/{BACKEND_PID}").exists():
                raise RuntimeError("frozen_owner_reappeared_before_retirement")
            if shutil.disk_usage(ROOT).free < MAX_ARCHIVE_BYTES + TEMP_RESERVE_BYTES:
                raise RuntimeError("same_volume_archive_reserve_not_met")
            secrets = sensitive_values(ROOT)
            selected, omissions = selected_files()
            if len({archive_name for _, archive_name in selected}) != len(selected):
                raise RuntimeError("duplicate_export_member_path")
            EXPORT.mkdir(mode=0o700, exist_ok=False)
            retired = {
                "schema": "aurora.worker-cpu-v737-retirement.v762",
                "at": now(),
                "host": os.uname().nodename,
                "controllerPid": CONTROLLER_PID,
                "backendPid": BACKEND_PID,
                "bothExactOwnersAbsent": True,
                "globalBuildLockObservedFreeThenHeld": True,
                "noProcessesTerminatedByFinalizer": True,
                "terminal": binding(terminal_path),
                "conditionManifestSha256": CONDITION_MANIFEST_SHA,
            }
            write_once(
                retirement_path, (json.dumps(retired, indent=2, sort_keys=True) + "\n").encode()
            )
            selected.append((retirement_path, "runtime/retirement-v762.json"))

            archive_path = EXPORT / "aurora-worker-cpu-padded-local900-v737.zip"
            entries: list[dict] = []
            with zipfile.ZipFile(
                archive_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6
            ) as saved:
                for source, name in sorted(selected, key=lambda pair: pair[1]):
                    raw = source.read_bytes()
                    binary = source.suffix.lower() in (".wav", ".pcm")
                    data, changed = redact(raw, secrets, binary=binary)
                    saved.writestr(name, data)
                    entries.append(
                        {
                            "path": name,
                            "sourceBytes": len(raw),
                            "sourceSHA256": digest(raw),
                            "exportBytes": len(data),
                            "exportSHA256": digest(data),
                            "credentialRedacted": changed,
                        }
                    )
                omissions.append(
                    {
                        "path": "controller.py",
                        "bytes": (ROOT / "controller.py").stat().st_size,
                        "sha256": digest((ROOT / "controller.py").read_bytes()),
                        "reason": "fixture-bearing source; body not exported",
                    }
                )
                if (ROOT / "runtime/backend.private.log").exists() and not any(
                    item["path"] == "runtime/backend.private.log" for item in omissions
                ):
                    path = ROOT / "runtime/backend.private.log"
                    omissions.append(
                        {
                            "path": "runtime/backend.private.log",
                            "bytes": path.stat().st_size,
                            "reason": "private raw backend log; contents withheld",
                        }
                    )
                omissions = list({item["path"]: item for item in omissions}.values())
                manifest = {
                    "schema": "aurora.raw-worker-cpu-cohort-custody.v1",
                    "createdAt": now(),
                    "cohort": COHORT,
                    "host": "code-worker",
                    "frozenConditionManifestSha256": CONDITION_MANIFEST_SHA,
                    "plannedMeasured": PLANNED_MEASURED,
                    "excludedWarmups": REQUESTED_WARMUPS,
                    "rawOriginalsPreserved": True,
                    "modelWeightsCopied": False,
                    "sourceAndWeightIdentity": "Retained in measurement-admission.json and source-inventory.json; weight files are not duplicated.",
                    "files": entries,
                    "omissions": omissions,
                    "scope": "One finalizer pass for the existing CPU V737 run; no new measurements or V491 mutation.",
                }
                manifest_bytes = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
                saved.writestr("ARCHIVE-MANIFEST.json", manifest_bytes)
            write_once(EXPORT / "ARCHIVE-MANIFEST.json", manifest_bytes)
            audit_data, audit_status = audit_archive(archive_path, manifest, secrets)
            if audit_status["savedZipIntegrityHashesAndOutcomeAuditPassed"]:
                write_once(
                    EXPORT / "NATIVE-STAGE-CASE-HISTORY.json",
                    (
                        json.dumps(
                            audit_data.pop("nativeStageCaseHistory"), indent=2, sort_keys=True
                        )
                        + "\n"
                    ).encode(),
                )
            archive_binding = binding(archive_path)
            receipt = {
                "schema": "aurora.worker-cpu-v737-audit-receipt.v762",
                "at": now(),
                "host": "code-worker",
                "archive": archive_binding,
                "archiveMembers": len(entries) + 1,
                "conditionManifestSha256": CONDITION_MANIFEST_SHA,
                "retirement": binding(retirement_path),
                "rawOriginalsPreserved": True,
                **audit_status,
                "audit": audit_data,
                "publication": {"status": "not_published"},
            }
            write_once(
                EXPORT / "audit-verification.json",
                (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode(),
            )
            archive_bytes = archive_path.stat().st_size
            metadata_bytes = sum(
                path.stat().st_size
                for path in EXPORT.iterdir()
                if path.is_file() and path != archive_path
            )
            needed = archive_bytes + metadata_bytes + 1_000_000
            publication_names = (
                archive_path.name,
                "ARCHIVE-MANIFEST.json",
                "NATIVE-STAGE-CASE-HISTORY.json",
                "audit-verification.json",
                "verification.json",
            )
            destination_available = (not DEST.exists() or DEST.is_dir()) and not any(
                (DEST / name).exists() for name in publication_names
            )
            if (
                archive_bytes <= MAX_ARCHIVE_BYTES
                and shutil.disk_usage(DEST.parent).free >= needed + PROJECT_RESERVE_BYTES
                and destination_available
            ):
                DEST.mkdir(mode=0o700, parents=True, exist_ok=True)
                copied = DEST / archive_path.name
                with (
                    archive_path.open("rb") as source_stream,
                    copied.open("xb") as destination_stream,
                ):
                    shutil.copyfileobj(source_stream, destination_stream)
                    destination_stream.flush()
                    os.fsync(destination_stream.fileno())
                if binding(copied)["sha256"] != archive_binding["sha256"]:
                    raise RuntimeError("published_archive_copy_hash_mismatch")
                for name in (
                    "ARCHIVE-MANIFEST.json",
                    "NATIVE-STAGE-CASE-HISTORY.json",
                    "audit-verification.json",
                ):
                    source = EXPORT / name
                    if source.exists():
                        write_once(DEST / name, source.read_bytes())
                receipt["publication"] = {
                    "status": "published",
                    "destination": str(DEST),
                    "actualArchivePlusMetadataAndReserveAdmissionPassed": True,
                }
                write_once(
                    DEST / "verification.json",
                    (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode(),
                )
            else:
                receipt["publication"] = {
                    "status": "storage_admission_unmet_or_destination_exists",
                    "archiveBytes": archive_bytes,
                    "archiveCapBytes": MAX_ARCHIVE_BYTES,
                    "requiredProjectReserveBytes": PROJECT_RESERVE_BYTES,
                    "projectFreeBytes": shutil.disk_usage(DEST.parent).free,
                    "destinationExists": DEST.exists(),
                    "action": "preserve temporary export and reconcile custody; do not delete or repeat the audit",
                }
            write_once(
                EXPORT / "verification.json",
                (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode(),
            )
            marker = {
                "export": str(EXPORT),
                "archiveBytes": archive_bytes,
                "archiveSha256": archive_binding["sha256"],
                "auditPassed": audit_status["savedZipIntegrityHashesAndOutcomeAuditPassed"],
                "publication": receipt["publication"],
            }
            print("AURORA_V762_FINALIZE=" + json.dumps(marker, sort_keys=True), flush=True)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


if __name__ == "__main__":
    main()
