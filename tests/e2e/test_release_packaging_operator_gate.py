"""PER-227 release packaging and operator runbook gate tests."""

import json

import pytest

from scripts.release_packaging_operator_gate import (
    NEGATIVE_GATES,
    PLATFORM_ROWS,
    RUNBOOK_SECTIONS,
    build_report,
)


@pytest.mark.e2e
def test_release_packaging_gate_records_platforms_commands_and_artifacts(tmp_path):
    build_report(tmp_path)

    gate_json = tmp_path / "release_packaging_gate.json"
    gate_md = tmp_path / "release_packaging_gate.md"
    runbook = tmp_path / "runbook.md"

    assert gate_json.exists()
    assert gate_md.exists()
    assert runbook.exists()

    persisted = json.loads(gate_json.read_text(encoding="utf-8"))
    expected_platforms = {row.row_id for row in PLATFORM_ROWS}
    expected_commands = {
        command.command_id for row in PLATFORM_ROWS for command in row.commands
    }
    assert {row["row_id"] for row in persisted["platform_rows"]} == expected_platforms
    assert set(persisted["summary"]["required_commands"]) == expected_commands
    assert persisted["summary"]["platform_count"] == len(PLATFORM_ROWS)
    assert persisted["summary"]["mock_transport_release_evidence_allowed"] is False
    assert persisted["summary"]["production_complete"] is False
    assert persisted["secrets_redacted"] is True


@pytest.mark.e2e
def test_release_packaging_gate_documents_skips_owners_and_manual_device_lab(tmp_path):
    report = build_report(tmp_path)
    manual_items = set(report.summary["manual_device_lab_items"])
    accepted_skips = report.summary["accepted_skips"]
    owners = {
        command["owner"]
        for row in report.platform_rows
        for command in row["commands"]
    }

    assert {"android-signed-release", "ios-app-store-dry-run"}.issubset(manual_items)
    assert "Emulator-only CI cannot prove production assistant-role behavior." in accepted_skips[
        "android-signed-release"
    ]
    assert "Simulator-only CI cannot prove real-device/TestFlight behavior." in accepted_skips[
        "ios-app-store-dry-run"
    ]
    assert {"release-ops", "tauri-native", "android-native", "ios-native"}.issubset(owners)


@pytest.mark.e2e
def test_release_packaging_gate_requires_security_privacy_negative_cases(tmp_path):
    report = build_report(tmp_path)
    gates = {gate["gate_id"]: gate for gate in report.negative_gates}

    assert set(gates) == {gate.gate_id for gate in NEGATIVE_GATES}
    assert gates["security-privacy-negative-suite"]["category"] == "security_privacy"
    assert gates["mock-transport-not-release-proof"]["category"] == "release_safety"
    assert gates["emulator-only-mobile-not-production-complete"]["category"] == "release_safety"
    assert gates["diagnostics-redaction-required"]["category"] == "credential"
    assert "QA-003" in gates["security-privacy-negative-suite"]["source_task_ids"]


@pytest.mark.e2e
def test_release_operator_runbook_has_required_operations_and_no_secret_leaks(tmp_path):
    report = build_report(tmp_path)
    section_ids = {section["section_id"] for section in report.runbook_sections}

    assert section_ids == {section.section_id for section in RUNBOOK_SECTIONS}
    assert {"install", "update", "backup", "diagnostics", "rollback"}.issubset(section_ids)

    serialized = json.dumps(report.__dict__, default=str)
    for forbidden in (
        "secret-token",
        "redis://localhost:6379",
        "/home/developer",
        "mock transport is production",
    ):
        assert forbidden not in serialized

    runbook = (tmp_path / "runbook.md").read_text(encoding="utf-8")
    assert "Install" in runbook
    assert "Update" in runbook
    assert "Backup" in runbook
    assert "Diagnostics" in runbook
    assert "Rollback" in runbook
    assert "Mock transport artifacts are fixture evidence only" in runbook


@pytest.mark.e2e
def test_release_readiness_checklist_crosslinks_qa_task_ids(tmp_path):
    report = build_report(tmp_path)
    checklist = {item["task_id"]: item for item in report.final_readiness_checklist}

    required = {"QA-001", "QA-002", "QA-003", "QA-004", "QA-005", "QA-006", "QA-007"}
    assert required.issubset(checklist)
    assert checklist["QA-006"]["status"] == "covered"
    assert checklist["DEVICE-LAB"]["status"] == "blocked"
