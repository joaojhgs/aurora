from app.shared.mesh.observability import (
    MESH_ROLLOUT_REASON_CODES,
    MeshRolloutMetrics,
    canonical_mesh_rollout_reason,
)


def test_public_reason_taxonomy_covers_rollout_and_switch_failures() -> None:
    assert {
        "method_not_shared",
        "missing_required_features",
        "permissions_unknown",
        "permission_denied",
        "missing_required_capability_tags",
        "method_not_advertised",
        "tool_not_shared",
        "tool_group_not_shared",
        "tool_permission_denied",
        "tool_schema_review_required",
        "snapshot_revision_changed",
        "legacy_unverifiable",
        "unsafe_downgrade_blocked",
        "provider_mesh_tooling_disabled",
        "consumer_mesh_tooling_disabled",
    } <= MESH_ROLLOUT_REASON_CODES
    assert canonical_mesh_rollout_reason("feature_unshared") == "feature_not_shared"
    assert canonical_mesh_rollout_reason("permissions_denied") == "permission_denied"
    assert canonical_mesh_rollout_reason("free form secret-bearing error") is None


def test_rollout_metrics_are_bounded_and_payload_free() -> None:
    metrics = MeshRolloutMetrics(max_peers=2)
    metrics.record(
        "manifest_sent",
        peer_id="peer-a",
        manifest_revision=4,
        projection_size=7,
        protocol_status="projection-v1",
    )
    metrics.record(
        "route_denied",
        peer_id="peer-b",
        reason_code="method_unshared",
    )
    metrics.record(
        "catalog_failed",
        peer_id="peer-c",
        reason_code="projection_sync_failed",
        sync_duration_ms=12.34567,
    )

    snapshot = metrics.snapshot()
    assert [peer["peer_id"] for peer in snapshot["peers"]] == ["peer-b", "peer-c"]
    assert snapshot["denied_by_reason"] == {
        "method_not_shared": 1,
        "projection_sync_failed": 1,
    }
    assert snapshot["peers"][1]["last_sync_duration_ms"] == 12.346
    dumped = repr(snapshot).lower()
    for forbidden in ("argument", "cursor", "schema", "credential", "password"):
        assert forbidden not in dumped


def test_rollout_metrics_ignore_unknown_reason_in_public_snapshot() -> None:
    metrics = MeshRolloutMetrics()
    metrics.record("route_denied", peer_id="peer-a", reason_code="token=do-not-export")
    snapshot = metrics.snapshot()
    assert snapshot["denied_by_reason"] == {}
    assert snapshot["peers"][0]["last_reason_code"] is None


def test_rollout_metrics_ignore_unknown_event_names() -> None:
    metrics = MeshRolloutMetrics()
    metrics.record("peer-name-or-payload")  # type: ignore[arg-type]

    assert metrics.snapshot()["counters"] == {}
