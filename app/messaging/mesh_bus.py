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

import inspect
from collections.abc import AsyncIterator, Mapping
from types import SimpleNamespace
from typing import Any, Protocol

from pydantic import BaseModel

from app.helpers.aurora_logger import log_debug, log_error, log_warning
from app.messaging.bus import Handler, MessageBus, QueryResult
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.tts import TTSMethods
from app.shared.mesh.tracing import ensure_correlation_id, get_payload_correlation_id

# Default remote call timeout in seconds (used when mesh_config has no override)
_DEFAULT_REMOTE_TIMEOUT: float = 30.0
_SCOPED_ONLY_EVENT_TOPICS = frozenset({OrchestratorMethods.RESPONSE, TTSMethods.AUDIO_CHUNK})


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
        routing_config: Any | None = None,
        mesh_config: Any | None = None,
        selector: MeshAddressSelector | None = None,
        policy_snapshot: MeshPolicySnapshot | None = None,
    ) -> _RouteLike: ...

    def resolve_fallback(
        self,
        topic: str,
        *,
        routing_config: Any | None = None,
        mesh_config: Any | None = None,
        failed_peer_id: str,
        selector: MeshAddressSelector | None = None,
        policy_snapshot: MeshPolicySnapshot | None = None,
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
        principal_id: str | None = None,
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
    ) -> QueryResult: ...

    def stream_call(
        self,
        peer_id: str,
        method: str,
        params: BaseModel,
        *,
        timeout: float,
        correlation_id: str | None = None,
        principal_id: str | None = None,
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
    ) -> AsyncIterator[Any]: ...

    def fire_event(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel,
        *,
        correlation_id: str | None = None,
        target_peer_id: str | None = None,
    ) -> bool: ...

    async def fire_event_async(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel,
        *,
        correlation_id: str | None = None,
        target_peer_id: str | None = None,
    ) -> bool: ...


class _MeshConfigLike(Protocol):
    services: dict[str, Any]


class _MeshPolicySnapshotLike(Protocol):
    revision: int
    source_revision: int | None
    mesh_config: _MeshConfigLike


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
        policy_provider: Any | None = None,
    ) -> None:
        self._inner = inner_bus
        self._routing_table = routing_table
        self._peer_bridge = peer_bridge
        self._config = mesh_config
        self._policy_provider = policy_provider

    def _operation_snapshot(self) -> MeshPolicySnapshot:
        if self._policy_provider is None:
            return MeshPolicySnapshot(revision=0, source_revision=None, mesh_config=self._config)
        return self._policy_provider()

    def current_mesh_policy_snapshot(self) -> MeshPolicySnapshot:
        """Return one synchronous snapshot of the live mesh policy."""
        return self._operation_snapshot()

    def current_mesh_config(self) -> _MeshConfigLike:
        """Return one synchronous snapshot of the live mesh policy."""
        return self.current_mesh_policy_snapshot().mesh_config

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
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
        projected_service_id: str | None = None,
        projected_method_id: str | None = None,
        projected_method_topics: list[str] | None = None,
        projected_method_set_digest: str | None = None,
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
                effective_perms=effective_perms,
                identity_source=identity_source,
                method_type=method_type,
                caller_peer_id=caller_peer_id,
                auth_grant_revision=auth_grant_revision,
                manifest_revision=manifest_revision,
                projected_service_id=projected_service_id,
                projected_method_id=projected_method_id,
                correlation_id=event_correlation_id,
            )
            # Forward events to connected peers when mesh=True and module is shared
            if mesh and self._peer_bridge and origin != "mesh_forwarded":
                module = topic.split(".")[0] if "." in topic else topic
                mesh_config = self.current_mesh_policy_snapshot().mesh_config
                sharing_cfg = mesh_config.services.get(module)
                if mesh_config.enabled and sharing_cfg and sharing_cfg.export.share:
                    peers = self._routing_table.get_negotiated_peers()
                    target_peer_id = caller_peer_id if topic in _SCOPED_ONLY_EVENT_TOPICS else None
                    if topic in _SCOPED_ONLY_EVENT_TOPICS and not target_peer_id:
                        log_debug(
                            f"MeshBus: Suppressed scoped-only event {topic}; target peer absent"
                        )
                        return
                    for peer in peers:
                        if target_peer_id is not None and peer.peer_id != target_peer_id:
                            continue
                        try:
                            event_kwargs = {"correlation_id": event_correlation_id}
                            if target_peer_id is not None:
                                event_kwargs["target_peer_id"] = target_peer_id
                            fire_event_async = getattr(self._peer_bridge, "fire_event_async", None)
                            if callable(fire_event_async) and inspect.iscoroutinefunction(
                                fire_event_async
                            ):
                                await fire_event_async(
                                    peer.peer_id,
                                    topic,
                                    message,
                                    **event_kwargs,
                                )
                            else:
                                self._peer_bridge.fire_event(
                                    peer.peer_id,
                                    topic,
                                    message,
                                    **event_kwargs,
                                )
                        except Exception as exc:
                            log_debug(
                                f"MeshBus: Failed to forward event {topic} to {peer.peer_id}: {exc}"
                            )
            return

        # For commands, check routing
        selector = _extract_mesh_selector(message, topic=topic)
        trace_id = ensure_correlation_id(message, correlation_id)
        policy_snapshot = self._operation_snapshot()
        mesh_config = policy_snapshot.mesh_config
        remote_timeout = getattr(mesh_config, "remote_timeout_s", _DEFAULT_REMOTE_TIMEOUT)
        routing_config = mesh_config.services.get(_module_from_topic(topic))
        route = self._routing_table.resolve(
            topic,
            routing_config=routing_config,
            mesh_config=mesh_config,
            selector=selector,
            policy_snapshot=policy_snapshot,
        )
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
                effective_perms=effective_perms,
                identity_source=identity_source,
                method_type=method_type,
                caller_peer_id=caller_peer_id,
                auth_grant_revision=auth_grant_revision,
                manifest_revision=manifest_revision,
                projected_service_id=projected_service_id,
                projected_method_id=projected_method_id,
                projected_method_topics=projected_method_topics,
                projected_method_set_digest=projected_method_set_digest,
                correlation_id=trace_id,
            )
            return

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            attempted: set[str] = set()
            current_route = route
            while current_route.target == "remote" and current_route.peer_id:
                peer_id = current_route.peer_id
                log_debug(f"MeshBus: Routing command {topic} to remote peer {peer_id}")
                attempted.add(peer_id)
                lease = await self._acquire_capacity_lease(peer_id, current_route.module)
                if lease is None:
                    log_warning(f"MeshBus: Remote publish provider {peer_id} is at capacity")
                    if selector and selector.has_routing_target():
                        current_route = SimpleNamespace(
                            target="error",
                            peer_id=None,
                            module=current_route.module,
                            error_message=(
                                f"{current_route.module} explicit selector target "
                                f"'{peer_id}' is at capacity"
                            ),
                        )
                        break
                    current_route = self._next_remote_route(
                        topic=topic,
                        module=current_route.module,
                        routing_config=routing_config,
                        policy_snapshot=policy_snapshot,
                        attempted=attempted,
                        selector=selector,
                    )
                    continue
                try:
                    result = await self._peer_bridge.call(
                        peer_id,
                        topic,
                        message,
                        timeout=remote_timeout,
                        correlation_id=trace_id,
                        principal_id=principal_id,
                        effective_perms=effective_perms,
                        identity_source=identity_source,
                        method_type=method_type,
                        caller_peer_id=caller_peer_id,
                        auth_grant_revision=auth_grant_revision,
                        manifest_revision=manifest_revision,
                    )
                except Exception as e:
                    log_warning(f"MeshBus: Remote publish to {peer_id} failed: {e}")
                finally:
                    await self._release_capacity_lease(lease)
                if "result" in locals():
                    try:
                        if isinstance(result, QueryResult) and not result.ok:
                            log_warning(
                                f"MeshBus: Remote publish to {peer_id} returned "
                                f"application-level error: {result.error}; attempting fallback",
                            )
                        else:
                            return
                    finally:
                        del result
                current_route = self._next_remote_route(
                    topic=topic,
                    module=current_route.module,
                    routing_config=routing_config,
                    policy_snapshot=policy_snapshot,
                    attempted=attempted,
                    selector=selector,
                )

            terminal = self._terminal_fallback_route(
                topic=topic,
                module=route.module,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                attempted=attempted,
                selector=selector,
                current_route=current_route,
            )
            if terminal.target == "error":
                raise RuntimeError(
                    terminal.error_message or f"No fallback route available for {topic}"
                )
            if terminal.target == "none":
                log_warning(f"MeshBus: No fallback route for {topic} (target=none)")
                return
            if terminal.target == "local":
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
                    effective_perms=effective_perms,
                    identity_source=identity_source,
                    method_type=method_type,
                    caller_peer_id=caller_peer_id,
                    auth_grant_revision=auth_grant_revision,
                    manifest_revision=manifest_revision,
                    projected_service_id=projected_service_id,
                    projected_method_id=projected_method_id,
                    projected_method_topics=projected_method_topics,
                    projected_method_set_digest=projected_method_set_digest,
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
            effective_perms=effective_perms,
            identity_source=identity_source,
            method_type=method_type,
            caller_peer_id=caller_peer_id,
            auth_grant_revision=auth_grant_revision,
            manifest_revision=manifest_revision,
            projected_service_id=projected_service_id,
            projected_method_id=projected_method_id,
            projected_method_topics=projected_method_topics,
            projected_method_set_digest=projected_method_set_digest,
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
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
        projected_service_id: str | None = None,
        projected_method_id: str | None = None,
        projected_method_topics: list[str] | None = None,
        projected_method_set_digest: str | None = None,
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
        selector = _extract_mesh_selector(message, topic=topic)
        trace_id = ensure_correlation_id(message, correlation_id)
        policy_snapshot = self._operation_snapshot()
        mesh_config = policy_snapshot.mesh_config
        routing_config = mesh_config.services.get(_module_from_topic(topic))
        route = self._routing_table.resolve(
            topic,
            routing_config=routing_config,
            mesh_config=mesh_config,
            selector=selector,
            policy_snapshot=policy_snapshot,
        )
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
                effective_perms=effective_perms,
                identity_source=identity_source,
                method_type=method_type,
                caller_peer_id=caller_peer_id,
                auth_grant_revision=auth_grant_revision,
                manifest_revision=manifest_revision,
                projected_service_id=projected_service_id,
                projected_method_id=projected_method_id,
                projected_method_topics=projected_method_topics,
                projected_method_set_digest=projected_method_set_digest,
                correlation_id=trace_id,
            )

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            attempted: set[str] = set()
            current_route = route
            while current_route.target == "remote" and current_route.peer_id:
                peer_id = current_route.peer_id
                log_debug(f"MeshBus: Routing request {topic} to remote peer {peer_id}")
                attempted.add(peer_id)
                lease = await self._acquire_capacity_lease(peer_id, current_route.module)
                if lease is None:
                    log_warning(f"MeshBus: Remote request provider {peer_id} is at capacity")
                    if selector and selector.has_routing_target():
                        current_route = SimpleNamespace(
                            target="error",
                            peer_id=None,
                            module=current_route.module,
                            error_message=(
                                f"{current_route.module} explicit selector target "
                                f"'{peer_id}' is at capacity"
                            ),
                        )
                        break
                    current_route = self._next_remote_route(
                        topic=topic,
                        module=current_route.module,
                        routing_config=routing_config,
                        policy_snapshot=policy_snapshot,
                        attempted=attempted,
                        selector=selector,
                    )
                    continue
                try:
                    result = await self._peer_bridge.call(
                        peer_id,
                        topic,
                        message,
                        timeout=timeout,
                        correlation_id=trace_id,
                        principal_id=principal_id,
                        effective_perms=effective_perms,
                        identity_source=identity_source,
                        method_type=method_type,
                        caller_peer_id=caller_peer_id,
                        auth_grant_revision=auth_grant_revision,
                        manifest_revision=manifest_revision,
                    )
                except Exception as e:
                    log_warning(f"MeshBus: Remote request to {peer_id} failed: {e}")
                finally:
                    await self._release_capacity_lease(lease)
                if "result" in locals():
                    try:
                        if result.ok:
                            return result
                        log_warning(
                            f"MeshBus: Remote request to {peer_id} returned error: {result.error}"
                        )
                    finally:
                        del result
                current_route = self._next_remote_route(
                    topic=topic,
                    module=current_route.module,
                    routing_config=routing_config,
                    policy_snapshot=policy_snapshot,
                    attempted=attempted,
                    selector=selector,
                )

            terminal = self._terminal_fallback_route(
                topic=topic,
                module=route.module,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                attempted=attempted,
                selector=selector,
                current_route=current_route,
            )
            if terminal.target == "error":
                return QueryResult(
                    ok=False,
                    error=terminal.error_message or f"No fallback route available for {topic}",
                )
            if terminal.target == "none":
                return QueryResult(ok=False, error=f"No fallback route available for {topic}")
            if terminal.target == "local":
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
                    effective_perms=effective_perms,
                    identity_source=identity_source,
                    method_type=method_type,
                    caller_peer_id=caller_peer_id,
                    auth_grant_revision=auth_grant_revision,
                    manifest_revision=manifest_revision,
                    projected_service_id=projected_service_id,
                    projected_method_id=projected_method_id,
                    projected_method_topics=projected_method_topics,
                    projected_method_set_digest=projected_method_set_digest,
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
            effective_perms=effective_perms,
            identity_source=identity_source,
            method_type=method_type,
            caller_peer_id=caller_peer_id,
            auth_grant_revision=auth_grant_revision,
            manifest_revision=manifest_revision,
            projected_service_id=projected_service_id,
            projected_method_id=projected_method_id,
            projected_method_topics=projected_method_topics,
            projected_method_set_digest=projected_method_set_digest,
            correlation_id=trace_id,
        )

    async def stream_request(
        self,
        topic: str,
        message: BaseModel,
        *,
        priority: int = 50,
        origin: str = "internal",
        timeout: float = 30.0,
        ttl_ms: int | None = None,
        max_attempts: int = 3,
        principal_id: str | None = None,
        effective_perms: list[str] | None = None,
        identity_source: str | None = None,
        method_type: str | None = None,
        caller_peer_id: str | None = None,
        auth_grant_revision: int | None = None,
        manifest_revision: int | None = None,
        projected_service_id: str | None = None,
        projected_method_id: str | None = None,
        projected_method_topics: list[str] | None = None,
        projected_method_set_digest: str | None = None,
        correlation_id: str | None = None,
    ) -> AsyncIterator[Any]:
        """Request a stream, using PeerBridge streaming when routed remote."""
        selector = _extract_mesh_selector(message, topic=topic)
        trace_id = ensure_correlation_id(message, correlation_id)
        policy_snapshot = self._operation_snapshot()
        mesh_config = policy_snapshot.mesh_config
        routing_config = mesh_config.services.get(_module_from_topic(topic))
        route = self._routing_table.resolve(
            topic,
            routing_config=routing_config,
            mesh_config=mesh_config,
            selector=selector,
            policy_snapshot=policy_snapshot,
        )

        if route.target == "error":
            raise RuntimeError(route.error_message or f"No remote peer available for {topic}")

        if route.target == "none":
            raise RuntimeError(f"No route available for {topic}")

        if route.target == "local":
            async for item in self._stream_local_request(
                topic,
                message,
                priority=priority,
                origin=origin,
                timeout=timeout,
                ttl_ms=ttl_ms,
                max_attempts=max_attempts,
                principal_id=principal_id,
                effective_perms=effective_perms,
                identity_source=identity_source,
                method_type=method_type,
                caller_peer_id=caller_peer_id,
                auth_grant_revision=auth_grant_revision,
                manifest_revision=manifest_revision,
                projected_service_id=projected_service_id,
                projected_method_id=projected_method_id,
                projected_method_topics=projected_method_topics,
                projected_method_set_digest=projected_method_set_digest,
                correlation_id=trace_id,
            ):
                yield item
            return

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            attempted: set[str] = set()
            current_route = route
            yielded_remote_chunk = False
            while current_route.target == "remote" and current_route.peer_id:
                peer_id = current_route.peer_id
                attempted.add(peer_id)
                lease = await self._acquire_capacity_lease(peer_id, current_route.module)
                if lease is None:
                    log_warning(f"MeshBus: Remote stream provider {peer_id} is at capacity")
                    if selector and selector.has_routing_target():
                        current_route = SimpleNamespace(
                            target="error",
                            peer_id=None,
                            module=current_route.module,
                            error_message=(
                                f"{current_route.module} explicit selector target "
                                f"'{peer_id}' is at capacity"
                            ),
                        )
                        break
                    current_route = self._next_remote_route(
                        topic=topic,
                        module=current_route.module,
                        routing_config=routing_config,
                        policy_snapshot=policy_snapshot,
                        attempted=attempted,
                        selector=selector,
                    )
                    continue
                try:
                    async for item in self._peer_bridge.stream_call(
                        peer_id,
                        topic,
                        message,
                        timeout=timeout,
                        correlation_id=trace_id,
                        principal_id=principal_id,
                        effective_perms=effective_perms,
                        identity_source=identity_source,
                        method_type=method_type,
                        caller_peer_id=caller_peer_id,
                        auth_grant_revision=auth_grant_revision,
                        manifest_revision=manifest_revision,
                    ):
                        yielded_remote_chunk = True
                        yield item
                    return
                except Exception as e:
                    if yielded_remote_chunk:
                        raise
                    log_warning(f"MeshBus: Remote stream request to {peer_id} failed: {e}")
                finally:
                    await self._release_capacity_lease(lease)
                current_route = self._next_remote_route(
                    topic=topic,
                    module=current_route.module,
                    routing_config=routing_config,
                    policy_snapshot=policy_snapshot,
                    attempted=attempted,
                    selector=selector,
                )

            terminal = self._terminal_fallback_route(
                topic=topic,
                module=route.module,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                attempted=attempted,
                selector=selector,
                current_route=current_route,
            )
            if terminal.target == "error":
                raise RuntimeError(
                    terminal.error_message or f"No fallback route available for {topic}"
                )
            if terminal.target == "none":
                raise RuntimeError(f"No fallback route available for {topic}")
            if terminal.target == "local":
                async for item in self._stream_local_request(
                    topic,
                    message,
                    priority=priority,
                    origin=origin,
                    timeout=timeout,
                    ttl_ms=ttl_ms,
                    max_attempts=max_attempts,
                    principal_id=principal_id,
                    effective_perms=effective_perms,
                    identity_source=identity_source,
                    method_type=method_type,
                    caller_peer_id=caller_peer_id,
                    auth_grant_revision=auth_grant_revision,
                    manifest_revision=manifest_revision,
                    projected_service_id=projected_service_id,
                    projected_method_id=projected_method_id,
                    projected_method_topics=projected_method_topics,
                    projected_method_set_digest=projected_method_set_digest,
                    correlation_id=trace_id,
                ):
                    yield item
                return

        raise RuntimeError(f"No route available for {topic}")

    def _registry(self) -> Any | None:
        """Return the real PeerRegistry behind RoutingTable when available."""

        try:
            values = vars(self._routing_table)
        except TypeError:
            return None
        return values.get("_registry")

    async def _acquire_capacity_lease(self, peer_id: str, module: str) -> Any | None:
        registry = self._registry()
        acquire = getattr(registry, "acquire_capacity_lease", None)
        if not callable(acquire):
            return SimpleNamespace(peer_id=peer_id, module=module, lease_id="")
        return await acquire(peer_id, module)

    async def _release_capacity_lease(self, lease: Any | None) -> None:
        if lease is None:
            return
        registry = self._registry()
        release = getattr(registry, "release_capacity_lease", None)
        if callable(release):
            await release(lease)

    def _next_remote_route(
        self,
        *,
        topic: str,
        module: str,
        routing_config: Any | None,
        policy_snapshot: MeshPolicySnapshot,
        attempted: set[str],
        selector: MeshAddressSelector | None,
    ) -> _RouteLike:
        mesh_config = policy_snapshot.mesh_config
        if selector and selector.has_routing_target():
            return SimpleNamespace(
                target="error",
                peer_id=None,
                module=module,
                error_message=(
                    f"{module} explicit selector target failed; transparent fallback skipped"
                ),
            )

        registry = self._registry()
        get_candidates = getattr(registry, "get_provider_candidates", None)
        if callable(get_candidates):
            try:
                candidates = get_candidates(
                    module=module,
                    topic=topic,
                    routing_config=routing_config,
                    version_policy=getattr(mesh_config, "version_policy", "compatible"),
                    exclude=list(attempted),
                    selector=selector,
                    include_ineligible=False,
                    policy_snapshot=policy_snapshot,
                )
            except Exception as error:
                log_warning(f"MeshBus: Provider fallback enumeration failed: {error}")
            else:
                for candidate in candidates:
                    peer = getattr(candidate, "peer", None)
                    peer_id = getattr(peer, "peer_id", None)
                    if peer_id and peer_id not in attempted:
                        service = getattr(candidate, "service", None)
                        return SimpleNamespace(
                            target="remote",
                            peer_id=peer_id,
                            module=module,
                            version=getattr(service, "version", ""),
                            latency_ms=getattr(peer, "latency_ms", None),
                            error_message=None,
                        )
                return SimpleNamespace(
                    target="none",
                    peer_id=None,
                    module=module,
                    error_message=f"No eligible unattempted provider for {topic}",
                )

        if not attempted:
            return SimpleNamespace(target="none", peer_id=None, module=module, error_message=None)
        failed_peer_id = next(reversed(tuple(attempted)))
        return self._routing_table.resolve_fallback(
            topic,
            routing_config=routing_config,
            mesh_config=mesh_config,
            failed_peer_id=failed_peer_id,
            selector=selector,
            policy_snapshot=policy_snapshot,
        )

    def _terminal_fallback_route(
        self,
        *,
        topic: str,
        module: str,
        routing_config: Any | None,
        policy_snapshot: MeshPolicySnapshot,
        attempted: set[str],
        selector: MeshAddressSelector | None,
        current_route: _RouteLike,
    ) -> _RouteLike:
        mesh_config = policy_snapshot.mesh_config
        if current_route.target == "error":
            return current_route
        if selector and selector.has_routing_target():
            return SimpleNamespace(
                target="error",
                peer_id=None,
                module=module,
                error_message=(
                    f"{module} explicit selector target failed; transparent fallback skipped"
                ),
            )
        routing_policy = getattr(routing_config, "routing", None)
        if getattr(routing_policy, "prefer", None) == "network_only":
            return SimpleNamespace(
                target="none",
                peer_id=None,
                module=module,
                error_message=f"No eligible network provider for {topic}",
            )
        if getattr(routing_policy, "fallback", None) == "local":
            return SimpleNamespace(target="local", peer_id=None, module=module, error_message=None)
        if getattr(routing_policy, "fallback", None) == "error":
            return SimpleNamespace(
                target="error",
                peer_id=None,
                module=module,
                error_message=f"No fallback route available for {topic}",
            )
        if not self._registry() and attempted:
            failed_peer_id = next(reversed(tuple(attempted)))
            fallback = self._routing_table.resolve_fallback(
                topic,
                routing_config=routing_config,
                mesh_config=mesh_config,
                failed_peer_id=failed_peer_id,
                selector=selector,
                policy_snapshot=policy_snapshot,
            )
            if fallback.target != "remote":
                return fallback
        return SimpleNamespace(
            target="none",
            peer_id=None,
            module=module,
            error_message=f"No fallback route available for {topic}",
        )

    async def _stream_local_request(
        self,
        topic: str,
        message: BaseModel,
        *,
        priority: int,
        origin: str,
        timeout: float,
        ttl_ms: int | None,
        max_attempts: int,
        principal_id: str | None,
        effective_perms: list[str] | None,
        identity_source: str | None,
        method_type: str | None,
        caller_peer_id: str | None,
        auth_grant_revision: int | None,
        manifest_revision: int | None,
        projected_service_id: str | None,
        projected_method_id: str | None,
        projected_method_topics: list[str] | None,
        projected_method_set_digest: str | None,
        correlation_id: str | None,
    ) -> AsyncIterator[Any]:
        """Stream from the wrapped local bus or adapt request data into stream items."""

        inner_stream = getattr(self._inner, "stream_request", None)
        if callable(inner_stream):
            stream = inner_stream(
                topic,
                message,
                priority=priority,
                origin=origin,
                timeout=timeout,
                ttl_ms=ttl_ms,
                max_attempts=max_attempts,
                principal_id=principal_id,
                effective_perms=effective_perms,
                identity_source=identity_source,
                method_type=method_type,
                caller_peer_id=caller_peer_id,
                auth_grant_revision=auth_grant_revision,
                manifest_revision=manifest_revision,
                projected_service_id=projected_service_id,
                projected_method_id=projected_method_id,
                projected_method_topics=projected_method_topics,
                projected_method_set_digest=projected_method_set_digest,
                correlation_id=correlation_id,
            )
            if inspect.isawaitable(stream):
                stream = await stream
            async for item in stream:
                yield item
            return

        if _requires_native_local_stream(topic):
            raise RuntimeError(
                f"Local bus does not support native stream_request for {topic}; "
                "refusing request fallback to avoid serializing async stream data"
            )

        result = await self.request(
            topic,
            message,
            priority=priority,
            origin=origin,
            timeout=timeout,
            ttl_ms=ttl_ms,
            max_attempts=max_attempts,
            principal_id=principal_id,
            effective_perms=effective_perms,
            identity_source=identity_source,
            method_type=method_type,
            caller_peer_id=caller_peer_id,
            auth_grant_revision=auth_grant_revision,
            manifest_revision=manifest_revision,
            projected_service_id=projected_service_id,
            projected_method_id=projected_method_id,
            projected_method_topics=projected_method_topics,
            projected_method_set_digest=projected_method_set_digest,
            correlation_id=correlation_id,
        )
        if not result.ok:
            raise RuntimeError(result.error or f"Stream request failed for {topic}")
        async for item in _iterate_stream_data(result.data):
            yield item

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

    def unsubscribe(self, topic: str, handler: Handler) -> None:
        """Unsubscribe from the inner local bus."""
        self._inner.unsubscribe(topic, handler)

    def register_stream_handler(self, topic: str, handler: Handler) -> None:
        """Register a local streaming handler on the wrapped bus when supported."""

        register = getattr(self._inner, "register_stream_handler", None)
        if callable(register):
            register(topic, handler)

    def unregister_stream_handler(self, topic: str, handler: Handler) -> None:
        """Unregister a local streaming handler on the wrapped bus when supported."""

        unregister = getattr(self._inner, "unregister_stream_handler", None)
        if callable(unregister):
            unregister(topic, handler)


def _requires_native_local_stream(topic: str) -> bool:
    """Return True when request fallback would corrupt stream-only responses."""
    from app.shared.contracts.models.orchestrator import OrchestratorMethods

    return topic == OrchestratorMethods.STREAM_INFER_CHAT


def _module_from_topic(topic: str) -> str:
    return topic.split(".", 1)[0] if "." in topic else topic


def _extract_mesh_selector(message: Any, *, topic: str | None = None) -> MeshAddressSelector | None:
    """Return a typed mesh selector from a bus payload when present."""
    from app.shared.contracts.models.gateway import GatewayMethods
    from app.shared.contracts.models.orchestrator import OrchestratorMethods

    selector_is_request_data = topic == GatewayMethods.EXPLAIN_ROUTE

    if isinstance(message, Mapping):
        selector = message.get("dispatch_selector")
        if selector is None and topic != OrchestratorMethods.GET_MODEL_CATALOG:
            selector = message.get("mesh_selector")
        if (
            selector is None
            and topic != OrchestratorMethods.GET_MODEL_CATALOG
            and not selector_is_request_data
        ):
            selector = message.get("selector")
    else:
        selector = getattr(message, "dispatch_selector", None)
        if selector is None and topic != OrchestratorMethods.GET_MODEL_CATALOG:
            selector = getattr(message, "mesh_selector", None)
        if (
            selector is None
            and topic != OrchestratorMethods.GET_MODEL_CATALOG
            and not selector_is_request_data
        ):
            selector = getattr(message, "selector", None)

    if isinstance(selector, MeshAddressSelector):
        return selector
    if isinstance(selector, Mapping):
        return MeshAddressSelector.model_validate(dict(selector))
    return None


async def _iterate_stream_data(data: Any) -> AsyncIterator[Any]:
    if data is None:
        return
    if hasattr(data, "__aiter__"):
        async for item in data:
            yield item
        return
    if isinstance(data, dict):
        for key in ("chunks", "events", "stream"):
            value = data.get(key)
            if value is not None and not isinstance(value, bool):
                async for item in _iterate_stream_data(value):
                    yield item
                return
        yield data
        return
    if isinstance(data, (str, bytes)):
        yield data.decode() if isinstance(data, bytes) else data
        return
    try:
        iterator = iter(data)
    except TypeError:
        yield data
        return
    for item in iterator:
        yield item
