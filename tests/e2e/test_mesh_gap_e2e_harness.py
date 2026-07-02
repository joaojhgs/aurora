"""E2E tests for the mesh transport harness."""

import json

import pytest

from scripts.mesh_gap_e2e_harness import (
    MODES,
    SCENARIOS,
    ScenarioResult,
    _summary,
    run_harness,
)


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
    assert report.summary["status"] in {"pass", "blocked"}
    assert report.summary["required_scenarios_passed"] is True
    assert report.summary["final_mesh_mode_included"] is True
    assert report.summary["final_mesh_mode_status"] == "pass"
    assert report.summary["preflight_not_counted_as_final_proof"] is True

    process_results = [
        result for result in report.results if result["mode_id"] == "process_bullmq_redis"
    ]
    if report.summary["dependency_gap"]:
        assert report.summary["status"] == "blocked"
        assert report.summary["dependency_gap"] == len(SCENARIOS)
        assert report.summary["dependency_gap_modes"] == ["process_bullmq_redis"]
        assert all(result["status"] == "dependency_gap" for result in process_results)
        assert all(result["evidence"]["live_attempted"] is True for result in process_results)
    else:
        assert report.summary["status"] == "pass"
        assert report.summary["dependency_gap_modes"] == []
        assert all(result["status"] == "pass" for result in process_results)
        assert all(
            result["evidence"]["transport_path"]
            == "BullMQBus.request->Redis->BullMQBus.worker->BullMQBus.reply"
            for result in process_results
        )

    assert all(
        result["status"] == "pass"
        for result in report.results
        if result["mode_id"]
        in {"thread_localbus", "http_gateway_thin_client", "tauri_local_native", "mesh_webrtc"}
    )

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
    by_scenario = {(result["mode_id"], result["scenario_id"]): result for result in report.results}

    remote_approval = by_scenario[("mesh_webrtc", "dangerous_remote_approval_token")]["evidence"]
    assert remote_approval["missing_token_error"] == "approval_token_required"
    assert remote_approval["replay_error"] == "approval_token_replayed"
    assert remote_approval["mismatch_error"] == "approval_token_args_hash_mismatch"
    assert remote_approval["rpc_handler_invoked"] is True
    assert remote_approval["transport_path"] == (
        "RTCPeerConnection.DataChannel->RPCHandler.on_message->LocalBus.request"
    )

    rag = by_scenario[("mesh_webrtc", "rag_remote_namespace")]["evidence"]
    assert rag["missing_namespace_error"] == "namespace_selector_required"
    assert rag["provenance"]["source_peer_id"] == "provider-peer"

    audio = by_scenario[("mesh_webrtc", "streaming_audio_consent")]["evidence"]
    assert audio["missing_consent_error"] == "consent_token_required"
    assert audio["approved_session_status"] == "active"

    admin = by_scenario[("mesh_webrtc", "auth_config_denied")]["evidence"]
    assert admin["auth_config_mutation_error"] == "mesh_rpc_denied"

    safe_remote = by_scenario[("mesh_webrtc", "safe_remote_tool")]["evidence"]
    assert safe_remote["rpc_handler_invoked"] is True
    assert safe_remote["provider_peer_id"] == "provider-peer"
    assert safe_remote["route_decision_id"]


@pytest.mark.e2e
def test_mesh_gap_harness_uses_executable_component_paths(tmp_path):
    report = run_harness(output_dir=tmp_path, mode_filter={"mesh_webrtc"})
    by_scenario = {result["scenario_id"]: result for result in report.results}

    assert report.summary["status"] == "pass"
    assert report.summary["component_modes"] == ["mesh_webrtc"]
    assert by_scenario["safe_remote_tool"]["evidence"]["transport_path"] == (
        "RTCPeerConnection.DataChannel->RPCHandler.on_message->LocalBus.request"
    )
    assert by_scenario["pair_peers"]["evidence"]["rpc_handler_invoked"] is True

    http_report = run_harness(
        output_dir=tmp_path / "http",
        mode_filter={"http_gateway_thin_client"},
    )
    assert http_report.summary["status"] == "pass"
    assert http_report.summary["passed"] == len(SCENARIOS)
    assert all(result["status"] == "pass" for result in http_report.results)

    process_report = run_harness(
        output_dir=tmp_path / "process",
        mode_filter={"process_bullmq_redis"},
    )
    if process_report.summary["dependency_gap"]:
        assert process_report.summary["status"] == "blocked"
        assert process_report.summary["dependency_gap"] == len(SCENARIOS)
        assert all(result["status"] == "dependency_gap" for result in process_report.results)
        assert all(
            result["evidence"]["live_attempted"] is True for result in process_report.results
        )
    else:
        assert process_report.summary["status"] == "pass"
        assert process_report.summary["passed"] == len(SCENARIOS)
        assert all(result["status"] == "pass" for result in process_report.results)
        assert process_report.results[0]["evidence"]["transport_path"] == (
            "BullMQBus.request->Redis->BullMQBus.worker->BullMQBus.reply"
        )

    process_mode = next(mode for mode in MODES if mode.mode_id == "process_bullmq_redis")
    synthetic_process_results = [
        ScenarioResult(
            scenario_id=scenario.scenario_id,
            mode_id="process_bullmq_redis",
            status="pass",
            assertion=scenario.assertion,
            evidence={
                "transport_path": "BullMQBus.request->Redis->BullMQBus.worker->BullMQBus.reply"
            },
            correlation_id=f"process_bullmq_redis-{scenario.scenario_id}",
        )
        for scenario in SCENARIOS
    ]
    synthetic_summary = _summary(synthetic_process_results, [process_mode])
    assert synthetic_summary["status"] == "pass"
    assert synthetic_summary["dependency_gap"] == 0
    assert synthetic_summary["passed"] == len(SCENARIOS)


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
