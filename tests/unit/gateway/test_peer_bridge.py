"""Unit tests for PeerBridge outbound RPC."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.services.gateway.mesh.peer_bridge import PeerBridge


class FakePayload(BaseModel):
    text: str = "hello"


@pytest.fixture
def mock_rtc_client():
    client = MagicMock()
    client.send_to_peer = MagicMock(return_value=True)
    return client


@pytest.fixture
def mock_peer_registry():
    reg = AsyncMock()
    reg.increment_active_calls = AsyncMock(return_value=True)
    reg.decrement_active_calls = AsyncMock()
    return reg


@pytest.fixture
def bridge(mock_rtc_client, mock_peer_registry):
    return PeerBridge(mock_rtc_client, mock_peer_registry)


class TestPeerBridgeCall:
    """Tests for PeerBridge.call()."""

    @pytest.mark.asyncio
    async def test_successful_call(self, bridge, mock_rtc_client, mock_peer_registry):
        """Simulate a call where the response arrives before timeout."""

        async def simulate_response():
            await asyncio.sleep(0.05)
            # Find the pending call and resolve it
            for req_id, fut in list(bridge._pending_calls.items()):
                if not fut.done():
                    bridge.on_response("peer-1", {
                        "type": "result",
                        "id": req_id,
                        "result": {"text": "world"},
                    })

        task = asyncio.create_task(simulate_response())
        result = await bridge.call("peer-1", "TTS.Request", FakePayload(), timeout=5.0)
        await task

        assert result.ok is True
        assert result.data == {"text": "world"}
        mock_rtc_client.send_to_peer.assert_called_once()
        mock_peer_registry.decrement_active_calls.assert_awaited()

    @pytest.mark.asyncio
    async def test_call_timeout(self, bridge, mock_rtc_client):
        result = await bridge.call("peer-1", "TTS.Request", FakePayload(), timeout=0.1)
        assert result.ok is False
        assert "timed out" in result.error

    @pytest.mark.asyncio
    async def test_call_send_failure(self, bridge, mock_rtc_client):
        mock_rtc_client.send_to_peer.return_value = False
        result = await bridge.call("peer-1", "TTS.Request", FakePayload())
        assert result.ok is False
        assert "not connected" in result.error

    @pytest.mark.asyncio
    async def test_call_with_dict_payload(self, bridge, mock_rtc_client):
        async def simulate_response():
            await asyncio.sleep(0.05)
            for req_id, fut in list(bridge._pending_calls.items()):
                if not fut.done():
                    bridge.on_response("peer-1", {
                        "type": "result",
                        "id": req_id,
                        "result": {"ok": True},
                    })

        task = asyncio.create_task(simulate_response())
        result = await bridge.call("peer-1", "TTS.Request", {"text": "hi"}, timeout=5.0)
        await task
        assert result.ok is True


class TestPeerBridgeOnResponse:
    """Tests for PeerBridge.on_response()."""

    @pytest.mark.asyncio
    async def test_result_response(self, bridge):
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        bridge._pending_calls["req-123"] = fut

        bridge.on_response("peer-1", {
            "type": "result",
            "id": "req-123",
            "result": {"data": 42},
        })

        result = fut.result()
        assert result.ok is True
        assert result.data == {"data": 42}

    @pytest.mark.asyncio
    async def test_error_response(self, bridge):
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        bridge._pending_calls["req-456"] = fut

        bridge.on_response("peer-1", {
            "type": "error",
            "id": "req-456",
            "error": {"message": "Not found", "code": 404},
        })

        result = fut.result()
        assert result.ok is False
        assert "Not found" in result.error

    @pytest.mark.asyncio
    async def test_response_no_pending(self, bridge):
        # Should not raise
        bridge.on_response("peer-1", {"type": "result", "id": "unknown"})

    @pytest.mark.asyncio
    async def test_response_missing_id(self, bridge):
        bridge.on_response("peer-1", {"type": "result"})


class TestPeerBridgeOnPong:
    """Tests for pong routing to LatencyMonitor."""

    def test_pong_with_monitor(self, bridge):
        mock_monitor = MagicMock()
        bridge.set_latency_monitor(mock_monitor)
        bridge.on_pong("peer-1", {"id": "ping-1", "ts": 1234})
        mock_monitor.on_pong.assert_called_once_with("peer-1", {"id": "ping-1", "ts": 1234})

    def test_pong_without_monitor(self, bridge):
        # Should not raise
        bridge.on_pong("peer-1", {"id": "ping-1", "ts": 1234})


class TestPeerBridgeCancelAll:
    """Tests for cancel_all()."""

    @pytest.mark.asyncio
    async def test_cancel_all_resolves_futures(self, bridge):
        loop = asyncio.get_running_loop()
        fut1 = loop.create_future()
        fut2 = loop.create_future()
        bridge._pending_calls["a"] = fut1
        bridge._pending_calls["b"] = fut2

        await bridge.cancel_all()

        assert fut1.done()
        assert fut2.done()
        assert fut1.result().ok is False
        assert "shutting down" in fut1.result().error
        assert bridge.get_pending_call_count() == 0
