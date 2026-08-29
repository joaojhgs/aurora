"""Versioned schemas and validation for local speech benchmark inputs/results."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .redaction import sanitize_runtime_provenance, validate_report_redacted
from .scoring import percentile

SCHEMA_VERSION = "aurora.local_speech.stt.benchmark.v0.1"
FIXTURE_MANIFEST_VERSION = "aurora.local_speech.stt.fixtures.v0.1"

LanguageMode = Literal["fixed", "auto"]
RunStatus = Literal["ok", "unsupported", "unavailable", "failed"]

RESULT_REQUIRED_TOP_LEVEL = {
    "schema_version",
    "benchmark_id",
    "source",
    "matrix",
    "runs",
    "aggregates",
    "decisions",
    "redaction",
}


@dataclass(frozen=True)
class Fixture:
    """Approved offline fixture metadata plus private scoring text."""

    fixture_id: str
    language: str
    bucket: str
    duration_ms: int
    audio_sha256: str
    reference_text: str
    local_audio_path: str | None = None
    smoke_hypotheses: dict[str, str] | None = None


@dataclass(frozen=True)
class Candidate:
    """Benchmark candidate metadata separated from engine adapters."""

    candidate_id: str
    display_name: str
    adapter: str
    role: str
    revision: str
    source_url: str
    supported_languages: list[str]
    supports_auto_language: bool
    required_browser_features: list[str]
    model_artifacts: list[dict[str, str]]
    notes: list[str]


def stable_json_dumps(value: Any) -> str:
    """Serialize JSON deterministically for hashing and reports."""

    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def stable_sha256(value: Any) -> str:
    return hashlib.sha256(stable_json_dumps(value).encode("utf-8")).hexdigest()


def load_fixture_manifest(path: Path) -> list[Fixture]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("manifest_version") != FIXTURE_MANIFEST_VERSION:
        raise ValueError("fixture manifest version mismatch")
    fixtures = []
    seen = set()
    for item in raw.get("fixtures", []):
        fixture_id = item["fixture_id"]
        if fixture_id in seen:
            raise ValueError(f"duplicate fixture_id {fixture_id}")
        seen.add(fixture_id)
        reference_text = item["reference_text"]
        if not isinstance(reference_text, str) or not reference_text.strip():
            raise ValueError(f"fixture {fixture_id} needs reference_text for offline scoring")
        fixtures.append(
            Fixture(
                fixture_id=fixture_id,
                language=item["language"],
                bucket=item["bucket"],
                duration_ms=int(item["duration_ms"]),
                audio_sha256=item["audio_sha256"],
                local_audio_path=item.get("local_audio_path"),
                reference_text=reference_text,
                smoke_hypotheses=dict(item.get("smoke_hypotheses", {})),
            )
        )
    if not fixtures:
        raise ValueError("fixture manifest contains no fixtures")
    return fixtures


def load_candidates(path: Path) -> list[Candidate]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    candidates = []
    seen = set()
    for item in raw.get("candidates", []):
        candidate_id = item["candidate_id"]
        if candidate_id in seen:
            raise ValueError(f"duplicate candidate_id {candidate_id}")
        seen.add(candidate_id)
        candidates.append(
            Candidate(
                candidate_id=candidate_id,
                display_name=item["display_name"],
                adapter=item["adapter"],
                role=item["role"],
                revision=item["revision"],
                source_url=item["source_url"],
                supported_languages=list(item.get("supported_languages", [])),
                supports_auto_language=bool(item.get("supports_auto_language", False)),
                required_browser_features=list(item.get("required_browser_features", [])),
                model_artifacts=list(item.get("model_artifacts", [])),
                notes=list(item.get("notes", [])),
            )
        )
    if not candidates:
        raise ValueError("candidate config contains no candidates")
    return candidates


def validate_report_schema(report: dict[str, Any]) -> None:
    missing = RESULT_REQUIRED_TOP_LEVEL - set(report)
    if missing:
        raise ValueError(f"benchmark report missing keys: {sorted(missing)}")
    if report["schema_version"] != SCHEMA_VERSION:
        raise ValueError("benchmark report schema version mismatch")
    validate_report_redacted(report)
    for run in report["runs"]:
        if run["status"] == "ok" and "wer" not in run:
            raise ValueError(f"successful run missing WER: {run['run_id']}")
        if "fixture_id" not in run or "candidate_id" not in run or "language_mode" not in run:
            raise ValueError(f"run missing identity fields: {run}")
        if "runtime_provenance" in run:
            sanitize_runtime_provenance(run["runtime_provenance"], location="$.runtime_provenance")
        if "utterance_count" in run and int(run["utterance_count"]) < 0:
            raise ValueError(f"negative utterance_count: {run['run_id']}")
        if run.get("latency_statistic") not in (None, "p50", "p95", "single"):
            raise ValueError(f"unsupported latency_statistic: {run['run_id']}")


def aggregate_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate redacted run metrics by candidate/language/bucket/mode."""

    grouped: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        grouped[
            (
                run["candidate_id"],
                run["language"],
                run["bucket"],
                run["language_mode"],
            )
        ].append(run)

    aggregates: list[dict[str, Any]] = []
    for (candidate_id, language, bucket, language_mode), items in sorted(grouped.items()):
        ok = [item for item in items if item["status"] == "ok"]
        failed = [item for item in items if item["status"] != "ok"]
        latencies = [
            float(item["finalization_latency_ms"])
            for item in ok
            if item.get("finalization_latency_ms") is not None
        ]
        wers = [float(item["wer"]) for item in ok if item.get("wer") is not None]
        aggregates.append(
            {
                "candidate_id": candidate_id,
                "language": language,
                "bucket": bucket,
                "language_mode": language_mode,
                "ok_runs": len(ok),
                "failed_runs": len(failed),
                "wer_mean": round(sum(wers) / len(wers), 6) if wers else None,
                "finalization_latency_samples": len(latencies),
                "finalization_latency_ms_p50": percentile(latencies, 50)
                if len(latencies) >= 10
                else None,
                "finalization_latency_ms_p95": percentile(latencies, 95)
                if len(latencies) >= 10
                else None,
                "finalization_latency_ms_max_observed": max(latencies) if latencies else None,
                "failure_buckets": sorted(
                    {item.get("failure_bucket", "unknown") for item in failed}
                ),
            }
        )
    return aggregates
