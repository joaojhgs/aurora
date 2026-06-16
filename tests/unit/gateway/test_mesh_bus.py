"""Unit tests for MeshBus routing decisions and fallback behavior."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig, MeshServiceConfig
from app.services.gateway.mesh.models import RouteDecision
from app.shared.contracts.models.mesh import MeshAddressSelector


class FakePayload(BaseModel):
    text: str = "hello"
    mesh_selector: MeshAddressSelector | None = None


@pytest.fixture
def inner_bus():
    bus = AsyncMock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"result": "local"}))
    bus.subscribe = MagicMock()
    return bus


@pytest.fixture
def routing_table():
    rt = MagicMock()
    rt.resolve = MagicMock(return_value=RouteDecision(target="local", module="TTS"))
    rt.resolve_fallback = MagicMock(return_value=RouteDecision(target="local", module="TTS"))
    return rt


@pytest.fixture
def peer_bridge():
    pb = AsyncMock()
    pb.call = AsyncMock(return_value=QueryResult(ok=True, data={"result": "remote"}))
    return pb


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="test",
        services={
            "TTS": MeshServiceConfig(prefer="network", fallback="local"),
        },
    )


@pytest.fixture
def mesh_bus(inner_bus, routing_table, peer_bridge, mesh_config):
    return MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)


class TestMeshBusPublish:
    """Tests for MeshBus.publish()."""

    @pytest.mark.asyncio
    async def test_events_go_local_by_default(self, mesh_bus, inner_bus, routing_table):
        """Events without mesh=True are delivered locally only."""
        await mesh_bus.publish("TTS.StateChanged", FakePayload(), event=True)
        inner_bus.publish.assert_awaited_once()
        routing_table.resolve.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_with_mesh_false_not_forwarded(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events with explicit mesh=False are NOT forwarded to peers."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": MeshServiceConfig(share=True, prefer="network", fallback="local")},
        )
        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)

        await bus.publish("TTS.StateChanged", FakePayload(), event=True, mesh=False)
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_with_mesh_true_forwarded_when_shared(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events with mesh=True are forwarded to peers when the module is shared."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": MeshServiceConfig(share=True, prefer="network", fallback="local")},
        )
        fake_peer = MagicMock()
        fake_peer.peer_id = "peer-1"
        routing_table.get_negotiated_peers.return_value = [fake_peer]

        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)
        await bus.publish("TTS.Started", FakePayload(), event=True, mesh=True)

        # Local delivery
        inner_bus.publish.assert_awaited_once()
        # Peer forwarding
        peer_bridge.fire_event.assert_called_once_with("peer-1", "TTS.Started", FakePayload())

    @pytest.mark.asyncio
    async def test_events_with_mesh_true_not_forwarded_when_not_shared(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events with mesh=True are NOT forwarded when the module share=false."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": MeshServiceConfig(share=False, prefer="network", fallback="local")},
        )
        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)

        await bus.publish("TTS.Started", FakePayload(), event=True, mesh=True)
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_mesh_forwarded_events_not_re_forwarded(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events from mesh peers (origin=mesh_forwarded) are NOT re-forwarded."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": MeshServiceConfig(share=True, prefer="network", fallback="local")},
        )
        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)

        await bus.publish(
            "TTS.Started", FakePayload(), event=True, mesh=True, origin="mesh_forwarded"
        )
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_with_mesh_true_no_sharing_config(self, mesh_bus, inner_bus, peer_bridge):
        """Events with mesh=True but no sharing config for module stay local."""
        # Default mesh_config fixture has no sharing entries
        await mesh_bus.publish("Unknown.Event", FakePayload(), event=True, mesh=True)
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_forwarded_to_multiple_peers(self, inner_bus, routing_table, peer_bridge):
        """Events with mesh=True are forwarded to ALL negotiated peers."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": MeshServiceConfig(share=True)},
        )
        peer1 = MagicMock()
        peer1.peer_id = "peer-1"
        peer2 = MagicMock()
        peer2.peer_id = "peer-2"
        routing_table.get_negotiated_peers.return_value = [peer1, peer2]

        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)
        await bus.publish("TTS.Started", FakePayload(), event=True, mesh=True)

        assert peer_bridge.fire_event.call_count == 2

    @pytest.mark.asyncio
    async def test_command_local_route(self, mesh_bus, inner_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="local", module="TTS")
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        inner_bus.publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_command_passes_selector_to_routing(self, mesh_bus, routing_table):
        selector = MeshAddressSelector(peer_id="peer-1")
        await mesh_bus.publish("TTS.Request", FakePayload(mesh_selector=selector), event=False)
        routing_table.resolve.assert_called_once_with("TTS.Request", selector=selector)

    @pytest.mark.asyncio
    async def test_command_remote_route(self, mesh_bus, inner_bus, routing_table, peer_bridge):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        peer_bridge.call.assert_awaited_once()
        inner_bus.publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_command_remote_failure_falls_back_local(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        peer_bridge.call.side_effect = Exception("connection lost")
        routing_table.resolve_fallback.return_value = RouteDecision(target="local", module="TTS")
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        inner_bus.publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_command_error_route_raises(self, mesh_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="error", module="TTS")
        with pytest.raises(RuntimeError, match="No remote peer"):
            await mesh_bus.publish("TTS.Request", FakePayload(), event=False)

    @pytest.mark.asyncio
    async def test_command_none_route_drops(self, mesh_bus, inner_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="none", module="TTS")
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        inner_bus.publish.assert_not_awaited()


class TestMeshBusRequest:
    """Tests for MeshBus.request()."""

    @pytest.mark.asyncio
    async def test_local_request(self, mesh_bus, inner_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="local", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_request(self, mesh_bus, routing_table, peer_bridge):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        peer_bridge.call.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_request_failure_falls_back_local(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        peer_bridge.call.side_effect = Exception("timeout")
        routing_table.resolve_fallback.return_value = RouteDecision(target="local", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_explicit_remote_request_failure_does_not_fallback_local(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        selector = MeshAddressSelector(peer_id="peer-1")
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS", selector=selector
        )
        peer_bridge.call.side_effect = Exception("timeout")
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="error",
            module="TTS",
            selector=selector,
            error_code="selector_target_failed",
            error_message="TTS explicit selector target failed; transparent fallback skipped",
        )

        result = await mesh_bus.request("TTS.Request", FakePayload(mesh_selector=selector))

        assert result.ok is False
        assert "transparent fallback skipped" in result.error
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_remote_error_result_triggers_fallback(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        peer_bridge.call.return_value = QueryResult(ok=False, error="Service error")
        routing_table.resolve_fallback.return_value = RouteDecision(target="local", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_error_route(self, mesh_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="error", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is False
        assert "No remote peer" in result.error

    @pytest.mark.asyncio
    async def test_none_route(self, mesh_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="none", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is False


class TestMeshBusSubscribe:
    """Tests for MeshBus.subscribe()."""

    def test_subscribe_delegates_to_inner(self, mesh_bus, inner_bus):
        handler = MagicMock()
        mesh_bus.subscribe("TTS.*", handler)
        inner_bus.subscribe.assert_called_once_with("TTS.*", handler)


class TestMeshBusLifecycle:
    """Tests for MeshBus start/stop."""

    @pytest.mark.asyncio
    async def test_start_delegates(self, mesh_bus, inner_bus):
        await mesh_bus.start()
        inner_bus.start.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_stop_delegates(self, mesh_bus, inner_bus):
        await mesh_bus.stop()
        inner_bus.stop.assert_awaited_once()
