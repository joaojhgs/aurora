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

from typing import Any, Protocol

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.messaging.bus import Handler, MessageBus, QueryResult
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.mesh.tracing import ensure_correlation_id, get_payload_correlation_id

# Default remote call timeout in seconds (used when mesh_config has no override)
_DEFAULT_REMOTE_TIMEOUT: float = 30.0


class _RouteLike(Protocol):
    target: str
    peer_id: str | None
    module: str
    error_message: str | None


class _PeerLike(Protocol):
    peer_id: str


class _RoutingTableLike(Protocol):
    def resolve(
        self,
        topic: str,
        *,
        selector: MeshAddressSelector | None = None,
    ) -> _RouteLike: ...

    def resolve_fallback(
        self,
        topic: str,
        *,
        failed_peer_id: str,
        selector: MeshAddressSelector | None = None,
    ) -> _RouteLike: ...

    def get_negotiated_peers(self) -> list[_PeerLike]: ...


class _PeerBridgeLike(Protocol):
    async def call(
        self,
        peer_id: str,
        method: str,
        params: BaseModel,
        *,
        timeout: float,
        correlation_id: str | None = None,
    ) -> QueryResult: ...

    def fire_event(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel,
        *,
        correlation_id: str | None = None,
    ) -> None: ...


class _MeshConfigLike(Protocol):
    services: dict[str, Any]


class MeshBus:
    """Message bus with transparent mesh routing.

    Wraps an inner bus and adds remote peer routing. Implements the
    ``MessageBus`` protocol so it can be used as a drop-in replacement
    via ``set_bus()``.
    """

    def __init__(
        self,
        inner_bus: MessageBus,
        routing_table: _RoutingTableLike,
        peer_bridge: _PeerBridgeLike | None,
        mesh_config: _MeshConfigLike,
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
            event_correlation_id = correlation_id or get_payload_correlation_id(message)
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
                correlation_id=event_correlation_id,
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
                                correlation_id=event_correlation_id,
                            )
                        except Exception as exc:
                            log_debug(
                                f"MeshBus: Failed to forward event {topic} to {peer.peer_id}: {exc}"
                            )
            return

        # For commands, check routing
        selector = _extract_mesh_selector(message)
        trace_id = ensure_correlation_id(message, correlation_id)
        route = self._routing_table.resolve(topic, selector=selector)
        log_debug(
            f"MeshBus: Routing command {topic} → target={route.target}, "
            f"peer={route.peer_id or 'n/a'}, module={route.module}, "
            f"correlation_id={trace_id}"
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
                correlation_id=trace_id,
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
                    correlation_id=trace_id,
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
                selector=selector,
            )
            if fallback.target == "error":
                raise RuntimeError(
                    fallback.error_message or f"No fallback route available for {topic}"
                )
            if fallback.target == "none":
                log_warning(f"MeshBus: No fallback route for {topic} (target=none)")
                return
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
                    correlation_id=trace_id,
                )
                return
            elif fallback.target == "remote" and fallback.peer_id and self._peer_bridge:
                try:
                    result = await self._peer_bridge.call(
                        fallback.peer_id,
                        topic,
                        message,
                        timeout=self._remote_timeout,
                        correlation_id=trace_id,
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
                    correlation_id=trace_id,
                )
                return

        if route.target == "error":
            raise RuntimeError(route.error_message or f"No remote peer available for {topic}")

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
            correlation_id=trace_id,
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
        correlation_id: str | None = None,
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
        selector = _extract_mesh_selector(message)
        trace_id = ensure_correlation_id(message, correlation_id)
        route = self._routing_table.resolve(topic, selector=selector)
        log_debug(
            f"MeshBus: Routing request {topic} → target={route.target}, "
            f"peer={route.peer_id or 'n/a'}, module={route.module}, "
            f"correlation_id={trace_id}"
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
                correlation_id=trace_id,
            )

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            log_debug(f"MeshBus: Routing request {topic} to remote peer {route.peer_id}")
            try:
                result = await self._peer_bridge.call(
                    route.peer_id,
                    topic,
                    message,
                    timeout=timeout,
                    correlation_id=trace_id,
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
                selector=selector,
            )
            if fallback.target == "error":
                return QueryResult(
                    ok=False,
                    error=fallback.error_message or f"No fallback route available for {topic}",
                )
            if fallback.target == "none":
                return QueryResult(ok=False, error=f"No fallback route available for {topic}")
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
                    correlation_id=trace_id,
                )
            elif fallback.target == "remote" and fallback.peer_id and self._peer_bridge:
                try:
                    return await self._peer_bridge.call(
                        fallback.peer_id,
                        topic,
                        message,
                        timeout=timeout,
                        correlation_id=trace_id,
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
                        correlation_id=trace_id,
                    )

        if route.target == "error":
            return QueryResult(
                ok=False,
                error=route.error_message or f"No remote peer available for {topic}",
            )

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
            correlation_id=trace_id,
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

<<<<<<< HEAD
    def unsubscribe(self, topic: str, handler: Handler) -> None:
        """Unsubscribe from the inner local bus."""
        self._inner.unsubscribe(topic, handler)
=======

def _extract_mesh_selector(message: BaseModel) -> MeshAddressSelector | None:
    """Return a typed mesh selector from a bus payload when present."""

    selector = getattr(message, "mesh_selector", None)
    if isinstance(selector, MeshAddressSelector):
        return selector
    if isinstance(selector, dict):
        return MeshAddressSelector.model_validate(selector)
    return None
>>>>>>> 686ca75 (feat(mesh): add PER-135 hybrid addressing selectors)
