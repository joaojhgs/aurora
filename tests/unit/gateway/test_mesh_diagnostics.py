"""Unit tests for Gateway mesh diagnostics."""

from collections import deque
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig, MeshServiceConfig, Settings
from app.services.gateway.mesh.models import ManifestAck, PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from app.services.gateway.service import GatewayService
from app.services.gateway.webrtc.rtc_client import RTCClient
from app.shared.contracts.models.common import EmptyInput
from app.shared.contracts.models.gateway import MethodInfo, WebRTCDiagnosticError


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


@pytest.mark.asyncio
async def test_webrtc_diagnostics_reports_disabled_state_without_client():
    settings = Settings(mesh=MeshConfig(enabled=True, node_name="local-node"))
    settings.webrtc.enabled = False
    settings.api.auth_enabled = True
    service = _service_with_settings(settings)
    service._mesh_peer_id = "local-peer"

    response = await service.get_webrtc_diagnostics(EmptyInput())

    assert response.enabled is False
    assert response.started is False
    assert response.mesh_enabled is True
    assert response.local_mesh_peer_id == "local-peer"
    assert response.local_node_name == "local-node"
    assert response.require_auth is True
    assert response.peers == []
    assert response.secrets_redacted is True


@pytest.mark.asyncio
async def test_rtc_client_diagnostics_reports_ice_channel_auth_and_redacts_errors():
    settings = Settings(mesh=MeshConfig(enabled=True, node_name="local-node"))
    settings.webrtc.enabled = True
    settings.webrtc.enable_app_layer_e2ee = True
    settings.signaling_mqtt.brokers = ["wss://broker.emqx.io:8084/mqtt"]
    registry = PeerRegistry(settings.mesh)
    await registry.register_peer("stable-peer", "remote-node")
    await registry.update_latency("stable-peer", 42.5)

    client = RTCClient.__new__(RTCClient)
    client._settings = settings
    client._require_auth = True
    client._peer_id = "signaling-local"
    client._mesh_peer_id = "local-peer"
    client._mesh_node_name = "local-node"
    client._adapter = object()
    client._pcs = {
        "session-peer": SimpleNamespace(
            connectionState="connected",
            iceConnectionState="completed",
            iceGatheringState="complete",
            signalingState="stable",
        )
    }
    client._peer_acl = {
        "session-peer": Identity(
            principal_id="principal-1",
            principal_name="remote",
            is_admin=False,
            permissions=frozenset({"Gateway.manage"}),
            effective_perms=frozenset({"Gateway.manage"}),
            source="webrtc_peer",
        )
    }
    client._peer_tokens = {}
    client._peer_timeout_tasks = {"session-peer": object()}
    client._auth_timeout = 10.0
    client._peer_pairing_active = {"session-peer"}
    client._pairing_timeout = 300.0
    client._saved_auth_tokens = {"stable-peer": "secret-token"}
    client._on_token_saved = None
    client._pending_rpc = {"rpc-1": object()}
    client._pairing_tasks = {"session-peer": object()}
    client._mesh_enabled = True
    client._mesh_config = settings.mesh
    client._peer_registry = registry
    client._peer_bridge = None
    client._peer_send_fns = {"session-peer": lambda text: None}
    client._peer_data_channels = {
        "session-peer": SimpleNamespace(readyState="open", label="aurora-rpc")
    }
    client._peer_stable_ids = {"session-peer": "stable-peer"}
    client._stable_peer_sessions = {"stable-peer": "session-peer"}
    client._peer_names = {"stable-peer": "remote-node"}
    client._diagnostic_errors = deque(
        [
            WebRTCDiagnosticError(
                timestamp=datetime.now(UTC).isoformat(),
                code="auth_failed",
                message="redacted diagnostic event",
                peer_id="session-peer",
            )
        ],
        maxlen=50,
    )

    response = client.get_diagnostics()
    payload = response.model_dump_json()

    assert response.enabled is True
    assert response.started is True
    assert response.mesh_enabled is True
    assert response.local_signaling_peer_id == "signaling-local"
    assert response.local_mesh_peer_id == "local-peer"
    assert response.app_layer_e2ee_enabled is True
    assert response.signaling.connected is True
    assert response.signaling.public_broker_warning is True
    assert response.connected_peer_count == 1
    assert response.authenticated_peer_count == 1
    assert response.pairing_peer_count == 1
    assert response.pending_rpc_count == 1

    peer = response.peers[0]
    assert peer.signaling_peer_id == "session-peer"
    assert peer.stable_peer_id == "stable-peer"
    assert peer.connection_state == "connected"
    assert peer.ice_connection_state == "completed"
    assert peer.ice_gathering_state == "complete"
    assert peer.signaling_state == "stable"
    assert peer.data_channel_state == "open"
    assert peer.has_send_channel is True
    assert peer.rtt_ms == 42.5
    assert peer.auth_state == "authenticated"
    assert peer.effective_permission_count == 1
    assert peer.pairing_active is True
    assert peer.auth_timeout_pending is True
    assert peer.pending_pairing_task is True

    assert "secret-token" not in payload
    assert "password" not in payload.lower()
    assert response.secrets_redacted is True
