#!/usr/bin/env python3
"""Run isolated local STT benchmark fixtures and write redacted JSON."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common.redaction import validate_report_redacted
from common.schema import (  # noqa: E402
    SCHEMA_VERSION,
    Candidate,
    Fixture,
    aggregate_runs,
    load_candidates,
    load_fixture_manifest,
    stable_json_dumps,
    stable_sha256,
    validate_report_schema,
)
from common.scoring import score_wer  # noqa: E402

from stt.adapters import AdapterResult, build_adapter  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    candidates = load_candidates(args.candidates)
    fixtures = load_fixture_manifest(args.fixtures)
    selected_candidates = [
        candidate
        for candidate in candidates
        if not args.candidate or candidate.candidate_id in args.candidate
    ]
    if not selected_candidates:
        raise SystemExit("no selected candidates")

    report = build_report(
        candidates=selected_candidates,
        fixtures=fixtures,
        language_modes=args.language_mode,
        run_id=args.run_id,
        generated_at_utc=_generated_at(args.generated_at),
        external_command=args.external_command,
    )
    validate_report_schema(report)
    validate_report_redacted(report)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(stable_json_dumps(report), encoding="utf-8")
    else:
        sys.stdout.write(stable_json_dumps(report))
    if report["evidence_status"] == "blocked_no_ok_runs":
        return 2
    return 0


def build_report(
    *,
    candidates: list[Candidate],
    fixtures: list[Fixture],
    language_modes: list[str],
    run_id: str,
    generated_at_utc: str,
    external_command: list[str] | None = None,
) -> dict[str, Any]:
    matrix = _matrix(candidates, fixtures, language_modes)
    runs: list[dict[str, Any]] = []
    for candidate in candidates:
        adapter = build_adapter(candidate.adapter, external_command=external_command)
        for fixture in fixtures:
            for language_mode in language_modes:
                runs.append(
                    _run_one(
                        adapter=adapter,
                        candidate=candidate,
                        fixture=fixture,
                        language_mode=language_mode,
                    )
                )
    report = {
        "schema_version": SCHEMA_VERSION,
        "benchmark_id": run_id,
        "generated_at_utc": generated_at_utc,
        "evidence_status": _evidence_status(candidates, runs),
        "source": {
            "harness_revision": _revision(),
            "candidate_config_sha256": stable_sha256(
                [candidate.__dict__ for candidate in candidates]
            ),
            "fixture_manifest_sha256": stable_sha256(
                [
                    {
                        "fixture_id": fixture.fixture_id,
                        "language": fixture.language,
                        "bucket": fixture.bucket,
                        "duration_ms": fixture.duration_ms,
                        "audio_sha256": fixture.audio_sha256,
                    }
                    for fixture in fixtures
                ]
            ),
        },
        "matrix": matrix,
        "runs": runs,
        "aggregates": aggregate_runs(runs),
        "decisions": _decision_inputs(candidates, runs),
        "redaction": {
            "audio_logged": False,
            "private_text_logged": False,
            "allowed_fixture_identifiers_only": True,
        },
    }
    report["report_sha256_without_self"] = stable_sha256(report)
    return report


def _run_one(
    *,
    adapter: Any,
    candidate: Candidate,
    fixture: Fixture,
    language_mode: str,
) -> dict[str, Any]:
    if language_mode == "fixed" and fixture.language not in candidate.supported_languages:
        result = AdapterResult(status="unsupported", failure_bucket="unsupported_language")
    elif language_mode == "auto" and not candidate.supports_auto_language:
        result = AdapterResult(status="unsupported", failure_bucket="unsupported_language_mode")
    else:
        result = adapter.transcribe(
            candidate=candidate,
            fixture=fixture,
            language_mode=language_mode,  # type: ignore[arg-type]
        )

    run: dict[str, Any] = {
        "run_id": f"{candidate.candidate_id}:{fixture.fixture_id}:{language_mode}",
        "candidate_id": candidate.candidate_id,
        "fixture_id": fixture.fixture_id,
        "language": fixture.language,
        "bucket": fixture.bucket,
        "language_mode": language_mode,
        "status": result.status,
        "failure_bucket": result.failure_bucket,
        "finalization_latency_ms": result.finalization_latency_ms,
        "initialization_ms": result.initialization_ms,
        "download_bytes": result.download_bytes,
        "peak_memory_mb": result.peak_memory_mb,
        "thermal_state": result.thermal_state,
        "browser_features": sorted(result.browser_features or []),
    }
    if result.runtime_provenance:
        run["runtime_provenance"] = result.runtime_provenance
    if result.status == "ok":
        assert result.hypothesis_text is not None
        wer = score_wer(fixture.reference_text, result.hypothesis_text)
        run.update(
            {
                "reference_words": wer.reference_words,
                "wer": round(wer.wer, 6),
                "word_errors": wer.errors,
                "substitutions": wer.substitutions,
                "deletions": wer.deletions,
                "insertions": wer.insertions,
            }
        )
    return run


def _matrix(
    candidates: list[Candidate],
    fixtures: list[Fixture],
    language_modes: list[str],
) -> dict[str, Any]:
    return {
        "candidate_ids": [candidate.candidate_id for candidate in candidates],
        "fixture_ids": [fixture.fixture_id for fixture in fixtures],
        "languages": sorted({fixture.language for fixture in fixtures}),
        "buckets": sorted({fixture.bucket for fixture in fixtures}),
        "language_modes": language_modes,
        "metrics": [
            "wer",
            "finalization_latency_ms",
            "initialization_ms",
            "download_bytes",
            "peak_memory_mb",
            "thermal_state",
            "browser_features",
            "failure_bucket",
        ],
    }


def _decision_inputs(
    candidates: list[Candidate], runs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    decisions = []
    for candidate in candidates:
        candidate_runs = [run for run in runs if run["candidate_id"] == candidate.candidate_id]
        decisions.append(
            {
                "candidate_id": candidate.candidate_id,
                "role": candidate.role,
                "revision": candidate.revision,
                "source_url": candidate.source_url,
                "model_artifacts": candidate.model_artifacts,
                "decision_eligible": candidate.role != "harness-smoke",
                "ok_runs": sum(1 for run in candidate_runs if run["status"] == "ok"),
                "unavailable_or_failed_runs": sum(
                    1 for run in candidate_runs if run["status"] != "ok"
                ),
                "rejected_alternatives": [],
                "notes": candidate.notes,
            }
        )
    return decisions


def _evidence_status(candidates: list[Candidate], runs: list[dict[str, Any]]) -> str:
    if all(candidate.role == "harness-smoke" for candidate in candidates):
        return "schema_only"
    if not any(run["status"] == "ok" for run in runs):
        return "blocked_no_ok_runs"
    if any(candidate.role == "harness-smoke" for candidate in candidates):
        return "mixed_schema_only"
    return "measured_incomplete"


def _revision() -> str:
    return os.environ.get("AURORA_BENCHMARK_REVISION", "worktree")


def _generated_at(value: str) -> str:
    if value != "source-date-epoch":
        return value
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    if epoch == 0:
        return "1970-01-01T00:00:00Z"
    return datetime.fromtimestamp(epoch, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[3]
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=root / "tests/fixtures/local_speech/stt/manifest.json",
    )
    parser.add_argument(
        "--candidates",
        type=Path,
        default=root / "benchmarks/local-speech/stt/candidates.json",
    )
    parser.add_argument("--candidate", action="append", default=[])
    parser.add_argument(
        "--language-mode",
        action="append",
        choices=["fixed", "auto"],
        default=[],
    )
    parser.add_argument("--external-command", nargs="+")
    parser.add_argument("--run-id", default="local-stt-smoke")
    parser.add_argument("--generated-at", default="source-date-epoch")
    parser.add_argument("--output", type=Path)
    parsed = parser.parse_args(argv)
    if not parsed.language_mode:
        parsed.language_mode = ["fixed", "auto"]
    return parsed


if __name__ == "__main__":
    raise SystemExit(main())
