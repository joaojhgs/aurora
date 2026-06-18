"""Unit tests for Gateway capability catalog and route explain contracts."""

import pytest

from app.services.gateway.config import MeshConfig, MeshServiceConfig
from app.services.gateway.mesh.capability_catalog import build_capability_catalog, explain_route
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.services.gateway.service import GatewayService
from app.shared.contracts.models.gateway import (
    CapabilityCatalogRequest,
    GatewayMethods,
    MethodInfo,
    RouteExplainRequest,
    ServiceAnnouncement,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.registry import clear_registry, list_modules


def _method(
    module: str,
    name: str = "Execute",
    method_type: str = "use",
    input_schema: dict | None = None,
) -> MethodInfo:
    return MethodInfo(
        name=name,
        summary=f"{module} {name}",
        bus_topic=f"{module}.{name}",
        exposure="external",
        method_type=method_type,
        required_perms=[f"{module}.{name}"],
        input_model=f"{name}Request",
        output_model=f"{name}Response",
        input_schema=input_schema,
        output_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
    )


def _remote_service(module: str, version: str, max_concurrent: int = 4) -> PeerServiceInfo:
    return PeerServiceInfo(
        module=module,
        version=version,
        capabilities=["tools", "basic"],
        methods=[_method(module)],
        max_concurrent=max_concurrent,
        digest=f"digest-{module}-{version}",
    )


@pytest.mark.asyncio
async def test_catalog_exposes_multiple_providers_bindability_and_redacted_schemas():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={
            "Tooling": MeshServiceConfig(
                share=True,
                prefer="network",
                allowed_peers=["peer-a", "peer-b"],
                required_capabilities=["tools"],
            ),
        },
    )
    registry = PeerRegistry(mesh_config)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        PeerManifest(
            peer_id="peer-a",
            node_name="alpha",
            timestamp="2026-06-18T19:00:00Z",
            shared_services=[_remote_service("Tooling", "1.0.0")],
        ),
    )
    await registry.update_latency("peer-a", 10.0)

    await registry.register_peer("peer-b", "beta")
    await registry.update_manifest(
        "peer-b",
        PeerManifest(
            peer_id="peer-b",
            node_name="beta",
            timestamp="2026-06-18T19:01:00Z",
            shared_services=[_remote_service("Tooling", "2.0.0", max_concurrent=1)],
        ),
    )
    await registry.increment_active_calls("peer-b")

    await registry.register_peer("peer-c", "gamma")
    await registry.update_manifest(
        "peer-c",
        PeerManifest(
            peer_id="peer-c",
            node_name="gamma",
            timestamp="2026-06-18T19:02:00Z",
            shared_services=[_remote_service("Tooling", "3.0.0")],
        ),
    )

    local_services = {
        "Tooling": ServiceAnnouncement(
            module="Tooling",
            version="9.0.0",
            methods=[
                _method(
                    "Tooling",
                    input_schema={
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "api_token": {"type": "string", "default": "secret-token"},
                            "file_path": {"type": "string", "default": "/home/user/private"},
                        },
                    },
                )
            ],
        )
    }

    catalog = build_capability_catalog(
        request=CapabilityCatalogRequest(modules=["Tooling"]),
        mesh_config=mesh_config,
        local_services=local_services,
        peers=registry.get_all_peers(),
        local_peer_id="local-peer",
    )

    assert catalog.secrets_redacted is True
    assert catalog.provider_index["Tooling"] == [
        "local:local-peer:Tooling",
        "remote:peer-a:Tooling",
        "remote:peer-b:Tooling",
        "remote:peer-c:Tooling",
    ]

    peer_a_action = next(action for action in catalog.actions if action.peer_id == "peer-a")
    assert peer_a_action.selector.peer_id == "peer-a"
    assert peer_a_action.service_instance_id == "remote:peer-a:Tooling"
    assert peer_a_action.bindability == "approval-required"
    assert peer_a_action.policy.safety_class == "delegated_action"
    assert peer_a_action.policy.required_permissions == ["Tooling.Execute"]
    assert peer_a_action.freshness.registry_digest == "digest-Tooling-1.0.0"

    peer_c_provider = next(
        provider for provider in catalog.providers if provider.peer_id == "peer-c"
    )
    assert peer_c_provider.eligible is False
    assert peer_c_provider.reason_code == "peer_not_allowed"

    local_action = next(action for action in catalog.actions if action.peer_id == "local-peer")
    assert local_action.input_schema["properties"]["query"]["type"] == "string"
    assert local_action.input_schema["properties"]["api_token"]["description"] == "redacted"
    assert local_action.input_schema["properties"]["file_path"]["description"] == "redacted"
    dumped = catalog.model_dump_json()
    assert "secret-token" not in dumped
    assert "/home/user/private" not in dumped


@pytest.mark.asyncio
async def test_route_explain_reports_selected_remote_stale_denied_and_local_candidates():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        peer_selection="lowest_latency",
        services={
            "Tooling": MeshServiceConfig(
                share=True,
                prefer="network",
                fallback="local",
                allowed_peers=["peer-a", "peer-stale"],
                required_capabilities=["tools"],
            ),
        },
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        PeerManifest(peer_id="peer-a", shared_services=[_remote_service("Tooling", "1.0.0")]),
    )
    await registry.update_latency("peer-a", 15.0)

    await registry.register_peer("peer-denied", "denied")
    await registry.update_manifest(
        "peer-denied",
        PeerManifest(
            peer_id="peer-denied",
            shared_services=[_remote_service("Tooling", "1.0.0")],
        ),
    )

    await registry.register_peer("peer-stale", "stale")
    await registry.update_manifest(
        "peer-stale",
        PeerManifest(peer_id="peer-stale", shared_services=[_remote_service("Tooling", "1.0.0")]),
    )
    registry.get_peer("peer-stale").status = "stale"

    response = explain_route(
        request=RouteExplainRequest(topic="Tooling.Execute"),
        mesh_config=mesh_config,
        local_services={
            "Tooling": ServiceAnnouncement(module="Tooling", version="local", methods=[])
        },
        registry=registry,
        routing_table=routing_table,
        local_peer_id="local-peer",
    )

    assert response.selected_target == "remote"
    assert response.selected_peer_id == "peer-a"
    assert response.selected_provider_id == "remote:peer-a:Tooling"
    assert response.fallback_behavior == "remote_selected; fallback=local"

    by_peer = {candidate.peer_id: candidate for candidate in response.candidates}
    assert by_peer["local-peer"].included is True
    assert by_peer["peer-a"].selected is True
    assert by_peer["peer-denied"].reason_code == "peer_not_allowed"
    assert by_peer["peer-denied"].blockers[0].security_privacy is True
    assert by_peer["peer-stale"].reason_code == "peer_stale"


@pytest.mark.asyncio
async def test_route_explain_reports_selector_validation_failure():
    mesh_config = MeshConfig(
        enabled=True,
        services={"Tooling": MeshServiceConfig(share=True, prefer="network")},
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        PeerManifest(peer_id="peer-a", shared_services=[_remote_service("Tooling", "1.0.0")]),
    )

    response = explain_route(
        request=RouteExplainRequest(
            topic="Tooling.Execute",
            selector=MeshAddressSelector(peer_id="missing-peer"),
        ),
        mesh_config=mesh_config,
        registry=registry,
        routing_table=routing_table,
    )

    assert response.selected_target == "error"
    assert response.selector_valid is False
    assert response.selector_validation_code == "selector_peer_not_found"
    assert response.security_privacy_blockers[0].code == "selector_peer_not_found"


def test_gateway_service_registers_capability_catalog_and_explain_contracts():
    clear_registry()
    GatewayService()
    gateway = list_modules()["Gateway"]
    methods = {method.bus_topic: method for method in gateway.methods}

    assert GatewayMethods.GET_CAPABILITY_CATALOG in methods
    assert GatewayMethods.EXPLAIN_ROUTE in methods
    assert methods[GatewayMethods.GET_CAPABILITY_CATALOG].exposure == "external"
    assert methods[GatewayMethods.GET_CAPABILITY_CATALOG].method_type == "manage"
    assert methods[GatewayMethods.EXPLAIN_ROUTE].required_perms == ["Gateway.manage"]
    clear_registry()
