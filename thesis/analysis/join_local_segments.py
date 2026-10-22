#!/usr/bin/env python3
"""Join only the admitted V735+V745 segments of one padded LocalBus condition.

Reads the already-audited attempt JSON members from two ZIPs and the separately
saved paired native-span histories. It does not audit ZIP integrity, inspect WAV
contents, reclassify transcripts/replies, or run product workloads. This is saved-data analysis, not a measurement launcher.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import zipfile
from pathlib import Path

FIRST_MANIFEST_SHA = "be108882b3024b33545f1484da00a56dccc5993e5c441b3eb3854102e7f14ac5"
SECOND_MANIFEST_SHA = "31dea74bf4587e7bef60c44ef28c2b3f7a2da73a69891df27bc318b9819d505d"
FIRST_PREFIX = "padded-audio-v689-"
SECOND_PREFIX = "padded-audio-v745-"
FIRST_PID = 3295224
SECOND_PID = 3312941
TOTAL_MEASURED = 900
ATTEMPT_MEMBER = re.compile(r"^runtime/campaign/attempts/attempt-[^/]+\.jsonl$")
STAGES = ("stt", "llm", "tts")


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def file_binding(path: Path) -> dict:
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": sha256(raw)}


def finite_ms(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def type7(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def counts(rows: list[dict], planned: int) -> dict:
    statuses: dict[str, int] = {}
    for row in rows:
        status = row["status"]
        statuses[status] = statuses.get(status, 0) + 1
    return {
        "planned": planned,
        "attempted": len(rows),
        "completed_correct": statuses.get("completed_correct", 0),
        "completed_incorrect": statuses.get("completed_incorrect", 0),
        "failed_or_interrupted": sum(
            n for status, n in statuses.items() if not status.startswith("completed_")
        ),
        "timeouts": sum(row.get("timeout") is True for row in rows),
        "unattempted": planned - len(rows),
        "rawOutcomeCounts": dict(sorted(statuses.items())),
    }


def load_json(path: Path) -> tuple[dict, dict]:
    raw = path.read_bytes()
    return json.loads(raw), {"path": str(path), "bytes": len(raw), "sha256": sha256(raw)}


def verify_audit(
    path: Path,
    expected_manifest: str,
    expected_planned: int,
    expected_attempted: int,
    require_complete_segment: bool,
) -> tuple[dict, dict]:
    audit, binding = load_json(path)
    if audit.get("savedZipIntegrityHashesAndOutcomeAuditPassed") is not True:
        raise ValueError(f"{path}: prior_saved_archive_outcome_audit_not_passed")
    if audit.get("frozenManifestSHA256") != expected_manifest:
        raise ValueError(f"{path}: frozen_manifest_binding_mismatch")
    archive = audit.get("archive")
    if not isinstance(archive, dict) or not isinstance(archive.get("bytes"), int):
        raise ValueError(f"{path}: missing_prior_archive_size_binding")
    phases = audit.get("phaseDenominators", {})
    measured = phases.get("measured", {})
    warmups = phases.get("warmup_excluded", {})
    if (
        measured.get("planned") != expected_planned
        or measured.get("attempted") != expected_attempted
    ):
        raise ValueError(f"{path}: audited_measured_population_mismatch")
    if measured.get("unattempted") != expected_planned - expected_attempted:
        raise ValueError(f"{path}: audited_unattempted_denominator_mismatch")
    if (
        warmups.get("planned") != 15
        or warmups.get("attempted") != 15
        or warmups.get("unattempted") != 0
    ):
        raise ValueError(f"{path}: audited_excluded_warmup_population_mismatch")
    if require_complete_segment and audit.get("fullSegmentMeasuredCountReached") is not True:
        raise ValueError(f"{path}: second_segment_not_audited_complete")
    if require_complete_segment and audit.get("conditionTotalPlanned") != TOTAL_MEASURED:
        raise ValueError(f"{path}: second_segment_condition_total_mismatch")
    return audit, binding


def read_attempts(
    archive_path: Path,
    audit: dict,
    manifest_sha: str,
    prefix: str,
    pid: int,
    expected_measured: int,
    planned_measured: int,
    segment: str,
) -> tuple[list[dict], dict]:
    expected_archive_size = audit["archive"]["bytes"]
    actual_archive_size = archive_path.stat().st_size
    if actual_archive_size != expected_archive_size:
        raise ValueError(f"{archive_path}: size_does_not_match_prior_audit_receipt")

    with zipfile.ZipFile(archive_path) as saved:
        members = [name for name in saved.namelist() if ATTEMPT_MEMBER.fullmatch(name)]
        if len(members) != len(set(members)):
            raise ValueError(f"{archive_path}: duplicate_attempt_member_names")
        rows: list[dict] = []
        selected_bindings: list[dict] = []
        seen_ids: set[str] = set()
        measured_ordinal_start = 16
        measured_ordinal_end = 15 + expected_measured
        for member in sorted(members):
            raw = saved.read(member)
            row = json.loads(raw)
            if row.get("phase") == "warmup":
                continue
            if row.get("phase") != "measured":
                raise ValueError(f"{archive_path}: unknown_attempt_phase")
            case_id = row.get("harness_case_id")
            ordinal = row.get("ordinal")
            if not isinstance(case_id, str) or not case_id.startswith(prefix):
                raise ValueError(f"{archive_path}: attempt_case_prefix_mismatch")
            suffix = case_id[len(prefix) :]
            if not suffix.isdigit() or int(suffix) != ordinal:
                raise ValueError(f"{archive_path}: case_id_ordinal_mismatch")
            if (
                not isinstance(ordinal, int)
                or not measured_ordinal_start <= ordinal <= measured_ordinal_end
            ):
                raise ValueError(f"{archive_path}: measured_ordinal_out_of_segment_range")
            if case_id in seen_ids:
                raise ValueError(f"{archive_path}: duplicate_measured_case_id")
            seen_ids.add(case_id)
            status = row.get("status")
            if not isinstance(status, str) or not status:
                raise ValueError(f"{archive_path}: missing_attempt_status")
            duration = row.get("flow_duration_ms")
            if duration is not None and not finite_ms(duration):
                raise ValueError(f"{archive_path}: invalid_flow_duration")
            row["_segment"] = segment
            row["_segment_receiver_pid"] = pid
            row["_member"] = member
            row["_member_sha256"] = sha256(raw)
            row["_manifest_sha256"] = manifest_sha
            rows.append(row)
            selected_bindings.append(
                {
                    "segment": segment,
                    "member": member,
                    "bytes": len(raw),
                    "sha256": sha256(raw),
                    "harness_case_id": case_id,
                }
            )
        if len(rows) != expected_measured:
            raise ValueError(f"{archive_path}: measured_member_population_mismatch")
        return rows, {
            "path": str(archive_path),
            "bytes": actual_archive_size,
            "sha256": audit["archive"].get("sha256"),
            "sha256Source": "prior successful archive audit receipt; ZIP was not rehashed",
            "priorAuditMemberCount": audit["archiveMembers"],
            "selectedMeasuredAttemptMembers": selected_bindings,
        }


def validate_audited_population(rows: list[dict], audit: dict, planned: int, label: str) -> dict:
    measured = counts(rows, planned)
    audited = audit["phaseDenominators"]["measured"]
    for key in (
        "planned",
        "attempted",
        "completed_correct",
        "completed_incorrect",
        "failed_or_interrupted",
        "timeouts",
        "unattempted",
    ):
        if measured[key] != audited.get(key):
            raise ValueError(f"{label}: selected_attempts_disagree_with_prior_audited_{key}")
    if measured["rawOutcomeCounts"] != audit.get("rawOutcomeCounts"):
        raise ValueError(f"{label}: selected_attempts_disagree_with_prior_audited_raw_outcomes")
    return measured


def load_history(path: Path, expected_rows: list[dict], pid: int) -> tuple[dict, dict]:
    history, binding = load_json(path)
    expected_ids = {row["harness_case_id"] for row in expected_rows}
    if set(history) != expected_ids:
        raise ValueError(f"{path}: history_case_population_mismatch")
    valid: dict[str, dict] = {}
    for case_id, stages in history.items():
        if not isinstance(stages, dict):
            raise ValueError(f"{path}: malformed_case_history")
        if set(stages) - set(STAGES):
            raise ValueError(f"{path}: unexpected_stage_key")
        valid[case_id] = {}
        for stage in STAGES:
            rows = stages.get(stage, [])
            if not isinstance(rows, list):
                raise ValueError(f"{path}: malformed_stage_history")
            copied = []
            for span in rows:
                if not isinstance(span, dict):
                    raise ValueError(f"{path}: malformed_span")
                copied.append(span)
            valid[case_id][stage] = copied
    return valid, binding


def stage_analysis(
    all_rows: list[dict], histories: dict[str, dict]
) -> tuple[list[dict], list[dict]]:
    keys: set[tuple[str, str]] = set()
    for stages in histories.values():
        for stage, spans in stages.items():
            for span in spans:
                handler = span.get("handler")
                if isinstance(handler, str) and handler:
                    keys.add((stage, handler))

    metrics: list[dict] = []
    csv_rows: list[dict] = []
    for stage, handler in sorted(keys):
        durations: list[float] = []
        missing = multiple = invalid = missing_operation = missing_attempt = 0
        missing_request = missing_session = 0
        for attempt in all_rows:
            case_id = attempt["harness_case_id"]
            candidates = [
                span for span in histories[case_id].get(stage, []) if span.get("handler") == handler
            ]
            if not candidates:
                missing += 1
                continue
            if len(candidates) != 1:
                multiple += 1
                continue
            span = candidates[0]
            valid = (
                finite_ms(span.get("durationMs"))
                and span.get("receiverPid") == attempt["_segment_receiver_pid"]
                and span.get("clockDomain") == "python_process_monotonic"
                and bool(span.get("spanId"))
                and bool(attempt.get("correlation", {}).get("correlation_id"))
                and span.get("correlationId") == attempt["correlation"]["correlation_id"]
                and all(
                    (span.get(span_key) is None and stage != "llm")
                    or (
                        bool(attempt["correlation"].get(attempt_key))
                        and span.get(span_key) == attempt["correlation"][attempt_key]
                    )
                    for span_key, attempt_key in (
                        ("requestId", "request_id"),
                        ("sessionId", "session_id"),
                    )
                )
            )
            if not valid:
                invalid += 1
                continue
            duration = float(span["durationMs"])
            durations.append(duration)
            missing_operation += not bool(span.get("nativeOperationId"))
            missing_attempt += not bool(span.get("nativeAttemptId"))
            missing_request += span.get("requestId") is None
            missing_session += span.get("sessionId") is None
            csv_rows.append(
                {
                    "harness_case_id": case_id,
                    "segment": attempt["_segment"],
                    "stage": stage,
                    "handler": handler,
                    "duration_ms": duration,
                    "clock_domain": span.get("clockDomain"),
                    "receiver_pid": span.get("receiverPid"),
                    "correlation_id": span.get("correlationId"),
                    "span_id": span.get("spanId"),
                    "native_operation_id": span.get("nativeOperationId"),
                    "native_attempt_id": span.get("nativeAttemptId"),
                    "request_id": span.get("requestId"),
                    "session_id": span.get("sessionId"),
                }
            )
        metrics.append(
            {
                "stage": stage,
                "handler": handler,
                "attemptedCaseDenominator": len(all_rows),
                "validCompletedSpanDenominator": len(durations),
                "missingCases": missing,
                "multipleCompletedSpans": multiple,
                "invalidBoundarySpans": invalid,
                "missingNativeOperationId": missing_operation,
                "missingNativeAttemptId": missing_attempt,
                "missingNativeRequestId": missing_request,
                "missingNativeSessionId": missing_session,
                "p90_ms": type7(durations, 0.9),
                "p95_ms": type7(durations, 0.95),
                "scope": "one valid saved paired span per case and exact stage/handler; no sums or cross-process subtraction",
            }
        )
    return metrics, csv_rows


def attempt_summary(rows: list[dict], planned: int) -> dict:
    correct = [row for row in rows if row["status"] == "completed_correct"]
    completed = [
        row for row in rows if row["status"] in ("completed_correct", "completed_incorrect")
    ]
    observed = [row for row in rows if finite_ms(row.get("flow_duration_ms"))]
    result = counts(rows, planned)
    result["durationType7Ms"] = {
        "correctOnly": {
            "denominator": sum(finite_ms(r.get("flow_duration_ms")) for r in correct),
            "p90": type7(
                [
                    float(r["flow_duration_ms"])
                    for r in correct
                    if finite_ms(r.get("flow_duration_ms"))
                ],
                0.9,
            ),
            "p95": type7(
                [
                    float(r["flow_duration_ms"])
                    for r in correct
                    if finite_ms(r.get("flow_duration_ms"))
                ],
                0.95,
            ),
        },
        "completedIncludingIncorrect": {
            "denominator": sum(finite_ms(r.get("flow_duration_ms")) for r in completed),
            "p90": type7(
                [
                    float(r["flow_duration_ms"])
                    for r in completed
                    if finite_ms(r.get("flow_duration_ms"))
                ],
                0.9,
            ),
            "p95": type7(
                [
                    float(r["flow_duration_ms"])
                    for r in completed
                    if finite_ms(r.get("flow_duration_ms"))
                ],
                0.95,
            ),
        },
        "observedAttemptsIncludingFailures": {
            "denominator": len(observed),
            "p90": type7([float(r["flow_duration_ms"]) for r in observed], 0.9),
            "p95": type7([float(r["flow_duration_ms"]) for r in observed], 0.95),
        },
    }
    result["durationMissingOrInvalid"] = sum(
        not finite_ms(row.get("flow_duration_ms")) for row in rows
    )
    return result


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    with path.open("x", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--first-archive", type=Path, required=True)
    parser.add_argument("--second-archive", type=Path, required=True)
    parser.add_argument("--first-audit", type=Path, required=True)
    parser.add_argument("--second-audit", type=Path, required=True)
    parser.add_argument("--first-manifest", type=Path, required=True)
    parser.add_argument("--second-manifest", type=Path, required=True)
    parser.add_argument("--first-history", type=Path, required=True)
    parser.add_argument("--second-history", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.output_dir.exists() or args.output_dir.is_symlink():
        raise FileExistsError("output directory already exists; choose a fresh versioned path")

    first_manifest, first_manifest_binding = load_json(args.first_manifest)
    second_manifest, second_manifest_binding = load_json(args.second_manifest)
    if first_manifest_binding["sha256"] != FIRST_MANIFEST_SHA:
        raise ValueError("first_manifest_not_admitted_v735")
    if second_manifest_binding["sha256"] != SECOND_MANIFEST_SHA:
        raise ValueError("second_manifest_not_admitted_v745")
    # Parsing is intentional: these immutable manifests are explicit inputs and
    # their hashes are the admission identity; do not use declared fields to
    # replace the pinned bytes.
    del first_manifest, second_manifest

    first_audit, first_audit_binding = verify_audit(
        args.first_audit, FIRST_MANIFEST_SHA, 900, 274, False
    )
    second_audit, second_audit_binding = verify_audit(
        args.second_audit, SECOND_MANIFEST_SHA, 626, 626, True
    )
    first_rows, first_archive_binding = read_attempts(
        args.first_archive,
        first_audit,
        FIRST_MANIFEST_SHA,
        FIRST_PREFIX,
        FIRST_PID,
        274,
        900,
        "V735-original-segment",
    )
    second_rows, second_archive_binding = read_attempts(
        args.second_archive,
        second_audit,
        SECOND_MANIFEST_SHA,
        SECOND_PREFIX,
        SECOND_PID,
        626,
        626,
        "V745-continuation",
    )
    first_counts = validate_audited_population(first_rows, first_audit, 900, "V735")
    second_counts = validate_audited_population(second_rows, second_audit, 626, "V745")
    if first_counts["rawOutcomeCounts"] != {"completed_correct": 273, "interrupted": 1}:
        raise ValueError("V735 original audited outcome population changed")
    attempts = first_rows + second_rows
    if (
        len(attempts) != TOTAL_MEASURED
        or len({row["harness_case_id"] for row in attempts}) != TOTAL_MEASURED
    ):
        raise ValueError("joined_population_not_900_unique_measured_cases")

    first_history, first_history_binding = load_history(args.first_history, first_rows, FIRST_PID)
    second_history, second_history_binding = load_history(
        args.second_history, second_rows, SECOND_PID
    )
    histories = {**first_history, **second_history}
    native_metrics, span_csv = stage_analysis(attempts, histories)
    overall = attempt_summary(attempts, TOTAL_MEASURED)
    if overall["attempted"] != TOTAL_MEASURED or overall["unattempted"] != 0:
        raise ValueError("joined_attempt_denominator_not_900")

    attempt_csv = [
        {
            "harness_case_id": row["harness_case_id"],
            "segment": row["_segment"],
            "ordinal": row["ordinal"],
            "status": row["status"],
            "timeout": row.get("timeout"),
            "flow_duration_ms": row.get("flow_duration_ms"),
            "archive_member": row["_member"],
            "archive_member_sha256": row["_member_sha256"],
            "frozen_manifest_sha256": row["_manifest_sha256"],
        }
        for row in attempts
    ]
    provenance = {
        "firstSegment": {
            "archive": first_archive_binding,
            "audit": first_audit_binding,
            "frozenManifest": first_manifest_binding,
            "nativeStageHistory": first_history_binding,
        },
        "secondSegment": {
            "archive": second_archive_binding,
            "audit": second_audit_binding,
            "frozenManifest": second_manifest_binding,
            "nativeStageHistory": second_history_binding,
        },
        "selectedAttemptMembers": [
            *first_archive_binding["selectedMeasuredAttemptMembers"],
            *second_archive_binding["selectedMeasuredAttemptMembers"],
        ],
        "archiveIntegrity": "Relies on the named successful prior audit receipts; this analysis only reads selected audited attempt JSON members and does not rehash/test the full ZIPs.",
    }
    summary = {
        "schema": "aurora.v735-v745-compatible-segment-join.v760",
        "newMeasurements": 0,
        "condition": "aurora-padded-local900-segmented-v735-v745",
        "admission": {
            "firstManifestSha256": FIRST_MANIFEST_SHA,
            "secondManifestSha256": SECOND_MANIFEST_SHA,
            "firstReceiverPid": FIRST_PID,
            "secondReceiverPid": SECOND_PID,
            "firstWarmupsExcluded": 15,
            "secondWarmupsExcluded": 15,
            "totalMeasured": TOTAL_MEASURED,
        },
        "segmentDenominators": {"V735-original": first_counts, "V745-continuation": second_counts},
        "joinedMeasured": overall,
        "excludedWarmupDenominators": {
            "V735-original": first_audit["phaseDenominators"]["warmup_excluded"],
            "V745-continuation": second_audit["phaseDenominators"]["warmup_excluded"],
        },
        "nativeStageByExactStageAndHandler": native_metrics,
        "nativeStageDurationsAreSeparate": True,
        "unknownMetrics": {
            "queueWait": None,
            "TTFT": None,
            "firstStreamedAudio": None,
            "playback": None,
        },
        "unknownReason": "The headless finite adapters do not expose those boundaries; no zero or inferred value is substituted.",
        "limitations": [
            "V745 restarted the process and repeated excluded warmups; startup, order, state initialization and thermal variation remain.",
            "This is a compatible segmented aggregate, not an uninterrupted run or a pure protocol-causal comparison.",
            "Attempt statuses are preserved from the prior audits; this tool does not reclassify transcripts, replies, audio, or audit correctness.",
            "Correct-only, completed-including-incorrect, and observed-attempt duration distributions have separate denominators; stage quantiles are not added.",
        ],
        "inputs": provenance,
    }
    summary_text = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    history_text = json.dumps(histories, indent=2, sort_keys=True) + "\n"
    # Finish all input/admission validation and in-memory assembly before creating
    # the destination. Exclusive output paths prevent replacing any prior result.
    args.output_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    write_csv(
        args.output_dir / "attempt-outcomes.csv",
        attempt_csv,
        [
            "harness_case_id",
            "segment",
            "ordinal",
            "status",
            "timeout",
            "flow_duration_ms",
            "archive_member",
            "archive_member_sha256",
            "frozen_manifest_sha256",
        ],
    )
    write_csv(
        args.output_dir / "native-stage-spans.csv",
        span_csv,
        [
            "harness_case_id",
            "segment",
            "stage",
            "handler",
            "duration_ms",
            "clock_domain",
            "receiver_pid",
            "correlation_id",
            "span_id",
            "native_operation_id",
            "native_attempt_id",
            "request_id",
            "session_id",
        ],
    )
    with (args.output_dir / "joined-stage-history.json").open("x", encoding="utf-8") as stream:
        stream.write(history_text)
    with (args.output_dir / "summary.json").open("x", encoding="utf-8") as stream:
        stream.write(summary_text)
    print(
        json.dumps(
            {
                "outputDir": str(args.output_dir),
                "newMeasurements": 0,
                "measuredCases": TOTAL_MEASURED,
                "interruptedCasesPreserved": overall["failed_or_interrupted"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
