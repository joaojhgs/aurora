"""Pure exact-topic outbound provider eligibility evaluation."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

from app.services.gateway.config import MeshServiceRoutingPolicy
from app.services.gateway.mesh.models import PeerServiceInfo
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.shared.auth.permissions import check_access
from app.shared.contracts.mesh_compatibility import MeshCompatibilityReasonCode
from app.shared.contracts.models.gateway import MethodInfo

from .version_compat import is_compatible

ProviderEligibilityReason = MeshCompatibilityReasonCode | Literal["eligible", "excluded_peer"]


@dataclass(frozen=True, slots=True)
class OutboundRouteRequirements:
    """Immutable facts captured once for a route operation."""

    topic: str
    module: str
    policy_snapshot: MeshPolicySnapshot
    routing: MeshServiceRoutingPolicy | None
    local_peer_id: str | None = None
    captured_at_monotonic: float = field(default_factory=time.monotonic)
    stale_peer_timeout_s: float = 0.0
    version_policy: str = "compatible"
    attempted_peer_ids: frozenset[str] = frozenset()
    explicit_peer_id: str | None = None


@dataclass(frozen=True, slots=True)
class OutboundProviderSnapshot:
    """Immutable peer/provider facts for one evaluation."""

    peer_id: str
    status: str
    latency_ms: float
    last_ping: float
    last_manifest: float
    service: PeerServiceInfo | None
    active_calls: int = 0
    active_calls_for_module: int = 0
    projection_protocol: str | None = None
    projection_active: bool = False
    projection_tier: str | None = None
    projection_digest: str = ""
    registry_revision: str = ""
    policy_revision: str = ""
    auth_grant_revision: int = 0
    auth_grant_state: str = "unknown"
    grants: frozenset[str] | None = None


@dataclass(frozen=True, slots=True)
class ProviderEligibilityDecision:
    """Pure decision for one peer/topic/module under one policy snapshot."""

    peer_id: str
    topic: str
    module: str
    eligible: bool
    reason_code: ProviderEligibilityReason
    reason: str
    policy_revision: int
    projection_registry_revision: str = ""
    projection_policy_revision: str = ""
    auth_grant_revision: int = 0
    projection_digest: str = ""
    service_version: str = ""
    service_digest: str = ""
    method_name: str | None = None
    method_type: str | None = None
    required_perms: tuple[str, ...] = ()
    granted_permissions: tuple[str, ...] = ()
    missing_features: tuple[str, ...] = ()
    missing_capability_tags: tuple[str, ...] = ()
    active_calls: int = 0
    max_concurrent: int = 0
    available_capacity: int | None = None


def evaluate_outbound_provider(
    requirements: OutboundRouteRequirements,
    provider: OutboundProviderSnapshot,
) -> ProviderEligibilityDecision:
    """Evaluate exact-topic outbound eligibility without live reads or mutation."""

    service = provider.service
    routing = requirements.routing
    base = {
        "peer_id": provider.peer_id,
        "topic": requirements.topic,
        "module": requirements.module,
        "policy_revision": requirements.policy_snapshot.revision,
        "projection_registry_revision": provider.registry_revision,
        "projection_policy_revision": provider.policy_revision,
        "auth_grant_revision": provider.auth_grant_revision,
        "projection_digest": provider.projection_digest,
        "service_version": service.version if service else "",
        "service_digest": service.digest if service else "",
        "active_calls": provider.active_calls_for_module,
        "max_concurrent": service.max_concurrent if service else 0,
        "available_capacity": _available_capacity(service, provider.active_calls_for_module),
    }

    if provider.peer_id in requirements.attempted_peer_ids:
        return _decision(
            **base, eligible=False, reason_code="excluded_peer", reason="peer was already attempted"
        )

    if requirements.explicit_peer_id and provider.peer_id != requirements.explicit_peer_id:
        return _decision(
            **base,
            eligible=False,
            reason_code="provider_not_allowed",
            reason=f"selector constrains routing to peer/provider '{requirements.explicit_peer_id}'",
        )

    allowed = routing.allowed_provider_peer_ids if routing else None
    if allowed is not None and provider.peer_id not in allowed:
        return _decision(
            **base,
            eligible=False,
            reason_code="provider_not_allowed",
            reason="peer is not allowed by outbound provider policy",
        )

    if provider.status != "negotiated":
        return _decision(
            **base,
            eligible=False,
            reason_code="manifest_projection_stale",
            reason=f"peer status is {provider.status}, not negotiated",
        )

    if _is_stale(requirements, provider):
        return _decision(
            **base,
            eligible=False,
            reason_code="manifest_projection_stale",
            reason="peer projection or liveness is stale",
        )

    if not _has_projection_v1_authority(provider):
        return _decision(
            **base,
            eligible=False,
            reason_code="legacy_unverifiable",
            reason="provider manifest lacks verified projection-v1 authority",
        )

    if provider.auth_grant_state != "active" or provider.auth_grant_revision < 1:
        return _decision(
            **base,
            eligible=False,
            reason_code="permissions_unknown",
            reason="recipient grant evidence is not active",
        )

    if service is None:
        return _decision(
            **base,
            eligible=False,
            reason_code="service_not_advertised",
            reason=f"{requirements.module} is not advertised by provider",
        )

    method = _find_exact_method(service, requirements.topic)
    if method is None:
        return _decision(
            **base,
            eligible=False,
            reason_code="method_not_advertised",
            reason=f"{requirements.topic} is not advertised by provider",
        )

    method_base = {
        **base,
        "method_name": method.name,
        "method_type": method.method_type,
        "required_perms": tuple(method.required_perms),
        "granted_permissions": tuple(sorted(provider.grants or ())),
    }
    if provider.grants is None:
        return _decision(
            **method_base,
            eligible=False,
            reason_code="permissions_unknown",
            reason="recipient grant evidence is missing",
        )

    if not method.required_perms and not method.public_infrastructure:
        return _decision(
            **method_base,
            eligible=False,
            reason_code="permissions_unknown",
            reason=f"{requirements.topic} lacks signed required permission evidence",
        )

    if not check_access(set(provider.grants), list(method.required_perms), method.method_type):
        return _decision(
            **method_base,
            eligible=False,
            reason_code="permission_denied",
            reason=f"recipient grants do not satisfy {requirements.topic}",
        )

    required_features = tuple(routing.required_provider_feature_ids if routing else ())
    missing_features = tuple(
        feature_id
        for feature_id in required_features
        if feature_id not in service.available_feature_ids
    )
    if missing_features:
        return _decision(
            **method_base,
            eligible=False,
            reason_code="missing_required_features",
            reason=f"missing required callable features: {', '.join(missing_features)}",
            missing_features=missing_features,
        )

    required_tags = tuple(routing.required_provider_capability_tags if routing else ())
    missing_tags = tuple(tag for tag in required_tags if tag not in service.capabilities)
    if missing_tags:
        return _decision(
            **method_base,
            eligible=False,
            reason_code="missing_required_capability_tags",
            reason=f"missing required capability tags: {', '.join(missing_tags)}",
            missing_capability_tags=missing_tags,
        )

    if (
        routing
        and routing.min_version
        and not is_compatible(
            routing.min_version,
            service.version,
            requirements.version_policy,
            routing.min_version,
        )
    ):
        return _decision(
            **method_base,
            eligible=False,
            reason_code="incompatible_version",
            reason=f"version {service.version} does not satisfy {routing.min_version}",
        )

    if service.max_concurrent > 0 and provider.active_calls_for_module >= service.max_concurrent:
        return _decision(
            **method_base,
            eligible=False,
            reason_code="provider_at_capacity",
            reason="provider is at capacity",
        )

    return _decision(
        **method_base, eligible=True, reason_code="eligible", reason="eligible provider"
    )


def _decision(**kwargs: object) -> ProviderEligibilityDecision:
    return ProviderEligibilityDecision(**kwargs)


def _find_exact_method(service: PeerServiceInfo, topic: str) -> MethodInfo | None:
    for method in service.methods:
        if method.bus_topic == topic:
            return method
    return None


def _is_stale(
    requirements: OutboundRouteRequirements,
    provider: OutboundProviderSnapshot,
) -> bool:
    timeout = requirements.stale_peer_timeout_s
    if timeout <= 0:
        return False
    last_seen = max(provider.last_ping, provider.last_manifest)
    return last_seen > 0 and (requirements.captured_at_monotonic - last_seen) > timeout


def _has_projection_v1_authority(provider: OutboundProviderSnapshot) -> bool:
    return (
        provider.projection_protocol == "projection-v1"
        and provider.projection_tier == "projection"
        and provider.projection_active
    )


def _available_capacity(service: PeerServiceInfo | None, active_calls: int) -> int | None:
    if service is None or service.max_concurrent <= 0:
        return None
    return max(service.max_concurrent - active_calls, 0)
