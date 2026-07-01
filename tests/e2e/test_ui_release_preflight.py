"""PER-275 non-signing UI/Tauri/operator preflight tests."""

import json
from pathlib import Path

import pytest

from scripts.ui_release_preflight import (
    COMMAND_CHECKS,
    PreflightDefinition,
    PreflightRow,
    _redact,
    run_preflight,
)


@pytest.mark.e2e
def test_ui_release_preflight_writes_report_markdown_and_redaction_probe(tmp_path):
    report = run_preflight(output_dir=tmp_path)

    report_json = tmp_path / "ui_release_preflight.json"
    report_md = tmp_path / "ui_release_preflight.md"
    redaction_probe = tmp_path / "redaction_probe.json"

    assert report_json.exists()
    assert report_md.exists()
    assert redaction_probe.exists()
    assert report.non_signing_scope is True
    assert report.final_release_ready is False

    persisted = json.loads(report_json.read_text(encoding="utf-8"))
    row_ids = {row["row_id"] for row in persisted["rows"]}
    assert {"sdk-build", "ui-package-build", "tauri-ui-build"}.issubset(row_ids)
    assert {"sidecar-source", "redis-port", "support-bundle-redaction"}.issubset(row_ids)
    assert persisted["summary"]["non_signing_scope"] is True
    assert persisted["summary"]["final_release_ready"] is False
    assert persisted["secrets_redacted"] is True


@pytest.mark.e2e
def test_ui_release_preflight_records_commands_as_skipped_without_execution(tmp_path):
    report = run_preflight(output_dir=tmp_path)
    rows = {row["row_id"]: row for row in report.rows}

    for check in COMMAND_CHECKS:
        assert rows[check.row_id]["status"] == "skipped"
        assert rows[check.row_id]["command"] == list(check.command)
        assert "not executed" in rows[check.row_id]["rationale"] or rows[check.row_id]["rationale"]


@pytest.mark.e2e
def test_ui_release_preflight_maps_command_runner_results(tmp_path):
    def runner(check: PreflightDefinition, output_dir: Path) -> PreflightRow:
        log_path = output_dir / f"{check.row_id}.log"
        log_path.write_text("token=<redacted>\n", encoding="utf-8")
        return PreflightRow(
            row_id=check.row_id,
            category=check.category,
            label=check.label,
            mode=check.mode,
            owner=check.owner,
            status="pass" if check.row_id == "sdk-build" else "fail",
            required=check.required,
            remediation=check.remediation,
            command=list(check.command),
            artifact_path=str(log_path),
            returncode=0 if check.row_id == "sdk-build" else 1,
        )

    report = run_preflight(output_dir=tmp_path, execute_commands=True, command_runner=runner)
    rows = {row["row_id"]: row for row in report.rows}

    assert rows["sdk-build"]["status"] == "pass"
    assert rows["ui-package-build"]["status"] == "fail"
    assert "ui-package-build" in report.summary["required_failures"]
    assert report.summary["status"] == "fail"


@pytest.mark.e2e
def test_ui_release_preflight_redacts_support_bundle_and_log_like_values(tmp_path):
    report = run_preflight(output_dir=tmp_path)
    probe = report.support_bundle_redaction_probe
    serialized = json.dumps(probe, sort_keys=True)

    assert probe["secrets_redacted"] is True
    assert probe["leak_count"] == 0
    for forbidden in (
        "secret-token-123",
        "abc.def.ghi",
        "redis://:password@localhost:6379/0",
        "/home/developer",
        "peer-secret-value",
        "model.gguf",
        "/tmp/aurora",
        "sk-test-value",
        "hunter2",
    ):
        assert forbidden not in serialized

    redacted = _redact(
        {
            "message": (
                "Bearer abc.def token=raw redis://:pw@localhost:6379/0 "
                "/home/developer/private/model.gguf /tmp/aurora/file.txt"
            ),
            "safe": "degraded",
        }
    )
    redacted_dump = json.dumps(redacted, sort_keys=True)
    assert "Bearer abc.def" not in redacted_dump
    assert "redis://:pw@localhost:6379/0" not in redacted_dump
    assert "/home/developer" not in redacted_dump
    assert "/tmp/aurora" not in redacted_dump
    assert "degraded" in redacted_dump


@pytest.mark.e2e
def test_ui_release_preflight_markdown_names_degraded_rows_and_no_final_release_claim(tmp_path):
    report = run_preflight(output_dir=tmp_path)
    markdown = (tmp_path / "ui_release_preflight.md").read_text(encoding="utf-8")

    assert "non-signing operator preflight" in markdown
    assert "Final release ready: `false`" in markdown
    assert report.summary["degraded_or_skipped_rows"]
    assert "signing" in markdown.lower()
