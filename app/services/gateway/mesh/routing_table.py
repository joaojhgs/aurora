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

        Returns:
            RouteDecision indicating where to deliver the message
        """
        module = _extract_module(topic)

        # Get routing config for this module
        if routing_config is None:
            routing_config = self._config.services.get(module)

        # No routing config or mesh disabled → always local
        if not routing_config:
            return RouteDecision(target="local", module=module)

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

    def resolve_fallback(
        self,
        topic: str,
        routing_config: MeshServiceConfig | None = None,
        failed_peer_id: str | None = None,
    ) -> RouteDecision:
        """Resolve a fallback route after a primary route failure.

        Args:
            topic: Bus topic
            routing_config: Routing configuration
            failed_peer_id: The peer that failed (to exclude)

        Returns:
            RouteDecision for the fallback target
        """
        module = _extract_module(topic)

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
