"""MeshBus — Transparent mesh routing layer for the message bus.

Wraps an underlying ``LocalBus`` or ``BullMQBus`` and adds the ability
to route messages to remote peers based on mesh configuration.

For each ``publish()`` or ``request()`` call:
1. Check routing config for the topic's module
2. If prefer=local → deliver locally via inner bus
3. If prefer=network → find best remote peer, send via PeerBridge
4. On failure → apply fallback strategy (local, network, error)

Events (``event=True``) are **always** delivered locally first. Additionally,
if the caller passes ``mesh=True`` **and** the event's module has
``share: true`` in the mesh config, the event is forwarded to all
connected (negotiated) peers so they can react to remote lifecycle
events (e.g., TTS.Started, LLM.Response).

The ``mesh`` flag is a *publish-site* declaration: each individual
``bus.publish()`` call decides whether the event has cross-instance
relevance.  High-frequency / hardware-bound events (e.g. audio
streams) default to ``mesh=False`` and stay local.

Events received from peers (``origin="mesh_forwarded"``) are NOT
re-forwarded, preventing infinite loops.

The MeshBus implements the same ``MessageBus`` protocol, so all existing
services work without any modification.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.messaging.bus import Handler, QueryResult

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.config import MeshConfig
    from app.services.gateway.mesh.peer_bridge import PeerBridge
    from app.services.gateway.mesh.routing_table import RoutingTable


# Default remote call timeout in seconds (used when mesh_config has no override)
_DEFAULT_REMOTE_TIMEOUT: float = 30.0


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
        # Configurable remote call timeout (defaults to 30s)
        self._remote_timeout: float = getattr(
            mesh_config, "remote_timeout_s", _DEFAULT_REMOTE_TIMEOUT
        )

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
        mesh: bool = False,
        priority: int = 50,
        origin: str = "internal",
        reliable: bool = True,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
        reply_to: str | None = None,
        principal_id: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Publish with mesh routing.

        Events are delivered locally first. If ``mesh=True`` and the
        event's module has ``share: true`` in the mesh config, the event
        is forwarded to negotiated peers (unless it was itself forwarded,
        to prevent loops).
        Commands may be routed to remote peers based on routing config.

        Args:
            topic: Topic name (e.g., "TTS.Request")
            message: Message payload
            event: True for broadcast events, False for commands
            mesh: If True, forward this event to mesh peers when the
                  module is shared.  Ignored for commands (event=False).
            priority: Message priority (0=highest)
            origin: Message origin
            reliable: Whether to guarantee delivery
            ttl_ms: Time-to-live in milliseconds
            max_attempts: Maximum retry attempts
            reply_to: Optional reply topic for request/response pattern
        """
        # Events always go local first
        if event:
            await self._inner.publish(
                topic,
                message,
                event=True,
                priority=priority,
                origin=origin,
                reliable=reliable,
                ttl_ms=ttl_ms,
                max_attempts=max_attempts,
                reply_to=reply_to,
                principal_id=principal_id,
                correlation_id=correlation_id,
            )
            # Forward events to connected peers when mesh=True and module is shared
            if mesh and self._peer_bridge and origin != "mesh_forwarded":
                module = topic.split(".")[0] if "." in topic else topic
                sharing_cfg = self._config.services.get(module)
                if sharing_cfg and sharing_cfg.share:
                    peers = self._routing_table.get_negotiated_peers()
                    for peer in peers:
                        try:
                            self._peer_bridge.fire_event(
                                peer.peer_id,
                                topic,
                                message,
                            )
                        except Exception as exc:
                            log_debug(
                                f"MeshBus: Failed to forward event {topic} to {peer.peer_id}: {exc}"
                            )
            return

        # For commands, check routing
        route = self._routing_table.resolve(topic)
        log_debug(
            f"MeshBus: Routing command {topic} → target={route.target}, "
            f"peer={route.peer_id or 'n/a'}, module={route.module}"
        )

        if route.target == "local":
            await self._inner.publish(
                topic,
                message,
                event=False,
                priority=priority,
                origin=origin,
                reliable=reliable,
                ttl_ms=ttl_ms,
                max_attempts=max_attempts,
                reply_to=reply_to,
                principal_id=principal_id,
                correlation_id=correlation_id,
            )
            return

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            log_debug(f"MeshBus: Routing command {topic} to remote peer {route.peer_id}")
            try:
                result = await self._peer_bridge.call(
                    route.peer_id,
                    topic,
                    message,
                    timeout=self._remote_timeout,
                )
            except Exception as e:
                log_warning(f"MeshBus: Remote publish to {route.peer_id} failed: {e}")
            else:
                # Transport-level call succeeded; check application-level status
                if isinstance(result, QueryResult) and not result.ok:
                    log_warning(
                        f"MeshBus: Remote publish to {route.peer_id} returned "
                        f"application-level error: {result.error}; attempting fallback",
                    )
                else:
                    # Successful remote handling, no fallback needed
                    return

            # Try fallback (either transport error or application-level error)
            fallback = self._routing_table.resolve_fallback(
                topic,
                failed_peer_id=route.peer_id,
            )
            if fallback.target == "local":
                await self._inner.publish(
                    topic,
                    message,
                    event=False,
                    priority=priority,
                    origin=origin,
                    reliable=reliable,
                    ttl_ms=ttl_ms,
                    max_attempts=max_attempts,
                    reply_to=reply_to,
                    principal_id=principal_id,
                    correlation_id=correlation_id,
                )
                return
            elif fallback.target == "remote" and fallback.peer_id and self._peer_bridge:
                try:
                    result = await self._peer_bridge.call(
                        fallback.peer_id,
                        topic,
                        message,
                        timeout=self._remote_timeout,
                    )
                except Exception as e2:
                    log_warning(f"MeshBus: Fallback remote publish failed: {e2}")
                else:
                    # Fallback transport succeeded; check application-level status
                    if isinstance(result, QueryResult) and not result.ok:
                        log_warning(
                            "MeshBus: Fallback remote publish returned "
                            "application-level error; delivering locally as last resort",
                        )
                    else:
                        # Fallback remote handled the command successfully
                        return

                # Last resort — deliver locally so the command isn't dropped
                await self._inner.publish(
                    topic,
                    message,
                    event=False,
                    priority=priority,
                    origin=origin,
                    reliable=reliable,
                    ttl_ms=ttl_ms,
                    max_attempts=max_attempts,
                    reply_to=reply_to,
                    principal_id=principal_id,
                    correlation_id=correlation_id,
                )
                return

        if route.target == "error":
            raise RuntimeError(f"No remote peer available for {topic} and fallback=error")

        if route.target == "none":
            log_warning(f"MeshBus: No route for {topic} (target=none), dropping command")
            return

        # Default: deliver locally
        await self._inner.publish(
            topic,
            message,
            event=False,
            priority=priority,
            origin=origin,
            reliable=reliable,
            ttl_ms=ttl_ms,
            max_attempts=max_attempts,
            reply_to=reply_to,
            principal_id=principal_id,
            correlation_id=correlation_id,
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
        principal_id: str | None = None,
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
        log_debug(
            f"MeshBus: Routing request {topic} → target={route.target}, "
            f"peer={route.peer_id or 'n/a'}, module={route.module}"
        )

        if route.target == "local":
            return await self._inner.request(
                topic,
                message,
                priority=priority,
                origin=origin,
                timeout=timeout,
                ttl_ms=ttl_ms,
                max_attempts=max_attempts,
                principal_id=principal_id,
            )

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            log_debug(f"MeshBus: Routing request {topic} to remote peer {route.peer_id}")
            try:
                result = await self._peer_bridge.call(
                    route.peer_id,
                    topic,
                    message,
                    timeout=timeout,
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
                topic,
                failed_peer_id=route.peer_id,
            )
            if fallback.target == "local":
                log_debug(f"MeshBus: Falling back to local for {topic}")
                return await self._inner.request(
                    topic,
                    message,
                    priority=priority,
                    origin=origin,
                    timeout=timeout,
                    ttl_ms=ttl_ms,
                    max_attempts=max_attempts,
                    principal_id=principal_id,
                )
            elif fallback.target == "remote" and fallback.peer_id and self._peer_bridge:
                try:
                    return await self._peer_bridge.call(
                        fallback.peer_id,
                        topic,
                        message,
                        timeout=timeout,
                    )
                except Exception as e2:
                    log_warning(f"MeshBus: Fallback remote request failed: {e2}")
                    # Last resort — try local
                    return await self._inner.request(
                        topic,
                        message,
                        priority=priority,
                        origin=origin,
                        timeout=timeout,
                        ttl_ms=ttl_ms,
                        max_attempts=max_attempts,
                        principal_id=principal_id,
                    )

        if route.target == "error":
            return QueryResult(ok=False, error=f"No remote peer available for {topic}")

        if route.target == "none":
            return QueryResult(ok=False, error=f"No route available for {topic}")

        # Default: deliver locally
        return await self._inner.request(
            topic,
            message,
            priority=priority,
            origin=origin,
            timeout=timeout,
            ttl_ms=ttl_ms,
            max_attempts=max_attempts,
            principal_id=principal_id,
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
