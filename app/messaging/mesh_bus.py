"""MeshBus — Transparent mesh routing layer for the message bus.

Wraps an underlying ``LocalBus`` or ``BullMQBus`` and adds the ability
to route messages to remote peers based on mesh configuration.

For each ``publish()`` or ``request()`` call:
1. Check routing config for the topic's module
2. If prefer=local → deliver locally via inner bus
3. If prefer=network → find best remote peer, send via PeerBridge
4. On failure → apply fallback strategy (local, network, error)

Events (``event=True``) are **always** delivered locally. Only commands
and requests are candidates for remote routing.

The MeshBus implements the same ``MessageBus`` protocol, so all existing
services work without any modification.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging.bus import Handler, QueryResult

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.config import MeshConfig
    from app.services.gateway.mesh.peer_bridge import PeerBridge
    from app.services.gateway.mesh.routing_table import RoutingTable


class MeshBus:
    """Message bus with transparent mesh routing.

    Wraps an inner bus and adds remote peer routing. Implements the
    ``MessageBus`` protocol so it can be used as a drop-in replacement
    via ``set_bus()``.
    """

    def __init__(
        self,
        inner_bus: MessageBus,
        routing_table: RoutingTable,
        peer_bridge: PeerBridge | None,
        mesh_config: MeshConfig,
    ) -> None:
        self._inner = inner_bus
        self._routing_table = routing_table
        self._peer_bridge = peer_bridge
        self._config = mesh_config

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the underlying bus."""
        await self._inner.start()

    async def stop(self) -> None:
        """Stop the underlying bus."""
        await self._inner.stop()

    # ── Publish ──────────────────────────────────────────────────────────

    async def publish(
        self,
        topic: str,
        message: BaseModel,
        *,
        event: bool = True,
        priority: int = 50,
        origin: str = "internal",
        reliable: bool = True,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
    ) -> None:
        """Publish with mesh routing.

        Events are ALWAYS delivered locally (they're broadcasts for local state).
        Commands may be routed to remote peers based on routing config.

        Args:
            topic: Topic name (e.g., "TTS.Request")
            message: Message payload
            event: True for broadcast events, False for commands
            priority: Message priority (0=highest)
            origin: Message origin
            reliable: Whether to guarantee delivery
            ttl_ms: Time-to-live in milliseconds
            max_attempts: Maximum retry attempts
        """
        # Events always go local (they're broadcasts for local state)
        if event:
            await self._inner.publish(
                topic, message, event=True, priority=priority,
                origin=origin, reliable=reliable, ttl_ms=ttl_ms,
                max_attempts=max_attempts,
            )
            return

        # For commands, check routing
        route = self._routing_table.resolve(topic)

        if route.target == "local":
            await self._inner.publish(
                topic, message, event=False, priority=priority,
                origin=origin, reliable=reliable, ttl_ms=ttl_ms,
                max_attempts=max_attempts,
            )
            return

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            try:
                await self._peer_bridge.call(
                    route.peer_id, topic, message, timeout=30.0,
                )
                return
            except Exception as e:
                log_warning(f"MeshBus: Remote publish to {route.peer_id} failed: {e}")
                # Try fallback
                fallback = self._routing_table.resolve_fallback(
                    topic, failed_peer_id=route.peer_id,
                )
                if fallback.target == "local":
                    await self._inner.publish(
                        topic, message, event=False, priority=priority,
                        origin=origin, reliable=reliable, ttl_ms=ttl_ms,
                        max_attempts=max_attempts,
                    )
                    return
                elif fallback.target == "remote" and fallback.peer_id and self._peer_bridge:
                    try:
                        await self._peer_bridge.call(
                            fallback.peer_id, topic, message, timeout=30.0,
                        )
                        return
                    except Exception as e2:
                        log_warning(f"MeshBus: Fallback remote publish failed: {e2}")

        if route.target == "error":
            raise RuntimeError(f"No remote peer available for {topic} and fallback=error")

        if route.target == "none":
            log_warning(f"MeshBus: No route for {topic} (target=none), dropping command")
            return

        # Default: deliver locally
        await self._inner.publish(
            topic, message, event=False, priority=priority,
            origin=origin, reliable=reliable, ttl_ms=ttl_ms,
            max_attempts=max_attempts,
        )

    # ── Request ──────────────────────────────────────────────────────────

    async def request(
        self,
        topic: str,
        message: BaseModel,
        *,
        priority: int = 50,
        origin: str = "internal",
        timeout: float = 5.0,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
    ) -> QueryResult:
        """Request with mesh routing.

        Same routing logic as publish, but returns a result.

        Args:
            topic: Topic name for the request
            message: Request payload
            priority: Message priority
            origin: Message origin
            timeout: Response timeout in seconds
            ttl_ms: Time-to-live in milliseconds
            max_attempts: Maximum retry attempts

        Returns:
            QueryResult containing the response data or error
        """
        route = self._routing_table.resolve(topic)

        if route.target == "local":
            return await self._inner.request(
                topic, message, priority=priority, origin=origin,
                timeout=timeout, ttl_ms=ttl_ms, max_attempts=max_attempts,
            )

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            try:
                result = await self._peer_bridge.call(
                    route.peer_id, topic, message, timeout=timeout,
                )
                if result.ok:
                    return result
                # Remote returned error — try fallback
                log_warning(
                    f"MeshBus: Remote request to {route.peer_id} returned error: {result.error}"
                )
            except Exception as e:
                log_warning(f"MeshBus: Remote request to {route.peer_id} failed: {e}")

            # Try fallback
            fallback = self._routing_table.resolve_fallback(
                topic, failed_peer_id=route.peer_id,
            )
            if fallback.target == "local":
                log_info(f"MeshBus: Falling back to local for {topic}")
                return await self._inner.request(
                    topic, message, priority=priority, origin=origin,
                    timeout=timeout, ttl_ms=ttl_ms, max_attempts=max_attempts,
                )
            elif fallback.target == "remote" and fallback.peer_id and self._peer_bridge:
                try:
                    return await self._peer_bridge.call(
                        fallback.peer_id, topic, message, timeout=timeout,
                    )
                except Exception as e2:
                    log_warning(f"MeshBus: Fallback remote request failed: {e2}")
                    # Last resort — try local
                    return await self._inner.request(
                        topic, message, priority=priority, origin=origin,
                        timeout=timeout, ttl_ms=ttl_ms, max_attempts=max_attempts,
                    )

        if route.target == "error":
            return QueryResult(ok=False, error=f"No remote peer available for {topic}")

        if route.target == "none":
            return QueryResult(ok=False, error=f"No route available for {topic}")

        # Default: deliver locally
        return await self._inner.request(
            topic, message, priority=priority, origin=origin,
            timeout=timeout, ttl_ms=ttl_ms, max_attempts=max_attempts,
        )

    # ── Subscribe ────────────────────────────────────────────────────────

    def subscribe(self, topic: str, handler: Handler) -> None:
        """Subscribe always goes to the inner bus (local delivery).

        Remote services don't subscribe to our local bus — they subscribe
        on their own bus and we call them via PeerBridge.

        Args:
            topic: Topic pattern (supports wildcards)
            handler: Async function to handle messages
        """
        self._inner.subscribe(topic, handler)
