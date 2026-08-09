#!/usr/bin/env python3
"""Evaluate local STT benchmark reports against the Phase-0 decision gate."""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common.redaction import validate_report_redacted
from common.schema import (
    Candidate,
    load_candidates,
    stable_json_dumps,
    stable_sha256,
    validate_report_schema,
)
from common.scoring import percentile

DECISION_SCHEMA_VERSION = "aurora.local_speech.stt.decision.v0.2"
REQUIRED_LANGUAGES = ("en", "pt")
REQUIRED_BUCKETS = ("clean", "noise")
REQUIRED_LANGUAGE_MODES = ("fixed", "auto")
REQUIRED_SURFACES = ("desktop-browser", "android-webview", "ios-webview")
MIN_UTTERANCES_PER_CELL = 10
MAX_WER_REGRESSION = 0.02
DESKTOP_P95_TARGET_MS = 2000.0
MOBILE_P95_TARGET_MS = 3500.0
MEMORY_BUDGET_MB = 512.0


def build_decision(
    *,
    baseline_report: dict[str, Any],
    candidate_report: dict[str, Any],
    baseline_id: str,
    candidate_id: str,
    candidates: list[Candidate] | None = None,
) -> dict[str, Any]:
    """Return a redacted decision input summary and gate verdict."""

    validate_report_schema(baseline_report)
    validate_report_schema(candidate_report)
    baseline_runs = _runs_for(baseline_report, baseline_id)
    candidate_runs = _runs_for(candidate_report, candidate_id)
    failed_gates: set[str] = set()
    candidate_index = {candidate.candidate_id: candidate for candidate in candidates or []}
    baseline_metadata = candidate_index.get(baseline_id)
    candidate_metadata = candidate_index.get(candidate_id)
    if candidates is not None and baseline_metadata is None:
        failed_gates.add("baseline_candidate_metadata_missing")
    if candidates is not None and candidate_metadata is None:
        failed_gates.add("candidate_metadata_missing")

    if _is_schema_only(baseline_report, baseline_id):
        failed_gates.add("baseline_schema_only_not_decision_evidence")
    if _is_schema_only(candidate_report, candidate_id):
        failed_gates.add("candidate_schema_only_not_decision_evidence")
    if baseline_metadata is not None:
        _check_report_candidate_metadata(
            "baseline", baseline_report, baseline_metadata, failed_gates
        )
    if candidate_metadata is not None:
        _check_report_candidate_metadata(
            "candidate", candidate_report, candidate_metadata, failed_gates
        )

    baseline_ok = [run for run in baseline_runs if run["status"] == "ok"]
    candidate_ok = [run for run in candidate_runs if run["status"] == "ok"]
    if not baseline_ok:
        failed_gates.add("baseline_missing_ok_runs")
    if not candidate_ok:
        failed_gates.add("candidate_missing_ok_runs")
    if not _has_ok_mode(candidate_runs, "fixed"):
        failed_gates.add("candidate_fixed_mode_missing")
    if not _has_ok_mode(candidate_runs, "auto"):
        failed_gates.add("candidate_auto_mode_missing")

    baseline_cells = _index_runs(baseline_runs)
    candidate_cells = _index_runs(candidate_runs)
    cell_summaries: list[dict[str, Any]] = []

    for language in REQUIRED_LANGUAGES:
        for bucket in REQUIRED_BUCKETS:
            for mode in REQUIRED_LANGUAGE_MODES:
                for surface in REQUIRED_SURFACES:
                    key = (language, bucket, mode, surface)
                    baseline_cell_runs = baseline_cells.get(key, [])
                    candidate_cell_runs = candidate_cells.get(key, [])
                    baseline_cell = [run for run in baseline_cell_runs if run["status"] == "ok"]
                    candidate_cell = [run for run in candidate_cell_runs if run["status"] == "ok"]
                    if _has_non_ok(baseline_cell_runs):
                        failed_gates.add(f"baseline_non_ok_required_cell:{_cell_name(key)}")
                    if _has_non_ok(candidate_cell_runs):
                        failed_gates.add(f"candidate_non_ok_required_cell:{_cell_name(key)}")
                    if not baseline_cell:
                        failed_gates.add(f"baseline_missing_cell:{_cell_name(key)}")
                    if not candidate_cell:
                        failed_gates.add(f"candidate_missing_cell:{_cell_name(key)}")
                    if not baseline_cell or not candidate_cell:
                        continue
                    summary = _compare_cell(key, baseline_cell, candidate_cell, failed_gates)
                    if baseline_metadata is not None:
                        _check_run_provenance(
                            "baseline", baseline_metadata, baseline_cell, failed_gates
                        )
                    if candidate_metadata is not None:
                        _check_run_provenance(
                            "candidate", candidate_metadata, candidate_cell, failed_gates
                        )
                    cell_summaries.append(summary)

    candidate_failure_buckets = sorted(
        {
            str(run["failure_bucket"])
            for run in candidate_runs
            if run.get("failure_bucket") is not None
        }
    )
    metrics = {
        "baseline_ok_runs": len(baseline_ok),
        "candidate_ok_runs": len(candidate_ok),
        "candidate_failure_buckets": candidate_failure_buckets,
        "required_cell_count": (
            len(REQUIRED_LANGUAGES)
            * len(REQUIRED_BUCKETS)
            * len(REQUIRED_LANGUAGE_MODES)
            * len(REQUIRED_SURFACES)
        ),
        "matched_cell_count": len(cell_summaries),
        "max_candidate_finalization_latency_ms": _max_metric(
            candidate_ok, "finalization_latency_ms"
        ),
        "max_candidate_peak_memory_mb": _max_metric(candidate_ok, "peak_memory_mb"),
        "max_wer_regression": _max_wer_regression(cell_summaries),
        "cells": cell_summaries,
    }

    decision = "default_candidate" if not failed_gates else "decision_blocked"
    payload = {
        "schema_version": DECISION_SCHEMA_VERSION,
        "decision": decision,
        "baseline_candidate_id": baseline_id,
        "candidate_id": candidate_id,
        "failed_gates": sorted(failed_gates),
        "metrics": metrics,
        "notes": [
            "Default selection requires measured fixed and auto evidence for English and Portuguese, clean and noise buckets, desktop browser plus Android and iOS WebView target surfaces, per-cell latency and WER limits, memory evidence, browser/device provenance, and non-Linux thermal evidence.",
            "Fixture-smoke rows are schema and redaction checks only and are never decision evidence.",
        ],
    }
    payload["decision_sha256_without_self"] = stable_sha256(payload)
    validate_report_redacted(payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    baseline_report = json.loads(args.baseline_report.read_text(encoding="utf-8"))
    candidate_report = json.loads(args.candidate_report.read_text(encoding="utf-8"))
    decision = build_decision(
        baseline_report=baseline_report,
        candidate_report=candidate_report,
        baseline_id=args.baseline_id,
        candidate_id=args.candidate_id,
        candidates=load_candidates(args.candidates),
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(stable_json_dumps(decision), encoding="utf-8")
    else:
        print(stable_json_dumps(decision), end="")
    return 0 if decision["decision"] != "decision_blocked" else 2


def _runs_for(report: dict[str, Any], candidate_id: str) -> list[dict[str, Any]]:
    return [run for run in report["runs"] if run["candidate_id"] == candidate_id]


def _is_schema_only(report: dict[str, Any], candidate_id: str) -> bool:
    if report.get("evidence_status") == "schema_only":
        return True
    if candidate_id == "fixture-smoke":
        return True
    for item in report.get("decisions", []):
        if item.get("candidate_id") == candidate_id:
            return item.get("role") == "harness-smoke" or item.get("decision_eligible") is False
    return False


def _has_ok_mode(runs: list[dict[str, Any]], mode: str) -> bool:
    return any(run["language_mode"] == mode and run["status"] == "ok" for run in runs)


def _index_runs(
    runs: list[dict[str, Any]],
) -> dict[tuple[str, str, str, str], list[dict[str, Any]]]:
    indexed: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        surface = _surface(run)
        if surface is None:
            continue
        indexed[
            (
                str(run["language"]),
                str(run["bucket"]),
                str(run["language_mode"]),
                surface,
            )
        ].append(run)
    return indexed


def _has_non_ok(runs: list[dict[str, Any]]) -> bool:
    return any(run["status"] in {"failed", "unavailable", "unsupported"} for run in runs)


def _compare_cell(
    key: tuple[str, str, str, str],
    baseline: list[dict[str, Any]],
    candidate: list[dict[str, Any]],
    failed_gates: set[str],
) -> dict[str, Any]:
    cell_name = _cell_name(key)
    baseline_p95 = _cell_p95_latency(
        "baseline",
        cell_name,
        baseline,
        failed_gates,
    )
    candidate_p95 = _cell_p95_latency(
        "candidate",
        cell_name,
        candidate,
        failed_gates,
    )
    baseline_wer = _max_metric(baseline, "wer")
    candidate_wer = _max_metric(candidate, "wer")
    baseline_memory = _max_metric(baseline, "peak_memory_mb")
    candidate_memory = _max_metric(candidate, "peak_memory_mb")
    baseline_utterances = _cell_utterance_count(baseline)
    candidate_utterances = sum(int(run.get("utterance_count", 1)) for run in candidate)
    wer_regression = None

    if baseline_utterances < MIN_UTTERANCES_PER_CELL:
        failed_gates.add(f"baseline_insufficient_utterances:{cell_name}")
    if candidate_utterances < MIN_UTTERANCES_PER_CELL:
        failed_gates.add(f"candidate_insufficient_utterances:{cell_name}")
    if baseline_p95 is None:
        failed_gates.add(f"baseline_latency_missing:{cell_name}")
    elif baseline_p95 > _latency_target_ms(key[3]):
        failed_gates.add(f"baseline_latency_target_missed:{cell_name}")
    if candidate_p95 is None:
        failed_gates.add(f"candidate_latency_missing:{cell_name}")
    elif candidate_p95 > _latency_target_ms(key[3]):
        failed_gates.add(f"candidate_latency_target_missed:{cell_name}")
    if baseline_wer is None:
        failed_gates.add(f"baseline_wer_missing:{cell_name}")
    if candidate_wer is None:
        failed_gates.add(f"candidate_wer_missing:{cell_name}")
    if baseline_wer is not None and candidate_wer is not None:
        wer_regression = round(candidate_wer - baseline_wer, 6)
        if wer_regression > MAX_WER_REGRESSION:
            failed_gates.add(f"candidate_wer_regression:{cell_name}")
    if baseline_memory is None:
        failed_gates.add(f"baseline_memory_missing:{cell_name}")
    elif baseline_memory > MEMORY_BUDGET_MB:
        failed_gates.add(f"baseline_memory_budget_missed:{cell_name}")
    if candidate_memory is None:
        failed_gates.add(f"candidate_memory_missing:{cell_name}")
    elif candidate_memory > MEMORY_BUDGET_MB:
        failed_gates.add(f"candidate_memory_budget_missed:{cell_name}")
    if any(_thermal_missing(run) for run in baseline):
        failed_gates.add(f"baseline_thermal_missing:{cell_name}")
    if any(_thermal_missing(run) for run in candidate):
        failed_gates.add(f"candidate_thermal_missing:{cell_name}")
    if any(not _has_measured_provenance(run) for run in baseline):
        failed_gates.add(f"baseline_provenance_missing:{cell_name}")
    if any(not _has_measured_provenance(run) for run in candidate):
        failed_gates.add(f"candidate_provenance_missing:{cell_name}")
    if any(not _has_device_identity(run) for run in baseline):
        failed_gates.add(f"baseline_device_identity_missing:{cell_name}")
    if any(not _has_device_identity(run) for run in candidate):
        failed_gates.add(f"candidate_device_identity_missing:{cell_name}")

    return {
        "language": key[0],
        "bucket": key[1],
        "language_mode": key[2],
        "target_surface": key[3],
        "baseline_utterances": baseline_utterances,
        "candidate_utterances": candidate_utterances,
        "baseline_p95_finalization_latency_ms": baseline_p95,
        "candidate_p95_finalization_latency_ms": candidate_p95,
        "baseline_worst_wer": baseline_wer,
        "candidate_worst_wer": candidate_wer,
        "wer_regression": wer_regression,
        "baseline_peak_memory_mb": baseline_memory,
        "candidate_peak_memory_mb": candidate_memory,
    }


def _surface(run: dict[str, Any]) -> str | None:
    explicit = run.get("target_surface")
    observed = _observed_surface(run)
    if isinstance(explicit, str) and explicit:
        if explicit not in REQUIRED_SURFACES:
            return None
        if observed is not None and observed != explicit:
            return None
        if _is_normal_mobile_browser(run):
            return None
        return explicit
    return observed


def _observed_surface(run: dict[str, Any]) -> str | None:
    features = [str(item).lower() for item in run.get("browser_features", [])]
    if any("android" in item and (" wv" in item or "; wv" in item) for item in features):
        return "android-webview"
    if any("ios-webview" in item for item in features):
        return "ios-webview"
    if any("android" in item or "iphone" in item or "ipad" in item for item in features):
        return None
    if any("headlesschrome" in item or "chrome/" in item for item in features):
        return "desktop-browser"
    return None


def _is_normal_mobile_browser(run: dict[str, Any]) -> bool:
    features = [str(item).lower() for item in run.get("browser_features", [])]
    return any(
        ("android" in item and "chrome/" in item and " wv" not in item and "; wv" not in item)
        or ("iphone" in item and ("safari/" in item or "crios/" in item))
        or ("ipad" in item and ("safari/" in item or "crios/" in item))
        for item in features
    )


def _thermal_missing(run: dict[str, Any]) -> bool:
    return run.get("thermal_state") in (None, "not_measured", "unavailable_in_linux_ci")


def _has_measured_provenance(run: dict[str, Any]) -> bool:
    if run.get("evidence_kind") != "measured":
        return False
    provenance = run.get("runtime_provenance")
    return isinstance(provenance, dict) and bool(provenance)


def _has_device_identity(run: dict[str, Any]) -> bool:
    if isinstance(run.get("device_profile"), str) and run["device_profile"]:
        return True
    return any("chrome/" in str(item).lower() for item in run.get("browser_features", []))


def _cell_name(key: tuple[str, str, str, str]) -> str:
    return "/".join(key)


def _latency_target_ms(surface: str) -> float:
    return DESKTOP_P95_TARGET_MS if surface == "desktop-browser" else MOBILE_P95_TARGET_MS


def _cell_p95_latency(
    role: str,
    cell_name: str,
    runs: list[dict[str, Any]],
    failed_gates: set[str],
) -> float | None:
    if _cell_utterance_count(runs) < MIN_UTTERANCES_PER_CELL:
        return None
    latencies = [
        float(run["finalization_latency_ms"])
        for run in runs
        if run.get("finalization_latency_ms") is not None
    ]
    if len(latencies) >= MIN_UTTERANCES_PER_CELL:
        return round(percentile(latencies, 95), 6)
    summary_runs = [
        run
        for run in runs
        if run.get("latency_statistic") == "p95"
        and int(run.get("utterance_count", 0)) >= MIN_UTTERANCES_PER_CELL
        and run.get("finalization_latency_ms") is not None
    ]
    if summary_runs:
        return max(float(run["finalization_latency_ms"]) for run in summary_runs)
    failed_gates.add(f"{role}_p95_statistic_unproven:{cell_name}")
    return None


def _cell_utterance_count(runs: list[dict[str, Any]]) -> int:
    return sum(int(run.get("utterance_count", 1)) for run in runs)


def _check_report_candidate_metadata(
    role: str,
    report: dict[str, Any],
    candidate: Candidate,
    failed_gates: set[str],
) -> None:
    decision = next(
        (
            item
            for item in report.get("decisions", [])
            if item.get("candidate_id") == candidate.candidate_id
        ),
        None,
    )
    if decision is None:
        failed_gates.add(f"{role}_report_candidate_metadata_missing")
        return
    if decision.get("revision") != candidate.revision:
        failed_gates.add(f"{role}_report_revision_mismatch")
    if decision.get("model_artifacts") != candidate.model_artifacts:
        failed_gates.add(f"{role}_report_model_artifacts_mismatch")


def _check_run_provenance(
    role: str,
    candidate: Candidate,
    runs: list[dict[str, Any]],
    failed_gates: set[str],
) -> None:
    expected_revision = _expected_model_revision(candidate)
    expected_artifact_set = _candidate_artifact_set_sha256(candidate)
    for run in runs:
        provenance = run.get("runtime_provenance")
        if not isinstance(provenance, dict):
            failed_gates.add(f"{role}_runtime_provenance_missing")
            continue
        if provenance.get("candidate_id") != candidate.candidate_id:
            failed_gates.add(f"{role}_runtime_candidate_id_mismatch")
        if expected_revision is None or provenance.get("model_revision") != expected_revision:
            failed_gates.add(f"{role}_runtime_model_revision_mismatch")
        if provenance.get("model_artifact_sha256") != expected_artifact_set:
            failed_gates.add(f"{role}_runtime_model_artifact_hash_mismatch")
        if provenance.get("package_pins") != candidate.revision:
            failed_gates.add(f"{role}_runtime_package_pins_mismatch")


def _expected_model_revision(candidate: Candidate) -> str | None:
    revisions = {
        artifact.get("revision")
        for artifact in candidate.model_artifacts
        if artifact.get("revision")
    }
    return revisions.pop() if len(revisions) == 1 else None


def _candidate_artifact_set_sha256(candidate: Candidate) -> str:
    return stable_sha256(
        [
            {
                "artifact_id": artifact.get("artifact_id"),
                "revision": artifact.get("revision"),
                "sha256": artifact.get("sha256"),
            }
            for artifact in sorted(
                candidate.model_artifacts,
                key=lambda item: item.get("artifact_id", ""),
            )
        ]
    )


def _max_metric(runs: list[dict[str, Any]], key: str) -> float | None:
    values = [float(run[key]) for run in runs if run.get(key) is not None]
    return max(values) if values else None


def _max_wer_regression(cell_summaries: list[dict[str, Any]]) -> float | None:
    values = [
        float(summary["wer_regression"])
        for summary in cell_summaries
        if summary.get("wer_regression") is not None
    ]
    return max(values) if values else None


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-report", type=Path, required=True)
    parser.add_argument("--candidate-report", type=Path, required=True)
    parser.add_argument("--baseline-id", required=True)
    parser.add_argument("--candidate-id", required=True)
    parser.add_argument(
        "--candidates",
        type=Path,
        default=Path(__file__).resolve().parent / "candidates.json",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
