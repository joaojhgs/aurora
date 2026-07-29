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
import uuid
from collections import OrderedDict
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from app.helpers.aurora_logger import log_debug, log_info, log_warning
from app.services.gateway.mesh.provider_eligibility import (
    OutboundProviderSnapshot,
    OutboundRouteRequirements,
    ProviderEligibilityDecision,
    evaluate_outbound_provider,
)
from app.services.gateway.mesh.provider_export import ACTIVE_MANIFEST_PROTOCOL
from app.shared.contracts.models.mesh import MeshAddressSelector

from .models import PeerManifest, PeerServiceInfo, PeerState, ProviderCandidate, ProviderLeaseState

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig, MeshServicePolicy
    from app.services.gateway.mesh.models import ManifestAck
    from app.services.gateway.mesh.policy_store import MeshPolicyProvider, MeshPolicySnapshot

# Callback type: async fn(peer_id, node_name, status) -> None
PeerLifecycleCallback = Callable[[str, str, str], Coroutine[Any, Any, None]]
_LEGACY_CAPACITY_MODULE = "__legacy__"
_MAX_RETIRED_PROVIDER_LEASE_EPOCHS_PER_PEER = 16


def _protocol_revision_number(value: str | None) -> int | None:
    if not value or not value.startswith("v") or not value[1:].isdigit():
        return None
    return int(value[1:])


@dataclass(frozen=True, slots=True)
class CapacityLease:
    """Idempotent per-peer/per-module capacity lease for remote dispatch."""

    peer_id: str
    module: str
    lease_id: str


class PeerRegistry:
    """Tracks connected peers and their capabilities in the mesh.

    Thread-safe via asyncio.Lock. All mutating operations acquire the lock.
    Read-only operations snapshot state under the lock and release quickly.

    Supports optional lifecycle callbacks for DB persistence:
    - ``on_peer_registered``: called after a peer is (re-)registered
    - ``on_peer_removed``: called after a peer is removed
    - ``on_peer_status_changed``: called when peer status changes
    """

    def __init__(
        self,
        mesh_config: MeshConfig,
        policy_provider: MeshPolicyProvider | None = None,
    ) -> None:
        self._config = mesh_config
        self._policy_provider = policy_provider
        self._peers: dict[str, PeerState] = {}
        self._provider_leases: dict[str, ProviderLeaseState] = {}
        self._retired_provider_lease_epochs: dict[str, OrderedDict[str, None]] = {}
        self._capacity_leases: dict[tuple[str, str], set[str]] = {}
        self._legacy_leases: dict[str, list[CapacityLease]] = {}
        self._lock = asyncio.Lock()
        self._stale_check_task: asyncio.Task | None = None
        self._sleep: Callable[[float], Coroutine[Any, Any, None]] = asyncio.sleep

        # Lifecycle callbacks (set by gateway for DB persistence)
        self.on_peer_registered: PeerLifecycleCallback | None = None
        self.on_peer_removed: PeerLifecycleCallback | None = None
        self.on_peer_status_changed: PeerLifecycleCallback | None = None

    def _snapshot_config(self) -> MeshConfig:
        if self._policy_provider is not None:
            return self._policy_provider().mesh_config
        return self._config

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start the stale peer detection loop."""
        if self._stale_check_task is not None and not self._stale_check_task.done():
            return
        if self._policy_provider is None and self._config.stale_peer_timeout_s <= 0:
            return
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
        should_notify = False
        async with self._lock:
            if peer_id in self._peers:
                # Manifest re-announcements also pass through this method. Keep
                # negotiated state and measured liveness intact instead of
                # fabricating a fresh ping and DB write on every announcement.
                state = self._peers[peer_id]
                if node_name and node_name != state.node_name:
                    state.node_name = node_name
                    should_notify = True
                log_debug(f"PeerRegistry: Peer {peer_id} already registered")
            else:
                self._peers[peer_id] = PeerState(
                    peer_id=peer_id,
                    node_name=node_name,
                    status="authenticated",
                    last_ping=time.monotonic(),
                )
                should_notify = True
                log_info(f"PeerRegistry: Peer {peer_id} registered ({node_name or 'unnamed'})")

        # Fire lifecycle callback outside the lock
        if should_notify and self.on_peer_registered:
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
        status_changed = False
        async with self._lock:
            state = self._peers.get(peer_id)
            if not state:
                log_warning(f"PeerRegistry: Manifest from unknown peer {peer_id}")
                return
            state.manifest = manifest
            state.node_name = manifest.node_name or state.node_name
            node_name = state.node_name
            state.last_manifest = time.monotonic()
            next_status = self._bindable_status_for_peer_locked(peer_id, state)
            status_changed = state.status != next_status
            state.status = next_status
            svc_names = [s.module for s in manifest.shared_services]
            if status_changed:
                log_info(f"PeerRegistry: Peer {peer_id} manifest updated — services: {svc_names}")
            else:
                log_debug(
                    f"PeerRegistry: Peer {peer_id} manifest refreshed — services: {svc_names}"
                )

        # Fire status change callback outside the lock
        if status_changed and self.on_peer_status_changed:
            try:
                await self.on_peer_status_changed(peer_id, node_name, next_status)
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
            current_ack = state.remote_manifest_ack
            current_protocol_revision = _protocol_revision_number(
                current_ack.protocol_revision if current_ack else None
            )
            next_protocol_revision = _protocol_revision_number(ack.protocol_revision)
            if (
                current_protocol_revision is not None
                and next_protocol_revision is not None
                and next_protocol_revision < current_protocol_revision
            ):
                log_warning(
                    f"PeerRegistry: Ignored stale manifest ACK from {peer_id} "
                    f"at protocol revision {ack.protocol_revision}"
                )
                return
            state.remote_compatible = list(ack.compatible_services)
            state.remote_incompatible = list(ack.incompatible_services)
            state.remote_unused = list(ack.unused_services)
            if ack.services or current_ack is None:
                state.remote_manifest_ack = ack.model_copy(deep=True)
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
                self._provider_leases.pop(peer_id, None)
                self._retired_provider_lease_epochs.pop(peer_id, None)
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
        recovered: tuple[str, str, str] | None = None
        async with self._lock:
            state = self._peers.get(peer_id)
            if state:
                state.latency_ms = latency_ms
                state.last_ping = time.monotonic()
                # If peer was stale, restore to negotiated (if it has a bindable manifest)
                if state.status == "stale" and state.manifest:
                    next_status = self._bindable_status_for_peer_locked(peer_id, state)
                    if next_status != "negotiated":
                        return
                    state.status = next_status
                    log_info(
                        f"PeerRegistry: Peer {peer_id} recovered from stale (latency={latency_ms:.1f}ms)"
                    )
                    recovered = (peer_id, state.node_name, "negotiated")

        if recovered and self.on_peer_status_changed:
            try:
                await self.on_peer_status_changed(*recovered)
            except Exception as exc:
                log_warning(f"PeerRegistry: on_peer_status_changed callback failed: {exc}")

    async def increment_active_calls(self, peer_id: str) -> bool:
        """Increment the active call count for a peer.

        Returns False if the peer is at capacity or not found.

        Args:
            peer_id: Peer identifier

        Returns:
            True if the call was permitted, False otherwise
        """
        lease = await self.acquire_capacity_lease(peer_id, _LEGACY_CAPACITY_MODULE)
        if lease is None:
            return False
        self._legacy_leases.setdefault(peer_id, []).append(lease)
        return True

    async def decrement_active_calls(self, peer_id: str) -> None:
        """Decrement the active call count for a peer.

        Args:
            peer_id: Peer identifier
        """
        lease = None
        leases = self._legacy_leases.get(peer_id)
        if leases:
            lease = leases.pop()
        if lease is not None:
            await self.release_capacity_lease(lease)
            return
        await self._release_legacy_capacity_lease(peer_id)

    async def acquire_capacity_lease(
        self,
        peer_id: str,
        module: str,
        lease_id: str | None = None,
    ) -> CapacityLease | None:
        """Atomically acquire an idempotent per-peer/per-module capacity lease."""

        lease_id = lease_id or uuid.uuid4().hex
        async with self._lock:
            state = self._peers.get(peer_id)
            if not state or state.status in {"stale", "provider_unavailable"}:
                return None
            key = (peer_id, module)
            leases = self._capacity_leases.setdefault(key, set())
            if lease_id in leases:
                return CapacityLease(peer_id=peer_id, module=module, lease_id=lease_id)

            service = self._find_peer_service_unlocked(state, module)
            max_concurrent = service.max_concurrent if service else 0
            if max_concurrent > 0 and len(leases) >= max_concurrent:
                return None

            leases.add(lease_id)
            self._sync_active_calls_locked(state)
            return CapacityLease(peer_id=peer_id, module=module, lease_id=lease_id)

    async def release_capacity_lease(
        self,
        lease: CapacityLease | None = None,
        *,
        peer_id: str | None = None,
        module: str | None = None,
        lease_id: str | None = None,
    ) -> None:
        """Release a capacity lease exactly once; duplicate releases are no-ops."""

        if lease is not None:
            peer_id = lease.peer_id
            module = lease.module
            lease_id = lease.lease_id
        if not peer_id or not module or not lease_id:
            return
        async with self._lock:
            self._release_capacity_lease_locked(peer_id, module, lease_id)

    async def _release_legacy_capacity_lease(self, peer_id: str) -> None:
        """Legacy peer-wide release shim for pre-Lane-B callers only."""

        async with self._lock:
            self._release_capacity_lease_locked(peer_id, _LEGACY_CAPACITY_MODULE, None)

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
                state.active_calls_by_module = {}

    async def require_provider_lease(self, peer_id: str) -> None:
        """Mark a stable peer as lease-aware; a manifest alone is not bindable."""

        status_changed: tuple[str, str, str] | None = None
        async with self._lock:
            state = self._peers.get(peer_id)
            if not state:
                return
            if peer_id not in self._provider_leases:
                self._provider_leases[peer_id] = ProviderLeaseState(
                    peer_id=peer_id,
                    connection_epoch="",
                    availability_revision=0,
                    issued_at_ms=0,
                    expires_at_ms=0,
                    available=False,
                    reason_code="lease_missing",
                    lease_required=True,
                )
            next_status = self._bindable_status_for_peer_locked(peer_id, state)
            if state.status != next_status:
                state.status = next_status
                status_changed = (peer_id, state.node_name, next_status)

        if status_changed and self.on_peer_status_changed:
            try:
                await self.on_peer_status_changed(*status_changed)
            except Exception as exc:
                log_warning(f"PeerRegistry: on_peer_status_changed callback failed: {exc}")

    async def apply_provider_lease(
        self,
        lease: ProviderLeaseState,
        *,
        now_ms: int,
    ) -> bool:
        """Apply one provider lease/tombstone with per-peer epoch/revision CAS."""

        status_changed: tuple[str, str, str] | None = None
        async with self._lock:
            state = self._peers.get(lease.peer_id)
            if not state:
                return False
            current = self._provider_leases.get(lease.peer_id)
            retired = self._retired_provider_lease_epochs.get(lease.peer_id)
            if retired and lease.connection_epoch in retired:
                return False
            if current and current.connection_epoch == lease.connection_epoch:
                if lease.availability_revision <= current.availability_revision:
                    return False
            elif current and current.connection_epoch:
                self._retire_provider_lease_epoch_locked(lease.peer_id, current.connection_epoch)
            self._provider_leases[lease.peer_id] = lease
            next_status = self._bindable_status_for_peer_locked(
                lease.peer_id,
                state,
                now_ms=now_ms,
            )
            if state.status != next_status:
                state.status = next_status
                status_changed = (lease.peer_id, state.node_name, next_status)

        if status_changed and self.on_peer_status_changed:
            try:
                await self.on_peer_status_changed(*status_changed)
            except Exception as exc:
                log_warning(f"PeerRegistry: on_peer_status_changed callback failed: {exc}")
        return True

    async def expire_provider_lease(
        self,
        peer_id: str,
        *,
        connection_epoch: str,
        availability_revision: int,
        now_ms: int,
    ) -> bool:
        """Expire the exact current lease without retiring newer state."""

        status_changed: tuple[str, str, str] | None = None
        async with self._lock:
            state = self._peers.get(peer_id)
            current = self._provider_leases.get(peer_id)
            if (
                not state
                or not current
                or current.connection_epoch != connection_epoch
                or current.availability_revision != availability_revision
                or not current.available
                or current.expires_at_ms > now_ms
            ):
                return False
            self._provider_leases[peer_id] = current.model_copy(
                update={"available": False, "reason_code": "lease_expired"}
            )
            next_status = self._bindable_status_for_peer_locked(peer_id, state, now_ms=now_ms)
            if state.status != next_status:
                state.status = next_status
                status_changed = (peer_id, state.node_name, next_status)

        if status_changed and self.on_peer_status_changed:
            try:
                await self.on_peer_status_changed(*status_changed)
            except Exception as exc:
                log_warning(f"PeerRegistry: on_peer_status_changed callback failed: {exc}")
        return True

    def get_provider_lease(self, peer_id: str) -> ProviderLeaseState | None:
        """Return runtime provider lease state for tests/diagnostics."""

        return self._provider_leases.get(peer_id)

    async def clear_provider_lease_session(self, peer_id: str) -> None:
        """Clear lease and bounded epoch history for a disconnected stable peer."""

        async with self._lock:
            self._provider_leases.pop(peer_id, None)
            self._retired_provider_lease_epochs.pop(peer_id, None)

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
            if (
                peer.status != "negotiated"
                or not peer.manifest
                or not _manifest_has_verified_projection_authority(peer.manifest)
            ):
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
        if (
            not state
            or not state.manifest
            or not _manifest_has_verified_projection_authority(state.manifest)
        ):
            return None
        for svc in state.manifest.shared_services:
            if svc.module == module:
                return svc
        return None

    def get_best_provider(
        self,
        module: str,
        topic: str | None = None,
        routing_config: MeshServicePolicy | None = None,
        version_policy: str = "compatible",
        exclude: list[str] | None = None,
        peer_selection: str | None = None,
        policy_snapshot: MeshPolicySnapshot | None = None,
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
                topic=topic,
                routing_config=routing_config,
                version_policy=version_policy,
                exclude=exclude,
                include_ineligible=False,
                policy_snapshot=policy_snapshot,
            )
        ]

        if not candidates:
            return None

        return self._select_peer(candidates, peer_selection=peer_selection)

    def get_provider_candidates(
        self,
        module: str,
        topic: str | None = None,
        routing_config: MeshServicePolicy | None = None,
        version_policy: str = "compatible",
        exclude: list[str] | None = None,
        selector: MeshAddressSelector | None = None,
        include_ineligible: bool = True,
        policy_snapshot: MeshPolicySnapshot | None = None,
    ) -> list[ProviderCandidate]:
        """Return provider candidates with eligibility diagnostics.

        Unlike ``get_best_provider()``, this API preserves every peer that
        advertises the requested module by default and explains why each
        provider is included or excluded. It is the provider aggregation
        surface for remote Tooling discovery and mesh diagnostics.
        """
        policy_snapshot = policy_snapshot or self._current_policy_snapshot()
        if routing_config is None:
            routing_config = policy_snapshot.mesh_config.services.get(module)
        captured_at = time.monotonic()

        selector_peer_id, selector_error = _selector_peer_id(selector, module)
        candidates: list[ProviderCandidate] = []

        for peer in self._peers.values():
            service = self.get_peer_service(peer.peer_id, module)

            candidate = self._evaluate_provider_candidate(
                peer=peer,
                service=service,
                module=module,
                topic=topic,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                version_policy=version_policy,
                exclude=set(exclude or []),
                selector_peer_id=selector_peer_id,
                selector_error=selector_error,
                captured_at=captured_at,
            )
            if include_ineligible or candidate.eligible:
                candidates.append(candidate)

        return candidates

    def _evaluate_provider_candidate(
        self,
        *,
        peer: PeerState,
        service: PeerServiceInfo | None,
        module: str,
        topic: str | None,
        routing_config: MeshServicePolicy | None,
        policy_snapshot: Any,
        version_policy: str,
        exclude: set[str],
        selector_peer_id: str | None,
        selector_error: str | None,
        captured_at: float,
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

        if topic:
            decision = self.evaluate_provider_for_topic(
                peer=peer,
                module=module,
                topic=topic,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                version_policy=version_policy,
                attempted_peer_ids=frozenset(),
                explicit_peer_id=selector_peer_id,
                captured_at=captured_at,
            )
            return _candidate_from_decision(peer, service, decision)

        return self._evaluate_module_provider_candidate(
            peer=peer,
            module=module,
            service=service,
            routing_config=routing_config,
            policy_snapshot=policy_snapshot,
            version_policy=version_policy,
            captured_at=captured_at,
        )

    def evaluate_provider_for_topic(
        self,
        *,
        peer: PeerState,
        module: str,
        topic: str,
        routing_config: MeshServicePolicy | None,
        policy_snapshot: MeshPolicySnapshot | None = None,
        version_policy: str | None = None,
        attempted_peer_ids: frozenset[str] = frozenset(),
        explicit_peer_id: str | None = None,
        captured_at: float | None = None,
    ) -> ProviderEligibilityDecision:
        """Evaluate one peer against one exact bus topic."""

        policy_snapshot = policy_snapshot or self._current_policy_snapshot()
        mesh_config = policy_snapshot.mesh_config
        service = self._find_peer_service_unlocked(peer, module)
        requirements = OutboundRouteRequirements(
            topic=topic,
            module=module,
            policy_snapshot=policy_snapshot,
            routing=routing_config.routing if routing_config else None,
            local_peer_id=None,
            captured_at_monotonic=captured_at if captured_at is not None else time.monotonic(),
            stale_peer_timeout_s=mesh_config.stale_peer_timeout_s,
            version_policy=version_policy or mesh_config.version_policy,
            attempted_peer_ids=attempted_peer_ids,
            explicit_peer_id=explicit_peer_id,
        )
        return evaluate_outbound_provider(
            requirements,
            _provider_snapshot(peer=peer, module=module, service=service),
        )

    def _evaluate_module_provider_candidate(
        self,
        *,
        peer: PeerState,
        module: str,
        service: PeerServiceInfo | None,
        routing_config: MeshServicePolicy | None,
        policy_snapshot: MeshPolicySnapshot,
        version_policy: str,
        captured_at: float,
    ) -> ProviderCandidate:
        if service is None:
            if peer.status == "provider_unavailable" and peer.manifest:
                manifest_service = self._find_peer_service_unlocked(
                    peer,
                    module,
                    include_unavailable=True,
                )
                if manifest_service is not None:
                    return _candidate(
                        peer,
                        manifest_service,
                        False,
                        "provider_unavailable",
                        "provider lease is unavailable",
                    )
            return _candidate(
                peer,
                None,
                False,
                "service_not_advertised",
                "requested service is not advertised by provider",
            )
        topic = _first_method_topic(service)
        if topic:
            decision = self.evaluate_provider_for_topic(
                peer=peer,
                module=service.module,
                topic=topic,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                version_policy=version_policy,
                captured_at=captured_at,
            )
            return _candidate_from_decision(peer, service, decision)
        if peer.status != "negotiated":
            return _candidate(
                peer,
                service,
                False,
                "provider_unavailable"
                if peer.status == "provider_unavailable"
                else "manifest_projection_stale",
                f"peer status is {peer.status}, not negotiated",
            )
        if (
            routing_config
            and routing_config.routing.allowed_provider_peer_ids is not None
            and peer.peer_id not in routing_config.routing.allowed_provider_peer_ids
        ):
            return _candidate(
                peer,
                service,
                False,
                "provider_not_allowed",
                "peer is not allowed by outbound provider policy",
            )
        if service.max_concurrent > 0 and peer.active_calls >= service.max_concurrent:
            return _candidate(
                peer, service, False, "provider_at_capacity", "provider is at capacity"
            )
        return _candidate(peer, service, True, "eligible", "eligible provider")

    def get_service_route_blockers(
        self,
        *,
        peer: PeerState,
        service: PeerServiceInfo,
        routing_config: MeshServicePolicy | None,
        policy_snapshot: MeshPolicySnapshot | None = None,
        version_policy: str | None = None,
    ) -> list[str]:
        """Return module-summary blockers from exact-topic evaluator decisions."""

        if not routing_config:
            return ["no_routing_config"]
        # ``local`` is an automatic-routing preference, not a prohibition on
        # an explicit peer selector. Keep verified remote providers visible so
        # callers can deliberately dispatch to them. ``local_only`` remains a
        # hard outbound boundary.
        if routing_config.routing.prefer == "local_only":
            return [f"routing_prefer:{routing_config.routing.prefer}"]

        topics = sorted(method.bus_topic for method in service.methods if method.bus_topic)
        if not topics:
            return ["method_not_advertised"]

        policy_snapshot = policy_snapshot or self._current_policy_snapshot()
        captured_at = time.monotonic()
        decisions = [
            self.evaluate_provider_for_topic(
                peer=peer,
                module=service.module,
                topic=topic,
                routing_config=routing_config,
                policy_snapshot=policy_snapshot,
                version_policy=version_policy or policy_snapshot.mesh_config.version_policy,
                captured_at=captured_at,
            )
            for topic in topics
        ]
        if any(decision.eligible for decision in decisions):
            return []
        return sorted({decision.reason_code for decision in decisions})

    def _current_policy_snapshot(self) -> Any:
        if self._policy_provider is not None:
            return self._policy_provider()
        from app.services.gateway.mesh.policy_store import MeshPolicySnapshot

        return MeshPolicySnapshot(revision=0, source_revision=None, mesh_config=self._config)

    def _find_peer_service_unlocked(
        self,
        state: PeerState,
        module: str,
        *,
        include_unavailable: bool = False,
    ) -> PeerServiceInfo | None:
        if (
            (state.status == "provider_unavailable" and not include_unavailable)
            or not state.manifest
            or not _manifest_has_verified_projection_authority(state.manifest)
        ):
            return None
        for svc in state.manifest.shared_services:
            if svc.module == module:
                return svc
        return None

    def _sync_active_calls_locked(self, state: PeerState) -> None:
        counts = {
            module: len(leases)
            for (peer_id, module), leases in self._capacity_leases.items()
            if peer_id == state.peer_id and leases
        }
        state.active_calls_by_module = counts
        state.active_calls = sum(counts.values())

    def _release_capacity_lease_locked(
        self,
        peer_id: str,
        module: str,
        lease_id: str | None,
    ) -> None:
        leases = self._capacity_leases.get((peer_id, module))
        if leases:
            if lease_id is None:
                leases.pop()
            else:
                leases.discard(lease_id)
            if not leases:
                self._capacity_leases.pop((peer_id, module), None)
        state = self._peers.get(peer_id)
        if state:
            self._sync_active_calls_locked(state)

    def _bindable_status_for_peer_locked(
        self,
        peer_id: str,
        state: PeerState,
        *,
        now_ms: int | None = None,
    ) -> str:
        lease = self._provider_leases.get(peer_id)
        if lease and lease.lease_required:
            if not lease.available:
                return "provider_unavailable"
            if now_ms is not None and lease.expires_at_ms <= now_ms:
                return "provider_unavailable"
            if state.manifest:
                return "negotiated"
            return "authenticated"
        if state.manifest:
            return "negotiated"
        return "authenticated"

    def _retire_provider_lease_epoch_locked(self, peer_id: str, connection_epoch: str) -> None:
        retired = self._retired_provider_lease_epochs.setdefault(peer_id, OrderedDict())
        retired[connection_epoch] = None
        retired.move_to_end(connection_epoch)
        while len(retired) > _MAX_RETIRED_PROVIDER_LEASE_EPOCHS_PER_PEER:
            retired.popitem(last=False)

    # ── Peer selection ───────────────────────────────────────────────────

    _rr_counter: int = 0

    def _select_peer(
        self,
        candidates: list[PeerState],
        *,
        peer_selection: str | None = None,
    ) -> PeerState | None:
        """Select the best peer from pre-filtered candidates.

        Args:
            candidates: Pre-filtered list of valid peers

        Returns:
            Selected peer, or None if list is empty
        """
        import random

        if not candidates:
            return None

        policy = peer_selection or self._snapshot_config().peer_selection

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
        interval = 10.0
        while True:
            try:
                await self._sleep(interval)
                mesh_config = self._snapshot_config()
                timeout = mesh_config.stale_peer_timeout_s
                interval = max(timeout / 3, 10.0) if timeout > 0 else 10.0
                if timeout > 0:
                    await self._check_stale_peers(mesh_config)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log_warning(f"PeerRegistry: Error in stale check loop: {e}")

    async def _check_stale_peers(self, mesh_config: MeshConfig | None = None) -> None:
        """Mark peers as stale if they haven't responded to pings."""
        mesh_config = mesh_config or self._snapshot_config()
        timeout = mesh_config.stale_peer_timeout_s
        if timeout <= 0:
            return

        now = time.monotonic()
        stale_peers: list[tuple[str, str, str]] = []

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
                    stale_peers.append((peer_id, state.node_name, "stale"))

        if self.on_peer_status_changed:
            for stale_peer in stale_peers:
                try:
                    await self.on_peer_status_changed(*stale_peer)
                except Exception as exc:
                    log_warning(f"PeerRegistry: on_peer_status_changed callback failed: {exc}")


def _candidate(
    peer: PeerState,
    service: PeerServiceInfo | None,
    eligible: bool,
    reason_code: str,
    reason: str,
    decision: ProviderEligibilityDecision | None = None,
) -> ProviderCandidate:
    return ProviderCandidate(
        peer=peer,
        service=service,
        eligible=eligible,
        reason_code=reason_code,
        reason=reason,
        decision=decision,
    )


def _candidate_from_decision(
    peer: PeerState,
    service: PeerServiceInfo | None,
    decision: ProviderEligibilityDecision,
) -> ProviderCandidate:
    return _candidate(
        peer,
        service,
        decision.eligible,
        decision.reason_code,
        decision.reason,
        decision,
    )


def _provider_snapshot(
    *,
    peer: PeerState,
    module: str,
    service: PeerServiceInfo | None,
) -> OutboundProviderSnapshot:
    evidence = peer.manifest.recipient_projection_evidence if peer.manifest else None
    grants = None
    if evidence and evidence.grants is not None:
        grants = frozenset(grant.permission for grant in evidence.grants)
    active_for_module = peer.active_calls_by_module.get(module, peer.active_calls)
    return OutboundProviderSnapshot(
        peer_id=peer.peer_id,
        status=peer.status,
        latency_ms=peer.latency_ms,
        last_ping=peer.last_ping,
        last_manifest=peer.last_manifest,
        service=service,
        active_calls=peer.active_calls,
        active_calls_for_module=active_for_module,
        projection_protocol=evidence.protocol_tier if evidence else None,
        projection_active=bool(peer.manifest and peer.manifest.projection_active),
        projection_tier=peer.manifest.active_tier if peer.manifest else None,
        projection_digest=evidence.projection_digest if evidence else "",
        registry_revision=evidence.registry_revision if evidence else "",
        policy_revision=evidence.policy_revision if evidence else "",
        auth_grant_revision=evidence.auth_grant_revision if evidence else 0,
        auth_grant_state=evidence.auth_grant_state if evidence else "unknown",
        grants=grants,
    )


def _first_method_topic(service: PeerServiceInfo) -> str | None:
    for method in service.methods:
        if method.bus_topic:
            return method.bus_topic
    return None


def _manifest_has_verified_projection_authority(manifest: PeerManifest) -> bool:
    evidence = manifest.recipient_projection_evidence
    return bool(
        manifest.active_protocol == ACTIVE_MANIFEST_PROTOCOL
        and manifest.active_tier == "projection"
        and manifest.projection_active is True
        and evidence is not None
        and evidence.protocol_tier == ACTIVE_MANIFEST_PROTOCOL
        and evidence.auth_grant_state == "active"
        and evidence.auth_grant_revision >= 1
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
