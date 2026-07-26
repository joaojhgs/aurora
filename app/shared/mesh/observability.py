"""Payload-free observability contracts for mesh rollout and support diagnostics.

This module is diagnostic only.  It must never participate in an authorization,
routing, projection, or execution decision.
"""

from __future__ import annotations

from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from threading import Lock
from typing import Literal, get_args

MeshRolloutReasonCode = Literal[
    "service_not_shared",
    "feature_not_shared",
    "method_not_shared",
    "method_not_exposed",
    "provider_not_allowed",
    "service_not_advertised",
    "method_not_advertised",
    "permissions_unknown",
    "permission_denied",
    "missing_required_features",
    "missing_required_capability_tags",
    "manifest_projection_stale",
    "incompatible_version",
    "provider_at_capacity",
    "tool_not_shared",
    "tool_group_not_shared",
    "tool_permission_denied",
    "tool_approval_required",
    "tool_schema_review_required",
    "snapshot_revision_changed",
    "config_revision_conflict",
    "unsafe_downgrade_blocked",
    "legacy_unverifiable",
    "protocol_unsupported",
    "baseline_required",
    "provider_mesh_tooling_disabled",
    "consumer_mesh_tooling_disabled",
    "projection_sync_failed",
]
MeshRolloutEvent = Literal[
    "manifest_sent",
    "manifest_failed",
    "manifest_retry",
    "manifest_retry_exhausted",
    "route_denied",
    "route_candidate_denied",
    "catalog_failed",
]

MESH_ROLLOUT_REASON_CODES = frozenset(get_args(MeshRolloutReasonCode))
MESH_ROLLOUT_EVENTS = frozenset(get_args(MeshRolloutEvent))

_REASON_ALIASES = {
    "feature_unshared": "feature_not_shared",
    "method_unshared": "method_not_shared",
    "permissions_denied": "permission_denied",
    "tooling_service_not_shared": "service_not_shared",
    "tooling_feature_not_shared": "feature_not_shared",
    "tooling_method_not_shared": "method_not_shared",
    "remote_catalog_snapshot_revision_changed": "snapshot_revision_changed",
}


def canonical_mesh_rollout_reason(reason: str | None) -> MeshRolloutReasonCode | None:
    """Map internal spellings to the stable public taxonomy, or return ``None``."""

    if not reason:
        return None
    normalized = _REASON_ALIASES.get(str(reason), str(reason))
    if normalized not in MESH_ROLLOUT_REASON_CODES:
        return None
    return normalized  # type: ignore[return-value]


@dataclass(slots=True)
class _PeerRolloutState:
    manifest_revision: int = 0
    catalog_revision: int = 0
    export_policy_revision: int = 0
    auth_grant_revision: int = 0
    switch_revision: int = 0
    projection_size: int = 0
    last_sync_duration_ms: float | None = None
    protocol_status: str = "unknown"
    last_reason_code: MeshRolloutReasonCode | None = None
    counters: Counter[str] = field(default_factory=Counter)


class MeshRolloutMetrics:
    """Bounded in-memory rollout metrics without names, payloads, or schemas."""

    def __init__(self, *, max_peers: int = 128) -> None:
        self._max_peers = max(1, max_peers)
        self._peers: OrderedDict[str, _PeerRolloutState] = OrderedDict()
        self._totals: Counter[str] = Counter()
        self._denied: Counter[str] = Counter()
        self._lock = Lock()

    def record(
        self,
        event: MeshRolloutEvent,
        *,
        peer_id: str | None = None,
        reason_code: str | None = None,
        manifest_revision: int | None = None,
        catalog_revision: int | None = None,
        export_policy_revision: int | None = None,
        auth_grant_revision: int | None = None,
        switch_revision: int | None = None,
        projection_size: int | None = None,
        sync_duration_ms: float | None = None,
        protocol_status: str | None = None,
    ) -> None:
        """Record fixed-shape metadata; caller payloads are intentionally unsupported."""

        if event not in MESH_ROLLOUT_EVENTS:
            return
        canonical_reason = canonical_mesh_rollout_reason(reason_code)
        with self._lock:
            self._totals[event] += 1
            if canonical_reason and ("denied" in event or "failed" in event):
                self._denied[canonical_reason] += 1
            if not peer_id:
                return
            state = self._peers.pop(peer_id, _PeerRolloutState())
            self._peers[peer_id] = state
            while len(self._peers) > self._max_peers:
                self._peers.popitem(last=False)
            state.counters[event] += 1
            if canonical_reason:
                state.last_reason_code = canonical_reason
            for name, value in (
                ("manifest_revision", manifest_revision),
                ("catalog_revision", catalog_revision),
                ("export_policy_revision", export_policy_revision),
                ("auth_grant_revision", auth_grant_revision),
                ("switch_revision", switch_revision),
                ("projection_size", projection_size),
            ):
                if value is not None:
                    setattr(state, name, max(0, int(value)))
            if sync_duration_ms is not None:
                state.last_sync_duration_ms = max(0.0, round(float(sync_duration_ms), 3))
            if protocol_status:
                state.protocol_status = str(protocol_status)

    def snapshot(self) -> dict[str, object]:
        """Return a deterministic JSON-safe copy for status/support bundles."""

        with self._lock:
            peers = [
                {
                    "peer_id": peer_id,
                    "manifest_revision": state.manifest_revision,
                    "catalog_revision": state.catalog_revision,
                    "export_policy_revision": state.export_policy_revision,
                    "auth_grant_revision": state.auth_grant_revision,
                    "switch_revision": state.switch_revision,
                    "projection_size": state.projection_size,
                    "last_sync_duration_ms": state.last_sync_duration_ms,
                    "protocol_status": state.protocol_status,
                    "last_reason_code": state.last_reason_code,
                    "counters": dict(sorted(state.counters.items())),
                }
                for peer_id, state in self._peers.items()
            ]
            return {
                "counters": dict(sorted(self._totals.items())),
                "denied_by_reason": dict(sorted(self._denied.items())),
                "peers": peers,
                "secrets_redacted": True,
            }
