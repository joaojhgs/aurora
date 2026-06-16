"""Unit tests for mesh capability graph projection."""

from unittest.mock import AsyncMock

import pytest

from app.services.gateway.config import MeshConfig, MeshServiceConfig, Settings
from app.services.gateway.mesh.capability_graph import build_capability_graph
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.service import GatewayService
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import (
    CapabilityAddressInfo,
    CapabilityResourceInfo,
    MethodInfo,
    ServiceAnnouncement,
)


def _method(module: str, name: str = "Execute", method_type: str = "use") -> MethodInfo:
    return MethodInfo(
        name=name,
        summary=f"{module} {name}",
        bus_topic=f"{module}.{name}",
        exposure="external",
        method_type=method_type,
        required_perms=[f"{module}.{name}"],
        input_model=f"{name}Request",
        output_model=f"{name}Response",
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
async def test_capability_graph_aggregates_multiple_providers_for_same_module():
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
            "DB": MeshServiceConfig(share=False, prefer="local"),
        },
    )
    registry = PeerRegistry(mesh_config)

    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        PeerManifest(
            peer_id="peer-a",
            node_name="alpha",
            timestamp="2026-06-16T00:00:00Z",
            shared_services=[_remote_service("Tooling", "1.0.0")],
        ),
    )
    await registry.update_latency("peer-a", 12.5)

    await registry.register_peer("peer-b", "beta")
    await registry.update_manifest(
        "peer-b",
        PeerManifest(
            peer_id="peer-b",
            node_name="beta",
            timestamp="2026-06-16T00:01:00Z",
            shared_services=[_remote_service("Tooling", "2.0.0", max_concurrent=2)],
        ),
    )
    await registry.update_latency("peer-b", 30.0)
    await registry.increment_active_calls("peer-b")

    await registry.register_peer("peer-c", "gamma")
    await registry.update_manifest(
        "peer-c",
        PeerManifest(
            peer_id="peer-c",
            node_name="gamma",
            timestamp="2026-06-16T00:02:00Z",
            shared_services=[_remote_service("Tooling", "2.1.0")],
        ),
    )

    local_services = {
        "Tooling": ServiceAnnouncement(
            module="Tooling",
            version="3.0.0",
            summary="local tools",
            capabilities=["tools", "local"],
            methods=[_method("Tooling"), _method("Tooling", "Reload", method_type="manage")],
        ),
        "DB": ServiceAnnouncement(
            module="DB",
            version="3.0.0",
            summary="local database",
            capabilities=["rag"],
            methods=[_method("DB", "Search")],
        ),
    }

    graph = build_capability_graph(
        mesh_config=mesh_config,
        local_services=local_services,
        peers=registry.get_all_peers(),
        local_peer_id="local-peer",
    )

    assert graph.local_peer_id == "local-peer"
    assert graph.local_node_name == "local-node"
    assert graph.secrets_redacted is True
    assert graph.provider_index["Tooling"] == [
        "local:local-peer:Tooling",
        "remote:peer-a:Tooling",
        "remote:peer-b:Tooling",
    ]
    assert graph.candidate_provider_index["Tooling"] == [
        "local:local-peer:Tooling",
        "remote:peer-a:Tooling",
        "remote:peer-b:Tooling",
        "remote:peer-c:Tooling",
    ]

    tooling_services = [svc for svc in graph.services if svc.module == "Tooling"]
    assert len(tooling_services) == 4
    assert {svc.peer_id for svc in tooling_services} == {
        "local-peer",
        "peer-a",
        "peer-b",
        "peer-c",
    }

    peer_b_service = next(svc for svc in tooling_services if svc.peer_id == "peer-b")
    assert peer_b_service.available_capacity == 1
    assert peer_b_service.latency_ms == 30.0
    assert peer_b_service.policy.allowed_peers == ["peer-a", "peer-b"]
    assert peer_b_service.policy.safety_class == "delegated_action"
    assert peer_b_service.routable is True

    peer_c_service = next(svc for svc in tooling_services if svc.peer_id == "peer-c")
    assert peer_c_service.routable is False
    assert peer_c_service.route_blockers == ["peer_not_allowed"]

    local_reload = next(
        method
        for svc in tooling_services
        if svc.peer_id == "local-peer"
        for method in svc.methods
        if method.name == "Reload"
    )
    assert local_reload.policy.explicit_selector_required is True
    assert local_reload.policy.safety_class == "admin"

    local_db = next(svc for svc in graph.services if svc.module == "DB")
    assert local_db.share is False
    assert local_db.routable is True
    assert local_db.policy.local_only is True
    assert local_db.policy.mesh_visible is False


def test_capability_graph_models_support_explicit_resource_selectors():
    resource = CapabilityResourceInfo(
        resource_id="db:memories:home",
        resource_type="db_namespace",
        owner_peer_id="peer-a",
        service_instance_id="remote:peer-a:DB",
        namespace="memories/home",
        capabilities=["rag_search"],
        address=CapabilityAddressInfo(
            peer_id="peer-a",
            module="DB",
            service_instance_id="remote:peer-a:DB",
            resource_id="db:memories:home",
            namespace="memories/home",
        ),
    )

    data = resource.model_dump()
    assert data["namespace"] == "memories/home"
    assert data["address"]["resource_id"] == "db:memories:home"


@pytest.mark.asyncio
async def test_capability_graph_treats_empty_allowed_peers_as_allow_none():
    mesh_config = MeshConfig(
        enabled=True,
        services={"Tooling": MeshServiceConfig(share=True, prefer="network", allowed_peers=[])},
    )
    registry = PeerRegistry(mesh_config)
    await registry.register_peer("peer-a", "alpha")
    await registry.update_manifest(
        "peer-a",
        PeerManifest(peer_id="peer-a", shared_services=[_remote_service("Tooling", "1.0.0")]),
    )

    graph = build_capability_graph(
        mesh_config=mesh_config,
        peers=registry.get_all_peers(),
        local_peer_id="local-peer",
    )
    remote_tooling = next(svc for svc in graph.services if svc.module == "Tooling")

    assert graph.provider_index == {}
    assert graph.candidate_provider_index["Tooling"] == ["remote:peer-a:Tooling"]
    assert remote_tooling.routable is False
    assert remote_tooling.policy.allowed_peers == []
    assert remote_tooling.route_blockers == ["peer_not_allowed"]


@pytest.mark.asyncio
async def test_gateway_capability_graph_output_is_redacted():
    mesh_config = MeshConfig(enabled=True, node_name="local")
    service = GatewayService()
    service._get_gateway_config = AsyncMock(return_value=Settings(mesh=mesh_config))
    service._mesh_peer_id = "local-peer"

    response = await service.get_capability_graph(EmptyInput())
    payload = response.model_dump_json().lower()

    assert response.secrets_redacted is True
    assert "password" not in payload
    assert "token" not in payload
    assert "api_key" not in payload
