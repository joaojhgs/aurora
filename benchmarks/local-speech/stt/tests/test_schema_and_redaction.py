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


def test_measured_english_whisper_metadata_does_not_claim_portuguese_or_auto():
    candidates = load_candidates(ROOT / "benchmarks/local-speech/stt/candidates.json")
    whisper = next(
        candidate
        for candidate in candidates
        if candidate.candidate_id == "transformersjs-whisper-webgpu-wasm"
    )
    moonshine = next(
        candidate
        for candidate in candidates
        if candidate.candidate_id == "transformersjs-moonshine-onnx"
    )

    assert whisper.supported_languages == ["en"]
    assert whisper.supports_auto_language is False
    assert whisper.source_url == "https://huggingface.co/Xenova/whisper-tiny.en"
    assert all(
        artifact["revision"] == "79fb389fc764e7c395bd330e9531d9d32ada7049"
        for artifact in whisper.model_artifacts
    )
    assert moonshine.source_url == "https://huggingface.co/onnx-community/moonshine-tiny-ONNX"
    assert all(
        artifact["revision"] == "a6da1241cd305dcd64eab1edbd615f2bb9aabb95"
        for artifact in moonshine.model_artifacts
    )


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


def test_runtime_provenance_rejects_sensitive_keys_and_values():
    safe = {
        "runtime_provenance": {
            "candidate_id": "candidate",
            "model_revision": "revision",
            "model_artifact_sha256": "a" * 64,
            "package_pins": "pkg@1.0.0",
            "browser_engine": "HeadlessChrome/145.0",
        }
    }
    validate_report_redacted(safe)

    blocked = [
        {"runtime_provenance": {"model_path": "/tmp/model.onnx"}},
        {"runtime_provenance": {"candidate_id": "candidate", "token": "secret"}},
        {"runtime_provenance": {"candidate_id": "candidate", "device_id": "abc"}},
        {"runtime_provenance": {"candidate_id": "candidate", "serial": "abc"}},
        {"runtime_provenance": {"candidate_id": "candidate", "browser_engine": "/home/user"}},
        {"runtime_provenance": {"candidate_id": "candidate", "model_id": "model.onnx"}},
        {"runtime_provenance": {"candidate_id": "candidate", "package_pins": "Bearer secret"}},
    ]
    for payload in blocked:
        with pytest.raises(RedactionError):
            validate_report_redacted(payload)
