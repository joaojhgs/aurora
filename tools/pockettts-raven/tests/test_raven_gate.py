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
    assert payload["status"] == "pass"
    assert payload["required_packs"] == ["english_2026-04", "french_24l", "portuguese"]


def test_conversion_dry_run_reports_missing_assets_without_claiming_reproduction() -> None:
    result = run_cli("conversion", "--manifest", str(MANIFEST), "--pack", "english_2026-04", "--dry-run")

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["first_failure"]["reason"] == "missing"
    assert "conversion not reproduced" in payload["claim"]


def test_benchmark_report_derives_rtf_and_cancellation_status() -> None:
    result = run_cli("benchmark", "--manifest", str(MANIFEST), "--pack", "english_2026-04", "--input", str(BENCH))

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "pass"
    assert payload["rtf"] == 0.9
    assert payload["metrics"]["cancelled_stale_audio"] is False


def test_french_24l_is_not_labeled_compact() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    assert manifest["packs"]["french_24l"]["layers"] == 24
    assert manifest["packs"]["french_24l"]["state_slots"] == 72
    assert manifest["packs"]["french_24l"]["claims_compact"] is False
