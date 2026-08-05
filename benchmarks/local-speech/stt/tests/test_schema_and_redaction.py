import json
from pathlib import Path

import pytest
from common.redaction import RedactionError, validate_report_redacted
from common.schema import load_candidates, load_fixture_manifest, validate_report_schema
from stt.run_benchmark import build_report, main

ROOT = Path(__file__).resolve().parents[4]


def test_fixture_smoke_report_is_redacted_and_schema_valid():
    fixtures = load_fixture_manifest(ROOT / "tests/fixtures/local_speech/stt/manifest.json")
    candidates = [
        candidate
        for candidate in load_candidates(ROOT / "benchmarks/local-speech/stt/candidates.json")
        if candidate.candidate_id == "fixture-smoke"
    ]

    report = build_report(
        candidates=candidates,
        fixtures=fixtures,
        language_modes=["fixed", "auto"],
        run_id="unit-smoke",
        generated_at_utc="1970-01-01T00:00:00Z",
    )

    validate_report_schema(report)
    serialized = str(report)
    assert "reference_text" not in serialized
    assert "hypothesis_text" not in serialized
    assert "Aurora starts" not in serialized
    assert report["aggregates"]
    assert report["evidence_status"] == "schema_only"
    assert report["decisions"][0]["decision_eligible"] is False
    assert all(run["status"] == "ok" for run in report["runs"])


def test_external_candidates_record_unavailable_without_fabricated_metrics():
    fixtures = load_fixture_manifest(ROOT / "tests/fixtures/local_speech/stt/manifest.json")
    candidates = [
        candidate
        for candidate in load_candidates(ROOT / "benchmarks/local-speech/stt/candidates.json")
        if candidate.candidate_id == "whisper-cpp-wasm"
    ]

    report = build_report(
        candidates=candidates,
        fixtures=fixtures,
        language_modes=["fixed"],
        run_id="unit-unavailable",
        generated_at_utc="1970-01-01T00:00:00Z",
        external_command=["definitely-missing-aurora-stt-adapter"],
    )

    validate_report_schema(report)
    assert {run["status"] for run in report["runs"]} == {"unavailable"}
    assert {run["failure_bucket"] for run in report["runs"]} == {"adapter_unavailable"}
    assert all(run["wer"] is None if "wer" in run else True for run in report["runs"])
    assert report["evidence_status"] == "blocked_no_ok_runs"


def test_real_all_failed_cli_writes_report_and_exits_2(tmp_path):
    output = tmp_path / "unavailable.json"

    exit_code = main(
        [
            "--fixtures",
            str(ROOT / "tests/fixtures/local_speech/stt/manifest.json"),
            "--candidate",
            "whisper-cpp-wasm",
            "--language-mode",
            "fixed",
            "--external-command",
            "definitely-missing-aurora-stt-adapter",
            "--run-id",
            "unit-unavailable-cli",
            "--output",
            str(output),
        ]
    )

    assert exit_code == 2
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["evidence_status"] == "blocked_no_ok_runs"


def test_fixture_smoke_cli_is_schema_only_and_exits_0(tmp_path):
    output = tmp_path / "schema-only.json"

    exit_code = main(
        [
            "--fixtures",
            str(ROOT / "tests/fixtures/local_speech/stt/manifest.json"),
            "--candidate",
            "fixture-smoke",
            "--run-id",
            "unit-schema-only-cli",
            "--output",
            str(output),
        ]
    )

    assert exit_code == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["evidence_status"] == "schema_only"
    assert report["decisions"][0]["decision_eligible"] is False


def test_report_redaction_rejects_transcripts_and_audio_paths():
    with pytest.raises(RedactionError):
        validate_report_redacted({"runs": [{"reference_text": "private"}]})
    with pytest.raises(RedactionError):
        validate_report_redacted({"runs": [{"fixture": "/tmp/private.wav"}]})
