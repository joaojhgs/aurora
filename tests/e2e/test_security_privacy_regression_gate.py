"""PER-224 security/privacy regression gate tests."""

import json

import pytest

from scripts.security_privacy_regression_gate import (
    GATE_COMMANDS,
    RUNBOOK_SECTIONS,
    SECURITY_PRIVACY_CASES,
    build_report,
)


@pytest.mark.e2e
def test_security_privacy_gate_records_required_artifacts_and_commands(tmp_path):
    report = build_report(tmp_path)

    gate_json = tmp_path / "security_privacy_gate.json"
    gate_md = tmp_path / "security_privacy_gate.md"
    runbook = tmp_path / "runbook.md"

    assert gate_json.exists()
    assert gate_md.exists()
    assert runbook.exists()

    persisted = json.loads(gate_json.read_text(encoding="utf-8"))
    assert persisted["summary"] == report.summary
    assert persisted["summary"]["case_count"] == len(SECURITY_PRIVACY_CASES)
    assert persisted["summary"]["negative_case_count"] == len(SECURITY_PRIVACY_CASES)
    assert set(persisted["summary"]["required_commands"]) == {
        command.command_id for command in GATE_COMMANDS
    }
    assert "process-mode-security-privacy" in persisted["summary"]["accepted_skips"]
    assert persisted["summary"]["mock_transport_release_evidence_allowed"] is False
    assert persisted["secrets_redacted"] is True


@pytest.mark.e2e
def test_security_privacy_gate_covers_mesh_addendum_negative_cases(tmp_path):
    report = build_report(tmp_path)
    cases = {case["case_id"]: case for case in report.cases}

    required = {
        "mesh-missing-explicit-selector",
        "mesh-stale-peer-blocked",
        "mesh-denied-peer-blocked",
        "rpc-privilege-mismatch-denied",
        "local-raw-confirmed-bypass-denied",
        "remote-raw-confirmed-bypass-denied",
        "approval-token-replay-denied",
        "approval-token-args-hash-mismatch-denied",
        "approval-token-provider-mismatch-denied",
        "approval-token-expired-denied",
        "approve-all-peer-scope-escape-denied",
        "dry-run-bypass-denied",
        "remote-rag-namespace-denied",
        "remote-audio-consent-denied",
        "scheduler-foreign-namespace-denied",
        "support-bundle-redaction-leak-denied",
    }
    assert set(cases) == required
    assert cases["local-raw-confirmed-bypass-denied"]["expected_error"] == (
        "approval_token_required"
    )
    assert cases["remote-raw-confirmed-bypass-denied"]["expected_error"] == (
        "approval_token_required"
    )
    assert cases["approval-token-replay-denied"]["expected_error"] == ("approval_token_replayed")
    assert cases["approval-token-args-hash-mismatch-denied"]["expected_error"] == (
        "approval_token_args_hash_mismatch"
    )
    assert cases["approval-token-provider-mismatch-denied"]["expected_error"] == (
        "approval_token_caller_peer_id_mismatch"
    )
    assert cases["approval-token-expired-denied"]["expected_error"] == ("approval_token_expired")
    assert cases["remote-rag-namespace-denied"]["category"] == "data"
    assert cases["remote-audio-consent-denied"]["category"] == "raw-audio"
    assert cases["scheduler-foreign-namespace-denied"]["category"] == "scheduler"
    assert cases["support-bundle-redaction-leak-denied"]["category"] == "credential"


@pytest.mark.e2e
def test_security_privacy_gate_documents_modes_owners_and_task_crosslinks(tmp_path):
    report = build_report(tmp_path)
    platforms = set(report.summary["platforms"])
    owners = set(report.summary["owners"])
    checklist = {item["task_id"]: item for item in report.final_readiness_checklist}

    assert {"thread_localbus", "process_bullmq_redis", "mesh_webrtc"}.issubset(platforms)
    assert {"qa-release", "mesh-backend", "scheduler-backend", "db-backend"}.issubset(owners)
    assert {"BE-004", "SDK-012", "ADM-008", "MESH-GAP-005", "MESH-GAP-011", "QA-003"}.issubset(
        checklist
    )
    assert checklist["MESH-GAP-011"]["status"] == "required"
    assert checklist["QA-003"]["status"] == "covered"


@pytest.mark.e2e
def test_security_privacy_runbook_has_release_operations_sections_and_no_secret_leaks(tmp_path):
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
