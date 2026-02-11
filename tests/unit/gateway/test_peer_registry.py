"""Unit tests for the PeerRegistry."""

import asyncio
import time

import pytest

from app.services.gateway.config import (
    MeshConfig,
    ServiceRoutingConfig,
    ServiceSharingConfig,
)
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo, PeerState
from app.services.gateway.mesh.peer_registry import PeerRegistry


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="test",
        sharing={
            "TTS": ServiceSharingConfig(share=True, max_concurrent=5),
        },
        routing={
            "TTS": ServiceRoutingConfig(prefer="network", fallback="local"),
        },
        stale_peer_timeout_s=10.0,
        peer_selection="lowest_latency",
    )


@pytest.fixture
def registry(mesh_config):
    return PeerRegistry(mesh_config)


def _make_manifest(peer_id, modules, version="1.0.0"):
    services = [
        PeerServiceInfo(
            module=m,
            version=version,
            capabilities=["basic"],
            max_concurrent=10,
        )
        for m in modules
    ]
    return PeerManifest(
        peer_id=peer_id,
        node_name=f"node-{peer_id}",
        shared_services=services,
    )


class TestPeerRegistration:
    """Tests for register/remove operations."""

    @pytest.mark.asyncio
    async def test_register_peer(self, registry):
        await registry.register_peer("peer-1", "node-1")
        state = registry.get_peer("peer-1")
        assert state is not None
        assert state.peer_id == "peer-1"
        assert state.node_name == "node-1"
        assert state.status == "authenticated"

    @pytest.mark.asyncio
    async def test_re_register_peer(self, registry):
        await registry.register_peer("peer-1", "node-1")
        await registry.register_peer("peer-1", "node-1-updated")
        state = registry.get_peer("peer-1")
        assert state.status == "authenticated"
        assert state.node_name == "node-1-updated"

    @pytest.mark.asyncio
    async def test_remove_peer(self, registry):
        await registry.register_peer("peer-1")
        await registry.remove_peer("peer-1")
        assert registry.get_peer("peer-1") is None

    @pytest.mark.asyncio
    async def test_remove_nonexistent_peer(self, registry):
        await registry.remove_peer("nonexistent")  # Should not raise

    @pytest.mark.asyncio
    async def test_get_all_peers(self, registry):
        await registry.register_peer("p1")
        await registry.register_peer("p2")
        peers = registry.get_all_peers()
        assert len(peers) == 2


class TestManifestUpdate:
    """Tests for manifest handling."""

    @pytest.mark.asyncio
    async def test_update_manifest(self, registry):
        await registry.register_peer("peer-1")
        manifest = _make_manifest("peer-1", ["TTS"])
        await registry.update_manifest("peer-1", manifest)

        state = registry.get_peer("peer-1")
        assert state.status == "negotiated"
        assert state.manifest is not None
        assert len(state.manifest.shared_services) == 1

    @pytest.mark.asyncio
    async def test_update_manifest_unknown_peer(self, registry):
        manifest = _make_manifest("ghost", ["TTS"])
        await registry.update_manifest("ghost", manifest)
        # Should not create the peer
        assert registry.get_peer("ghost") is None


class TestLatencyAndCalls:
    """Tests for latency and active call tracking."""

    @pytest.mark.asyncio
    async def test_update_latency(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_latency("peer-1", 42.5)
        state = registry.get_peer("peer-1")
        assert state.latency_ms == 42.5

    @pytest.mark.asyncio
    async def test_latency_restores_stale(self, registry):
        await registry.register_peer("peer-1")
        manifest = _make_manifest("peer-1", ["TTS"])
        await registry.update_manifest("peer-1", manifest)

        # Manually mark stale
        state = registry.get_peer("peer-1")
        state.status = "stale"

        await registry.update_latency("peer-1", 50.0)
        assert registry.get_peer("peer-1").status == "negotiated"

    @pytest.mark.asyncio
    async def test_increment_active_calls(self, registry):
        await registry.register_peer("peer-1")
        result = await registry.increment_active_calls("peer-1")
        assert result is True
        assert registry.get_peer("peer-1").active_calls == 1

    @pytest.mark.asyncio
    async def test_increment_stale_peer_rejected(self, registry):
        await registry.register_peer("peer-1")
        state = registry.get_peer("peer-1")
        state.status = "stale"
        result = await registry.increment_active_calls("peer-1")
        assert result is False

    @pytest.mark.asyncio
    async def test_increment_nonexistent_peer(self, registry):
        result = await registry.increment_active_calls("ghost")
        assert result is False

    @pytest.mark.asyncio
    async def test_decrement_active_calls(self, registry):
        await registry.register_peer("peer-1")
        await registry.increment_active_calls("peer-1")
        await registry.decrement_active_calls("peer-1")
        assert registry.get_peer("peer-1").active_calls == 0

    @pytest.mark.asyncio
    async def test_decrement_does_not_go_negative(self, registry):
        await registry.register_peer("peer-1")
        await registry.decrement_active_calls("peer-1")
        assert registry.get_peer("peer-1").active_calls == 0


class TestProviderQueries:
    """Tests for get_providers and get_best_provider."""

    @pytest.mark.asyncio
    async def test_get_providers(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS", "DB"]))

        await registry.register_peer("peer-2")
        await registry.update_manifest("peer-2", _make_manifest("peer-2", ["TTS"]))

        providers = registry.get_providers("TTS")
        assert len(providers) == 2

        providers = registry.get_providers("DB")
        assert len(providers) == 1

        providers = registry.get_providers("Unknown")
        assert len(providers) == 0

    @pytest.mark.asyncio
    async def test_get_providers_excludes_non_negotiated(self, registry):
        await registry.register_peer("peer-1")
        # Peer is 'authenticated', not 'negotiated', so not a provider
        providers = registry.get_providers("TTS")
        assert len(providers) == 0

    @pytest.mark.asyncio
    async def test_get_best_provider_lowest_latency(self, registry):
        for pid, lat in [("p1", 100.0), ("p2", 20.0), ("p3", 50.0)]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, lat)

        best = registry.get_best_provider("TTS")
        assert best is not None
        assert best.peer_id == "p2"

    @pytest.mark.asyncio
    async def test_get_best_provider_excludes(self, registry):
        for pid, lat in [("p1", 10.0), ("p2", 20.0)]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, lat)

        best = registry.get_best_provider("TTS", exclude=["p1"])
        assert best is not None
        assert best.peer_id == "p2"

    @pytest.mark.asyncio
    async def test_get_best_provider_capacity_check(self, registry):
        await registry.register_peer("p1")
        manifest = PeerManifest(
            peer_id="p1",
            shared_services=[PeerServiceInfo(module="TTS", version="1.0.0", max_concurrent=1)],
        )
        await registry.update_manifest("p1", manifest)
        # Use up the capacity
        state = registry.get_peer("p1")
        state.active_calls = 1

        best = registry.get_best_provider("TTS")
        assert best is None  # At capacity

    @pytest.mark.asyncio
    async def test_get_best_provider_no_candidates(self, registry):
        best = registry.get_best_provider("TTS")
        assert best is None

    @pytest.mark.asyncio
    async def test_get_negotiated_peers(self, registry):
        await registry.register_peer("p1")
        await registry.update_manifest("p1", _make_manifest("p1", ["TTS"]))
        await registry.register_peer("p2")  # Only authenticated

        negotiated = registry.get_negotiated_peers()
        assert len(negotiated) == 1
        assert negotiated[0].peer_id == "p1"

    @pytest.mark.asyncio
    async def test_get_peer_service(self, registry):
        await registry.register_peer("p1")
        await registry.update_manifest("p1", _make_manifest("p1", ["TTS", "DB"]))

        svc = registry.get_peer_service("p1", "TTS")
        assert svc is not None
        assert svc.module == "TTS"

        svc = registry.get_peer_service("p1", "Unknown")
        assert svc is None

        svc = registry.get_peer_service("ghost", "TTS")
        assert svc is None


class TestPeerSelection:
    """Tests for peer selection strategies."""

    @pytest.mark.asyncio
    async def test_round_robin(self, mesh_config):
        mesh_config.peer_selection = "round_robin"
        registry = PeerRegistry(mesh_config)

        for pid in ["p1", "p2", "p3"]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, 50.0)

        # Round-robin should cycle through peers
        seen = set()
        for _ in range(6):
            best = registry.get_best_provider("TTS")
            if best:
                seen.add(best.peer_id)
        assert len(seen) >= 2  # Should hit multiple peers

    @pytest.mark.asyncio
    async def test_random_selection(self, mesh_config):
        mesh_config.peer_selection = "random"
        registry = PeerRegistry(mesh_config)

        for pid in ["p1", "p2"]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, 50.0)

        best = registry.get_best_provider("TTS")
        assert best is not None
        assert best.peer_id in ("p1", "p2")


class TestStaleDetection:
    """Tests for stale peer detection."""

    @pytest.mark.asyncio
    async def test_stale_check_marks_peers(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        state = registry.get_peer("peer-1")
        # Set last_ping far in the past
        state.last_ping = time.monotonic() - 200

        await registry._check_stale_peers()
        assert registry.get_peer("peer-1").status == "stale"

    @pytest.mark.asyncio
    async def test_recent_ping_not_stale(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))

        # Recent ping
        state = registry.get_peer("peer-1")
        state.last_ping = time.monotonic()

        await registry._check_stale_peers()
        assert registry.get_peer("peer-1").status == "negotiated"

    @pytest.mark.asyncio
    async def test_start_stop_lifecycle(self, registry):
        await registry.start()
        assert registry._stale_check_task is not None
        await registry.stop()
        assert registry._stale_check_task is None
