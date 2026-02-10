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
import time
from typing import TYPE_CHECKING

from app.helpers.aurora_logger import log_debug, log_info, log_warning

from .models import PeerManifest, PeerState

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig, ServiceRoutingConfig


class PeerRegistry:
    """Tracks connected peers and their capabilities in the mesh.

    Thread-safe via asyncio.Lock. All mutating operations acquire the lock.
    Read-only operations snapshot state under the lock and release quickly.
    """

    def __init__(self, mesh_config: MeshConfig) -> None:
        self._config = mesh_config
        self._peers: dict[str, PeerState] = {}
        self._lock = asyncio.Lock()
        self._stale_check_task: asyncio.Task | None = None

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
            try:
                await self._stale_check_task
            except asyncio.CancelledError:
                pass
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

    async def update_manifest(self, peer_id: str, manifest: PeerManifest) -> None:
        """Update a peer's capability manifest.

        Called when a peer sends (or re-sends) its manifest.
        Transitions the peer to 'negotiated' status.

        Args:
            peer_id: Peer identifier
            manifest: The peer's capability manifest
        """
        async with self._lock:
            state = self._peers.get(peer_id)
            if not state:
                log_warning(f"PeerRegistry: Manifest from unknown peer {peer_id}")
                return
            state.manifest = manifest
            state.node_name = manifest.node_name or state.node_name
            state.last_manifest = time.monotonic()
            state.status = "negotiated"
            svc_names = [s.module for s in manifest.shared_services]
            log_info(
                f"PeerRegistry: Peer {peer_id} manifest updated — "
                f"services: {svc_names}"
            )

    async def remove_peer(self, peer_id: str) -> None:
        """Remove a peer from the registry.

        Called when a peer disconnects or is force-disconnected.

        Args:
            peer_id: Peer identifier to remove
        """
        async with self._lock:
            removed = self._peers.pop(peer_id, None)
            if removed:
                log_info(f"PeerRegistry: Peer {peer_id} removed")

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
                    log_info(f"PeerRegistry: Peer {peer_id} recovered from stale (latency={latency_ms:.1f}ms)")

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
        routing_config: ServiceRoutingConfig | None = None,
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
        from .version_compat import is_compatible

        exclude_set = set(exclude or [])
        candidates = []

        for peer in self._peers.values():
            if peer.peer_id in exclude_set:
                continue
            if peer.status != "negotiated" or not peer.manifest:
                continue

            # Find the matching service in manifest
            svc_info = None
            for svc in peer.manifest.shared_services:
                if svc.module == module:
                    svc_info = svc
                    break
            if not svc_info:
                continue

            # Check allowed_peers in sharing config
            sharing = self._config.sharing.get(module)
            if sharing and sharing.allowed_peers is not None:
                if peer.peer_id not in sharing.allowed_peers:
                    continue

            # Version compatibility check
            if routing_config and routing_config.min_version:
                if not is_compatible(
                    routing_config.min_version,
                    svc_info.version,
                    version_policy,
                    routing_config.min_version,
                ):
                    continue

            # Required capabilities check
            if routing_config and routing_config.required_capabilities:
                if not all(
                    cap in svc_info.capabilities
                    for cap in routing_config.required_capabilities
                ):
                    continue

            # Capacity check
            if svc_info.max_concurrent > 0 and peer.active_calls >= svc_info.max_concurrent:
                continue

            candidates.append(peer)

        if not candidates:
            return None

        return self._select_peer(candidates)

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
