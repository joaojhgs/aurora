"""Routing table for the P2P mesh network.

Resolves bus topics to either local or remote targets based on:
- Mesh configuration (routing preferences per module)
- Peer availability and capabilities
- Version compatibility
- Latency measurements
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.helpers.aurora_logger import log_debug
from app.messaging.audio_messages import AudioTopics
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.stt import STTMethods, TranscriptionMethods, WakeWordMethods
from app.shared.contracts.models.tts import TTSMethods

from .models import RouteDecision

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig, MeshServiceConfig
    from app.services.gateway.mesh.peer_registry import PeerRegistry


class RoutingTable:
    """Maintains routing state and resolves topics to local/remote targets.

    The RoutingTable does not store routes directly — it queries the
    PeerRegistry on each resolution to ensure fresh data. This avoids
    stale route entries and simplifies cache invalidation.
    """

    def __init__(self, mesh_config: MeshConfig, peer_registry: PeerRegistry) -> None:
        self._config = mesh_config
        self._registry = peer_registry

    def resolve(
        self,
        topic: str,
        routing_config: MeshServiceConfig | None = None,
        exclude: list[str] | None = None,
        selector: MeshAddressSelector | None = None,
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

        # Get routing config for this module
        if routing_config is None:
            routing_config = self._config.services.get(module)

        if selector and selector.has_routing_target():
            return self._resolve_explicit_selector(
                module=module,
                routing_config=routing_config,
                selector=selector,
            )

        # No routing config or mesh disabled → always local
        if not routing_config:
            return RouteDecision(target="local", module=module)

        if _requires_explicit_audio_selector(topic) and routing_config.prefer in {
            "network",
            "network_only",
        }:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_required",
                message=f"{topic} requires an explicit mesh selector",
            )

        if routing_config.require_explicit_selector:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_required",
                message=f"{module} requires an explicit mesh selector",
            )

        prefer = routing_config.prefer

        if prefer == "local_only":
            return RouteDecision(target="local", module=module)

        if prefer == "local":
            # Local is preferred, but we note remote is available for fallback
            return RouteDecision(target="local", module=module)

        if prefer in ("network", "network_only"):
            # Try to find a remote peer
            best = self._registry.get_best_provider(
                module=module,
                routing_config=routing_config,
                version_policy=self._config.version_policy,
                exclude=exclude or [],
            )
            if best:
                # Get the service version from the peer's manifest
                version = ""
                if best.manifest:
                    for svc in best.manifest.shared_services:
                        if svc.module == module:
                            version = svc.version
                            break

                return RouteDecision(
                    target="remote",
                    peer_id=best.peer_id,
                    module=module,
                    version=version,
                    latency_ms=best.latency_ms,
                )

            # No remote peer available
            if prefer == "network_only":
                # Cannot fall back to local
                return RouteDecision(target="none", module=module)

            # prefer == "network" — fall back based on config
            fallback = routing_config.fallback
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
        module: str,
        routing_config: MeshServiceConfig | None,
        selector: MeshAddressSelector,
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

        if provider_kind == "local":
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
            and routing_config.allowed_peers is not None
            and peer_id not in routing_config.allowed_peers
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

        if routing_config and routing_config.min_version:
            from .version_compat import is_compatible

            if not is_compatible(
                routing_config.min_version,
                svc.version,
                self._config.version_policy,
                routing_config.min_version,
            ):
                return _route_error(
                    module=module,
                    selector=selector,
                    code="selector_incompatible_version",
                    message=(
                        f"{module} selector peer/provider '{peer_id}' version {svc.version} "
                        f"does not satisfy {routing_config.min_version}"
                    ),
                )

        if (
            routing_config
            and routing_config.required_capabilities
            and not all(cap in svc.capabilities for cap in routing_config.required_capabilities)
        ):
            missing = [
                cap for cap in routing_config.required_capabilities if cap not in svc.capabilities
            ]
            return _route_error(
                module=module,
                selector=selector,
                code="selector_incompatible_capabilities",
                message=(
                    f"{module} selector peer/provider '{peer_id}' lacks required "
                    f"capabilities: {', '.join(missing)}"
                ),
            )

        if svc.max_concurrent > 0 and peer.active_calls >= svc.max_concurrent:
            return _route_error(
                module=module,
                selector=selector,
                code="selector_provider_at_capacity",
                message=f"{module} selector peer/provider '{peer_id}' is at capacity",
            )

        return RouteDecision(
            target="remote",
            peer_id=peer_id,
            module=module,
            version=svc.version,
            latency_ms=peer.latency_ms,
            selector=selector,
        )

    def resolve_fallback(
        self,
        topic: str,
        routing_config: MeshServiceConfig | None = None,
        failed_peer_id: str | None = None,
        selector: MeshAddressSelector | None = None,
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

        if selector and selector.has_routing_target():
            return _route_error(
                module=module,
                selector=selector,
                code="selector_target_failed",
                message=f"{module} explicit selector target failed; transparent fallback skipped",
            )

        if routing_config is None:
            routing_config = self._config.services.get(module)

        if not routing_config:
            return RouteDecision(target="local", module=module)

        fallback = routing_config.fallback
        exclude = [failed_peer_id] if failed_peer_id else []

        if fallback == "local":
            return RouteDecision(target="local", module=module)
        elif fallback == "network":
            # Try another remote peer
            best = self._registry.get_best_provider(
                module=module,
                routing_config=routing_config,
                version_policy=self._config.version_policy,
                exclude=exclude,
            )
            if best:
                version = ""
                if best.manifest:
                    for svc in best.manifest.shared_services:
                        if svc.module == module:
                            version = svc.version
                            break
                return RouteDecision(
                    target="remote",
                    peer_id=best.peer_id,
                    module=module,
                    version=version,
                    latency_ms=best.latency_ms,
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
    WakeWordMethods.DETECT,
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
        return None, (
            f"selector names multiple provider kinds: {', '.join(provider_kinds)}"
        ), None
    return (peer_ids[0], None, provider_kinds[0] if provider_kinds else None) if peer_ids else (
        None,
        None,
        None,
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
    if len(parts) == 3 and parts[0] in {"local", "remote"}:
        provider_kind, peer_id, service_module = parts
    else:
        provider_kind = None
        peer_id, service_module = value.split(":", 1)

    if service_module and service_module != module:
        return None, (
            f"{field_name} '{value}' targets {service_module}, not {module}"
        ), None
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
