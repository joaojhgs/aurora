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
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.peer_bridge import PeerBridgePreAcceptRejectedError
from app.services.gateway.mesh.policy_store import MeshPolicyProvider, MeshPolicySnapshot
from app.services.gateway.mesh.provider_eligibility import (
    SpeechRouteConstraints,
    speech_route_binding_from_decision,
)
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.speech import SpeechLanguageRequirement, SpeechRouteBinding
from app.shared.contracts.models.stt import TranscriptionMethods
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
    speech_route_binding: SpeechRouteBinding | None
    method_type: str | None


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
        speech_constraints: SpeechRouteConstraints | None = None,
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
        speech_constraints: SpeechRouteConstraints | None = None,
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
        speech_route_binding: SpeechRouteBinding | None = None,
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
        speech_route_binding: SpeechRouteBinding | None = None,
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
        mesh_config: MeshConfig,
        policy_provider: MeshPolicyProvider | None = None,
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

    def current_mesh_config(self) -> MeshConfig:
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
        speech_route_binding: SpeechRouteBinding | None = None,
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
        if speech_route_binding is not None:
            await self._inner.publish(
                topic,
                message,
                event=event,
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
                speech_route_binding=speech_route_binding,
                correlation_id=correlation_id,
            )
            return

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
                projected_method_topics=projected_method_topics,
                projected_method_set_digest=projected_method_set_digest,
                correlation_id=event_correlation_id,
            )
            # Forward events to connected peers when mesh=True and module is shared
            if mesh and self._peer_bridge and origin != "mesh_forwarded":
                module = topic.split(".")[0] if "." in topic else topic
                mesh_config = self.current_mesh_policy_snapshot().mesh_config
                sharing_cfg = mesh_config.services.get(module)
                if mesh_config.enabled and sharing_cfg and sharing_cfg.export.share:
                    target_peer_id = caller_peer_id if topic in _SCOPED_ONLY_EVENT_TOPICS else None
                    if topic in _SCOPED_ONLY_EVENT_TOPICS and not target_peer_id:
                        log_debug(
                            f"MeshBus: Suppressed scoped-only event {topic}; target peer absent"
                        )
                        return
                    recipient_peer_ids = (
                        [target_peer_id]
                        if target_peer_id is not None
                        else [peer.peer_id for peer in self._routing_table.get_negotiated_peers()]
                    )
                    for recipient_peer_id in recipient_peer_ids:
                        try:
                            event_kwargs = {"correlation_id": event_correlation_id}
                            if target_peer_id is not None:
                                event_kwargs["target_peer_id"] = target_peer_id
                            fire_event_async = getattr(self._peer_bridge, "fire_event_async", None)
                            if callable(fire_event_async) and inspect.iscoroutinefunction(
                                fire_event_async
                            ):
                                await fire_event_async(
                                    recipient_peer_id,
                                    topic,
                                    message,
                                    **event_kwargs,
                                )
                            else:
                                self._peer_bridge.fire_event(
                                    recipient_peer_id,
                                    topic,
                                    message,
                                    **event_kwargs,
                                )
                        except Exception as exc:
                            log_debug(
                                f"MeshBus: Failed to forward event {topic} to {recipient_peer_id}: {exc}"
                            )
            return

        # For commands, check routing
        selector = _extract_mesh_selector(message, topic=topic)
        speech_constraints = _extract_speech_route_constraints(message, topic=topic)
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
            speech_constraints=speech_constraints,
        )
        log_debug(
            f"MeshBus: Routing command {topic} → target={route.target}, "
            f"peer={route.peer_id or 'n/a'}, module={route.module}, "
            f"correlation_id={trace_id}"
        )

        if _remote_manage_requires_selector(topic, route, selector):
            raise RuntimeError(f"{topic} requires an explicit mesh selector")

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
                speech_route_binding=speech_route_binding,
                correlation_id=trace_id,
            )
            return

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            attempted: set[str] = set()
            current_route = route
            reroute_used = False
            while current_route.target == "remote" and current_route.peer_id:
                if _remote_manage_requires_selector(topic, current_route, selector):
                    raise RuntimeError(f"{topic} requires an explicit mesh selector")
                peer_id = current_route.peer_id
                log_debug(f"MeshBus: Routing command {topic} to remote peer {peer_id}")
                attempted.add(peer_id)
                lease = await self._acquire_capacity_lease(peer_id, current_route.module)
                if lease is None:
                    log_warning(f"MeshBus: Remote publish provider {peer_id} is at capacity")
                    if reroute_used or (selector and selector.has_routing_target()):
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
                    reroute_used = True
                    current_route = self._next_remote_route(
                        topic=topic,
                        module=current_route.module,
                        routing_config=routing_config,
                        policy_snapshot=policy_snapshot,
                        attempted=attempted,
                        selector=selector,
                        speech_constraints=speech_constraints,
                    )
                    continue
                try:
                    route_binding = getattr(current_route, "speech_route_binding", None)
                    trusted_method_type = _trusted_method_type(topic, current_route, method_type)
                    result = await self._peer_bridge.call(
                        peer_id,
                        topic,
                        message,
                        timeout=remote_timeout,
                        correlation_id=trace_id,
                        principal_id=principal_id,
                        effective_perms=effective_perms,
                        identity_source=identity_source,
                        method_type=trusted_method_type,
                        caller_peer_id=caller_peer_id,
                        auth_grant_revision=auth_grant_revision,
                        manifest_revision=manifest_revision,
                        **_speech_route_binding_kwarg(route_binding),
                    )
                except Exception as e:
                    log_warning(f"MeshBus: Remote publish to {peer_id} failed: {e}")
                    return
                finally:
                    await self._release_capacity_lease(lease)
                if "result" in locals():
                    try:
                        if isinstance(result, QueryResult) and not result.ok:
                            if (
                                not reroute_used
                                and not (selector and selector.has_routing_target())
                                and _is_retryable_preaccept_result(result)
                            ):
                                reroute_used = True
                                current_route = self._next_remote_route(
                                    topic=topic,
                                    module=current_route.module,
                                    routing_config=routing_config,
                                    policy_snapshot=policy_snapshot,
                                    attempted=attempted,
                                    selector=selector,
                                    speech_constraints=speech_constraints,
                                )
                                continue
                            log_warning(
                                f"MeshBus: Remote publish to {peer_id} returned "
                                f"application-level error: {result.error}",
                            )
                            return
                        else:
                            return
                    finally:
                        del result
                break

            terminal = self._terminal_fallback_route(
                topic=topic,
                module=route.module,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                attempted=attempted,
                selector=selector,
                current_route=current_route,
                speech_constraints=speech_constraints,
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
                    speech_route_binding=speech_route_binding,
                    correlation_id=trace_id,
                )
                return

        if route.target == "remote":
            raise RuntimeError("remote_transport_unavailable")

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
            speech_route_binding=speech_route_binding,
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
        speech_route_binding: SpeechRouteBinding | None = None,
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
        if speech_route_binding is not None:
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
                speech_route_binding=speech_route_binding,
                correlation_id=correlation_id,
            )

        selector = _extract_mesh_selector(message, topic=topic)
        speech_constraints = _extract_speech_route_constraints(message, topic=topic)
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
            speech_constraints=speech_constraints,
        )
        log_debug(
            f"MeshBus: Routing request {topic} → target={route.target}, "
            f"peer={route.peer_id or 'n/a'}, module={route.module}, "
            f"correlation_id={trace_id}"
        )

        if _remote_manage_requires_selector(topic, route, selector):
            return QueryResult(ok=False, error="selector_required")

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
                speech_route_binding=speech_route_binding,
                correlation_id=trace_id,
            )

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            attempted: set[str] = set()
            current_route = route
            reroute_used = False
            while current_route.target == "remote" and current_route.peer_id:
                if _remote_manage_requires_selector(topic, current_route, selector):
                    return QueryResult(ok=False, error="selector_required")
                peer_id = current_route.peer_id
                log_debug(f"MeshBus: Routing request {topic} to remote peer {peer_id}")
                attempted.add(peer_id)
                lease = await self._acquire_capacity_lease(peer_id, current_route.module)
                if lease is None:
                    log_warning(f"MeshBus: Remote request provider {peer_id} is at capacity")
                    if reroute_used or (selector and selector.has_routing_target()):
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
                    reroute_used = True
                    current_route = self._next_remote_route(
                        topic=topic,
                        module=current_route.module,
                        routing_config=routing_config,
                        policy_snapshot=policy_snapshot,
                        attempted=attempted,
                        selector=selector,
                        speech_constraints=speech_constraints,
                    )
                    continue
                try:
                    route_binding = getattr(current_route, "speech_route_binding", None)
                    trusted_method_type = _trusted_method_type(topic, current_route, method_type)
                    result = await self._peer_bridge.call(
                        peer_id,
                        topic,
                        message,
                        timeout=timeout,
                        correlation_id=trace_id,
                        principal_id=principal_id,
                        effective_perms=effective_perms,
                        identity_source=identity_source,
                        method_type=trusted_method_type,
                        caller_peer_id=caller_peer_id,
                        auth_grant_revision=auth_grant_revision,
                        manifest_revision=manifest_revision,
                        **_speech_route_binding_kwarg(route_binding),
                    )
                except Exception as e:
                    log_warning(f"MeshBus: Remote request to {peer_id} failed: {e}")
                    return QueryResult(ok=False, error=str(e))
                finally:
                    await self._release_capacity_lease(lease)
                if "result" in locals():
                    try:
                        if result.ok:
                            return result
                        if (
                            not reroute_used
                            and not (selector and selector.has_routing_target())
                            and _is_retryable_preaccept_result(result)
                        ):
                            reroute_used = True
                            current_route = self._next_remote_route(
                                topic=topic,
                                module=current_route.module,
                                routing_config=routing_config,
                                policy_snapshot=policy_snapshot,
                                attempted=attempted,
                                selector=selector,
                                speech_constraints=speech_constraints,
                            )
                            continue
                        log_warning(
                            f"MeshBus: Remote request to {peer_id} returned error: {result.error}"
                        )
                        return result
                    finally:
                        del result
                break

            terminal = self._terminal_fallback_route(
                topic=topic,
                module=route.module,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                attempted=attempted,
                selector=selector,
                current_route=current_route,
                speech_constraints=speech_constraints,
            )
            if terminal.target == "error":
                return QueryResult(
                    ok=False,
                    error=_route_query_error(
                        terminal,
                        fallback=f"No fallback route available for {topic}",
                    ),
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
                    speech_route_binding=speech_route_binding,
                    correlation_id=trace_id,
                )

        if route.target == "remote":
            return QueryResult(ok=False, error="remote_transport_unavailable")

        if route.target == "error":
            return QueryResult(
                ok=False,
                error=_route_query_error(
                    route,
                    fallback=f"No remote peer available for {topic}",
                ),
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
            speech_route_binding=speech_route_binding,
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
        speech_route_binding: SpeechRouteBinding | None = None,
        correlation_id: str | None = None,
    ) -> AsyncIterator[Any]:
        """Request a stream, using PeerBridge streaming when routed remote."""
        if speech_route_binding is not None:
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
                speech_route_binding=speech_route_binding,
                correlation_id=correlation_id,
            ):
                yield item
            return

        selector = _extract_mesh_selector(message, topic=topic)
        speech_constraints = _extract_speech_route_constraints(message, topic=topic)
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
            speech_constraints=speech_constraints,
        )

        if _remote_manage_requires_selector(topic, route, selector):
            raise RuntimeError("selector_required")

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
                speech_route_binding=speech_route_binding,
                correlation_id=trace_id,
            ):
                yield item
            return

        if route.target == "remote" and route.peer_id and self._peer_bridge:
            attempted: set[str] = set()
            current_route = route
            yielded_remote_chunk = False
            reroute_used = False
            while current_route.target == "remote" and current_route.peer_id:
                if _remote_manage_requires_selector(topic, current_route, selector):
                    raise RuntimeError("selector_required")
                peer_id = current_route.peer_id
                attempted.add(peer_id)
                lease = await self._acquire_capacity_lease(peer_id, current_route.module)
                if lease is None:
                    log_warning(f"MeshBus: Remote stream provider {peer_id} is at capacity")
                    if reroute_used or (selector and selector.has_routing_target()):
                        raise RuntimeError(
                            f"{current_route.module} provider '{peer_id}' is at capacity"
                        )
                    reroute_used = True
                    current_route = self._next_remote_route(
                        topic=topic,
                        module=current_route.module,
                        routing_config=routing_config,
                        policy_snapshot=policy_snapshot,
                        attempted=attempted,
                        selector=selector,
                        speech_constraints=speech_constraints,
                    )
                    continue
                try:
                    route_binding = getattr(current_route, "speech_route_binding", None)
                    trusted_method_type = _trusted_method_type(topic, current_route, method_type)
                    async for item in self._peer_bridge.stream_call(
                        peer_id,
                        topic,
                        message,
                        timeout=timeout,
                        correlation_id=trace_id,
                        principal_id=principal_id,
                        effective_perms=effective_perms,
                        identity_source=identity_source,
                        method_type=trusted_method_type,
                        caller_peer_id=caller_peer_id,
                        auth_grant_revision=auth_grant_revision,
                        manifest_revision=manifest_revision,
                        **_speech_route_binding_kwarg(route_binding),
                    ):
                        yielded_remote_chunk = True
                        yield item
                    return
                except Exception as e:
                    if yielded_remote_chunk:
                        raise
                    if (
                        not reroute_used
                        and not (selector and selector.has_routing_target())
                        and _is_retryable_preaccept_error(e)
                    ):
                        reroute_used = True
                        current_route = self._next_remote_route(
                            topic=topic,
                            module=current_route.module,
                            routing_config=routing_config,
                            policy_snapshot=policy_snapshot,
                            attempted=attempted,
                            selector=selector,
                            speech_constraints=speech_constraints,
                        )
                        continue
                    log_warning(f"MeshBus: Remote stream request to {peer_id} failed: {e}")
                    raise
                finally:
                    await self._release_capacity_lease(lease)
                break

            terminal = self._terminal_fallback_route(
                topic=topic,
                module=route.module,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                attempted=attempted,
                selector=selector,
                current_route=current_route,
                speech_constraints=speech_constraints,
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
                    speech_route_binding=speech_route_binding,
                    correlation_id=trace_id,
                ):
                    yield item
                return

        if route.target == "remote":
            raise RuntimeError("remote_transport_unavailable")

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
        speech_constraints: SpeechRouteConstraints | None,
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
                    speech_constraints=speech_constraints,
                )
            except Exception as error:
                log_warning(f"MeshBus: Provider fallback enumeration failed: {error}")
            else:
                for candidate in candidates:
                    peer = getattr(candidate, "peer", None)
                    peer_id = getattr(peer, "peer_id", None)
                    if peer_id and peer_id not in attempted:
                        service = getattr(candidate, "service", None)
                        binding = (
                            speech_route_binding_from_decision(candidate.decision)
                            if (
                                speech_constraints is not None
                                and getattr(candidate, "decision", None) is not None
                            )
                            else None
                        )
                        if speech_constraints is not None and binding is None:
                            continue
                        return SimpleNamespace(
                            target="remote",
                            peer_id=peer_id,
                            module=module,
                            version=getattr(service, "version", ""),
                            latency_ms=getattr(peer, "latency_ms", None),
                            error_message=None,
                            speech_route_binding=binding,
                            method_type=_trusted_method_type(
                                topic,
                                SimpleNamespace(
                                    method_type=(
                                        getattr(candidate.decision, "method_type", None)
                                        if getattr(candidate, "decision", None) is not None
                                        else None
                                    )
                                ),
                                None,
                            ),
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
            speech_constraints=speech_constraints,
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
        speech_constraints: SpeechRouteConstraints | None,
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
                speech_constraints=speech_constraints,
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
        speech_route_binding: SpeechRouteBinding | None,
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
                speech_route_binding=speech_route_binding,
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
            speech_route_binding=speech_route_binding,
            correlation_id=correlation_id,
        )
        if not result.ok:
            raise RuntimeError(result.error or f"Stream request failed for {topic}")
        async for item in _iterate_stream_data(result.data):
            yield item

    # ── Subscribe ────────────────────────────────────────────────────────

    def subscribe(self, topic: str, handler: Handler, *, event: bool = False) -> None:
        """Subscribe always goes to the inner bus (local delivery).

        Remote services don't subscribe to our local bus — they subscribe
        on their own bus and we call them via PeerBridge.

        Args:
            topic: Topic pattern (supports wildcards)
            handler: Async function to handle messages
            event: True when subscribing to broadcast events
        """
        self._inner.subscribe(topic, handler, event=event)

    async def subscribe_event(self, topic: str, handler: Handler) -> None:
        """Subscribe to a local event through the wrapped bus and await readiness."""
        subscribe_event = getattr(self._inner, "subscribe_event", None)
        if callable(subscribe_event):
            await subscribe_event(topic, handler)
            return
        self._inner.subscribe(topic, handler, event=True)

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


def _route_query_error(route: Any, *, fallback: str) -> str:
    """Return a stable authorization code without exposing routing internals."""

    if getattr(route, "error_code", None) == "selector_permission_denied":
        return "permission_denied"
    return getattr(route, "error_message", None) or fallback


def _registered_method_type(topic: str) -> str | None:
    try:
        from app.shared.contracts.registry import get_contract

        contract = get_contract(topic)
    except Exception:
        return "lookup_failed"
    method_type = getattr(contract, "method_type", None)
    return method_type if method_type in {"use", "manage"} else None


def _trusted_method_type(
    topic: str,
    route: Any,
    _caller_method_type: str | None,
) -> str | None:
    """Return method type from authoritative route/registry metadata only."""

    route_method_type = getattr(route, "method_type", None)
    registered_method_type = _registered_method_type(topic)
    if route_method_type == "manage" or registered_method_type in {"lookup_failed", "manage"}:
        return "manage"
    if route_method_type == "use" or registered_method_type == "use":
        return "use"
    return None


def _remote_manage_requires_selector(
    topic: str,
    route: Any,
    selector: MeshAddressSelector | None,
) -> bool:
    if getattr(route, "target", None) != "remote":
        return False
    if selector is not None and selector.has_routing_target():
        return False
    return _trusted_method_type(topic, route, None) == "manage"


def _is_retryable_preaccept_result(result: QueryResult) -> bool:
    """Return True only for bounded pre-accept outcomes that did no remote work."""

    if result.ok:
        return False
    if isinstance(result.data, dict) and result.data.get("accepted") is False:
        return result.data.get("reason_code") in {
            "capability_changed",
            "not_sent",
        }
    return False


def _is_retryable_preaccept_error(error: Exception) -> bool:
    return isinstance(error, PeerBridgePreAcceptRejectedError) and error.reason_code in {
        "capability_changed",
        "not_sent",
    }


def _speech_route_binding_kwarg(
    binding: SpeechRouteBinding | None,
) -> dict[str, SpeechRouteBinding]:
    return {"speech_route_binding": binding} if binding is not None else {}


def _extract_speech_route_constraints(message: Any, *, topic: str) -> SpeechRouteConstraints | None:
    """Return immutable speech routing constraints derived from request data."""

    language = _payload_value(message, "language")
    if topic in {TTSMethods.REQUEST, TTSMethods.SYNTHESIZE, TTSMethods.STREAM_START}:
        voice_id = _payload_value(message, "voice")
        return SpeechRouteConstraints(
            topic=topic,
            language_requirement=SpeechLanguageRequirement(mode="exact", language=language)
            if language is not None
            else None,
            voice_id=voice_id,
        )

    if topic == TranscriptionMethods.TRANSCRIBE:
        if language is not None:
            language_requirement = SpeechLanguageRequirement(mode="exact", language=language)
        else:
            language_requirement = SpeechLanguageRequirement(
                mode="auto",
                auto_language_candidates=list(
                    _payload_value(message, "auto_language_candidates") or []
                ),
            )
        return SpeechRouteConstraints(topic=topic, language_requirement=language_requirement)

    return None


def _payload_value(message: Any, field_name: str) -> Any:
    if isinstance(message, Mapping):
        return message.get(field_name)
    return getattr(message, field_name, None)


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
