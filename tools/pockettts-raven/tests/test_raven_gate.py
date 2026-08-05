from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "tools/pockettts-raven/raven_gate.py"
MANIFEST = REPO / "tests/fixtures/local_speech/raven/pinned_raven_manifest.json"
BENCH = REPO / "tests/fixtures/local_speech/raven/sample_runtime_benchmark.json"


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )


def test_manifest_validates_pinned_sources_and_required_packs() -> None:
    result = run_cli("manifest", str(MANIFEST))

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "incomplete"
    assert payload["required_packs"] == ["english_2026-04", "french_24l", "portuguese"]
    assert payload["readiness"]["unpinned_asset_count"] == 14
    assert payload["readiness"]["release_ready"] is False


def test_conversion_dry_run_reports_missing_assets_without_claiming_reproduction() -> None:
    result = run_cli("conversion", "--manifest", str(MANIFEST), "--pack", "english_2026-04", "--dry-run")

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["first_failure"]["reason"] == "missing"
    assert "conversion not reproduced" in payload["claim"]


def test_fixture_benchmark_report_is_schema_only_not_release_evidence() -> None:
    result = run_cli("benchmark", "--manifest", str(MANIFEST), "--pack", "english_2026-04", "--input", str(BENCH))

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "schema-only"
    assert payload["release_evidence"] is False
    assert payload["first_failure"]["reason"] == "non_release_evidence_kind"
    assert payload["rtf"] == 0.9
    assert payload["metrics"]["cancelled_stale_audio"] is False


def test_measured_benchmark_requires_real_provenance(tmp_path: Path) -> None:
    report = tmp_path / "measured.json"
    report.write_text(
        json.dumps(
            {
                "evidence_kind": "measured",
                "first_audio_ms": 800,
                "audio_duration_ms": 10000,
                "generation_ms": 9000,
                "peak_memory_mb": 512,
                "download_bytes": 70254592,
                "cancelled_stale_audio": False,
                "device": "fixture",
                "browser_or_runtime": "fixture",
                "thermal": "not-measured",
                "source_commit": "1de0f10",
                "artifact_sha256": "0" * 64,
            }
        ),
        encoding="utf-8",
    )

    result = run_cli("benchmark", "--manifest", str(MANIFEST), "--pack", "english_2026-04", "--input", str(report))

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["first_failure"]["reason"] == "invalid_measurement_provenance"


def test_french_24l_is_not_labeled_compact() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    assert manifest["packs"]["french_24l"]["layers"] == 24
    assert manifest["packs"]["french_24l"]["state_slots"] == 72
    assert manifest["packs"]["french_24l"]["claims_compact"] is False
