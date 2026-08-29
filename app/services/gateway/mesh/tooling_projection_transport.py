"""Fail-closed transport primitives for recipient-specific Tooling projections.

The wire contracts live with Tooling, but Gateway owns the authenticated RTC
address.  Keep the recipient out of payloads: callers pass a stable peer ID to
``PeerBridge`` separately and inbound events are rebound to the stable identity
of the DataChannel that delivered them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from app.shared.contracts.models.tooling import ToolingMethods

TOOLING_PROJECTION_INVALIDATED_TOPIC = ToolingMethods.PROJECTION_INVALIDATED
TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC = ToolingMethods.PROJECTION_SYNC_REQUESTED
TOOLING_PROJECTION_PROTOCOL_TIER = "projection_v1"

ToolingProtocolStatus = Literal[
    "projection_v1",
    "legacy_unverifiable",
    "protocol_unsupported",
    "baseline_required",
]


@dataclass(frozen=True, slots=True)
class ToolingProtocolSelection:
    """One fail-closed protocol decision for an authenticated provider."""

    status: ToolingProtocolStatus
    selected_tier: str | None = None
    force_full_snapshot: bool = True

    @property
    def supported(self) -> bool:
        return self.status == "projection_v1"


def select_tooling_protocol(
    manifest: Any,
    *,
    manifest_status: str,
    has_verified_baseline: bool = False,
) -> ToolingProtocolSelection:
    """Select only a complete projection transport; never infer legacy support.

    ``projection_v1_delta`` is deliberately recognized only to deny it until a
    verified full baseline exists.  Gateway currently requests a full snapshot
    even after a baseline so page/cursor authority cannot be mixed accidentally.
    """

    if manifest_status != "verified":
        return ToolingProtocolSelection("legacy_unverifiable")

    evidence = getattr(manifest, "recipient_projection_evidence", None)
    manifest_tier = str(getattr(evidence, "protocol_tier", "") or "")
    supported = set(getattr(manifest, "tooling_protocol_tiers", None) or ())
    if manifest_tier == "projection-v1":
        supported.add(TOOLING_PROJECTION_PROTOCOL_TIER)
    if (
        "projection_v1_delta" in supported
        and not has_verified_baseline
        and TOOLING_PROJECTION_PROTOCOL_TIER not in supported
    ):
        return ToolingProtocolSelection("baseline_required")
    if TOOLING_PROJECTION_PROTOCOL_TIER in supported:
        return ToolingProtocolSelection(
            "projection_v1",
            selected_tier=TOOLING_PROJECTION_PROTOCOL_TIER,
        )
    return ToolingProtocolSelection("protocol_unsupported")


def bind_invalidation_to_authenticated_provider(
    params: dict[str, Any],
    *,
    stable_peer_id: str,
) -> dict[str, Any]:
    """Replace every provider routing claim with authenticated RTC authority."""

    normalized = dict(params)
    for field in (
        "peer_id",
        "provider_id",
        "provider_peer_id",
        "source_peer_id",
        "remote_peer_id",
        "service_instance_id",
    ):
        normalized.pop(field, None)
    normalized["provider_peer_id"] = stable_peer_id
    normalized["service_instance_id"] = f"remote:{stable_peer_id}:Tooling"
    return normalized
