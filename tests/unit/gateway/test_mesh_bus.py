"""Unit tests for MeshBus routing decisions and fallback behavior."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig, ServiceRoutingConfig, ServiceSharingConfig
from app.services.gateway.mesh.models import RouteDecision


class FakePayload(BaseModel):
    text: str = "hello"


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
        routing={
            "TTS": ServiceRoutingConfig(prefer="network", fallback="local"),
        },
    )


@pytest.fixture
def mesh_bus(inner_bus, routing_table, peer_bridge, mesh_config):
    return MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)


class TestMeshBusPublish:
    """Tests for MeshBus.publish()."""

    @pytest.mark.asyncio
    async def test_events_always_go_local(self, mesh_bus, inner_bus, routing_table):
        await mesh_bus.publish("TTS.StateChanged", FakePayload(), event=True)
        inner_bus.publish.assert_awaited_once()
        routing_table.resolve.assert_not_called()

    @pytest.mark.asyncio
    async def test_command_local_route(self, mesh_bus, inner_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="local", module="TTS")
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        inner_bus.publish.assert_awaited_once()

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
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="local", module="TTS"
        )
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
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="local", module="TTS"
        )
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_error_result_triggers_fallback(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        peer_bridge.call.return_value = QueryResult(ok=False, error="Service error")
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="local", module="TTS"
        )
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
