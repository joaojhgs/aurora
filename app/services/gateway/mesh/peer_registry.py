"""Peer Registry for tracking connected peers and their capabilities.

The PeerRegistry is the central authority for managing mesh peer state.
It lives inside the Gateway service as a component and is responsible for:
- Maintaining the list of connected, authenticated, and negotiated peers
- Storing each peer's manifest (shared services)
- Tracking latency measurements
- Detecting stale peers
- Providing query APIs for the routing table and peer selection
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Callable, Coroutine
from typing import TYPE_CHECKING, Any

from app.helpers.aurora_logger import log_debug, log_info, log_warning
from app.shared.contracts.models.mesh import MeshAddressSelector

from .models import PeerManifest, PeerServiceInfo, PeerState, ProviderCandidate

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig, MeshServiceConfig
    from app.services.gateway.mesh.models import ManifestAck

# Callback type: async fn(peer_id, node_name, status) -> None
PeerLifecycleCallback = Callable[[str, str, str], Coroutine[Any, Any, None]]


class PeerRegistry:
    """Tracks connected peers and their capabilities in the mesh.

    Thread-safe via asyncio.Lock. All mutating operations acquire the lock.
    Read-only operations snapshot state under the lock and release quickly.

    Supports optional lifecycle callbacks for DB persistence:
    - ``on_peer_registered``: called after a peer is (re-)registered
    - ``on_peer_removed``: called after a peer is removed
    - ``on_peer_status_changed``: called when peer status changes
    """

    def __init__(self, mesh_config: MeshConfig) -> None:
        self._config = mesh_config
        self._peers: dict[str, PeerState] = {}
        self._lock = asyncio.Lock()
        self._stale_check_task: asyncio.Task | None = None

        # Lifecycle callbacks (set by gateway for DB persistence)
        self.on_peer_registered: PeerLifecycleCallback | None = None
        self.on_peer_removed: PeerLifecycleCallback | None = None
        self.on_peer_status_changed: PeerLifecycleCallback | None = None

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the stale peer detection loop."""
        if self._config.stale_peer_timeout_s > 0:
            self._stale_check_task = asyncio.create_task(self._stale_check_loop())
            log_info("PeerRegistry stale-check loop started")

    async def stop(self) -> None:
        """Stop the stale peer detection loop."""
        if self._stale_check_task:
            self._stale_check_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stale_check_task
            self._stale_check_task = None

    # ── Mutation ─────────────────────────────────────────────────────────

    async def register_peer(self, peer_id: str, node_name: str = "") -> None:
        """Register a newly authenticated peer.

        Called when a WebRTC peer successfully completes authentication.
        The peer starts in 'authenticated' status, awaiting manifest exchange.

        Args:
            peer_id: Unique peer identifier
            node_name: Human-readable name for the peer
        """
        async with self._lock:
            if peer_id in self._peers:
                # Re-registration (reconnect) — reset state
                self._peers[peer_id].status = "authenticated"
                self._peers[peer_id].node_name = node_name or self._peers[peer_id].node_name
                self._peers[peer_id].last_ping = time.monotonic()
                log_info(f"PeerRegistry: Peer {peer_id} re-registered")
            else:
                self._peers[peer_id] = PeerState(
                    peer_id=peer_id,
                    node_name=node_name,
                    status="authenticated",
                    last_ping=time.monotonic(),
                )
                log_info(f"PeerRegistry: Peer {peer_id} registered ({node_name or 'unnamed'})")

        # Fire lifecycle callback outside the lock
        if self.on_peer_registered:
            try:
                await self.on_peer_registered(peer_id, node_name, "authenticated")
            except Exception as exc:
                log_warning(f"PeerRegistry: on_peer_registered callback failed: {exc}")

    async def update_manifest(self, peer_id: str, manifest: PeerManifest) -> None:
        """Update a peer's capability manifest.

        Called when a peer sends (or re-sends) its manifest.
        Transitions the peer to 'negotiated' status.

        Args:
            peer_id: Peer identifier
            manifest: The peer's capability manifest
        """
        node_name = ""
        async with self._lock:
            state = self._peers.get(peer_id)
            if not state:
                log_warning(f"PeerRegistry: Manifest from unknown peer {peer_id}")
                return
            state.manifest = manifest
            state.node_name = manifest.node_name or state.node_name
            node_name = state.node_name
            state.last_manifest = time.monotonic()
            state.status = "negotiated"
            svc_names = [s.module for s in manifest.shared_services]
            log_info(f"PeerRegistry: Peer {peer_id} manifest updated — services: {svc_names}")

        # Fire status change callback outside the lock
        if self.on_peer_status_changed:
            try:
                await self.on_peer_status_changed(peer_id, node_name, "negotiated")
            except Exception as exc:
                log_warning(f"PeerRegistry: on_peer_status_changed callback failed: {exc}")

    async def update_manifest_ack(self, peer_id: str, ack: ManifestAck) -> None:
        """Store a manifest ACK's compatibility report for a peer.

        Called when a remote peer responds to our manifest with their
        compatibility assessment of our shared services.

        Args:
            peer_id: Peer identifier
            ack: The manifest acknowledgment with compatibility data
        """
        async with self._lock:
            state = self._peers.get(peer_id)
            if not state:
                log_warning(f"PeerRegistry: Manifest ACK from unknown peer {peer_id}")
                return
            state.remote_compatible = list(ack.compatible_services)
            state.remote_incompatible = list(ack.incompatible_services)
            state.remote_unused = list(ack.unused_services)
            log_debug(
                f"PeerRegistry: Peer {peer_id} ACK stored — "
                f"compat={ack.compatible_services}, "
                f"incompat={ack.incompatible_services}"
            )

    async def remove_peer(self, peer_id: str) -> None:
        """Remove a peer from the registry.

        Called when a peer disconnects or is force-disconnected.

        Args:
            peer_id: Peer identifier to remove
        """
        node_name = ""
        async with self._lock:
            removed = self._peers.pop(peer_id, None)
            if removed:
                node_name = removed.node_name
                log_info(f"PeerRegistry: Peer {peer_id} removed")

        # Fire lifecycle callback outside the lock
        if removed and self.on_peer_removed:
            try:
                await self.on_peer_removed(peer_id, node_name, "disconnected")
            except Exception as exc:
                log_warning(f"PeerRegistry: on_peer_removed callback failed: {exc}")

    async def update_latency(self, peer_id: str, latency_ms: float) -> None:
        """Update latency measurement for a peer.

        Called after a successful ping/pong exchange.

        Args:
            peer_id: Peer identifier
            latency_ms: Measured round-trip time in milliseconds
        """
        async with self._lock:
            state = self._peers.get(peer_id)
            if state:
                state.latency_ms = latency_ms
                state.last_ping = time.monotonic()
                # If peer was stale, restore to negotiated (if it has a manifest)
                if state.status == "stale" and state.manifest:
                    state.status = "negotiated"
                    log_info(
                        f"PeerRegistry: Peer {peer_id} recovered from stale (latency={latency_ms:.1f}ms)"
                    )

    async def increment_active_calls(self, peer_id: str) -> bool:
        """Increment the active call count for a peer.

        Returns False if the peer is at capacity or not found.

        Args:
            peer_id: Peer identifier

        Returns:
            True if the call was permitted, False otherwise
        """
        async with self._lock:
            state = self._peers.get(peer_id)
            if not state or state.status == "stale":
                return False
            state.active_calls += 1
            return True

    async def decrement_active_calls(self, peer_id: str) -> None:
        """Decrement the active call count for a peer.

        Args:
            peer_id: Peer identifier
        """
        async with self._lock:
            state = self._peers.get(peer_id)
            if state and state.active_calls > 0:
                state.active_calls -= 1

    async def set_active_calls(self, peer_id: str, count: int) -> None:
        """Set the active call count for a peer directly.

        Used when receiving a capacity update from a remote peer
        that reports its own active/available counts.

        Args:
            peer_id: Peer identifier
            count: New active call count
        """
        async with self._lock:
            state = self._peers.get(peer_id)
            if state:
                state.active_calls = max(0, count)

    # ── Queries ──────────────────────────────────────────────────────────

    def get_peer(self, peer_id: str) -> PeerState | None:
        """Get the state of a specific peer.

        Args:
            peer_id: Peer identifier

        Returns:
            PeerState if found, None otherwise
        """
        return self._peers.get(peer_id)

    def get_all_peers(self) -> list[PeerState]:
        """Get all registered peers.

        Returns:
            List of all peer states
        """
        return list(self._peers.values())

    def get_negotiated_peers(self) -> list[PeerState]:
        """Get all peers that have completed negotiation.

        Returns:
            List of negotiated peer states
        """
        return [p for p in self._peers.values() if p.status == "negotiated"]

    def get_providers(self, module: str) -> list[PeerState]:
        """Get all peers that share a given service module.

        Filters by:
        - Peer has the module in their manifest
        - Peer is in 'negotiated' status (not stale or just authenticated)

        Args:
            module: Service module name (e.g., "TTS", "Orchestrator")

        Returns:
            List of peers that provide the requested module
        """
        providers = []
        for peer in self._peers.values():
            if peer.status != "negotiated" or not peer.manifest:
                continue
            for svc in peer.manifest.shared_services:
                if svc.module == module:
                    providers.append(peer)
                    break
        return providers

    def get_peer_service(self, peer_id: str, module: str):
        """Get a specific service info from a peer's manifest.

        Args:
            peer_id: Peer identifier
            module: Service module name

        Returns:
            PeerServiceInfo if found, None otherwise
        """
        state = self._peers.get(peer_id)
        if not state or not state.manifest:
            return None
        for svc in state.manifest.shared_services:
            if svc.module == module:
                return svc
        return None

    def get_best_provider(
        self,
        module: str,
        routing_config: MeshServiceConfig | None = None,
        version_policy: str = "compatible",
        exclude: list[str] | None = None,
    ) -> PeerState | None:
        """Get the best peer for a service based on routing policy.

        Selection criteria (applied in order):
        1. Filter by negotiated status
        2. Filter by module availability
        3. Filter by version compatibility (if routing_config.min_version)
        4. Filter by required capabilities
        5. Filter by available capacity
        6. Exclude specified peers
        7. Sort by selection policy (latency, round-robin, random)

        Args:
            module: Service module name
            routing_config: Routing configuration for version/capability filtering
            version_policy: Version matching policy
            exclude: Peer IDs to exclude from selection

        Returns:
            Best matching PeerState, or None if no suitable peer found
        """
        candidates = [
            candidate.peer
            for candidate in self.get_provider_candidates(
                module=module,
                routing_config=routing_config,
                version_policy=version_policy,
                exclude=exclude,
                include_ineligible=False,
            )
        ]

        if not candidates:
            return None

        return self._select_peer(candidates)

    def get_provider_candidates(
        self,
        module: str,
        routing_config: MeshServiceConfig | None = None,
        version_policy: str = "compatible",
        exclude: list[str] | None = None,
        selector: MeshAddressSelector | None = None,
        include_ineligible: bool = True,
    ) -> list[ProviderCandidate]:
        """Return provider candidates with eligibility diagnostics.

        Unlike ``get_best_provider()``, this API preserves every peer that
        advertises the requested module by default and explains why each
        provider is included or excluded. It is the provider aggregation
        surface for remote Tooling discovery and mesh diagnostics.
        """
        if routing_config is None:
            routing_config = self._config.services.get(module)

        selector_peer_id, selector_error = _selector_peer_id(selector, module)
        candidates: list[ProviderCandidate] = []

        for peer in self._peers.values():
            service = self.get_peer_service(peer.peer_id, module)
            if not service:
                continue

            candidate = self._evaluate_provider_candidate(
                peer=peer,
                service=service,
                module=module,
                routing_config=routing_config,
                version_policy=version_policy,
                exclude=set(exclude or []),
                selector_peer_id=selector_peer_id,
                selector_error=selector_error,
            )
            if include_ineligible or candidate.eligible:
                candidates.append(candidate)

        return candidates

    def _evaluate_provider_candidate(
        self,
        *,
        peer: PeerState,
        service: PeerServiceInfo,
        module: str,
        routing_config: MeshServiceConfig | None,
        version_policy: str,
        exclude: set[str],
        selector_peer_id: str | None,
        selector_error: str | None,
    ) -> ProviderCandidate:
        if peer.peer_id in exclude:
            return _candidate(peer, service, False, "excluded_peer", "peer excluded from selection")

        if selector_error:
            return _candidate(peer, service, False, "selector_conflict", selector_error)

        if selector_peer_id and peer.peer_id != selector_peer_id:
            return _candidate(
                peer,
                service,
                False,
                "selector_mismatch",
                f"selector targets peer/provider '{selector_peer_id}'",
            )

        if peer.status != "negotiated":
            return _candidate(
                peer,
                service,
                False,
                "peer_stale" if peer.status == "stale" else "peer_not_negotiated",
                f"peer status is {peer.status}, not negotiated",
            )

        if (
            routing_config
            and routing_config.allowed_peers is not None
            and peer.peer_id not in routing_config.allowed_peers
        ):
            return _candidate(
                peer,
                service,
                False,
                "peer_not_allowed",
                "peer is not allowed by module policy",
            )

        if routing_config and routing_config.min_version:
            from .version_compat import is_compatible

            if not is_compatible(
                routing_config.min_version,
                service.version,
                version_policy,
                routing_config.min_version,
            ):
                return _candidate(
                    peer,
                    service,
                    False,
                    "incompatible_version",
                    f"version {service.version} does not satisfy {routing_config.min_version}",
                )

        if routing_config and routing_config.required_capabilities:
            missing = [
                cap
                for cap in routing_config.required_capabilities
                if cap not in service.capabilities
            ]
            if missing:
                return _candidate(
                    peer,
                    service,
                    False,
                    "missing_capabilities",
                    f"missing required capabilities: {', '.join(missing)}",
                )

        if service.max_concurrent > 0 and peer.active_calls >= service.max_concurrent:
            return _candidate(
                peer,
                service,
                False,
                "provider_at_capacity",
                "provider is at capacity",
            )

        return _candidate(peer, service, True, "eligible", "eligible provider")

    # ── Peer selection ───────────────────────────────────────────────────

    _rr_counter: int = 0

    def _select_peer(self, candidates: list[PeerState]) -> PeerState | None:
        """Select the best peer from pre-filtered candidates.

        Args:
            candidates: Pre-filtered list of valid peers

        Returns:
            Selected peer, or None if list is empty
        """
        import random

        if not candidates:
            return None

        policy = self._config.peer_selection

        if policy == "lowest_latency":
            return min(candidates, key=lambda p: p.latency_ms)
        elif policy == "round_robin":
            self._rr_counter = (self._rr_counter + 1) % len(candidates)
            return candidates[self._rr_counter]
        elif policy == "random":
            return random.choice(candidates)

        # Default: lowest latency
        return min(candidates, key=lambda p: p.latency_ms)

    # ── Stale detection ──────────────────────────────────────────────────

    async def _stale_check_loop(self) -> None:
        """Periodically check for stale peers and mark them."""
        interval = max(self._config.stale_peer_timeout_s / 3, 10.0)
        while True:
            try:
                await asyncio.sleep(interval)
                await self._check_stale_peers()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log_warning(f"PeerRegistry: Error in stale check loop: {e}")

    async def _check_stale_peers(self) -> None:
        """Mark peers as stale if they haven't responded to pings."""
        now = time.monotonic()
        timeout = self._config.stale_peer_timeout_s

        async with self._lock:
            for peer_id, state in list(self._peers.items()):
                if state.status == "stale":
                    continue
                if state.last_ping > 0 and (now - state.last_ping) > timeout:
                    state.status = "stale"
                    log_warning(
                        f"PeerRegistry: Peer {peer_id} marked stale "
                        f"(no ping response for {timeout}s)"
                    )


def _candidate(
    peer: PeerState,
    service: PeerServiceInfo,
    eligible: bool,
    reason_code: str,
    reason: str,
) -> ProviderCandidate:
    return ProviderCandidate(
        peer=peer,
        service=service,
        eligible=eligible,
        reason_code=reason_code,
        reason=reason,
    )


def _selector_peer_id(
    selector: MeshAddressSelector | None, module: str
) -> tuple[str | None, str | None]:
    """Resolve selector peer aliases into a single peer id."""
    if not selector or not selector.has_routing_target():
        return None, None

    peer_ids: list[str] = []
    for value, field_name in (
        (selector.peer_id, "peer_id"),
        (selector.provider_id, "provider_id"),
        (selector.service_instance_id, "service_instance_id"),
    ):
        peer_id, error = _parse_selector_peer_id(value, field_name, module)
        if error:
            return None, error
        if peer_id and peer_id not in peer_ids:
            peer_ids.append(peer_id)

    if len(peer_ids) > 1:
        return None, f"selector names multiple peer/provider targets: {', '.join(peer_ids)}"
    return (peer_ids[0], None) if peer_ids else (None, None)


def _parse_selector_peer_id(
    value: str | None,
    field_name: str,
    module: str,
) -> tuple[str | None, str | None]:
    if not value:
        return None, None
    if ":" not in value:
        return value, None

    parts = value.split(":")
    if len(parts) == 3 and parts[0] in {"local", "remote"}:
        _, peer_id, service_module = parts
    else:
        peer_id, service_module = value.split(":", 1)

    if service_module and service_module != module:
        return None, f"{field_name} '{value}' targets {service_module}, not {module}"
    return peer_id, None
