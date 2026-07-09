"""PeerBridge — Outbound RPC calls to remote peers via WebRTC DataChannels.

The PeerBridge is the counterpart of ``RPCHandler`` (which handles **inbound**
calls). When the MeshBus decides to route a message to a remote peer,
it calls ``PeerBridge.call()`` which:

1. Serializes the call as a JSON-RPC message
2. Sends it via the RTCClient's DataChannel to the target peer
3. Waits for the response (result or error)
4. Returns a ``QueryResult`` to the caller

The bridge also handles latency pong messages, routing them to the
LatencyMonitor for RTT tracking.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.messaging.bus import QueryResult

_STREAM_QUEUE_MAXSIZE = 128

if TYPE_CHECKING:
    from app.services.gateway.mesh.latency import LatencyMonitor
    from app.services.gateway.mesh.peer_registry import PeerRegistry
    from app.services.gateway.webrtc.rtc_client import RTCClient


def _rpc_params_without_mesh_selectors(payload: BaseModel | dict) -> dict[str, Any]:
    """Serialize RPC params without consumed top-level mesh selectors.

    ``dispatch_selector``/``mesh_selector``/``selector`` are local routing controls
    used to choose the outbound peer. Once PeerBridge has the target
    peer id, forwarding those fields would make the receiving peer reconstruct
    typed params and route the call again through its own MeshBus. Keep the
    normalization shallow so nested business data named ``selector`` is
    preserved.
    """

    if isinstance(payload, BaseModel):
        params = payload.model_dump(mode="json")
    elif isinstance(payload, dict):
        params = dict(payload)
    else:
        return {}

    params.pop("dispatch_selector", None)
    params.pop("mesh_selector", None)
    params.pop("selector", None)
    return params


def _rpc_call_message(
    *,
    req_id: str,
    topic: str,
    params: dict[str, Any],
    principal_id: str | None,
    effective_perms: list[str] | None,
    identity_source: str | None,
    method_type: str | None,
    caller_peer_id: str | None,
) -> dict[str, Any]:
    """Build the wire payload for one peer RPC call."""

    return {
        "type": "call",
        "id": req_id,
        "correlation_id": req_id,
        "method": topic,
        "params": params,
        "identity": {
            "principal_id": principal_id,
            "effective_perms": effective_perms,
            "source": identity_source,
            "method_type": method_type,
            "caller_peer_id": caller_peer_id,
        },
    }


class PeerBridge:
    """Sends outbound RPC calls to remote peers over WebRTC DataChannels.

    Each call creates a pending future keyed by a unique request ID.
    When the remote peer responds (via ``on_response()``), the future
    is resolved. A timeout ensures we don't wait forever.
    """

    def __init__(
        self,
        rtc_client: RTCClient,
        peer_registry: PeerRegistry,
    ) -> None:
        self._rtc_client = rtc_client
        self._registry = peer_registry
        self._pending_calls: dict[tuple[str, str], asyncio.Future] = {}
        self._pending_streams: dict[tuple[str, str], asyncio.Queue] = {}
        self._latency_monitor: LatencyMonitor | None = None

    def set_latency_monitor(self, monitor: LatencyMonitor) -> None:
        """Set the latency monitor for pong routing.

        Args:
            monitor: LatencyMonitor instance
        """
        self._latency_monitor = monitor

    async def call(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel | dict,
        timeout: float = 30.0,
        correlation_id: str | None = None,
        principal_id: str | None = None,
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
    ) -> QueryResult:
        """Send an RPC call to a remote peer and wait for the response.

        Args:
            peer_id: Target peer identifier
            topic: Bus topic (e.g., "TTS.Request")
            payload: Message payload (Pydantic model or dict)
            timeout: Response timeout in seconds

        Returns:
            QueryResult with the response data or error
        """
        req_id = correlation_id or uuid.uuid4().hex[:12]

        # Serialize payload. Mesh routing selectors are consumed by the local
        # MeshBus/RoutingTable before this point; do not forward them to the
        # receiving peer or its MeshBus may re-route instead of executing the
        # local service. Only strip top-level routing metadata so nested
        # business payloads remain unchanged.
        params = _rpc_params_without_mesh_selectors(payload)

        msg = _rpc_call_message(
            req_id=req_id,
            topic=topic,
            params=params,
            principal_id=principal_id,
            effective_perms=effective_perms,
            identity_source=identity_source,
            method_type=method_type,
            caller_peer_id=caller_peer_id,
        )

        # Create a future for the response
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[QueryResult] = loop.create_future()
        pending_key = (peer_id, req_id)
        self._pending_calls[pending_key] = fut

        # Increment active calls counter
        await self._registry.increment_active_calls(peer_id)

        try:
            # Send via DataChannel
            sent = self._rtc_client.send_to_peer(peer_id, json.dumps(msg))
            if not sent:
                self._pending_calls.pop(pending_key, None)
                await self._registry.decrement_active_calls(peer_id)
                return QueryResult(
                    ok=False,
                    error=f"Cannot send to peer {peer_id} (not connected)",
                )

            log_debug(
                f"PeerBridge: Sent call {req_id} to {peer_id} topic={topic} correlation_id={req_id}"
            )

            # Wait for response with timeout
            result = await asyncio.wait_for(fut, timeout)
            return result

        except TimeoutError:
            self._pending_calls.pop(pending_key, None)
            log_warning(
                f"PeerBridge: Call {req_id} to {peer_id} timed out ({timeout}s) "
                f"correlation_id={req_id}"
            )
            return QueryResult(
                ok=False,
                error=f"Remote call to {peer_id} timed out after {timeout}s",
            )
        except Exception as e:
            self._pending_calls.pop(pending_key, None)
            log_error(f"PeerBridge: Call {req_id} to {peer_id} failed: {e}")
            return QueryResult(ok=False, error=str(e))
        finally:
            await self._registry.decrement_active_calls(peer_id)

    async def stream_call(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel | dict,
        timeout: float = 30.0,
        correlation_id: str | None = None,
        principal_id: str | None = None,
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
    ) -> AsyncIterator[Any]:
        """Send an RPC call to a remote peer and yield streamed chunks."""
        req_id = correlation_id or uuid.uuid4().hex[:12]
        params = _rpc_params_without_mesh_selectors(payload)

        msg = _rpc_call_message(
            req_id=req_id,
            topic=topic,
            params=params,
            principal_id=principal_id,
            effective_perms=effective_perms,
            identity_source=identity_source,
            method_type=method_type,
            caller_peer_id=caller_peer_id,
        )
        queue: asyncio.Queue = asyncio.Queue(maxsize=_STREAM_QUEUE_MAXSIZE)
        pending_key = (peer_id, req_id)
        self._pending_streams[pending_key] = queue
        sent = False
        completed = False
        await self._registry.increment_active_calls(peer_id)
        try:
            sent = self._rtc_client.send_to_peer(peer_id, json.dumps(msg))
            if not sent:
                raise ConnectionError(f"Cannot send to peer {peer_id} (not connected)")

            while True:
                item = await asyncio.wait_for(queue.get(), timeout=timeout)
                kind, data = item
                if kind == "chunk":
                    yield data
                elif kind == "eof":
                    completed = True
                    return
                elif kind == "error":
                    completed = True
                    raise RuntimeError(data or "Remote stream error")
                elif kind == "result":
                    yield data
                    completed = True
                    return
        except TimeoutError as exc:
            raise TimeoutError(
                f"Remote stream call to {peer_id} timed out after {timeout}s"
            ) from exc
        finally:
            if sent and not completed:
                try:
                    self._rtc_client.send_to_peer(
                        peer_id,
                        json.dumps({"type": "cancel", "id": req_id}),
                    )
                except Exception as exc:
                    log_debug(f"PeerBridge: Failed to send stream cancel to {peer_id}: {exc}")
            self._pending_streams.pop(pending_key, None)
            await self._registry.decrement_active_calls(peer_id)

    def on_response(self, peer_id: str, msg: dict) -> None:
        """Handle a response (result or error) from a remote peer.

        Called by RTCClient when it receives a message with
        type="result" or type="error".

        Args:
            peer_id: Peer that sent the response
            msg: Parsed JSON message
        """
        req_id = msg.get("id")
        if isinstance(req_id, (tuple, list)) and len(req_id) >= 2:
            # Backward-compatible tolerance for older tests/helpers that
            # iterated the internal (peer_id, req_id) pending key and fed the
            # whole tuple back as the response id.
            peer_id = str(req_id[0])
            req_id = req_id[1]
        if not req_id:
            log_debug(f"PeerBridge: Response from {peer_id} missing 'id' field")
            return

        msg_type = msg.get("type")
        pending_key = (peer_id, req_id)
        stream_queue = self._pending_streams.get(pending_key)
        if stream_queue is not None:
            if msg_type == "chunk":
                self._enqueue_stream_item(stream_queue, ("chunk", msg.get("data")))
            elif msg_type == "eof":
                self._enqueue_stream_item(stream_queue, ("eof", None))
            elif msg_type == "result":
                self._enqueue_stream_item(stream_queue, ("result", msg.get("result")))
            elif msg_type == "error":
                error = msg.get("error", {})
                if isinstance(error, dict):
                    error_msg = error.get("message", "Remote error")
                else:
                    error_msg = str(error)
                self._enqueue_stream_item(stream_queue, ("error", error_msg))
            else:
                self._enqueue_stream_item(
                    stream_queue, ("error", f"Unexpected response type: {msg_type}")
                )
            return

        fut = self._pending_calls.pop(pending_key, None)
        if not fut:
            log_debug(
                f"PeerBridge: Response {req_id} from {peer_id} has no pending future "
                f"(may have timed out)"
            )
            return

        if fut.done():
            return

        if msg_type == "result":
            result_data = msg.get("result")
            fut.set_result(QueryResult(ok=True, data=result_data))
        elif msg_type == "error":
            error = msg.get("error", {})
            if isinstance(error, dict):
                error_msg = error.get("message", "Remote error")
            else:
                error_msg = str(error)
            fut.set_result(QueryResult(ok=False, error=error_msg))
        else:
            fut.set_result(QueryResult(ok=False, error=f"Unexpected response type: {msg_type}"))

    @staticmethod
    def _enqueue_stream_item(queue: asyncio.Queue, item: tuple[str, Any]) -> None:
        try:
            queue.put_nowait(item)
            return
        except asyncio.QueueFull:
            pass
        try:
            while True:
                queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            queue.put_nowait(("error", "Remote stream queue overflow"))
        except asyncio.QueueFull:
            log_warning("PeerBridge: Remote stream queue overflow and error enqueue failed")

    @staticmethod
    def _force_enqueue_stream_item(queue: asyncio.Queue, item: tuple[str, Any]) -> None:
        """Best-effort enqueue for shutdown paths where full queues must not raise."""
        while True:
            try:
                queue.put_nowait(item)
                return
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    log_warning("PeerBridge: Stream queue reported full but yielded no item")
                    return

    def on_pong(self, peer_id: str, msg: dict) -> None:
        """Handle a pong response — route to LatencyMonitor.

        Called by RTCClient when it receives a message with type="pong".

        Args:
            peer_id: Peer that sent the pong
            msg: Parsed pong message with 'id' and 'ts' fields
        """
        if self._latency_monitor:
            self._latency_monitor.on_pong(peer_id, msg)
        else:
            log_debug(f"PeerBridge: Received pong from {peer_id} but no LatencyMonitor configured")

    def get_pending_call_count(self) -> int:
        """Get the number of pending (in-flight) calls.

        Returns:
            Number of pending calls
        """
        return len(self._pending_calls)

    def fire_event(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel | dict,
        correlation_id: str | None = None,
    ) -> None:
        """Forward an event to a remote peer (fire-and-forget).

        Unlike ``call()``, this does not wait for a response.
        Events are best-effort; failures are silently logged.

        Args:
            peer_id: Target peer identifier
            topic: Event topic (e.g., "TTS.Started")
            payload: Event payload (Pydantic model or dict)
        """
        if isinstance(payload, BaseModel):
            params = payload.model_dump(mode="json")
        elif isinstance(payload, dict):
            params = payload
        else:
            params = {}

        msg = {
            "type": "event",
            "topic": topic,
            "params": params,
            "correlation_id": correlation_id,
        }

        sent = self._rtc_client.send_to_peer(peer_id, json.dumps(msg))
        if sent:
            log_debug(f"PeerBridge: Forwarded event {topic} to {peer_id}")
        else:
            log_debug(f"PeerBridge: Could not forward event {topic} to {peer_id} (not connected)")

    async def cancel_all(self) -> None:
        """Cancel all pending calls.

        Called during shutdown to prevent futures from hanging.
        """
        for _req_id, fut in list(self._pending_calls.items()):
            if not fut.done():
                fut.set_result(QueryResult(ok=False, error="PeerBridge shutting down"))
        for queue in list(self._pending_streams.values()):
            self._force_enqueue_stream_item(queue, ("error", "PeerBridge shutting down"))
        self._pending_calls.clear()
        self._pending_streams.clear()
