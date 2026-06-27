"""PER-223 multi-mode E2E matrix tests."""

import json

import pytest

from scripts.multi_mode_e2e_matrix import (
    MESH_ADDENDUM_SCENARIOS,
    NEGATIVE_CASES,
    RUNBOOK_SECTIONS,
    build_report,
)


@pytest.mark.e2e
def test_multi_mode_matrix_covers_required_modes_and_artifacts(tmp_path):
    build_report(tmp_path)
    matrix_path = tmp_path / "matrix.json"
    matrix_md_path = tmp_path / "matrix.md"
    runbook_path = tmp_path / "runbook.md"

    assert matrix_path.exists()
    assert matrix_md_path.exists()
    assert runbook_path.exists()

    persisted = json.loads(matrix_path.read_text(encoding="utf-8"))
    required_modes = {
        "server_web",
        "desktop_thin",
        "desktop_local",
        "mesh_shell",
        "android_thin",
        "ios_thin",
    }
    assert {row["mode_id"] for row in persisted["rows"]} == required_modes
    assert persisted["summary"]["row_count"] == len(required_modes)
    assert persisted["summary"]["production_complete"] is False
    assert persisted["summary"]["manual_device_lab_items"] == [
        "android-physical-assistant-role",
        "ios-physical-testflight",
    ]
    assert persisted["secrets_redacted"] is True
    assert "install" in persisted["summary"]["runbook_sections"]
    assert "rollback" in persisted["summary"]["runbook_sections"]


@pytest.mark.e2e
def test_multi_mode_matrix_records_runtime_and_mesh_addendum_coverage(tmp_path):
    report = build_report(tmp_path)
    rows = {row["mode_id"]: row for row in report.rows}

    assert {"thread_localbus", "process_bullmq_redis", "http_gateway_thin_client"}.issubset(
        set(rows["server_web"]["runtime_modes"])
    )
    assert {"mesh_webrtc", "thread_localbus", "process_bullmq_redis"}.issubset(
        set(rows["mesh_shell"]["runtime_modes"])
    )
    assert "tauri_local_native" in rows["desktop_local"]["runtime_modes"]

    required_scenarios = {
        "local-only tool",
        "remote-only tool",
        "duplicated local+remote tool with explicit provider selector",
        "dangerous local tool approval",
        "dangerous remote tool approval",
        "approve-all session",
        "expired approval",
        "denied replay",
        "remote RAG namespace search/export/import preview",
        "remote STT session consent/event streaming",
        "scheduler remote delegation",
        "route explain",
        "diagnostics/audit support bundle",
    }
    assert set(MESH_ADDENDUM_SCENARIOS) == required_scenarios
    assert report.summary["mesh_addendum_scenario_count"] == len(required_scenarios)


@pytest.mark.e2e
def test_multi_mode_matrix_requires_security_privacy_negative_cases(tmp_path):
    report = build_report(tmp_path)
    cases = {case["case_id"]: case for case in report.negative_cases}

    assert set(cases) == {case.case_id for case in NEGATIVE_CASES}
    assert cases["dangerous-remote-missing-token"]["category"] == "tool_approval"
    assert "replayed" in cases["dangerous-remote-denied-replay"]["assertion"]
    assert cases["rag-missing-namespace"]["category"] == "data"
    assert cases["audio-missing-consent"]["category"] == "raw-audio"
    assert cases["auth-config-mesh-denied"]["category"] == "admin-critical"
    assert cases["support-bundle-redaction"]["category"] == "credential"
    assert report.summary["mock_transport_release_evidence_allowed"] is False


@pytest.mark.e2e
def test_multi_mode_runbook_has_release_operations_sections(tmp_path):
    report = build_report(tmp_path)
    section_ids = {section["section_id"] for section in report.runbook_sections}

    assert section_ids == {section.section_id for section in RUNBOOK_SECTIONS}
    assert {"install", "update", "backup", "diagnostics", "rollback"}.issubset(section_ids)

    serialized = json.dumps(report.__dict__, default=str)
    forbidden = [
        "secret-token",
        "redis://localhost:6379",
        "/home/developer",
        "mock transport is production",
    ]
    for value in forbidden:
        assert value not in serialized

    runbook = (tmp_path / "runbook.md").read_text(encoding="utf-8")
    assert "Install" in runbook
    assert "Update" in runbook
    assert "Backup" in runbook
    assert "Diagnostics" in runbook
    assert "Rollback" in runbook
