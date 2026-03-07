"""Unit tests for the mesh RoutingTable."""

import pytest

from app.services.gateway.config import MeshConfig, MeshServiceConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo, PeerState, RouteDecision
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.routing_table import RoutingTable, _extract_module


class TestExtractModule:
    """Tests for _extract_module helper."""

    def test_dotted_topic(self):
        assert _extract_module("TTS.Request") == "TTS"

    def test_multi_dotted_topic(self):
        assert _extract_module("TTS.Request.Extra") == "TTS"

    def test_plain_topic(self):
        assert _extract_module("TTS") == "TTS"


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="test-node",
        services={
            "TTS": MeshServiceConfig(prefer="network", fallback="local"),
            "DB": MeshServiceConfig(prefer="local"),
            "STT": MeshServiceConfig(prefer="network_only", fallback="error"),
            "Scheduler": MeshServiceConfig(prefer="local_only"),
        },
    )


@pytest.fixture
def peer_registry(mesh_config):
    return PeerRegistry(mesh_config)


@pytest.fixture
def routing_table(mesh_config, peer_registry):
    return RoutingTable(mesh_config, peer_registry)


def _make_negotiated_peer(peer_id, modules, latency_ms=50.0):
    """Create a negotiated PeerState with given modules."""
    services = [PeerServiceInfo(module=m, version="1.0.0") for m in modules]
    manifest = PeerManifest(peer_id=peer_id, shared_services=services)
    return PeerState(
        peer_id=peer_id,
        manifest=manifest,
        status="negotiated",
        latency_ms=latency_ms,
    )


class TestRoutingTableResolve:
    """Tests for RoutingTable.resolve()."""

    def test_no_routing_config_returns_local(self, routing_table):
        route = routing_table.resolve("Unknown.Topic")
        assert route.target == "local"
        assert route.module == "Unknown"

    def test_prefer_local_returns_local(self, routing_table):
        route = routing_table.resolve("DB.Query")
        assert route.target == "local"
        assert route.module == "DB"

    def test_prefer_local_only_returns_local(self, routing_table):
        route = routing_table.resolve("Scheduler.Schedule")
        assert route.target == "local"
        assert route.module == "Scheduler"

    @pytest.mark.asyncio
    async def test_prefer_network_no_peer_falls_back_to_local(self, routing_table):
        """No peers registered, so network preference falls back."""
        route = routing_table.resolve("TTS.Request")
        assert route.target == "local"
        assert route.module == "TTS"

    @pytest.mark.asyncio
    async def test_prefer_network_with_peer(self, routing_table, peer_registry):
        peer = _make_negotiated_peer("peer-1", ["TTS"], latency_ms=20.0)
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)
        await peer_registry.update_latency("peer-1", 20.0)

        route = routing_table.resolve("TTS.Request")
        assert route.target == "remote"
        assert route.peer_id == "peer-1"
        assert route.module == "TTS"

    @pytest.mark.asyncio
    async def test_prefer_network_only_no_peer(self, routing_table):
        """network_only with no peer → none (fallback=error maps to error)."""
        route = routing_table.resolve("STT.Transcribe")
        # STT routing has prefer=network_only, no peers → target=none
        # Because network_only can't fall back to local
        assert route.target in ("none", "error")

    @pytest.mark.asyncio
    async def test_exclude_peer(self, routing_table, peer_registry):
        peer = _make_negotiated_peer("peer-1", ["TTS"])
        await peer_registry.register_peer("peer-1")
        await peer_registry.update_manifest("peer-1", peer.manifest)

        route = routing_table.resolve("TTS.Request", exclude=["peer-1"])
        # Peer excluded, no other peers → fallback
        assert route.target == "local"


class TestRoutingTableResolveFallback:
    """Tests for RoutingTable.resolve_fallback()."""

    def test_fallback_local(self, routing_table):
        route = routing_table.resolve_fallback("TTS.Request", failed_peer_id="peer-1")
        assert route.target == "local"

    @pytest.mark.asyncio
    async def test_fallback_network_finds_another_peer(self, mesh_config, peer_registry):
        mesh_config.services["TTS"] = MeshServiceConfig(prefer="network", fallback="network")
        routing_table = RoutingTable(mesh_config, peer_registry)

        # Register two peers
        for pid, lat in [("peer-1", 20.0), ("peer-2", 30.0)]:
            await peer_registry.register_peer(pid)
            manifest = PeerManifest(
                peer_id=pid,
                shared_services=[PeerServiceInfo(module="TTS", version="1.0.0")],
            )
            await peer_registry.update_manifest(pid, manifest)
            await peer_registry.update_latency(pid, lat)

        fallback = routing_table.resolve_fallback("TTS.Request", failed_peer_id="peer-1")
        assert fallback.target == "remote"
        assert fallback.peer_id == "peer-2"

    def test_fallback_error(self, routing_table):
        config = MeshServiceConfig(prefer="network_only", fallback="error")
        route = routing_table.resolve_fallback("STT.Request", routing_config=config)
        assert route.target == "error"

    def test_no_routing_config_returns_local(self, routing_table):
        route = routing_table.resolve_fallback("Unknown.Topic")
        assert route.target == "local"
