"""Integration tests for mesh routing — end-to-end local→remote routing via MeshBus.

Tests the full mesh routing stack: MeshBus → RoutingTable → PeerRegistry → PeerBridge,
using mocked DataChannel communication (no actual WebRTC).
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig, ServiceRoutingConfig, ServiceSharingConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_bridge import PeerBridge
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable
from pydantic import BaseModel


class TTSRequest(BaseModel):
    text: str = "Hello, world!"


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="local-node",
        sharing={
            "TTS": ServiceSharingConfig(share=True, max_concurrent=5),
        },
        routing={
            "Orchestrator": ServiceRoutingConfig(prefer="network", fallback="local"),
            "TTS": ServiceRoutingConfig(prefer="local"),
        },
        peer_selection="lowest_latency",
        stale_peer_timeout_s=120.0,
    )


@pytest.fixture
def peer_registry(mesh_config):
    return PeerRegistry(mesh_config)


@pytest.fixture
def routing_table(mesh_config, peer_registry):
    return RoutingTable(mesh_config, peer_registry)


@pytest.fixture
def mock_rtc_client():
    client = MagicMock()
    client.send_to_peer = MagicMock(return_value=True)
    return client


@pytest.fixture
def peer_bridge(mock_rtc_client, peer_registry):
    return PeerBridge(mock_rtc_client, peer_registry)


@pytest.fixture
def inner_bus():
    bus = AsyncMock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"source": "local"}))
    bus.subscribe = MagicMock()
    bus.start = AsyncMock()
    bus.stop = AsyncMock()
    return bus


@pytest.fixture
def mesh_bus(inner_bus, routing_table, peer_bridge, mesh_config):
    return MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)


@pytest.mark.integration
class TestMeshRoutingEndToEnd:
    """End-to-end routing through the full mesh stack."""

    @pytest.mark.asyncio
    async def test_local_route_bypasses_remote(self, mesh_bus, inner_bus):
        """TTS is configured as prefer=local, should go through inner bus."""
        await mesh_bus.request("TTS.Request", TTSRequest())
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_network_route_uses_remote_peer(
        self, mesh_bus, peer_registry, peer_bridge, mock_rtc_client
    ):
        """Orchestrator is prefer=network, with a registered peer it should route remotely."""
        # Register a peer providing Orchestrator
        await peer_registry.register_peer("remote-1", "remote-node")
        manifest = PeerManifest(
            peer_id="remote-1",
            node_name="remote-node",
            shared_services=[
                PeerServiceInfo(module="Orchestrator", version="1.0.0", max_concurrent=10),
            ],
        )
        await peer_registry.update_manifest("remote-1", manifest)
        await peer_registry.update_latency("remote-1", 25.0)

        # Simulate the remote peer responding
        async def simulate_remote_response():
            await asyncio.sleep(0.05)
            for req_id, fut in list(peer_bridge._pending_calls.items()):
                if not fut.done():
                    peer_bridge.on_response("remote-1", {
                        "type": "result",
                        "id": req_id,
                        "result": {"source": "remote", "answer": "42"},
                    })

        task = asyncio.create_task(simulate_remote_response())
        result = await mesh_bus.request("Orchestrator.Query", TTSRequest(text="What is 6*7?"))
        await task

        assert result.ok is True
        assert result.data["source"] == "remote"
        mock_rtc_client.send_to_peer.assert_called_once()

    @pytest.mark.asyncio
    async def test_network_route_falls_back_to_local_when_no_peer(
        self, mesh_bus, inner_bus
    ):
        """Orchestrator prefer=network but no peers → fallback=local."""
        result = await mesh_bus.request("Orchestrator.Query", TTSRequest())
        assert result.ok is True
        assert result.data["source"] == "local"
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_event_always_goes_local(self, mesh_bus, inner_bus, peer_registry):
        """Events should always go to the local bus regardless of routing config."""
        await peer_registry.register_peer("remote-1")
        manifest = PeerManifest(
            peer_id="remote-1",
            shared_services=[
                PeerServiceInfo(module="Orchestrator", version="1.0.0"),
            ],
        )
        await peer_registry.update_manifest("remote-1", manifest)

        await mesh_bus.publish("Orchestrator.StateChanged", TTSRequest(), event=True)
        inner_bus.publish.assert_awaited_once()


@pytest.mark.integration
class TestMeshRegistryToRouting:
    """Tests that PeerRegistry state correctly affects routing decisions."""

    @pytest.mark.asyncio
    async def test_stale_peer_excluded_from_routing(
        self, routing_table, peer_registry
    ):
        """A stale peer should not be selected as a route target."""
        await peer_registry.register_peer("stale-peer")
        manifest = PeerManifest(
            peer_id="stale-peer",
            shared_services=[
                PeerServiceInfo(module="Orchestrator", version="1.0.0"),
            ],
        )
        await peer_registry.update_manifest("stale-peer", manifest)

        # Mark as stale
        state = peer_registry.get_peer("stale-peer")
        state.status = "stale"

        route = routing_table.resolve("Orchestrator.Query")
        # Should fallback to local since the only peer is stale
        assert route.target == "local"

    @pytest.mark.asyncio
    async def test_latency_affects_peer_selection(self, routing_table, peer_registry):
        """Lower latency peer should be preferred with lowest_latency policy."""
        for pid, lat in [("slow-peer", 200.0), ("fast-peer", 10.0)]:
            await peer_registry.register_peer(pid)
            manifest = PeerManifest(
                peer_id=pid,
                shared_services=[
                    PeerServiceInfo(module="Orchestrator", version="1.0.0"),
                ],
            )
            await peer_registry.update_manifest(pid, manifest)
            await peer_registry.update_latency(pid, lat)

        route = routing_table.resolve("Orchestrator.Query")
        assert route.target == "remote"
        assert route.peer_id == "fast-peer"

    @pytest.mark.asyncio
    async def test_capacity_affects_routing(self, routing_table, peer_registry):
        """A peer at capacity should be excluded."""
        await peer_registry.register_peer("busy-peer")
        manifest = PeerManifest(
            peer_id="busy-peer",
            shared_services=[
                PeerServiceInfo(module="Orchestrator", version="1.0.0", max_concurrent=1),
            ],
        )
        await peer_registry.update_manifest("busy-peer", manifest)
        state = peer_registry.get_peer("busy-peer")
        state.active_calls = 1  # At capacity

        route = routing_table.resolve("Orchestrator.Query")
        assert route.target == "local"  # Falls back since peer is at capacity
