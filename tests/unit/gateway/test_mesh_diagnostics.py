"""Unit tests for Gateway mesh diagnostics."""

from unittest.mock import AsyncMock

import pytest

from app.services.gateway.config import MeshConfig, MeshServiceConfig, Settings
from app.services.gateway.mesh.models import ManifestAck, PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.services.gateway.service import GatewayService
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import MethodInfo


def _service_with_settings(settings: Settings) -> GatewayService:
    service = GatewayService()
    service._get_gateway_config = AsyncMock(return_value=settings)
    return service


def _peer_service(module: str, version: str = "1.2.0", max_concurrent: int = 4):
    return PeerServiceInfo(
        module=module,
        version=version,
        capabilities=["tools", "basic"],
        methods=[
            MethodInfo(
                name="Execute",
                summary="execute",
                bus_topic=f"{module}.Execute",
                exposure="external",
            )
        ],
        max_concurrent=max_concurrent,
        digest=f"digest-{module}",
    )


@pytest.mark.asyncio
async def test_mesh_status_reports_disabled_state_without_components():
    service = _service_with_settings(Settings(mesh=MeshConfig(enabled=False, node_name="local")))

    response = await service.get_mesh_status(EmptyInput())

    assert response.local.mesh_enabled is False
    assert response.local.mesh_started is False
    assert response.local.webrtc_started is False
    assert response.local.node_name == "local"
    assert response.peers == []
    assert response.routes == []
    assert response.secrets_redacted is True


@pytest.mark.asyncio
async def test_mesh_status_reports_route_provider_capacity_and_compatibility():
    mesh_config = MeshConfig(
        enabled=True,
        node_name="local-node",
        services={
            "Tooling": MeshServiceConfig(
                share=True,
                prefer="network",
                fallback="local",
                min_version="1.0.0",
                required_capabilities=["tools"],
            ),
            "DB": MeshServiceConfig(prefer="network_only", fallback="error"),
        },
    )
    registry = PeerRegistry(mesh_config)
    routing_table = RoutingTable(mesh_config, registry)

    await registry.register_peer("peer-old", "old-node")
    await registry.update_manifest(
        "peer-old",
        PeerManifest(
            peer_id="peer-old",
            node_name="old-node",
            shared_services=[_peer_service("Tooling", version="0.9.0")],
        ),
    )
    await registry.update_latency("peer-old", 10.0)

    await registry.register_peer("peer-good", "good-node")
    await registry.update_manifest(
        "peer-good",
        PeerManifest(
            peer_id="peer-good",
            node_name="good-node",
            shared_services=[_peer_service("Tooling", version="1.2.0", max_concurrent=4)],
        ),
    )
    await registry.update_latency("peer-good", 25.0)
    await registry.increment_active_calls("peer-good")
    await registry.update_manifest_ack(
        "peer-good",
        ManifestAck(incompatible_services=["DB"], compatible_services=["Tooling"]),
    )

    service = _service_with_settings(Settings(mesh=mesh_config))
    service._mesh_peer_registry = registry
    service._mesh_routing_table = routing_table
    service._mesh_bus = object()
    service._rtc_client = object()
    service._mesh_peer_id = "local-peer"

    response = await service.get_mesh_status(EmptyInput())

    assert response.local.mesh_enabled is True
    assert response.local.mesh_started is True
    assert response.local.webrtc_started is True
    assert response.local.peer_id == "local-peer"
    assert response.local.shared_modules == ["Tooling"]
    assert response.local.routed_modules == ["DB", "Tooling"]

    tooling_route = next(route for route in response.routes if route.module == "Tooling")
    assert tooling_route.decision_target == "remote"
    assert tooling_route.decision_peer_id == "peer-good"
    assert tooling_route.reason == "selected peer peer-good using lowest_latency policy"

    providers = {provider.peer_id: provider for provider in tooling_route.providers}
    assert providers["peer-good"].eligible is True
    assert providers["peer-good"].reason_code == "eligible"
    assert providers["peer-good"].active_calls == 1
    assert providers["peer-good"].max_concurrent == 4
    assert providers["peer-old"].eligible is False
    assert providers["peer-old"].reason_code == "incompatible_version"
    assert "does not satisfy" in providers["peer-old"].reason

    good_peer = next(peer for peer in response.peers if peer.peer_id == "peer-good")
    tooling = next(svc for svc in good_peer.services if svc.module == "Tooling")
    assert tooling.available_capacity == 3
    assert tooling.active_calls == 1
    assert tooling.method_names == ["Execute"]
    assert good_peer.compatibility.remote_incompatible == ["DB"]

    failures = {
        (failure.peer_id, failure.module, failure.direction)
        for failure in response.compatibility_failures
    }
    assert ("peer-old", "Tooling", "local_view_of_remote") in failures
    assert ("peer-good", "DB", "remote_view_of_local") in failures


@pytest.mark.asyncio
async def test_mesh_status_output_does_not_include_secret_field_names():
    mesh_config = MeshConfig(enabled=True, node_name="local")
    service = _service_with_settings(Settings(mesh=mesh_config))

    response = await service.get_mesh_status(EmptyInput())
    payload = response.model_dump_json().lower()

    assert "password" not in payload
    assert "token" not in payload
    assert "api_key" not in payload
    assert response.secrets_redacted is True
