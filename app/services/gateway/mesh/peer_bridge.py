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
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.messaging.bus import QueryResult

if TYPE_CHECKING:
    from app.services.gateway.mesh.latency import LatencyMonitor
    from app.services.gateway.mesh.peer_registry import PeerRegistry
    from app.services.gateway.webrtc.rtc_client import RTCClient


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
        self._pending_calls: dict[str, asyncio.Future] = {}
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
        req_id = uuid.uuid4().hex[:12]

        # Serialize payload
        if isinstance(payload, BaseModel):
            params = payload.model_dump(mode="json")
        elif isinstance(payload, dict):
            params = payload
        else:
            params = {}

        # Create the RPC call message
        msg = {
            "type": "call",
            "id": req_id,
            "method": topic,
            "params": params,
        }

        # Create a future for the response
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[QueryResult] = loop.create_future()
        self._pending_calls[req_id] = fut

        # Increment active calls counter
        await self._registry.increment_active_calls(peer_id)

        try:
            # Send via DataChannel
            sent = self._rtc_client.send_to_peer(peer_id, json.dumps(msg))
            if not sent:
                self._pending_calls.pop(req_id, None)
                await self._registry.decrement_active_calls(peer_id)
                return QueryResult(
                    ok=False,
                    error=f"Cannot send to peer {peer_id} (not connected)",
                )

            log_debug(f"PeerBridge: Sent call {req_id} to {peer_id} topic={topic}")

            # Wait for response with timeout
            result = await asyncio.wait_for(fut, timeout)
            return result

        except TimeoutError:
            self._pending_calls.pop(req_id, None)
            log_warning(f"PeerBridge: Call {req_id} to {peer_id} timed out ({timeout}s)")
            return QueryResult(
                ok=False,
                error=f"Remote call to {peer_id} timed out after {timeout}s",
            )
        except Exception as e:
            self._pending_calls.pop(req_id, None)
            log_error(f"PeerBridge: Call {req_id} to {peer_id} failed: {e}")
            return QueryResult(ok=False, error=str(e))
        finally:
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
        if not req_id:
            log_debug(f"PeerBridge: Response from {peer_id} missing 'id' field")
            return

        fut = self._pending_calls.pop(req_id, None)
        if not fut:
            log_debug(
                f"PeerBridge: Response {req_id} from {peer_id} has no pending future "
                f"(may have timed out)"
            )
            return

        if fut.done():
            return

        msg_type = msg.get("type")
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

    async def cancel_all(self) -> None:
        """Cancel all pending calls.

        Called during shutdown to prevent futures from hanging.
        """
        for _req_id, fut in list(self._pending_calls.items()):
            if not fut.done():
                fut.set_result(
                    QueryResult(ok=False, error="PeerBridge shutting down")
                )
        self._pending_calls.clear()
