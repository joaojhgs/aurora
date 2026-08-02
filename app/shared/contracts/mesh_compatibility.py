"""Stable, payload-free mesh compatibility reason contracts."""

from typing import Literal, get_args

from app.shared.mesh.observability import MESH_ROLLOUT_REASON_CODES

MeshCompatibilityReasonCode = Literal[
    "provider_not_allowed",
    "service_not_shared",
    "method_not_shared",
    "service_not_advertised",
    "method_not_advertised",
    "permissions_unknown",
    "permission_denied",
    "missing_required_features",
    "missing_required_capability_tags",
    "manifest_projection_stale",
    "incompatible_version",
    "provider_at_capacity",
    "legacy_unverifiable",
]
MeshRoutingReasonCode = MeshCompatibilityReasonCode | Literal["provider_unavailable"]
MeshServiceCompatibilityStatus = Literal["compatible", "incompatible", "unused"]
MESH_COMPATIBILITY_REASON_CODES = frozenset(get_args(MeshCompatibilityReasonCode))

assert MESH_COMPATIBILITY_REASON_CODES <= MESH_ROLLOUT_REASON_CODES
