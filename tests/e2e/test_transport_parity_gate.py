"""QA-008 transport parity release gate tests."""

import json
import subprocess
import sys

import pytest

from scripts.mesh_gap_e2e_harness import HarnessReport
from scripts.transport_parity_gate import CommandResult, GateCommand, run_transport_parity_gate


@pytest.mark.e2e
def test_transport_parity_gate_script_entrypoint_imports_from_file_path():
    completed = subprocess.run(
        [sys.executable, "scripts/transport_parity_gate.py", "--help"],
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert "transport_parity_gate.py" in completed.stdout
    assert "--execute-commands" in completed.stdout


@pytest.mark.e2e
def test_transport_parity_gate_emits_required_rows_and_artifacts(tmp_path):
    report = run_transport_parity_gate(
        output_dir=tmp_path,
        command_runner=_passing_command,
        harness_runner=_fake_harness_report,
    )

    required_rows = {
        "thread_localbus",
        "process_bullmq_redis",
        "http_gateway_thin_client",
        "tauri_local_native",
        "mesh_webrtc",
        "android_thin_local_light",
        "ios_thin_local_light",
    }
    rows = {row["row_id"]: row for row in report["rows"]}

    assert set(rows) == required_rows
    assert report["summary"]["row_count"] == len(required_rows)
    assert report["summary"]["mock_only_evidence_sufficient"] is False
    assert report["summary"]["mesh_final_proof"] == "pass"
    assert report["secrets_redacted"] is True

    for row in rows.values():
        assert row["owner"]
        assert row["commands"]
        assert row["artifact_paths"]
        assert row["status"] in {"pass", "fail", "blocked", "skipped-with-rationale"}
        assert row["coverage"]
        assert row["rationale"]

    assert rows["thread_localbus"]["status"] == "pass"
    assert rows["http_gateway_thin_client"]["status"] == "pass"
    assert rows["tauri_local_native"]["status"] == "pass"
    assert rows["mesh_webrtc"]["status"] == "pass"
    assert rows["ios_thin_local_light"]["status"] == "skipped-with-rationale"
    assert rows["ios_thin_local_light"]["blocks_release"] is True

    persisted = json.loads((tmp_path / "transport_parity_report.json").read_text(encoding="utf-8"))
    assert persisted["summary"] == report["summary"]


@pytest.mark.e2e
def test_transport_parity_gate_blocks_when_required_commands_are_not_run(tmp_path):
    report = run_transport_parity_gate(output_dir=tmp_path, harness_runner=_fake_harness_report)

    assert report["summary"]["status"] == "blocked"
    assert report["release_ready"] is False
    assert {"sdk_conformance", "ui_flow_smoke", "tauri_local_smoke"}.issubset(
        set(report["summary"]["blocking_rows"])
    )

    rows = {row["row_id"]: row for row in report["rows"]}
    assert rows["http_gateway_thin_client"]["status"] == "blocked"
    assert rows["mesh_webrtc"]["status"] == "blocked"


@pytest.mark.e2e
def test_transport_parity_gate_does_not_allow_mock_only_success_to_pass(tmp_path):
    def only_sdk_passes(command: GateCommand, output_dir):
        status = "pass" if command.command_id == "sdk_conformance" else "not_run"
        artifact = output_dir / f"{command.command_id}.log"
        artifact.write_text("ok", encoding="utf-8")
        return CommandResult(
            command_id=command.command_id,
            owner=command.owner,
            command=list(command.command),
            status=status,
            artifact_path=str(artifact),
            returncode=0 if status == "pass" else None,
            rationale=command.rationale,
        )

    report = run_transport_parity_gate(
        output_dir=tmp_path,
        command_runner=only_sdk_passes,
        harness_runner=_fake_harness_report,
    )

    assert report["summary"]["mock_only_evidence_passed"] is True
    assert report["summary"]["mock_only_evidence_sufficient"] is False
    assert report["summary"]["status"] == "blocked"
    assert report["release_ready"] is False


@pytest.mark.e2e
def test_transport_parity_gate_redacts_sensitive_artifacts(tmp_path):
    report = run_transport_parity_gate(
        output_dir=tmp_path,
        command_runner=_passing_command,
        harness_runner=_fake_harness_report,
    )
    serialized = json.dumps(report) + (tmp_path / "transport_parity_report.json").read_text(
        encoding="utf-8"
    )

    assert "redis://localhost:6379" not in serialized
    assert "secret-token" not in serialized
    assert "/home/" not in serialized
    assert report["summary"]["secrets_redacted"] is True


def _passing_command(command: GateCommand, output_dir):
    artifact = output_dir / f"{command.command_id}.log"
    artifact.write_text("ok", encoding="utf-8")
    return CommandResult(
        command_id=command.command_id,
        owner=command.owner,
        command=list(command.command),
        status="pass",
        artifact_path=str(artifact),
        returncode=0,
        rationale=command.rationale,
    )


def _fake_harness_report(output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "report.json"
    events_path = output_dir / "events.ndjson"
    support_bundle_path = output_dir / "support_bundle.json"
    report_path.write_text("{}", encoding="utf-8")
    events_path.write_text("", encoding="utf-8")
    support_bundle_path.write_text("{}", encoding="utf-8")

    modes = [
        {
            "mode_id": "thread_localbus",
            "label": "thread mode / LocalBus",
            "bus": "LocalBus",
            "transport": "in-process SDK contract",
            "profile": "ci-dev",
            "execution": "component",
            "final_mesh_proof": False,
            "notes": [],
        },
        {
            "mode_id": "process_bullmq_redis",
            "label": "process mode / BullMQBus / Redis",
            "bus": "BullMQBus",
            "transport": "Redis-backed process request/reply",
            "profile": "ci-dev-live",
            "execution": "component",
            "final_mesh_proof": False,
            "notes": [],
        },
        {
            "mode_id": "http_gateway_thin_client",
            "label": "HTTP Gateway thin client",
            "bus": "Gateway",
            "transport": "HTTP contract",
            "profile": "ci-dev",
            "execution": "component",
            "final_mesh_proof": False,
            "notes": [],
        },
        {
            "mode_id": "tauri_local_native",
            "label": "Tauri local/native transport",
            "bus": "LocalBus",
            "transport": "Tauri command contract smoke",
            "profile": "ci-dev",
            "execution": "component",
            "final_mesh_proof": False,
            "notes": [],
        },
        {
            "mode_id": "mesh_webrtc",
            "label": "Mesh/WebRTC transport",
            "bus": "MeshBus",
            "transport": "WebRTC DataChannel JSON-RPC",
            "profile": "ci-dev",
            "execution": "component",
            "final_mesh_proof": True,
            "notes": [],
        },
    ]
    scenarios = [{"scenario_id": "required_flow", "title": "Required flow", "categories": ["audit"], "assertion": "passes"}]
    results = [
        {
            "scenario_id": "required_flow",
            "mode_id": mode["mode_id"],
            "status": "pass",
            "assertion": "passes",
            "evidence": {"transport_path": mode["transport"]},
            "correlation_id": f"{mode['mode_id']}-required_flow",
            "events": [],
        }
        for mode in modes
    ]
    summary = {
        "status": "pass",
        "passed": len(results),
        "failed": 0,
        "preflight": 0,
        "dependency_gap": 0,
        "scenario_count": 1,
        "mode_count": len(modes),
        "result_count": len(results),
        "component_modes": [mode["mode_id"] for mode in modes],
        "dependency_gap_modes": [],
        "required_scenarios_passed": True,
        "final_mesh_mode_included": True,
        "final_mesh_mode_status": "pass",
        "preflight_not_counted_as_final_proof": True,
    }
    return HarnessReport(
        harness_id="fake",
        generated_at="2026-06-27T00:00:00Z",
        consumer_peer_id="consumer-peer",
        provider_peer_id="provider-peer",
        modes=modes,
        scenarios=scenarios,
        results=results,
        summary=summary,
        artifacts={
            "report": str(report_path),
            "events": str(events_path),
            "support_bundle": str(support_bundle_path),
        },
    )
