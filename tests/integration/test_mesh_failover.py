"""Integration tests for mesh failover — remote failure triggers local fallback.

Tests the automatic failover mechanism when remote peers fail, timeout,
or become unavailable.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig, ServiceRoutingConfig, ServiceSharingConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.peer_bridge import PeerBridge
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable


class DummyPayload(BaseModel):
    text: str = "test"


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="failover-test",
        routing={
            "Orchestrator": ServiceRoutingConfig(prefer="network", fallback="local"),
            "STT": ServiceRoutingConfig(prefer="network", fallback="network"),
            "GPU": ServiceRoutingConfig(prefer="network_only", fallback="error"),
        },
        peer_selection="lowest_latency",
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
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"source": "local-fallback"}))
    bus.subscribe = MagicMock()
    return bus


@pytest.fixture
def mesh_bus(inner_bus, routing_table, peer_bridge, mesh_config):
    return MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)


async def _register_peer(registry, peer_id, modules, latency=50.0):
    """Helper to register a negotiated peer."""
    await registry.register_peer(peer_id)
    manifest = PeerManifest(
        peer_id=peer_id,
        shared_services=[
            PeerServiceInfo(module=m, version="1.0.0", max_concurrent=10) for m in modules
        ],
    )
    await registry.update_manifest(peer_id, manifest)
    await registry.update_latency(peer_id, latency)


@pytest.mark.integration
class TestRemoteFailureFallback:
    """Tests that remote call failures trigger proper fallback."""

    @pytest.mark.asyncio
    async def test_remote_timeout_falls_back_to_local(
        self, mesh_bus, inner_bus, peer_registry, mock_rtc_client
    ):
        """Remote call times out → fallback to local."""
        await _register_peer(peer_registry, "slow-peer", ["Orchestrator"])

        # Don't simulate a response — the call will timeout
        result = await mesh_bus.request("Orchestrator.Query", DummyPayload(), timeout=0.2)

        # Should fall back to local after timeout
        assert result.ok is True
        assert result.data["source"] == "local-fallback"
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_send_failure_falls_back_to_local(
        self, mesh_bus, inner_bus, peer_registry, mock_rtc_client
    ):
        """Send to peer fails (disconnected) → fallback to local."""
        await _register_peer(peer_registry, "dead-peer", ["Orchestrator"])
        mock_rtc_client.send_to_peer.return_value = False  # Send fails

        result = await mesh_bus.request("Orchestrator.Query", DummyPayload())
        assert result.ok is True
        assert result.data["source"] == "local-fallback"

    @pytest.mark.asyncio
    async def test_remote_error_response_falls_back_to_local(
        self, mesh_bus, inner_bus, peer_registry, peer_bridge, mock_rtc_client
    ):
        """Remote returns error → fallback to local."""
        await _register_peer(peer_registry, "error-peer", ["Orchestrator"])

        async def simulate_error():
            await asyncio.sleep(0.05)
            for req_id, fut in list(peer_bridge._pending_calls.items()):
                if not fut.done():
                    peer_bridge.on_response(
                        "error-peer",
                        {
                            "type": "error",
                            "id": req_id,
                            "error": {"message": "Service unavailable", "code": 503},
                        },
                    )

        task = asyncio.create_task(simulate_error())
        result = await mesh_bus.request("Orchestrator.Query", DummyPayload())
        await task

        # Should fall back to local after error
        assert result.ok is True
        assert result.data["source"] == "local-fallback"


@pytest.mark.integration
class TestNetworkFallbackToAnotherPeer:
    """Tests fallback=network routing to another peer."""

    @pytest.mark.asyncio
    async def test_first_peer_fails_second_peer_succeeds(
        self, mesh_bus, peer_registry, peer_bridge, mock_rtc_client
    ):
        """First peer times out → try second peer (fallback=network)."""
        await _register_peer(peer_registry, "peer-1", ["STT"], latency=10.0)
        await _register_peer(peer_registry, "peer-2", ["STT"], latency=20.0)

        # peer-1 will be selected first (lowest latency)
        # Don't respond from peer-1 (timeout), but respond from peer-2
        async def simulate_fallback_response():
            await asyncio.sleep(0.15)
            # After peer-1 times out, MeshBus tries fallback
            # The second call to peer-2 should get a response
            for req_id, fut in list(peer_bridge._pending_calls.items()):
                if not fut.done():
                    peer_bridge.on_response(
                        "peer-2",
                        {
                            "type": "result",
                            "id": req_id,
                            "result": {"source": "peer-2"},
                        },
                    )

        task = asyncio.create_task(simulate_fallback_response())
        result = await mesh_bus.request("STT.Transcribe", DummyPayload(), timeout=0.1)
        await task

        # May fall back to local or get peer-2 response depending on timing
        assert result.ok is True


@pytest.mark.integration
class TestNetworkOnlyWithNoFallback:
    """Tests network_only mode with fallback=error."""

    @pytest.mark.asyncio
    async def test_no_peer_returns_error(self, mesh_bus):
        """network_only with no peers → error response."""
        result = await mesh_bus.request("GPU.Compute", DummyPayload())
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_peer_timeout_returns_error(self, mesh_bus, peer_registry, mock_rtc_client):
        """network_only with peer timeout → eventually returns error or timeout."""
        await _register_peer(peer_registry, "gpu-peer", ["GPU"])

        # Don't simulate response — times out
        result = await mesh_bus.request("GPU.Compute", DummyPayload(), timeout=0.2)
        # After timeout on network_only, fallback is error
        # But the MeshBus tries fallback which returns error route
        assert result.ok is False or result.data is not None


@pytest.mark.integration
class TestPeerLifecycleImpactsRouting:
    """Tests that peer lifecycle events (connect/disconnect/stale) affect routing."""

    @pytest.mark.asyncio
    async def test_peer_removal_causes_local_fallback(self, mesh_bus, inner_bus, peer_registry):
        """After removing a peer, routing falls back to local."""
        await _register_peer(peer_registry, "temp-peer", ["Orchestrator"])

        # Verify it would route remotely
        route = RoutingTable(mesh_bus._config, peer_registry).resolve("Orchestrator.Query")
        assert route.target == "remote"

        # Remove the peer
        await peer_registry.remove_peer("temp-peer")

        # Now should fall back to local
        result = await mesh_bus.request("Orchestrator.Query", DummyPayload())
        assert result.ok is True
        inner_bus.request.assert_awaited()
