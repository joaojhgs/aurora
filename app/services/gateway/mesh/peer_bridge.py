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
import inspect
import json
import uuid
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.messaging.bus import QueryResult
from app.services.gateway.webrtc.peer_protocol import CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tts import TTSMethods

_STREAM_QUEUE_MAXSIZE = 128
_SCOPED_ONLY_EVENT_TOPICS = frozenset({OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK})
_SENSITIVE_EVENT_TOPICS = _SCOPED_ONLY_EVENT_TOPICS

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
    auth_grant_revision: int | None,
    manifest_revision: int | None,
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
            "auth_grant_revision": auth_grant_revision,
            "manifest_revision": manifest_revision,
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
        *,
        legacy_event_broadcast: bool = True,
    ) -> None:
        self._rtc_client = rtc_client
        self._registry = peer_registry
        self._legacy_event_broadcast = bool(legacy_event_broadcast)
        self._pending_calls: dict[tuple[str, str], asyncio.Future] = {}
        self._pending_streams: dict[tuple[str, str], asyncio.Queue] = {}
        self._latency_monitor: LatencyMonitor | None = None

    def set_legacy_event_broadcast(self, enabled: bool) -> None:
        """Enable or disable non-sensitive broadcasts to pre-subscription peers."""
        self._legacy_event_broadcast = bool(enabled)

    def set_latency_monitor(self, monitor: LatencyMonitor) -> None:
        """Set the latency monitor for pong routing.

        Args:
            monitor: LatencyMonitor instance
        """
        self._latency_monitor = monitor

    def request_latency_sample(
        self,
        peer_id: str,
        *,
        sample_count: int = 1,
        reset: bool = False,
    ) -> int:
        """Request tracked RTT samples through the configured monitor.

        A short initial burst lets the rolling median reject a one-off startup
        delay without waiting for the next periodic monitor interval.
        """
        if not self._latency_monitor:
            log_debug(
                f"PeerBridge: Cannot sample latency for {peer_id}; no LatencyMonitor configured"
            )
            return 0
        if reset:
            self._latency_monitor.reset_peer(peer_id)
        sent = 0
        for _ in range(max(1, sample_count)):
            if self._latency_monitor.ping_peer(peer_id):
                sent += 1
        return sent

    def _peer_role(self, peer_id: str) -> str:
        provider = getattr(self._rtc_client, "peer_protocol_role", None)
        if not callable(provider):
            return "hybrid"
        try:
            role = provider(peer_id)
        except Exception as error:
            log_debug(f"PeerBridge: Failed to resolve role for {peer_id}: {error}")
            return "hybrid"
        return role if role in {"provider", "consumer", "hybrid"} else "hybrid"

    def _peer_supports_capability(self, peer_id: str, capability: str) -> bool:
        provider = getattr(self._rtc_client, "peer_supports_capability", None)
        if not callable(provider):
            return False
        try:
            return bool(provider(peer_id, capability))
        except TypeError:
            try:
                return bool(provider(capability))
            except Exception as error:
                log_debug(f"PeerBridge: Failed to check {capability} for {peer_id}: {error}")
                return False
        except Exception as error:
            log_debug(f"PeerBridge: Failed to check {capability} for {peer_id}: {error}")
            return False

    async def _send_to_peer(self, peer_id: str, text: str) -> bool:
        async_send = getattr(self._rtc_client, "send_to_peer_async", None)
        if callable(async_send) and inspect.iscoroutinefunction(async_send):
            return bool(await async_send(peer_id, text))
        return bool(self._rtc_client.send_to_peer(peer_id, text))

    def _has_event_interest(
        self, peer_id: str, topic: str, correlation_id: str | None, *, sensitive: bool
    ) -> bool:
        registry = getattr(self._rtc_client, "event_subscriptions", None)
        if registry is None:
            return False
        is_interested = getattr(registry, "is_interested", None)
        if not callable(is_interested):
            return False
        try:
            return bool(is_interested(peer_id, topic, correlation_id, sensitive=sensitive))
        except Exception as error:
            log_debug(f"PeerBridge: Event interest check failed for {peer_id}: {error}")
            return False

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
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
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
        if self._peer_role(peer_id) == "consumer":
            return QueryResult(ok=False, error=f"Peer {peer_id} is consumer-only")

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
            auth_grant_revision=auth_grant_revision,
            manifest_revision=manifest_revision,
        )

        # Create a future for the response
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[QueryResult] = loop.create_future()
        pending_key = (peer_id, req_id)
        self._pending_calls[pending_key] = fut

        try:
            # Send via DataChannel
            sent = await self._send_to_peer(peer_id, json.dumps(msg))
            if not sent:
                self._pending_calls.pop(pending_key, None)
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
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
    ) -> AsyncIterator[Any]:
        """Send an RPC call to a remote peer and yield streamed chunks."""
        if self._peer_role(peer_id) == "consumer":
            raise PermissionError(f"Peer {peer_id} is consumer-only")
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
            auth_grant_revision=auth_grant_revision,
            manifest_revision=manifest_revision,
        )
        queue: asyncio.Queue = asyncio.Queue(maxsize=_STREAM_QUEUE_MAXSIZE)
        pending_key = (peer_id, req_id)
        self._pending_streams[pending_key] = queue
        sent = False
        completed = False
        try:
            sent = await self._send_to_peer(peer_id, json.dumps(msg))
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
                    await self._send_to_peer(
                        peer_id,
                        json.dumps({"type": "cancel", "id": req_id}),
                    )
                except Exception as exc:
                    log_debug(f"PeerBridge: Failed to send stream cancel to {peer_id}: {exc}")
            self._pending_streams.pop(pending_key, None)

    def on_response(self, peer_id: str, msg: dict) -> None:
        """Handle a response (result or error) from a remote peer.

        Called by RTCClient when it receives a message with
        type="result" or type="error".

        Args:
            peer_id: Peer that sent the response
            msg: Parsed JSON message
        """
        req_id = msg.get("id")
        if not isinstance(req_id, str) or not req_id:
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

    async def fire_event_async(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel | dict,
        correlation_id: str | None = None,
        *,
        target_peer_id: str | None = None,
    ) -> bool:
        """Forward an event after negotiated subscription filtering."""

        if target_peer_id is not None and target_peer_id != peer_id:
            log_debug(f"PeerBridge: Suppressed event {topic} to {peer_id}; target={target_peer_id}")
            return False

        sensitive = topic in _SENSITIVE_EVENT_TOPICS
        scoped_only = topic in _SCOPED_ONLY_EVENT_TOPICS
        if scoped_only and target_peer_id is None:
            log_debug(f"PeerBridge: Suppressed scoped-only event {topic}; target absent")
            return False

        scoped = self._peer_supports_capability(peer_id, CAP_SCOPED_EVENT_SUBSCRIPTIONS_V1)
        if scoped:
            if not self._has_event_interest(peer_id, topic, correlation_id, sensitive=sensitive):
                log_debug(f"PeerBridge: Suppressed event {topic} to {peer_id}; no exact interest")
                return False
        elif sensitive or scoped_only:
            log_debug(
                f"PeerBridge: Suppressed sensitive/scoped event {topic} to {peer_id}; "
                "scoped subscriptions absent"
            )
            return False
        elif not self._legacy_event_broadcast:
            log_debug(
                f"PeerBridge: Suppressed legacy event {topic} to {peer_id}; "
                "legacy event broadcast disabled"
            )
            return False

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

        sent = await self._send_to_peer(peer_id, json.dumps(msg))
        if sent:
            log_debug(f"PeerBridge: Forwarded event {topic} to {peer_id}")
        else:
            log_debug(f"PeerBridge: Could not forward event {topic} to {peer_id} (not connected)")
        return bool(sent)

    def fire_event(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel | dict,
        correlation_id: str | None = None,
        *,
        target_peer_id: str | None = None,
    ) -> bool:
        """Synchronous compatibility wrapper for legacy test doubles/callers."""

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(
                self.fire_event_async(
                    peer_id,
                    topic,
                    payload,
                    correlation_id=correlation_id,
                    target_peer_id=target_peer_id,
                )
            )
        raise RuntimeError("fire_event_async must be awaited inside an event loop")

    def cleanup_peer(self, peer_id: str) -> None:
        """Remove pending transport state and subscriptions for a disconnected peer."""

        for key, fut in list(self._pending_calls.items()):
            if key[0] == peer_id:
                if not fut.done():
                    fut.set_result(QueryResult(ok=False, error=f"Peer {peer_id} disconnected"))
                self._pending_calls.pop(key, None)
        for key, queue in list(self._pending_streams.items()):
            if key[0] == peer_id:
                self._force_enqueue_stream_item(queue, ("error", f"Peer {peer_id} disconnected"))
                self._pending_streams.pop(key, None)
        registry = getattr(self._rtc_client, "event_subscriptions", None)
        cleanup = getattr(registry, "cleanup_peer", None)
        if callable(cleanup):
            cleanup(peer_id)

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
