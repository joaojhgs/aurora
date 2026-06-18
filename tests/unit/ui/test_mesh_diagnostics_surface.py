"""Fixture tests for the production mesh diagnostics surface."""

from app.shared.contracts.models.gateway import (
    CapabilityAddressInfo,
    CapabilityGraph,
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
from app.ui.sdk import (
    AuditReference,
    build_loading_mesh_diagnostics,
    build_mesh_diagnostics_surface,
    normalize_auth_peers,
    normalize_capability_graph,
    normalize_mesh_status,
)


def test_loading_and_empty_states_are_explicit_and_accessible():
    loading = build_loading_mesh_diagnostics()
    assert loading.state == "loading"
    assert loading.aria_live == "polite"
    assert loading.focus_order == ["mesh-local"]
    assert loading.sections[0].aria_label == "Mesh diagnostics loading"

    empty = build_mesh_diagnostics_surface(
        normalize_mesh_status(GetMeshStatusResponse(local=MeshLocalStatus(mesh_enabled=False)))
    )
    assert empty.state == "empty"
    assert empty.sections[0].section_id == "mesh-local"
    assert empty.sections[0].items[0]["mesh_enabled"] is False


def test_connected_degraded_stale_denied_fallback_and_hard_failure_states_render():
    connected = build_mesh_diagnostics_surface(
        normalize_mesh_status(
            GetMeshStatusResponse(
                local=_local(),
                peers=[MeshPeerDiagnostic(peer_id="peer-ok", status="connected")],
                routes=[
                    MeshRouteDiagnostic(
                        module="Tooling",
                        decision_target="remote",
                        decision_peer_id="peer-ok",
                        providers=[
                            MeshRouteProviderDiagnostic(
                                peer_id="peer-ok",
                                eligible=True,
                                reason_code="eligible",
                            )
                        ],
                    )
                ],
            )
        )
    )
    assert connected.state == "connected"

    degraded = build_mesh_diagnostics_surface(
        normalize_mesh_status(
            GetMeshStatusResponse(
                local=_local(),
                routes=[
                    MeshRouteDiagnostic(
                        module="DB",
                        decision_target="none",
                        reason="no eligible provider",
                    )
                ],
            )
        )
    )
    assert degraded.state == "degraded"

    stale = build_mesh_diagnostics_surface(
        normalize_mesh_status(
            GetMeshStatusResponse(
                local=_local(),
                peers=[MeshPeerDiagnostic(peer_id="peer-stale", status="stale")],
            )
        )
    )
    assert stale.state == "stale"

    denied = build_mesh_diagnostics_surface(
        normalize_mesh_status(GetMeshStatusResponse(local=_local())),
        auth_peers=normalize_auth_peers(
            MeshPeerListResponse(
                peers=[
                    MeshPeerInfo(
                        id="row-1",
                        peer_id="peer-denied",
                        outbound_status="denied",
                        inbound_status="approved",
                    )
                ],
                total=1,
            )
        ),
    )
    assert denied.state == "denied"

    fallback = build_mesh_diagnostics_surface(
        normalize_mesh_status(
            GetMeshStatusResponse(
                local=_local(),
                routes=[
                    MeshRouteDiagnostic(
                        module="TTS",
                        prefer="network",
                        fallback="local",
                        decision_target="local",
                    )
                ],
            )
        )
    )
    assert fallback.state == "fallback"

    hard_failure = build_mesh_diagnostics_surface(
        normalize_mesh_status(
            GetMeshStatusResponse(
                local=_local(),
                routes=[MeshRouteDiagnostic(module="TTS", decision_target="error")],
            )
        )
    )
    assert hard_failure.state == "hard-failure"


def test_provider_status_distinguishes_candidates_eligible_denied_stale_capacity_and_privacy():
    mesh = normalize_mesh_status(
        GetMeshStatusResponse(
            local=_local(),
            routes=[
                MeshRouteDiagnostic(
                    module="Tooling",
                    decision_target="remote",
                    decision_peer_id="peer-ok",
                    providers=[
                        MeshRouteProviderDiagnostic(
                            peer_id="peer-ok",
                            eligible=True,
                            reason_code="eligible",
                        ),
                        MeshRouteProviderDiagnostic(
                            peer_id="peer-denied",
                            eligible=False,
                            reason_code="permission_denied",
                        ),
                        MeshRouteProviderDiagnostic(
                            peer_id="peer-stale",
                            eligible=False,
                            reason_code="stale",
                        ),
                        MeshRouteProviderDiagnostic(
                            peer_id="peer-busy",
                            eligible=False,
                            reason_code="at_capacity",
                        ),
                    ],
                ),
                MeshRouteDiagnostic(
                    module="WakeWord",
                    decision_target="none",
                    providers=[
                        MeshRouteProviderDiagnostic(
                            peer_id="peer-audio",
                            eligible=False,
                            reason_code="privacy_blocked",
                        )
                    ],
                ),
            ],
        )
    )
    graph = normalize_capability_graph(
        CapabilityGraph(
            local_peer_id="local-peer",
            services=[
                _service("remote:peer-ok:Tooling", "peer-ok", "Tooling", routable=True),
                _service(
                    "remote:peer-audio:WakeWord",
                    "peer-audio",
                    "WakeWord",
                    policy=CapabilityPolicyInfo(consent_required=True),
                    routable=True,
                ),
            ],
            provider_index={"Tooling": ["remote:peer-ok:Tooling"]},
            candidate_provider_index={
                "Tooling": ["remote:peer-ok:Tooling", "remote:peer-stale:Tooling"]
            },
        )
    )

    surface = build_mesh_diagnostics_surface(mesh, graph)
    by_module = {status.module: status for status in surface.provider_status}

    assert by_module["Tooling"].candidate_count == 4
    assert by_module["Tooling"].eligible_count == 1
    assert by_module["Tooling"].denied_count == 1
    assert by_module["Tooling"].stale_count == 1
    assert by_module["Tooling"].capacity_limited_count == 1
    assert by_module["WakeWord"].privacy_blocked_count == 1
    provider_section = next(
        section for section in surface.sections if section.section_id == "mesh-providers"
    )
    assert provider_section.aria_label == "Provider candidates and eligible providers"
    assert "mesh-providers" in surface.focus_order


def test_redacted_diagnostics_and_audit_references_never_render_sensitive_values():
    mesh = normalize_mesh_status(
        GetMeshStatusResponse(
            local=_local(),
            compatibility_failures=[
                {
                    "peer_id": "peer-1",
                    "module": "Tooling",
                    "direction": "local",
                    "reason": "token mismatch",
                }
            ],
            secrets_redacted=True,
        )
    )
    audit = AuditReference(
        correlation_id="corr-1",
        event_kind="tool.execute",
        peer_id="peer-1",
        details_redacted={"token": "super-secret-token", "safe": "visible"},
    )

    surface = build_mesh_diagnostics_surface(mesh, audit_references=[audit])

    rendered = str(surface.model_dump())
    assert "super-secret-token" not in rendered
    assert "<redacted>" in rendered
    assert "corr-1" in rendered
    assert surface.secrets_redacted is True


def _local() -> MeshLocalStatus:
    return MeshLocalStatus(
        mesh_enabled=True,
        mesh_started=True,
        webrtc_started=True,
        peer_id="local-peer",
        node_name="desktop",
    )


def _service(
    service_instance_id: str,
    peer_id: str,
    module: str,
    policy: CapabilityPolicyInfo | None = None,
    routable: bool = False,
) -> CapabilityServiceInfo:
    return CapabilityServiceInfo(
        service_instance_id=service_instance_id,
        peer_id=peer_id,
        provider_kind="remote",
        module=module,
        routable=routable,
        policy=policy or CapabilityPolicyInfo(),
        address=CapabilityAddressInfo(
            peer_id=peer_id,
            module=module,
            service_instance_id=service_instance_id,
        ),
        provenance=CapabilityProvenanceInfo(source="fixture", peer_id=peer_id),
    )
