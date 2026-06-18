"""Fixture tests for the UI SDK typed adapters."""

from app.shared.contracts.models.gateway import (
    CapabilityAddressInfo,
    CapabilityGraph,
    CapabilityMethodInfo,
    CapabilityPolicyInfo,
    CapabilityProvenanceInfo,
    CapabilityServiceInfo,
    GetMeshStatusResponse,
    MeshLocalStatus,
    MeshPeerDiagnostic,
    MeshRouteDiagnostic,
    MeshRouteProviderDiagnostic,
)
from app.shared.contracts.models.mesh import MeshPeerInfo, MeshPeerListResponse
from app.shared.contracts.models.scheduler import SchedulerJobInfo, SchedulerListJobsResponse
from app.shared.contracts.models.tooling import (
    ToolingExecuteToolResponse,
    ToolingGetToolsResponse,
    ToolingToolInfo,
    ToolingToolProvenance,
)
from app.ui.sdk import (
    normalize_audit_events,
    normalize_auth_peers,
    normalize_capability_graph,
    normalize_mesh_status,
    normalize_scheduler_jobs,
    normalize_tool_execution,
    normalize_tools,
    redact_sensitive,
    summarize_arguments,
)


def test_mesh_status_normalizes_route_reason_codes_and_redaction_flag():
    status = GetMeshStatusResponse(
        local=MeshLocalStatus(
            mesh_enabled=True,
            mesh_started=True,
            webrtc_started=True,
            peer_id="local-peer",
            node_name="desktop",
        ),
        peers=[
            MeshPeerDiagnostic(
                peer_id="peer-ok", node_name="lab", status="connected", latency_ms=12.0
            ),
            MeshPeerDiagnostic(
                peer_id="peer-stale",
                node_name="old",
                status="stale",
                last_manifest_age_s=500.0,
            ),
        ],
        routes=[
            MeshRouteDiagnostic(
                module="Tooling",
                prefer="network",
                fallback="local",
                decision_target="remote",
                decision_peer_id="peer-ok",
                providers=[
                    MeshRouteProviderDiagnostic(
                        peer_id="peer-ok",
                        eligible=True,
                        reason_code="eligible",
                    ),
                    MeshRouteProviderDiagnostic(
                        peer_id="peer-stale",
                        eligible=False,
                        reason_code="stale",
                        reason="manifest too old",
                    ),
                ],
            ),
            MeshRouteDiagnostic(
                module="DB",
                prefer="network_only",
                fallback="error",
                decision_target="none",
                reason="no eligible provider",
            ),
        ],
        secrets_redacted=True,
    )

    view = normalize_mesh_status(status)

    assert view.local_peer_id == "local-peer"
    assert view.secrets_redacted is True
    assert {peer.peer_id: peer.lifecycle_state for peer in view.peers}["peer-stale"] == "stale"
    tooling = next(route for route in view.routes if route.module == "Tooling")
    assert tooling.availability == "available-remote"
    assert tooling.provider_peer_id == "peer-ok"
    assert "stale" in tooling.reason_codes
    db = next(route for route in view.routes if route.module == "DB")
    assert db.availability == "no-route"


def test_auth_peer_state_preserves_bilateral_pending_denied_without_pairing_claim():
    peers = MeshPeerListResponse(
        peers=[
            MeshPeerInfo(
                id="1",
                peer_id="peer-pending",
                node_name="pending",
                outbound_status="approved",
                inbound_status="pending",
                connection_status="connected",
            ),
            MeshPeerInfo(
                id="2",
                peer_id="peer-denied",
                node_name="denied",
                outbound_status="denied",
                inbound_status="approved",
                connection_status="connected",
            ),
        ],
        total=2,
    )

    summaries = {peer.peer_id: peer for peer in normalize_auth_peers(peers)}

    assert summaries["peer-pending"].trust_state == "pending"
    assert summaries["peer-denied"].trust_state == "denied"
    assert summaries["peer-pending"].last_evidence_source == "Auth.MeshListPeers"


def test_capability_graph_covers_privacy_blocked_pending_denied_stale_and_deferred_claims():
    graph = CapabilityGraph(
        local_peer_id="local-peer",
        local_node_name="desktop",
        services=[
            _service("local:local-peer:Tooling", "local-peer", local_only=True, routable=True),
            _service("remote:peer-ok:Tooling", "peer-ok", routable=True),
            _service("remote:peer-stale:TTS", "peer-stale", module="TTS", route_blockers=["stale"]),
            _service(
                "remote:peer-denied:DB",
                "peer-denied",
                module="DB",
                route_blockers=["permission_denied"],
            ),
            _service(
                "remote:peer-audio:WakeWord",
                "peer-audio",
                module="WakeWord",
                policy=CapabilityPolicyInfo(consent_required=True, privacy_indicator_required=True),
                routable=True,
            ),
            _service(
                "remote:peer-tool:Tooling",
                "peer-tool",
                policy=CapabilityPolicyInfo(
                    explicit_selector_required=True, confirmation_required=True
                ),
                routable=True,
            ),
        ],
        provider_index={"Tooling": ["local:local-peer:Tooling", "remote:peer-ok:Tooling"]},
        candidate_provider_index={
            "Tooling": [
                "local:local-peer:Tooling",
                "remote:peer-ok:Tooling",
                "remote:peer-tool:Tooling",
            ]
        },
        secrets_redacted=True,
    )

    view = normalize_capability_graph(graph)
    by_id = {cap.capability_id: cap for cap in view.capabilities if cap.kind == "service"}

    assert by_id["local:local-peer:Tooling"].availability == "available-local"
    assert by_id["remote:peer-ok:Tooling"].availability == "available-remote"
    assert by_id["remote:peer-stale:TTS"].availability == "stale"
    assert by_id["remote:peer-denied:DB"].availability == "denied"
    assert by_id["remote:peer-audio:WakeWord"].availability == "privacy-blocked"
    assert by_id["remote:peer-tool:Tooling"].availability == "pending"
    assert "confirmation_required" in by_id["remote:peer-tool:Tooling"].blockers
    assert any(
        claim.claim == "raw_sql_across_peers" and claim.status == "blocked"
        for claim in view.deferred_claims
    )
    assert any(
        claim.claim == "remote_microphone_live_listening" and claim.status == "privacy-blocked"
        for claim in view.deferred_claims
    )


def test_tooling_discovery_execution_and_argument_redaction():
    response = ToolingGetToolsResponse(
        tools=[
            ToolingToolInfo(
                name="raspi_lamp_on",
                local_name="lamp_on",
                global_tool_id="raspi:tool:lamp_on",
                provider_peer_id="raspi",
                provider_service_instance_id="remote:raspi:Tooling",
                namespace="raspi",
                display_name="raspi.lamp_on",
                source_type="mesh_peer",
                execution_location="remote",
                safety_class="dangerous",
                required_permissions=["Tooling.ExecuteTool"],
                confirmation_required=True,
                provenance=ToolingToolProvenance(
                    provider_peer_id="raspi",
                    provider_service_instance_id="remote:raspi:Tooling",
                    provider_kind="mesh_peer",
                    source="core",
                    advertised_name="lamp_on",
                ),
            )
        ],
        count=1,
    )

    tool = normalize_tools(response)[0]
    assert tool.availability == "pending"
    assert tool.preflight is not None
    assert tool.preflight.target_selector.peer_id == "raspi"
    assert "confirmation_required" in tool.preflight.required_fields

    execution = normalize_tool_execution(
        ToolingExecuteToolResponse(
            ok=False,
            status="denied",
            error_code="permission_denied",
            correlation_id="corr-1",
            provider_peer_id="raspi",
            global_tool_id="raspi:tool:lamp_on",
        )
    )
    assert execution.availability == "denied"
    assert execution.audit.correlation_id == "corr-1"
    assert summarize_arguments({"target": "lamp", "token": "secret"}) == {
        "argument_keys": ["target", "token"],
        "redacted_arguments": {"target": "<redacted>", "token": "<redacted>"},
    }


def test_scheduler_ownership_and_audit_references_are_normalized():
    jobs = SchedulerListJobsResponse(
        jobs=[
            SchedulerJobInfo(
                job_id="job-1",
                name="remote cleanup",
                schedule="0 * * * *",
                action="Tooling.ExecuteTool",
                enabled=True,
                namespace="lab",
                owner_peer_id="desktop",
                owner_principal_id="admin",
                target_peer_id="raspi",
                target_resource_namespace="bench",
                delegated_permissions=["Tooling.ExecuteTool"],
                policy_decision_id="policy-1",
                correlation_id="corr-scheduler",
            )
        ],
        total=1,
    )

    job = normalize_scheduler_jobs(jobs)[0]

    assert job.availability == "available-remote"
    assert job.target_selector.peer_id == "raspi"
    assert job.target_selector.resource_namespace == "bench"
    assert job.audit.correlation_id == "corr-scheduler"


def test_audit_and_redaction_never_surface_secret_or_raw_argument_values():
    references = normalize_audit_events(
        [
            {
                "event": "tool.execute",
                "details": (
                    '{"correlation_id":"corr-2","peer_id":"raspi",'
                    '"arguments":{"target":"lamp"},"token":"abc","api_key":"key"}'
                ),
            }
        ]
    )

    details = references[0].details_redacted
    assert references[0].correlation_id == "corr-2"
    assert details["token"] == "<redacted>"
    assert details["api_key"] == "<redacted>"
    assert details["arguments"] == "<redacted>"
    assert "lamp" not in str(details)
    assert redact_sensitive({"password": "pw", "safe": "value"}) == {
        "password": "<redacted>",
        "safe": "value",
    }


def _service(
    service_instance_id: str,
    peer_id: str,
    module: str = "Tooling",
    policy: CapabilityPolicyInfo | None = None,
    route_blockers: list[str] | None = None,
    routable: bool = False,
    local_only: bool = False,
) -> CapabilityServiceInfo:
    policy = policy or CapabilityPolicyInfo(local_only=local_only)
    return CapabilityServiceInfo(
        service_instance_id=service_instance_id,
        peer_id=peer_id,
        provider_kind="local" if peer_id == "local-peer" else "remote",
        module=module,
        routable=routable,
        route_blockers=route_blockers or [],
        policy=policy,
        address=CapabilityAddressInfo(
            peer_id=peer_id,
            module=module,
            service_instance_id=service_instance_id,
        ),
        provenance=CapabilityProvenanceInfo(source="fixture", peer_id=peer_id),
        methods=[
            CapabilityMethodInfo(
                method_id=f"{module}.Run",
                module=module,
                name="Run",
                policy=policy,
                address=CapabilityAddressInfo(
                    peer_id=peer_id,
                    module=module,
                    service_instance_id=service_instance_id,
                    method="Run",
                ),
                provenance=CapabilityProvenanceInfo(source="fixture", peer_id=peer_id),
            )
        ],
    )
