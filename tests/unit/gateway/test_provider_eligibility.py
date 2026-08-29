"""Focused tests for exact-topic outbound provider eligibility."""

from app.services.gateway.config import MeshConfig, MeshServiceRoutingPolicy
from app.services.gateway.mesh.models import PeerServiceInfo
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.services.gateway.mesh.provider_eligibility import (
    OutboundProviderSnapshot,
    OutboundRouteRequirements,
    evaluate_outbound_provider,
)
from app.shared.contracts.models.gateway import MethodInfo


def _requirements(
    *,
    routing: MeshServiceRoutingPolicy | None = None,
    topic: str = "Tooling.Execute",
) -> OutboundRouteRequirements:
    return OutboundRouteRequirements(
        topic=topic,
        module=topic.split(".", 1)[0],
        policy_snapshot=MeshPolicySnapshot(
            revision=7,
            source_revision=11,
            mesh_config=MeshConfig(enabled=True),
        ),
        routing=routing or MeshServiceRoutingPolicy(),
        captured_at_monotonic=10.0,
        stale_peer_timeout_s=120,
        version_policy="compatible",
    )


def _service(
    *,
    methods: list[MethodInfo] | None = None,
    features: list[str] | None = None,
    tags: list[str] | None = None,
    max_concurrent: int = 4,
) -> PeerServiceInfo:
    return PeerServiceInfo(
        module="Tooling",
        version="1.2.0",
        capabilities=tags or ["tools"],
        available_feature_ids=features or ["catalog"],
        methods=methods
        if methods is not None
        else [
            MethodInfo(
                name="Execute",
                bus_topic="Tooling.Execute",
                exposure="external",
                required_perms=["Tooling.Execute"],
                method_type="use",
            )
        ],
        max_concurrent=max_concurrent,
    )


def _provider(**overrides) -> OutboundProviderSnapshot:
    values = {
        "peer_id": "peer-a",
        "status": "negotiated",
        "latency_ms": 10.0,
        "last_ping": 1.0,
        "last_manifest": 1.0,
        "service": _service(),
        "projection_protocol": "projection-v1",
        "projection_active": True,
        "projection_tier": "projection",
        "auth_grant_revision": 3,
        "auth_grant_state": "active",
        "grants": frozenset({"Tooling.use"}),
    }
    values.update(overrides)
    return OutboundProviderSnapshot(**values)


def test_provider_allowlist_is_checked_before_legacy_projection_state() -> None:
    decision = evaluate_outbound_provider(
        _requirements(routing=MeshServiceRoutingPolicy(allowed_provider_peer_ids=("other",))),
        _provider(projection_protocol=None, grants=None),
    )

    assert decision.reason_code == "provider_not_allowed"


def test_exact_topic_and_signed_permission_evidence_are_required() -> None:
    no_method = evaluate_outbound_provider(
        _requirements(topic="Tooling.GetTools"),
        _provider(),
    )
    no_grants = evaluate_outbound_provider(
        _requirements(),
        _provider(grants=None),
    )
    empty_requirements = evaluate_outbound_provider(
        _requirements(),
        _provider(
            service=_service(methods=[MethodInfo(name="Execute", bus_topic="Tooling.Execute")])
        ),
    )

    assert no_method.reason_code == "method_not_advertised"
    assert no_grants.reason_code == "permissions_unknown"
    assert empty_requirements.reason_code == "permissions_unknown"


def test_features_and_capability_tags_are_separate_all_of_constraints() -> None:
    routing = MeshServiceRoutingPolicy(
        required_provider_feature_ids=("catalog", "execute"),
        required_provider_capability_tags=("tools", "gpu"),
    )
    missing_feature = evaluate_outbound_provider(
        _requirements(routing=routing),
        _provider(service=_service(features=["catalog"], tags=["tools"])),
    )
    missing_tag = evaluate_outbound_provider(
        _requirements(routing=routing),
        _provider(service=_service(features=["catalog", "execute"], tags=["tools"])),
    )

    assert missing_feature.reason_code == "missing_required_features"
    assert missing_feature.missing_features == ("execute",)
    assert missing_tag.reason_code == "missing_required_capability_tags"
    assert missing_tag.missing_capability_tags == ("gpu",)


def test_module_capacity_is_exact_topic_eligible_until_limit() -> None:
    eligible = evaluate_outbound_provider(
        _requirements(),
        _provider(active_calls_for_module=1, service=_service(max_concurrent=2)),
    )
    full = evaluate_outbound_provider(
        _requirements(),
        _provider(active_calls_for_module=2, service=_service(max_concurrent=2)),
    )

    assert eligible.reason_code == "eligible"
    assert full.reason_code == "provider_at_capacity"
