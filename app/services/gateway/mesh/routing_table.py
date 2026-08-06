"""Routing table for the P2P mesh network.

Resolves bus topics to either local or remote targets based on:
- Mesh configuration (routing preferences per module)
- Peer availability and capabilities
- Version compatibility
- Latency measurements
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.parse import unquote

from app.helpers.aurora_logger import log_debug
from app.messaging.audio_messages import AudioTopics
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.stt import STTMethods, TranscriptionMethods, WakeWordMethods
from app.shared.contracts.models.tts import TTSMethods

from .models import RouteDecision
from .provider_eligibility import SpeechRouteConstraints, speech_route_binding_from_decision

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig, MeshServicePolicy
    from app.services.gateway.mesh.peer_registry import PeerRegistry
    from app.services.gateway.mesh.policy_store import MeshPolicyProvider, MeshPolicySnapshot


class RoutingTable:
    """Maintains routing state and resolves topics to local/remote targets.

    The RoutingTable does not store routes directly — it queries the
    PeerRegistry on each resolution to ensure fresh data. This avoids
    stale route entries and simplifies cache invalidation.
    """

    def __init__(
        self,
        mesh_config: MeshConfig,
        peer_registry: PeerRegistry,
        *,
        policy_provider: MeshPolicyProvider | None = None,
        local_peer_id: str | None = None,
    ) -> None:
        self._config = mesh_config
        self._registry = peer_registry
        self._policy_provider = policy_provider
        self._local_peer_id = local_peer_id

    def _snapshot_config(self) -> MeshConfig:
        if self._policy_provider is not None:
            return self._policy_provider().mesh_config
        return self._config

    def resolve(
        self,
        topic: str,
        routing_config: MeshServicePolicy | None = None,
        mesh_config: MeshConfig | None = None,
        exclude: list[str] | None = None,
        selector: MeshAddressSelector | None = None,
        policy_snapshot: MeshPolicySnapshot | None = None,
        speech_constraints: SpeechRouteConstraints | None = None,
    ) -> RouteDecision:
        """Determine where to route a message.

        Resolution logic:
        1. Extract the module name from the topic (e.g., "TTS" from "TTS.Request")
        2. Look up routing config for that module
        3. Based on prefer/fallback, decide local vs remote
        4. For remote: query PeerRegistry for the best provider
        5. Return RouteDecision

        Args:
            topic: Bus topic (e.g., "TTS.Request")
            routing_config: Override routing config (if None, uses mesh config)
            exclude: Peer IDs to exclude from selection
            selector: Optional explicit peer/provider/resource selector

        Returns:
            RouteDecision indicating where to deliver the message
        """
        module = _extract_module(topic)
        if policy_snapshot is None and self._policy_provider is not None:
            policy_snapshot = self._policy_provider()
        mesh_config = mesh_config or (
            policy_snapshot.mesh_config if policy_snapshot is not None else self._snapshot_config()
        )

        if not mesh_config.enabled:
            return _route_error(
                module=module,
                selector=selector,
                code="mesh_disabled",
                message=f"Mesh routing is disabled for {module}",
            )

        # Get routing config for this module
        if routing_config is None:
            routing_config = mesh_config.services.get(module)

        if selector and selector.has_routing_target():
            return self._resolve_explicit_selector(
                topic=topic,
                module=module,
                routing_config=routing_config,
                mesh_config=mesh_config,
                selector=selector,
                policy_snapshot=policy_snapshot,
                speech_constraints=speech_constraints,
            )

        # No routing config or mesh disabled → always local
        if not routing_config:
            return RouteDecision(target="local", module=module)

        routing_policy = routing_config.routing

        if _requires_explicit_audio_selector(topic) and routing_policy.prefer in {
            "network",
            "network_only",
        }:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_required",
                message=f"{topic} requires an explicit mesh selector",
            )

        if routing_policy.require_explicit_selector:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_required",
                message=f"{module} requires an explicit mesh selector",
            )

        prefer = routing_policy.prefer

        if prefer == "local_only":
            return RouteDecision(target="local", module=module)

        if prefer == "local":
            # Local is preferred, but we note remote is available for fallback
            return RouteDecision(target="local", module=module)

        if prefer in ("network", "network_only"):
            # Try to find a remote peer
            get_best_candidate = getattr(self._registry, "get_best_provider_candidate", None)
            candidate = (
                get_best_candidate(
                    module=module,
                    topic=topic,
                    routing_config=routing_config,
                    version_policy=mesh_config.version_policy,
                    exclude=exclude or [],
                    peer_selection=mesh_config.peer_selection,
                    policy_snapshot=policy_snapshot,
                    speech_constraints=speech_constraints,
                )
                if callable(get_best_candidate)
                else None
            )
            if not _is_real_provider_candidate(candidate):
                candidate = None
            if candidate is None and speech_constraints is None:
                best = self._registry.get_best_provider(
                    module=module,
                    topic=topic,
                    routing_config=routing_config,
                    version_policy=mesh_config.version_policy,
                    exclude=exclude or [],
                    peer_selection=mesh_config.peer_selection,
                    policy_snapshot=policy_snapshot,
                    speech_constraints=speech_constraints,
                )
            elif candidate is None:
                best = None
            else:
                best = candidate.peer
            if best:
                # Get the service version from the peer's manifest
                version = ""
                if best.manifest:
                    for svc in best.manifest.shared_services:
                        if svc.module == module:
                            version = svc.version
                            break
                binding = (
                    speech_route_binding_from_decision(candidate.decision)
                    if candidate is not None and candidate.decision is not None
                    else None
                )
                if speech_constraints is not None and binding is None:
                    return _route_error(
                        module=module,
                        selector=selector,
                        code="speech_route_binding_unavailable",
                        message=f"{module} speech route binding is unavailable",
                    )

                return RouteDecision(
                    target="remote",
                    peer_id=best.peer_id,
                    module=module,
                    version=version,
                    latency_ms=best.latency_ms,
                    speech_route_binding=binding,
                )

            # No remote peer available
            if prefer == "network_only":
                # Cannot fall back to local
                return RouteDecision(target="none", module=module)

            # prefer == "network" — fall back based on config
            fallback = routing_policy.fallback
            if fallback == "local":
                log_debug(f"RoutingTable: No remote peer for {module}, falling back to local")
                return RouteDecision(target="local", module=module)
            elif fallback == "error":
                return RouteDecision(target="error", module=module)
            else:
                return RouteDecision(target="none", module=module)

        # Unknown prefer value → default to local
        return RouteDecision(target="local", module=module)

    def get_negotiated_peers(self) -> list:
        """Get all peers that have completed negotiation.

        Delegates to the PeerRegistry.

        Returns:
            List of negotiated PeerState objects.
        """
        return self._registry.get_negotiated_peers()

    def _resolve_explicit_selector(
        self,
        topic: str,
        module: str,
        routing_config: MeshServicePolicy | None,
        mesh_config: MeshConfig,
        selector: MeshAddressSelector,
        policy_snapshot: MeshPolicySnapshot | None = None,
        speech_constraints: SpeechRouteConstraints | None = None,
    ) -> RouteDecision:
        peer_id, conflict_error, provider_kind = _selector_target(selector, module)
        if conflict_error:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_conflict",
                message=conflict_error,
            )
        if not peer_id:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_missing_provider",
                message=f"{module} selector does not name a peer/provider/service instance",
            )

        if peer_id == "local" or (
            provider_kind == "local"
            and (self._local_peer_id is None or peer_id == self._local_peer_id)
        ):
            return RouteDecision(target="local", module=module, selector=selector)

        peer = self._registry.get_peer(peer_id)
        if not peer:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_peer_not_found",
                message=f"{module} selector peer/provider '{peer_id}' is not connected",
            )
        if peer.status != "negotiated":
            return _route_error(
                module=module,
                selector=selector,
                code="selector_peer_stale" if peer.status == "stale" else "selector_peer_not_ready",
                message=(
                    f"{module} selector peer/provider '{peer_id}' is {peer.status}, not negotiated"
                ),
            )

        if (
            routing_config
            and routing_config.routing.allowed_provider_peer_ids is not None
            and peer_id not in routing_config.routing.allowed_provider_peer_ids
        ):
            return _route_error(
                module=module,
                selector=selector,
                code="selector_peer_unauthorized",
                message=f"{module} selector peer/provider '{peer_id}' is not allowed by policy",
            )

        svc = self._registry.get_peer_service(peer_id, module)
        if not svc:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_service_missing",
                message=f"{module} is not shared by selector peer/provider '{peer_id}'",
            )

        decision = self._registry.evaluate_provider_for_topic(
            peer=peer,
            module=module,
            topic=topic,
            routing_config=routing_config,
            policy_snapshot=policy_snapshot,
            version_policy=mesh_config.version_policy,
            explicit_peer_id=peer_id,
            speech_constraints=speech_constraints,
        )
        if not decision.eligible:
            return _route_error(
                module=module,
                selector=selector,
                code=f"selector_{decision.reason_code}",
                message=f"{module} selector peer/provider '{peer_id}': {decision.reason}",
            )
        binding = speech_route_binding_from_decision(decision)
        if speech_constraints is not None and binding is None:
            return _route_error(
                module=module,
                selector=selector,
                code="speech_route_binding_unavailable",
                message=f"{module} speech route binding is unavailable",
            )

        return RouteDecision(
            target="remote",
            peer_id=peer_id,
            module=module,
            version=svc.version,
            latency_ms=peer.latency_ms,
            selector=selector,
            speech_route_binding=binding,
        )

    def resolve_fallback(
        self,
        topic: str,
        routing_config: MeshServicePolicy | None = None,
        mesh_config: MeshConfig | None = None,
        failed_peer_id: str | None = None,
        selector: MeshAddressSelector | None = None,
        policy_snapshot: MeshPolicySnapshot | None = None,
        speech_constraints: SpeechRouteConstraints | None = None,
    ) -> RouteDecision:
        """Resolve a fallback route after a primary route failure.

        Args:
            topic: Bus topic
            routing_config: Routing configuration
            failed_peer_id: The peer that failed (to exclude)
            selector: Optional explicit selector. Explicit routes do not
                transparently fall back to another target.

        Returns:
            RouteDecision for the fallback target
        """
        module = _extract_module(topic)
        if policy_snapshot is None and self._policy_provider is not None:
            policy_snapshot = self._policy_provider()
        mesh_config = mesh_config or (
            policy_snapshot.mesh_config if policy_snapshot is not None else self._snapshot_config()
        )

        if not mesh_config.enabled:
            return _route_error(
                module=module,
                selector=selector,
                code="mesh_disabled",
                message=f"Mesh routing is disabled for {module}",
            )

        if selector and selector.has_routing_target():
            return _route_error(
                module=module,
                selector=selector,
                code="selector_target_failed",
                message=f"{module} explicit selector target failed; transparent fallback skipped",
            )

        if routing_config is None:
            routing_config = mesh_config.services.get(module)

        if not routing_config:
            return RouteDecision(target="local", module=module)

        fallback = routing_config.routing.fallback
        exclude = [failed_peer_id] if failed_peer_id else []

        if fallback == "local":
            return RouteDecision(target="local", module=module)
        elif fallback == "network":
            # Try another remote peer
            get_best_candidate = getattr(self._registry, "get_best_provider_candidate", None)
            candidate = (
                get_best_candidate(
                    module=module,
                    topic=topic,
                    routing_config=routing_config,
                    version_policy=mesh_config.version_policy,
                    exclude=exclude,
                    peer_selection=mesh_config.peer_selection,
                    policy_snapshot=policy_snapshot,
                    speech_constraints=speech_constraints,
                )
                if callable(get_best_candidate)
                else None
            )
            if not _is_real_provider_candidate(candidate):
                candidate = None
            if candidate is None and speech_constraints is None:
                best = self._registry.get_best_provider(
                    module=module,
                    topic=topic,
                    routing_config=routing_config,
                    version_policy=mesh_config.version_policy,
                    exclude=exclude,
                    peer_selection=mesh_config.peer_selection,
                    policy_snapshot=policy_snapshot,
                    speech_constraints=speech_constraints,
                )
            elif candidate is None:
                best = None
            else:
                best = candidate.peer
            if best:
                version = ""
                if best.manifest:
                    for svc in best.manifest.shared_services:
                        if svc.module == module:
                            version = svc.version
                            break
                binding = (
                    speech_route_binding_from_decision(candidate.decision)
                    if candidate is not None and candidate.decision is not None
                    else None
                )
                if speech_constraints is not None and binding is None:
                    return _route_error(
                        module=module,
                        selector=selector,
                        code="speech_route_binding_unavailable",
                        message=f"{module} speech route binding is unavailable",
                    )
                return RouteDecision(
                    target="remote",
                    peer_id=best.peer_id,
                    module=module,
                    version=version,
                    latency_ms=best.latency_ms,
                    speech_route_binding=binding,
                )
            # No more remote peers → try local as last resort
            return RouteDecision(target="local", module=module)
        elif fallback == "error":
            return RouteDecision(target="error", module=module)
        else:
            return RouteDecision(target="none", module=module)


def _extract_module(topic: str) -> str:
    """Extract the module name from a bus topic.

    Args:
        topic: Bus topic (e.g., "TTS.Request", "DB.StoreMessage")

    Returns:
        Module name (e.g., "TTS", "DB")
    """
    if "." in topic:
        return topic.split(".")[0]
    return topic


_EXPLICIT_AUDIO_TOPICS = {
    TTSMethods.REQUEST,
    TTSMethods.STOP,
    TTSMethods.PAUSE,
    TTSMethods.RESUME,
    STTMethods.LISTEN,
    STTMethods.STOP_LISTENING,
    STTMethods.AUDIO,
    STTMethods.CONTROL,
    WakeWordMethods.PROCESS_AUDIO,
    WakeWordMethods.CONTROL,
    TranscriptionMethods.PROCESS_AUDIO,
    TranscriptionMethods.CONTROL,
    AudioTopics.STREAM_MICROPHONE,
    AudioTopics.STREAM_WEBSOCKET,
    AudioTopics.STREAM_GENERIC,
    AudioTopics.CONTROL,
}


def _requires_explicit_audio_selector(topic: str) -> bool:
    """Return True for audio operations that must name a target peer/device."""

    return topic in _EXPLICIT_AUDIO_TOPICS


def _is_real_provider_candidate(candidate: object) -> bool:
    peer = getattr(candidate, "peer", None)
    return isinstance(getattr(peer, "peer_id", None), str)


def _selector_target(
    selector: MeshAddressSelector,
    module: str,
) -> tuple[str | None, str | None, str | None]:
    """Resolve selector provider aliases into a peer id and provider kind."""

    peer_ids: list[str] = []
    provider_kinds: list[str] = []
    for value, field_name in (
        (selector.peer_id, "peer_id"),
        (selector.provider_id, "provider_id"),
        (selector.service_instance_id, "service_instance_id"),
    ):
        peer_id, error, provider_kind = _parse_selector_target(value, field_name, module)
        if error:
            return None, error, None
        if peer_id and peer_id not in peer_ids:
            peer_ids.append(peer_id)
        if provider_kind and provider_kind not in provider_kinds:
            provider_kinds.append(provider_kind)

    if len(peer_ids) > 1:
        return None, f"selector names multiple peer/provider targets: {', '.join(peer_ids)}", None
    if len(provider_kinds) > 1:
        return None, (f"selector names multiple provider kinds: {', '.join(provider_kinds)}"), None
    return (
        (peer_ids[0], None, provider_kinds[0] if provider_kinds else None)
        if peer_ids
        else (
            None,
            None,
            None,
        )
    )


def _parse_selector_target(
    value: str | None,
    field_name: str,
    module: str,
) -> tuple[str | None, str | None, str | None]:
    if not value:
        return None, None, None
    if ":" not in value:
        return value, None, None

    parts = value.split(":")
    if len(parts) >= 3 and parts[0] in {"local", "remote", "mesh"}:
        provider_kind, peer_id, service_module = parts[:3]
        try:
            peer_id = unquote(peer_id, errors="strict")
        except UnicodeDecodeError:
            return None, f"{field_name} '{value}' has an invalid encoded peer id", None
        if provider_kind == "mesh":
            provider_kind = "remote"
    else:
        provider_kind = None
        peer_id, service_module = value.split(":", 1)

    if service_module and service_module != module:
        return None, (f"{field_name} '{value}' targets {service_module}, not {module}"), None
    return peer_id, None, provider_kind


def _route_error(
    *,
    module: str,
    selector: MeshAddressSelector | None,
    code: str,
    message: str,
) -> RouteDecision:
    return RouteDecision(
        target="error",
        module=module,
        selector=selector,
        error_code=code,
        error_message=message,
    )
