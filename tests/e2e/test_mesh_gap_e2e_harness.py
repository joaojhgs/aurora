"""E2E gate for the PER-163 mesh production harness."""

import json

import pytest

from scripts.mesh_gap_e2e_harness import MODES, SCENARIOS, run_harness


@pytest.mark.e2e
def test_mesh_gap_harness_covers_required_modes_scenarios_and_artifacts(tmp_path):
    report = run_harness(output_dir=tmp_path)

    required_modes = {
        "thread_localbus",
        "process_bullmq_redis",
        "http_gateway_thin_client",
        "tauri_local_native",
        "mesh_webrtc",
    }
    required_scenarios = {
        "pair_peers",
        "selected_tool_sharing",
        "catalog_local_remote_blocked",
        "safe_local_tool",
        "safe_remote_tool",
        "dangerous_local_approval",
        "dangerous_remote_approval_token",
        "rag_remote_namespace",
        "batch_audio",
        "streaming_audio_consent",
        "scheduler_remote_namespace",
        "auth_config_denied",
        "route_explain",
        "unified_event_stream",
        "support_bundle",
    }

    assert {mode["mode_id"] for mode in report.modes} == required_modes
    assert {scenario["scenario_id"] for scenario in report.scenarios} == required_scenarios
    assert len(report.results) == len(MODES) * len(SCENARIOS)
    assert report.summary["status"] == "pass"
    assert report.summary["required_scenarios_passed"] is True
    assert report.summary["final_mesh_mode_included"] is True
    assert all(result["status"] == "pass" for result in report.results)

    report_path = tmp_path / "report.json"
    events_path = tmp_path / "events.ndjson"
    support_bundle_path = tmp_path / "support_bundle.json"
    assert report_path.exists()
    assert events_path.exists()
    assert support_bundle_path.exists()

    persisted = json.loads(report_path.read_text(encoding="utf-8"))
    assert persisted["summary"] == report.summary


@pytest.mark.e2e
def test_mesh_gap_harness_records_security_privacy_negative_cases(tmp_path):
    report = run_harness(output_dir=tmp_path)
    by_scenario = {
        (result["mode_id"], result["scenario_id"]): result for result in report.results
    }

    remote_approval = by_scenario[
        ("mesh_webrtc", "dangerous_remote_approval_token")
    ]["evidence"]
    assert remote_approval["missing_token_error"] == "approval_token_required"
    assert remote_approval["replay_error"] == "approval_token_replayed"
    assert remote_approval["mismatch_error"] == "approval_token_args_hash_mismatch"
    assert remote_approval["mock_transport"] is False

    rag = by_scenario[("mesh_webrtc", "rag_remote_namespace")]["evidence"]
    assert rag["missing_namespace_error"] == "namespace_selector_required"
    assert rag["provenance"]["source_peer_id"] == "provider-peer"

    audio = by_scenario[("mesh_webrtc", "streaming_audio_consent")]["evidence"]
    assert audio["missing_consent_error"] == "consent_token_required"
    assert audio["approved_session_status"] == "active"

    admin = by_scenario[("mesh_webrtc", "auth_config_denied")]["evidence"]
    assert admin["auth_config_mutation_error"] == "mesh_rpc_denied"


@pytest.mark.e2e
def test_mesh_gap_artifacts_are_redacted_and_correlation_ready(tmp_path):
    report = run_harness(output_dir=tmp_path)
    events = [
        json.loads(line)
        for line in (tmp_path / "events.ndjson").read_text(encoding="utf-8").splitlines()
    ]
    support_bundle = json.loads((tmp_path / "support_bundle.json").read_text(encoding="utf-8"))
    serialized = json.dumps(
        {
            "report": json.loads((tmp_path / "report.json").read_text(encoding="utf-8")),
            "events": events,
            "support_bundle": support_bundle,
        }
    )

    assert "secret-token" not in serialized
    assert "redis://localhost:6379" not in serialized
    assert "/home/" not in serialized
    assert report.secrets_redacted is True
    assert support_bundle["secrets_redacted"] is True
    assert len(support_bundle["correlation_ids"]) == report.summary["result_count"]
    assert all(event["payload_sha256"] for event in events)

    categories = {event["category"] for event in events}
    assert {
        "capability",
        "tool_approval",
        "route",
        "audit",
        "audio",
        "data",
        "scheduler",
        "admin_action",
        "tool_execution",
    }.issubset(categories)
