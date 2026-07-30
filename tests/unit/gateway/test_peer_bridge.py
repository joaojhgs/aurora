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
            for (peer_id, req_id), fut in list(bridge._pending_calls.items()):
                if not fut.done():
                    bridge.on_response(
                        peer_id,
                        {
                            "type": "result",
                            "id": req_id,
                            "result": {"text": "world"},
                        },
                    )

        task = asyncio.create_task(simulate_response())
        result = await bridge.call("peer-1", "TTS.Request", FakePayload(), timeout=5.0)
        await task

        assert result.ok is True
        assert result.data == {"text": "world"}
        mock_rtc_client.send_to_peer.assert_called_once()
        mock_peer_registry.decrement_active_calls.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_call_timeout(self, bridge, mock_rtc_client):
        result = await bridge.call(
            "peer-1",
            "TTS.Request",
            FakePayload(),
            timeout=0.1,
            correlation_id="trace-timeout",
        )
        assert result.ok is False
        assert "timed out" in result.error
        assert "trace-timeout" not in bridge._pending_calls

    @pytest.mark.asyncio
    async def test_call_send_failure(self, bridge, mock_rtc_client):
        mock_rtc_client.send_to_peer.return_value = False
        result = await bridge.call(
            "peer-1",
            "TTS.Request",
            FakePayload(),
            correlation_id="trace-send-failure",
        )
        assert result.ok is False
        assert "not connected" in result.error

    @pytest.mark.asyncio
    async def test_call_with_dict_payload(self, bridge, mock_rtc_client):
        async def simulate_response():
            await asyncio.sleep(0.05)
            for (peer_id, req_id), fut in list(bridge._pending_calls.items()):
                if not fut.done():
                    bridge.on_response(
                        peer_id,
                        {
                            "type": "result",
                            "id": req_id,
                            "result": {"ok": True},
                        },
                    )

        task = asyncio.create_task(simulate_response())
        result = await bridge.call("peer-1", "TTS.Request", {"text": "hi"}, timeout=5.0)
        await task
        assert result.ok is True

    @pytest.mark.asyncio
    async def test_call_strips_top_level_mesh_selectors_after_peer_selection(
        self, bridge, mock_rtc_client
    ):
        from app.shared.contracts.models.mesh import MeshAddressSelector
        from app.shared.contracts.models.orchestrator import (
            OrchestratorMethods,
            OrchestratorProcessRequest,
        )

        async def simulate_response():
            await asyncio.sleep(0.05)
            bridge.on_response(
                "peer-1",
                {"type": "result", "id": "trace-strip", "result": {"ok": True}},
            )

        selector = MeshAddressSelector(peer_id="peer-1")
        task = asyncio.create_task(simulate_response())
        result = await bridge.call(
            "peer-1",
            OrchestratorMethods.EXTERNAL_USER_INPUT,
            OrchestratorProcessRequest(
                text="hello",
                mesh_selector=selector,
                selector=selector,
                dispatch_selector=selector,
                inference_selector=selector,
                inference_provider_id="provider-1",
                inference_model_id="model-1",
            ),
            timeout=5.0,
            correlation_id="trace-strip",
        )
        await task

        sent = json.loads(mock_rtc_client.send_to_peer.call_args.args[1])
        assert result.ok is True
        assert sent["method"] == OrchestratorMethods.EXTERNAL_USER_INPUT
        assert sent["params"]["text"] == "hello"
        assert sent["params"]["source"] == "external"
        assert sent["params"]["stream"] is False
        assert "dispatch_selector" not in sent["params"]
        assert "mesh_selector" not in sent["params"]
        assert "selector" not in sent["params"]
        assert sent["params"]["inference_selector"]["peer_id"] == "peer-1"
        assert sent["params"]["inference_provider_id"] == "provider-1"
        assert sent["params"]["inference_model_id"] == "model-1"

    @pytest.mark.asyncio
    async def test_call_uses_selected_tool_identity_for_remote_tooling_dispatch(
        self, bridge, mock_rtc_client
    ):
        """Bindable consumer aliases become the provider's canonical tool id."""

        from app.shared.contracts.models.mesh import MeshAddressSelector
        from app.shared.contracts.models.tooling import (
            ToolingExecuteToolRequest,
            ToolingMethods,
        )

        canonical_tool_id = "aurora-tool:v1:browser-peer:Tooling:native.get_device_status"

        async def simulate_response():
            await asyncio.sleep(0.05)
            bridge.on_response(
                "browser-peer",
                {"type": "result", "id": "trace-tool", "result": {"ok": True}},
            )

        task = asyncio.create_task(simulate_response())
        result = await bridge.call(
            "browser-peer",
            ToolingMethods.EXECUTE_TOOL,
            ToolingExecuteToolRequest(
                tool_name="browser_device_status",
                arguments={},
                mesh_selector=MeshAddressSelector(
                    peer_id="browser-peer",
                    service_instance_id="local:browser-peer:Tooling",
                    tool_id=canonical_tool_id,
                ),
            ),
            timeout=5.0,
            correlation_id="trace-tool",
        )
        await task

        sent = json.loads(mock_rtc_client.send_to_peer.call_args.args[1])
        assert result.ok is True
        assert sent["method"] == ToolingMethods.EXECUTE_TOOL
        assert sent["params"]["tool_name"] == canonical_tool_id
        assert "mesh_selector" not in sent["params"]

    @pytest.mark.asyncio
    async def test_stream_call_strips_top_level_mesh_selectors_but_preserves_nested_business_data(
        self, bridge, mock_rtc_client
    ):
        from app.shared.contracts.models.mesh import MeshAddressSelector
        from app.shared.contracts.models.orchestrator import (
            OrchestratorChatMessage,
            OrchestratorInferChatRequest,
            OrchestratorMethods,
        )

        async def simulate_eof():
            await asyncio.sleep(0.05)
            bridge.on_response("peer-1", {"type": "eof", "id": "stream-strip"})

        selector = MeshAddressSelector(peer_id="peer-1")
        payload = OrchestratorInferChatRequest(
            messages=[OrchestratorChatMessage(role="user", content="hello")],
            stream=True,
            mesh_selector=selector,
            selector=selector,
            metadata={
                "dispatch_selector": {"business": "preserved"},
                "selector": {"business": "preserved"},
            },
        )

        task = asyncio.create_task(simulate_eof())
        chunks = [
            chunk
            async for chunk in bridge.stream_call(
                "peer-1",
                OrchestratorMethods.STREAM_INFER_CHAT,
                payload,
                timeout=5.0,
                correlation_id="stream-strip",
            )
        ]
        await task

        sent = json.loads(mock_rtc_client.send_to_peer.call_args.args[1])
        assert chunks == []
        assert sent["method"] == OrchestratorMethods.STREAM_INFER_CHAT
        assert "dispatch_selector" not in sent["params"]
        assert "mesh_selector" not in sent["params"]
        assert "selector" not in sent["params"]
        assert sent["params"]["metadata"]["dispatch_selector"] == {"business": "preserved"}
        assert sent["params"]["metadata"]["selector"] == {"business": "preserved"}

    @pytest.mark.asyncio
    async def test_stream_call_sends_cancel_when_consumer_stops(self, bridge, mock_rtc_client):
        from app.shared.contracts.models.orchestrator import OrchestratorMethods

        stream = bridge.stream_call(
            "peer-1",
            OrchestratorMethods.STREAM_INFER_CHAT,
            FakePayload(),
            timeout=5.0,
            correlation_id="stream-cancel",
        )

        task = asyncio.create_task(stream.__anext__())
        await asyncio.sleep(0.05)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

        sent_payloads = [
            json.loads(call.args[1]) for call in mock_rtc_client.send_to_peer.call_args_list
        ]
        assert sent_payloads[0]["type"] == "call"
        assert sent_payloads[-1] == {"type": "cancel", "id": "stream-cancel"}

    @pytest.mark.asyncio
    async def test_call_sends_correlation_id(self, bridge, mock_rtc_client):
        async def simulate_response():
            await asyncio.sleep(0.05)
            bridge.on_response(
                "peer-1",
                {
                    "type": "result",
                    "id": "trace-123",
                    "result": {"ok": True},
                },
            )

        task = asyncio.create_task(simulate_response())
        result = await bridge.call(
            "peer-1",
            "TTS.Request",
            FakePayload(),
            timeout=5.0,
            correlation_id="trace-123",
        )
        await task

        sent = json.loads(mock_rtc_client.send_to_peer.call_args.args[1])
        assert sent["id"] == "trace-123"
        assert sent["correlation_id"] == "trace-123"
        assert result.ok is True


class TestPeerBridgeOnResponse:
    """Tests for PeerBridge.on_response()."""

    @pytest.mark.asyncio
    async def test_result_response(self, bridge):
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        bridge._pending_calls[("peer-1", "req-123")] = fut

        bridge.on_response(
            "peer-1",
            {
                "type": "result",
                "id": "req-123",
                "result": {"data": 42},
            },
        )

        result = fut.result()
        assert result.ok is True
        assert result.data == {"data": 42}

    @pytest.mark.asyncio
    async def test_error_response(self, bridge):
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        bridge._pending_calls[("peer-1", "req-456")] = fut

        bridge.on_response(
            "peer-1",
            {
                "type": "error",
                "id": "req-456",
                "error": {"message": "Not found", "code": 404},
            },
        )

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

    @pytest.mark.asyncio
    async def test_response_rejects_composite_id_without_overriding_transport_peer(self, bridge):
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        bridge._pending_calls[("selected-peer", "req-selected")] = fut

        bridge.on_response(
            "wrong-peer",
            {
                "type": "result",
                "id": ["selected-peer", "req-selected"],
                "result": {"poison": True},
            },
        )

        assert not fut.done()
        assert ("selected-peer", "req-selected") in bridge._pending_calls

    @pytest.mark.asyncio
    async def test_response_from_wrong_peer_does_not_resolve_pending_call(self, bridge):
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        bridge._pending_calls[("selected-peer", "req-selected")] = fut

        bridge.on_response(
            "wrong-peer",
            {
                "type": "result",
                "id": "req-selected",
                "result": {"poison": True},
            },
        )

        assert not fut.done()
        assert ("selected-peer", "req-selected") in bridge._pending_calls

    @pytest.mark.asyncio
    async def test_stream_response_from_wrong_peer_does_not_poison_queue(self, bridge):
        queue: asyncio.Queue = asyncio.Queue()
        bridge._pending_streams[("selected-peer", "stream-1")] = queue

        bridge.on_response(
            "wrong-peer",
            {
                "type": "chunk",
                "id": "stream-1",
                "data": {"poison": True},
            },
        )

        assert queue.empty()
        assert ("selected-peer", "stream-1") in bridge._pending_streams


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

    def test_initial_latency_sample_uses_tracked_burst(self, bridge):
        mock_monitor = MagicMock()
        mock_monitor.ping_peer.return_value = True
        bridge.set_latency_monitor(mock_monitor)

        sent = bridge.request_latency_sample("peer-1", sample_count=3, reset=True)

        assert sent == 3
        mock_monitor.reset_peer.assert_called_once_with("peer-1")
        assert mock_monitor.ping_peer.call_count == 3


class TestPeerBridgeCancelAll:
    """Tests for cancel_all()."""

    @pytest.mark.asyncio
    async def test_cancel_all_resolves_futures(self, bridge):
        loop = asyncio.get_running_loop()
        fut1 = loop.create_future()
        fut2 = loop.create_future()
        bridge._pending_calls[("peer-1", "a")] = fut1
        bridge._pending_calls[("peer-2", "b")] = fut2

        await bridge.cancel_all()

        assert fut1.done()
        assert fut2.done()
        assert fut1.result().ok is False
        assert "shutting down" in fut1.result().error
        assert bridge.get_pending_call_count() == 0

    @pytest.mark.asyncio
    async def test_cancel_all_handles_full_stream_queue(self, bridge):
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        queue.put_nowait(("chunk", {"stale": True}))
        bridge._pending_streams[("peer-1", "stream-full")] = queue

        await bridge.cancel_all()

        assert bridge._pending_streams == {}
        kind, message = queue.get_nowait()
        assert kind == "error"
        assert "shutting down" in message
