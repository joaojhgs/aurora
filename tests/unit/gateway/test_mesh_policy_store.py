from __future__ import annotations

import threading
import warnings

import pytest
from pydantic import ValidationError

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.policy_store import MeshPolicyStore
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


def test_policy_store_starts_fail_closed_revision_zero() -> None:
    store = MeshPolicyStore()
    snapshot = store.current()

    assert snapshot.revision == 0
    assert snapshot.mesh_config.enabled is False
    assert snapshot.mesh_config.services == {}


def test_policy_store_deep_freezes_services_mapping() -> None:
    store = MeshPolicyStore()
    snapshot = store.replace(
        MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}),
        source_revision=1,
    )

    with pytest.raises(TypeError):
        snapshot.mesh_config.services["DB"] = mesh_policy(share=True)  # type: ignore[index]

    with pytest.raises(ValidationError):
        snapshot.mesh_config.services["TTS"].export.share = False  # type: ignore[misc]

    with pytest.raises(ValidationError):
        snapshot.mesh_config.enabled = False  # type: ignore[misc]


def test_mesh_config_serializes_without_pydantic_warnings() -> None:
    config = MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)})

    with warnings.catch_warnings(record=True) as caught:
        dumped = config.model_dump()
        encoded = config.model_dump_json()

    assert caught == []
    assert dumped["services"]["TTS"]["export"]["share"] is True
    assert '"services":{"TTS"' in encoded


def test_policy_store_monotonic_duplicate_and_stale_revisions_are_noops() -> None:
    store = MeshPolicyStore()
    first_policy = MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)})
    second_policy = MeshConfig(enabled=True, services={"TTS": mesh_policy(share=False)})

    first = store.replace(first_policy, source_revision=10)
    duplicate = store.replace(first_policy, source_revision=10)
    stale = store.replace(second_policy, source_revision=9)
    second = store.replace(second_policy, source_revision=11)

    assert first.revision == 1
    assert duplicate is first
    assert stale is first
    assert second.revision == 2
    assert second.source_revision == 11
    assert second.mesh_config.services["TTS"].export.share is False


def test_policy_store_retains_high_water_across_unnumbered_replacement() -> None:
    store = MeshPolicyStore()
    numbered = store.replace(
        MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}),
        source_revision=10,
    )
    unnumbered = store.replace(
        MeshConfig(enabled=True, services={"TTS": mesh_policy(share=False)}),
    )
    stale = store.replace(
        MeshConfig(enabled=True, services={"DB": mesh_policy(share=True)}),
        source_revision=9,
    )

    assert numbered.source_revision == 10
    assert unnumbered.revision == numbered.revision + 1
    assert unnumbered.source_revision == 10
    assert stale is unnumbered


def test_policy_store_clones_candidate_and_isolates_caller_mutation() -> None:
    store = MeshPolicyStore()
    raw = {
        "enabled": True,
        "services": {
            "TTS": {
                "export": {"share": True, "max_concurrent": 2},
                "routing": {"prefer": "local"},
            }
        },
    }

    snapshot = store.replace(raw, source_revision=1)
    raw["services"]["TTS"]["export"]["share"] = False

    assert snapshot.mesh_config.services["TTS"].export.share is True
    assert store.current().mesh_config.services["TTS"].export.share is True


def test_policy_provider_reads_atomic_whole_snapshots_under_concurrency() -> None:
    store = MeshPolicyStore()
    provider = store.provider()
    seen: list[tuple[int, bool]] = []
    expected_by_revision = {0: False}
    stop = threading.Event()

    def reader() -> None:
        while not stop.is_set():
            snapshot = provider()
            seen.append((snapshot.revision, snapshot.mesh_config.enabled))

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for index in range(1, 50):
            snapshot = store.replace(
                MeshConfig(
                    enabled=bool(index % 2),
                    services={"TTS": mesh_policy(share=bool(index % 2))},
                ),
                source_revision=index,
            )
            expected_by_revision[snapshot.revision] = snapshot.mesh_config.enabled
    finally:
        stop.set()
        thread.join(timeout=2)

    assert seen
    assert all(expected_by_revision[revision] is enabled for revision, enabled in seen)
