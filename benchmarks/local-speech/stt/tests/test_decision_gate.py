import json
import sys

from common.schema import Candidate, Fixture
from stt.decision_gate import (
    REQUIRED_BUCKETS,
    REQUIRED_LANGUAGE_MODES,
    REQUIRED_LANGUAGES,
    REQUIRED_SURFACES,
    _candidate_artifact_set_sha256,
    _surface,
    build_decision,
    main,
)
from stt.run_benchmark import build_report


def _report(
    candidate_id: str,
    runs: list[dict[str, object]],
    *,
    schema_only: bool = False,
    candidate_metadata: Candidate | None = None,
) -> dict[str, object]:
    decision = {
        "candidate_id": candidate_id,
        "role": "harness-smoke" if schema_only else "gate-fixture",
        "decision_eligible": not schema_only,
    }
    if candidate_metadata is not None:
        decision.update(
            {
                "revision": candidate_metadata.revision,
                "source_url": candidate_metadata.source_url,
                "model_artifacts": candidate_metadata.model_artifacts,
            }
        )
    return {
        "schema_version": "aurora.local_speech.stt.benchmark.v0.1",
        "benchmark_id": f"{candidate_id}-gate-fixture",
        "evidence_status": "schema_only" if schema_only else "gate_fixture_complete",
        "source": {
            "harness_revision": "unit",
            "candidate_config_sha256": "0" * 64,
            "fixture_manifest_sha256": "1" * 64,
        },
        "matrix": {
            "candidate_ids": [candidate_id],
            "fixture_ids": ["stt-gate-fixture"],
            "languages": list(REQUIRED_LANGUAGES),
            "buckets": list(REQUIRED_BUCKETS),
            "language_modes": list(REQUIRED_LANGUAGE_MODES),
            "metrics": [],
        },
        "runs": runs,
        "aggregates": [],
        "decisions": [decision],
        "redaction": {
            "audio_logged": False,
            "private_text_logged": False,
            "allowed_fixture_identifiers_only": True,
        },
    }


def _run(
    candidate_id: str,
    *,
    language: str = "en",
    bucket: str = "clean",
    mode: str = "fixed",
    surface: str = "desktop-browser",
    latency: float = 1000.0,
    wer: float = 0.0,
    status: str = "ok",
) -> dict[str, object]:
    run = {
        "run_id": f"{candidate_id}:{language}:{bucket}:{mode}:{surface}",
        "candidate_id": candidate_id,
        "fixture_id": "stt-gate-fixture",
        "language": language,
        "bucket": bucket,
        "language_mode": mode,
        "status": status,
        "failure_bucket": None if status == "ok" else "adapter_failed",
        "finalization_latency_ms": latency if status == "ok" else None,
        "initialization_ms": 10.0 if status == "ok" else None,
        "download_bytes": 0 if status == "ok" else None,
        "peak_memory_mb": 100.0 if status == "ok" else None,
        "thermal_state": "nominal" if status == "ok" else None,
        "browser_features": _browser_features(surface),
        "target_surface": surface,
        "device_profile": f"{surface}-gate-fixture",
        "evidence_kind": "measured" if status == "ok" else "failed",
        "latency_statistic": "p95" if status == "ok" else None,
        "runtime_provenance": {
            "candidate_id": candidate_id,
            "model_revision": "gate-fixture-revision",
            "model_artifact_sha256": "2" * 64,
            "package_pins": "gate-fixture-package@1.0.0",
        },
        "utterance_count": 10 if status == "ok" else 0,
    }
    if status == "ok":
        run.update(
            {
                "reference_words": 100,
                "wer": wer,
                "word_errors": int(wer * 100),
                "substitutions": int(wer * 100),
                "deletions": 0,
                "insertions": 0,
            }
        )
    return run


def _complete_runs(
    candidate_id: str, *, latency: float, wer: float = 0.0
) -> list[dict[str, object]]:
    return [
        _run(
            candidate_id,
            language=language,
            bucket=bucket,
            mode=mode,
            surface=surface,
            latency=latency,
            wer=wer,
        )
        for language in REQUIRED_LANGUAGES
        for bucket in REQUIRED_BUCKETS
        for mode in REQUIRED_LANGUAGE_MODES
        for surface in REQUIRED_SURFACES
    ]


def test_gate_fixture_complete_matrix_can_select_default():
    baseline = _report("baseline", _complete_runs("baseline", latency=1800.0))
    candidate = _report("candidate", _complete_runs("candidate", latency=1200.0, wer=0.01))

    decision = build_decision(
        baseline_report=baseline,
        candidate_report=candidate,
        baseline_id="baseline",
        candidate_id="candidate",
    )

    assert decision["decision"] == "default_candidate"
    assert decision["failed_gates"] == []
    assert decision["metrics"]["matched_cell_count"] == 24


def test_decision_blocks_missing_portuguese_noise_and_device_matrix():
    baseline = _report("baseline", [_run("baseline", latency=1000.0)])
    candidate = _report("candidate", [_run("candidate", latency=750.0)])

    decision = build_decision(
        baseline_report=baseline,
        candidate_report=candidate,
        baseline_id="baseline",
        candidate_id="candidate",
    )

    assert decision["decision"] == "decision_blocked"
    assert "candidate_missing_cell:pt/noise/auto/android-webview" in decision["failed_gates"]
    assert "baseline_missing_cell:pt/noise/auto/android-webview" in decision["failed_gates"]


def test_decision_blocks_weak_baseline_evidence():
    baseline_runs = _complete_runs("baseline", latency=1800.0)
    baseline_runs[0].pop("runtime_provenance")
    baseline_runs[1]["thermal_state"] = "not_measured"
    baseline_runs[2]["peak_memory_mb"] = None
    baseline_runs[3]["device_profile"] = ""
    baseline_runs[3]["browser_features"] = []
    baseline_runs[4].pop("latency_statistic")
    candidate = _report("candidate", _complete_runs("candidate", latency=1200.0))

    decision = build_decision(
        baseline_report=_report("baseline", baseline_runs),
        candidate_report=candidate,
        baseline_id="baseline",
        candidate_id="candidate",
    )

    assert decision["decision"] == "decision_blocked"
    assert any(gate.startswith("baseline_provenance_missing:") for gate in decision["failed_gates"])
    assert any(gate.startswith("baseline_thermal_missing:") for gate in decision["failed_gates"])
    assert any(gate.startswith("baseline_memory_missing:") for gate in decision["failed_gates"])
    assert any(
        gate.startswith("baseline_device_identity_missing:") for gate in decision["failed_gates"]
    )
    assert any(
        gate.startswith("baseline_p95_statistic_unproven:") for gate in decision["failed_gates"]
    )


def test_decision_blocks_unproven_candidate_p95_statistic():
    baseline = _report("baseline", _complete_runs("baseline", latency=1800.0))
    candidate_runs = _complete_runs("candidate", latency=1200.0)
    candidate_runs[0].pop("latency_statistic")

    decision = build_decision(
        baseline_report=baseline,
        candidate_report=_report("candidate", candidate_runs),
        baseline_id="baseline",
        candidate_id="candidate",
    )

    assert decision["decision"] == "decision_blocked"
    assert any(
        gate.startswith("candidate_p95_statistic_unproven:") for gate in decision["failed_gates"]
    )


def test_decision_blocks_mixed_ok_candidate_memory_failure():
    baseline = _report("baseline", _complete_runs("baseline", latency=1800.0))
    candidate_runs = _complete_runs("candidate", latency=1200.0)
    failed_retry = _run("candidate", status="failed")
    failed_retry["failure_bucket"] = "memory_limit"
    candidate_runs.append(failed_retry)

    decision = build_decision(
        baseline_report=baseline,
        candidate_report=_report("candidate", candidate_runs),
        baseline_id="baseline",
        candidate_id="candidate",
    )

    assert decision["decision"] == "decision_blocked"
    assert (
        "candidate_non_ok_required_cell:en/clean/fixed/desktop-browser" in decision["failed_gates"]
    )


def test_decision_blocks_mixed_ok_baseline_thermal_failure():
    baseline_runs = _complete_runs("baseline", latency=1800.0)
    failed_retry = _run("baseline", status="failed")
    failed_retry["failure_bucket"] = "thermal_limit"
    baseline_runs.append(failed_retry)
    candidate = _report("candidate", _complete_runs("candidate", latency=1200.0))

    decision = build_decision(
        baseline_report=_report("baseline", baseline_runs),
        candidate_report=candidate,
        baseline_id="baseline",
        candidate_id="candidate",
    )

    assert decision["decision"] == "decision_blocked"
    assert (
        "baseline_non_ok_required_cell:en/clean/fixed/desktop-browser" in decision["failed_gates"]
    )


def test_mobile_webviews_are_detected_before_generic_chrome():
    android = {
        "browser_features": [
            "Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Version/4.0 Chrome/145.0 Mobile Safari/537.36 wv"
        ]
    }
    ios = {
        "browser_features": [
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/145.0 Mobile/15E148 Safari/604.1"
        ]
    }
    ios_webview = {"browser_features": ["ios-webview"]}
    android_browser = {
        "browser_features": [
            "Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/145.0 Mobile Safari/537.36"
        ]
    }

    assert _surface(android) == "android-webview"
    assert _surface(ios) is None
    assert _surface(ios_webview) == "ios-webview"
    assert _surface(android_browser) is None


def test_conflicting_surface_declaration_is_rejected():
    run = {
        "target_surface": "desktop-browser",
        "browser_features": [
            "Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Version/4.0 Chrome/145.0 Mobile Safari/537.36 wv"
        ],
    }

    assert _surface(run) is None


def test_decision_blocks_candidate_provenance_mismatch():
    baseline = _candidate("baseline")
    candidate = _candidate("candidate")
    baseline_runs = _complete_runs("baseline", latency=1200.0)
    candidate_runs = _complete_runs("candidate", latency=1000.0)
    for run in baseline_runs:
        run["runtime_provenance"] = _runtime_provenance(baseline)
    for run in candidate_runs:
        run["runtime_provenance"] = _runtime_provenance(candidate)
    candidate_runs[0]["runtime_provenance"] = {
        **candidate_runs[0]["runtime_provenance"],
        "model_revision": "wrong-revision",
    }

    decision = build_decision(
        baseline_report=_report("baseline", baseline_runs, candidate_metadata=baseline),
        candidate_report=_report("candidate", candidate_runs, candidate_metadata=candidate),
        baseline_id="baseline",
        candidate_id="candidate",
        candidates=[baseline, candidate],
    )

    assert decision["decision"] == "decision_blocked"
    assert "candidate_runtime_model_revision_mismatch" in decision["failed_gates"]


def test_decision_blocks_report_candidate_metadata_mismatch():
    baseline = _candidate("baseline")
    candidate = _candidate("candidate")
    baseline_runs = _complete_runs("baseline", latency=1200.0)
    candidate_runs = _complete_runs("candidate", latency=1000.0)
    for run in baseline_runs:
        run["runtime_provenance"] = _runtime_provenance(baseline)
    for run in candidate_runs:
        run["runtime_provenance"] = _runtime_provenance(candidate)
    report = _report("candidate", candidate_runs, candidate_metadata=candidate)
    report["decisions"][0]["revision"] = "wrong-package-pins"

    decision = build_decision(
        baseline_report=_report("baseline", baseline_runs, candidate_metadata=baseline),
        candidate_report=report,
        baseline_id="baseline",
        candidate_id="candidate",
        candidates=[baseline, candidate],
    )

    assert decision["decision"] == "decision_blocked"
    assert "candidate_report_revision_mismatch" in decision["failed_gates"]


def test_external_json_report_to_decision_default_candidate(tmp_path):
    audio = tmp_path / "fixture.wav"
    audio.write_bytes(b"RIFF")
    script = tmp_path / "adapter.py"
    script.write_text(
        """
import json
import sys

def arg(name):
    index = sys.argv.index(name)
    return sys.argv[index + 1]

candidate_id = arg("--candidate-id")
fixture_id = arg("--fixture-id")
surface = fixture_id.rsplit("-", 1)[-1]
if surface == "browser":
    target_surface = "desktop-browser"
elif surface == "android":
    target_surface = "android-webview"
else:
    target_surface = "ios-webview"
latency = 1500.0 if candidate_id == "baseline" else 1000.0
revision = "baseline-revision" if candidate_id == "baseline" else "candidate-revision"
artifact_hash = "BASELINE_HASH" if candidate_id == "baseline" else "CANDIDATE_HASH"
print(json.dumps({
    "status": "ok",
    "text": "hello world",
    "finalization_latency_ms": latency,
    "initialization_ms": 10.0,
    "download_bytes": 0,
    "peak_memory_mb": 100.0,
    "thermal_state": "nominal",
    "browser_features": ["Chrome/145.0"] if target_surface == "desktop-browser" else [target_surface],
    "runtime_provenance": {
        "candidate_id": candidate_id,
        "model_revision": revision,
        "model_artifact_sha256": artifact_hash,
        "package_pins": revision,
    },
    "utterance_count": 10,
    "latency_statistic": "p95",
    "evidence_kind": "measured",
    "target_surface": target_surface,
    "device_profile": target_surface + "-fixture",
}))
""".replace("BASELINE_HASH", _candidate_artifact_set_sha256(_candidate("baseline"))).replace(
            "CANDIDATE_HASH", _candidate_artifact_set_sha256(_candidate("candidate"))
        ),
        encoding="utf-8",
    )
    baseline = _candidate("baseline")
    candidate = _candidate("candidate")
    fixtures = [
        Fixture(
            fixture_id=f"{language}-{bucket}-{surface}",
            language=language,
            bucket=bucket,
            duration_ms=1000,
            audio_sha256="0" * 64,
            reference_text="hello world",
            local_audio_path=str(audio),
        )
        for language in REQUIRED_LANGUAGES
        for bucket in REQUIRED_BUCKETS
        for surface in ("browser", "android", "ios")
    ]
    baseline_report = build_report(
        candidates=[baseline],
        fixtures=fixtures,
        language_modes=list(REQUIRED_LANGUAGE_MODES),
        run_id="baseline-e2e",
        generated_at_utc="1970-01-01T00:00:00Z",
        external_command=[sys.executable, str(script)],
    )
    candidate_report = build_report(
        candidates=[candidate],
        fixtures=fixtures,
        language_modes=list(REQUIRED_LANGUAGE_MODES),
        run_id="candidate-e2e",
        generated_at_utc="1970-01-01T00:00:00Z",
        external_command=[sys.executable, str(script)],
    )

    decision = build_decision(
        baseline_report=baseline_report,
        candidate_report=candidate_report,
        baseline_id="baseline",
        candidate_id="candidate",
        candidates=[baseline, candidate],
    )

    assert decision["decision"] == "default_candidate"
    assert decision["failed_gates"] == []
    assert decision["metrics"]["matched_cell_count"] == 24


def test_decision_blocks_all_failed_runs():
    baseline = _report("baseline", _complete_runs("baseline", latency=1800.0))
    candidate = _report(
        "candidate",
        [_run("candidate", status="failed")],
    )

    decision = build_decision(
        baseline_report=baseline,
        candidate_report=candidate,
        baseline_id="baseline",
        candidate_id="candidate",
    )

    assert decision["decision"] == "decision_blocked"
    assert "candidate_missing_ok_runs" in decision["failed_gates"]
    assert (
        "candidate_non_ok_required_cell:en/clean/fixed/desktop-browser" in decision["failed_gates"]
    )


def test_decision_blocks_fixture_only_reports():
    baseline = _report("baseline", _complete_runs("baseline", latency=1800.0))
    candidate = _report(
        "fixture-smoke", _complete_runs("fixture-smoke", latency=100.0), schema_only=True
    )

    decision = build_decision(
        baseline_report=baseline,
        candidate_report=candidate,
        baseline_id="baseline",
        candidate_id="fixture-smoke",
    )

    assert decision["decision"] == "decision_blocked"
    assert "candidate_schema_only_not_decision_evidence" in decision["failed_gates"]


def test_decision_blocked_cli_exits_2(tmp_path):
    baseline_path = tmp_path / "baseline.json"
    candidate_path = tmp_path / "candidate.json"
    output_path = tmp_path / "decision.json"
    baseline_path.write_text(json.dumps(_report("baseline", [_run("baseline")])), encoding="utf-8")
    candidate_path.write_text(
        json.dumps(_report("candidate", [_run("candidate", status="failed")])), encoding="utf-8"
    )

    exit_code = main(
        [
            "--baseline-report",
            str(baseline_path),
            "--candidate-report",
            str(candidate_path),
            "--baseline-id",
            "baseline",
            "--candidate-id",
            "candidate",
            "--output",
            str(output_path),
        ]
    )

    assert exit_code == 2
    assert json.loads(output_path.read_text(encoding="utf-8"))["decision"] == "decision_blocked"


def _candidate(candidate_id: str) -> Candidate:
    revision = f"{candidate_id}-revision"
    return Candidate(
        candidate_id=candidate_id,
        display_name=candidate_id,
        adapter="external-json",
        role="gate-fixture",
        revision=revision,
        source_url=f"https://example.invalid/{candidate_id}",
        supported_languages=list(REQUIRED_LANGUAGES),
        supports_auto_language=True,
        required_browser_features=[],
        model_artifacts=[
            {
                "artifact_id": f"{candidate_id}-artifact",
                "revision": revision,
                "sha256": candidate_id[0] * 64,
                "source": f"https://example.invalid/{candidate_id}",
            }
        ],
        notes=[],
    )


def _runtime_provenance(candidate: Candidate) -> dict[str, str]:
    return {
        "candidate_id": candidate.candidate_id,
        "model_revision": candidate.model_artifacts[0]["revision"],
        "model_artifact_sha256": _candidate_artifact_set_sha256(candidate),
        "package_pins": candidate.revision,
    }


def _browser_features(surface: str) -> list[str]:
    if surface == "desktop-browser":
        return ["Chrome/145.0 gate-fixture"]
    if surface == "android-webview":
        return [
            "Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Version/4.0 Chrome/145.0 Mobile Safari/537.36 wv"
        ]
    return ["ios-webview"]
