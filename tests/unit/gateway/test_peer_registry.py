"""Unit tests for the PeerRegistry."""

import asyncio
import time
from unittest.mock import AsyncMock

import pytest

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import (
    ManifestAck,
    ManifestServiceCompatibility,
    PeerManifest,
    PeerServiceInfo,
    PeerState,
    ProviderLeaseState,
)
from app.services.gateway.mesh.negotiation import (
    finalize_recipient_projection_evidence,
    manifest_projection_digest,
)
from app.services.gateway.mesh.peer_registry import PeerRegistry
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot, MeshPolicyStore
from app.services.gateway.mesh.provider_export import ACTIVE_MANIFEST_PROTOCOL, SUPPORTED_PROTOCOLS
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.models.mesh import MeshAddressSelector, MeshPeerAuthoritySnapshot
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="test",
        services={
            "TTS": mesh_policy(share=True, max_concurrent=5, prefer="network", fallback="local"),
        },
        stale_peer_timeout_s=10.0,
        peer_selection="lowest_latency",
    )


@pytest.fixture
def registry(mesh_config):
    return PeerRegistry(mesh_config)


def _make_manifest(peer_id, modules, version="1.0.0"):
    services = [_make_service(module=m, version=version) for m in modules]
    return _verified_manifest(peer_id, services)


def _verified_manifest(peer_id: str, services: list[PeerServiceInfo]) -> PeerManifest:
    manifest = PeerManifest(
        peer_id=peer_id,
        node_name=f"node-{peer_id}",
        shared_services=services,
        active_protocol=ACTIVE_MANIFEST_PROTOCOL,
        active_version="v1",
        active_tier="projection",
        supported_protocols=list(SUPPORTED_PROTOCOLS),
        projection_supported=True,
        projection_active=True,
    )
    evidence = finalize_recipient_projection_evidence(
        {
            "provider_peer_id": peer_id,
            "recipient_peer_id": "local-peer",
            "registry_revision": "registry-1",
            "registry_digest": "registry-digest",
            "policy_revision": "policy-1",
            "policy_digest": "policy-digest",
            "auth_grant_revision": 1,
            "auth_grant_state": "active",
            "auth_grant_digest": "",
            "grants_digest": "",
            "protocol_tier": ACTIVE_MANIFEST_PROTOCOL,
            "projection_digest": manifest_projection_digest(manifest),
            "evidence_digest": "",
            "grants": [{"permission": "*", "source": "effective"}],
        }
    )
    return PeerManifest(
        peer_id=peer_id,
        node_name=f"node-{peer_id}",
        shared_services=services,
        active_protocol=ACTIVE_MANIFEST_PROTOCOL,
        active_version="v1",
        active_tier="projection",
        supported_protocols=list(SUPPORTED_PROTOCOLS),
        projection_supported=True,
        projection_active=True,
        recipient_projection_evidence=evidence,
    )


def _make_service(
    module="TTS",
    version="1.0.0",
    capabilities=None,
    max_concurrent=10,
    method_topic: str | None = None,
):
    topic = method_topic or f"{module}.Execute"
    method_name = topic.split(".", 1)[1] if "." in topic else "Execute"
    return PeerServiceInfo(
        module=module,
        version=version,
        capabilities=capabilities or ["basic"],
        available_feature_ids=["basic_feature"],
        methods=[
            MethodInfo(
                name=method_name,
                bus_topic=topic,
                exposure="external",
                required_perms=[topic],
            )
        ],
        max_concurrent=max_concurrent,
    )


def _with_service(mesh_config: MeshConfig, module: str, policy) -> MeshConfig:
    services = dict(mesh_config.services)
    services[module] = policy
    return mesh_config.model_copy(update={"services": services})


def _stale_timeout_and_ping() -> tuple[float, float]:
    """Return a positive timeout and an older, still-valid monotonic timestamp."""

    observed_at = time.monotonic()
    assert observed_at > 0
    return observed_at / 4, observed_at / 2


def _lease(
    peer_id: str = "peer-1",
    *,
    epoch: str = "epoch-1",
    revision: int = 1,
    issued_at_ms: int = 1000,
    expires_at_ms: int = 61000,
    available: bool = True,
    reason_code: str = "",
) -> ProviderLeaseState:
    return ProviderLeaseState(
        peer_id=peer_id,
        connection_epoch=epoch,
        availability_revision=revision,
        issued_at_ms=issued_at_ms,
        expires_at_ms=expires_at_ms,
        available=available,
        reason_code=reason_code,
    )


class TestPeerRegistration:
    """Tests for register/remove operations."""

    @pytest.mark.asyncio
    async def test_register_peer(self, registry):
        await registry.register_peer("peer-1", "node-1")
        state = registry.get_peer("peer-1")
        assert state is not None
        assert state.peer_id == "peer-1"
        assert state.node_name == "node-1"
        assert state.status == "authenticated"

    @pytest.mark.asyncio
    async def test_re_register_peer(self, registry):
        await registry.register_peer("peer-1", "node-1")
        await registry.register_peer("peer-1", "node-1-updated")
        state = registry.get_peer("peer-1")
        assert state.status == "authenticated"
        assert state.node_name == "node-1-updated"

    @pytest.mark.asyncio
    async def test_re_register_does_not_reset_negotiation_or_ping_liveness(self, registry):
        await registry.register_peer("peer-1", "node-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        await registry.update_latency("peer-1", 4.0)
        state = registry.get_peer("peer-1")
        last_ping = state.last_ping

        await registry.register_peer("peer-1", "node-1-updated")

        state = registry.get_peer("peer-1")
        assert state is not None
        assert state.status == "negotiated"
        assert state.node_name == "node-1-updated"
        assert state.last_ping == last_ping
        assert state.latency_ms == 4.0

    @pytest.mark.asyncio
    async def test_remove_peer(self, registry):
        await registry.register_peer("peer-1")
        await registry.remove_peer("peer-1")
        assert registry.get_peer("peer-1") is None

    @pytest.mark.asyncio
    async def test_remove_nonexistent_peer(self, registry):
        await registry.remove_peer("nonexistent")  # Should not raise

    @pytest.mark.asyncio
    async def test_get_all_peers(self, registry):
        await registry.register_peer("p1")
        await registry.register_peer("p2")
        peers = registry.get_all_peers()
        assert len(peers) == 2


class TestManifestUpdate:
    """Tests for manifest handling."""

    @pytest.mark.asyncio
    async def test_update_manifest(self, registry):
        await registry.register_peer("peer-1")
        manifest = _make_manifest("peer-1", ["TTS"])
        await registry.update_manifest("peer-1", manifest)

        state = registry.get_peer("peer-1")
        assert state.status == "negotiated"
        assert state.manifest is not None
        assert len(state.manifest.shared_services) == 1

    @pytest.mark.asyncio
    async def test_update_manifest_unknown_peer(self, registry):
        manifest = _make_manifest("ghost", ["TTS"])
        await registry.update_manifest("ghost", manifest)
        # Should not create the peer
        assert registry.get_peer("ghost") is None


class TestLatencyAndCalls:
    """Tests for latency and active call tracking."""

    @pytest.mark.asyncio
    async def test_update_latency(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_latency("peer-1", 42.5)
        state = registry.get_peer("peer-1")
        assert state.latency_ms == 42.5

    @pytest.mark.asyncio
    async def test_latency_restores_stale(self, registry):
        await registry.register_peer("peer-1")
        manifest = _make_manifest("peer-1", ["TTS"])
        await registry.update_manifest("peer-1", manifest)

        # Manually mark stale
        state = registry.get_peer("peer-1")
        state.status = "stale"

        await registry.update_latency("peer-1", 50.0)
        assert registry.get_peer("peer-1").status == "negotiated"

    @pytest.mark.asyncio
    async def test_latency_recovery_notifies_status_callback(self, registry):
        """A recovered route remains blocked until Gateway refreshes its manifest."""

        registry.on_peer_status_changed = AsyncMock()
        await registry.register_peer("peer-1", "node-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        registry.on_peer_status_changed.reset_mock()
        registry.get_peer("peer-1").status = "stale"

        await registry.update_latency("peer-1", 50.0)

        registry.on_peer_status_changed.assert_awaited_once_with(
            "peer-1", "node-peer-1", "negotiated"
        )

    @pytest.mark.asyncio
    async def test_latency_restores_consumer_only_stale_peer_as_authenticated(self, registry):
        """Thin peers remain live without advertising a provider manifest."""

        await registry.register_peer("thin-peer", "Thin client")
        state = registry.get_peer("thin-peer")
        assert state is not None
        state.status = "stale"
        registry.on_peer_status_changed = AsyncMock()

        await registry.update_latency("thin-peer", 4.5)

        assert state.status == "authenticated"
        assert state.latency_ms == 4.5
        registry.on_peer_status_changed.assert_awaited_once_with(
            "thin-peer", "Thin client", "authenticated"
        )

    @pytest.mark.asyncio
    async def test_provider_lease_required_blocks_manifest_until_active_lease(self, registry):
        await registry.register_peer("peer-1")
        await registry.require_provider_lease("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))

        assert registry.get_peer("peer-1").status == "provider_unavailable"
        assert registry.get_best_provider("TTS") is None

        assert await registry.apply_provider_lease(_lease(), now_ms=1000) is True

        assert registry.get_peer("peer-1").status == "negotiated"
        assert registry.get_best_provider("TTS").peer_id == "peer-1"

    @pytest.mark.asyncio
    async def test_provider_lease_revision_is_monotonic_within_epoch(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        await registry.require_provider_lease("peer-1")

        assert await registry.apply_provider_lease(_lease(revision=2), now_ms=1000) is True
        assert await registry.apply_provider_lease(_lease(revision=2), now_ms=2000) is False
        assert await registry.apply_provider_lease(_lease(revision=1), now_ms=2000) is False

        stored = registry.get_provider_lease("peer-1")
        assert stored.availability_revision == 2
        assert stored.available is True

    @pytest.mark.asyncio
    async def test_provider_lease_new_epoch_supersedes_and_old_epoch_noops(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        await registry.require_provider_lease("peer-1")

        assert await registry.apply_provider_lease(_lease(epoch="epoch-a", revision=1), now_ms=1000)
        assert await registry.apply_provider_lease(_lease(epoch="epoch-b", revision=1), now_ms=2000)
        assert not await registry.apply_provider_lease(
            _lease(epoch="epoch-a", revision=99, expires_at_ms=90000),
            now_ms=3000,
        )
        assert not await registry.apply_provider_lease(
            _lease(
                epoch="epoch-a",
                revision=100,
                issued_at_ms=3000,
                expires_at_ms=3000,
                available=False,
                reason_code="old_tombstone",
            ),
            now_ms=3000,
        )

        stored = registry.get_provider_lease("peer-1")
        assert stored.connection_epoch == "epoch-b"
        assert stored.available is True
        assert registry.get_peer("peer-1").status == "negotiated"

    @pytest.mark.asyncio
    async def test_provider_lease_retired_epochs_are_bounded_and_cleared(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        await registry.require_provider_lease("peer-1")

        for index in range(20):
            assert await registry.apply_provider_lease(
                _lease(epoch=f"epoch-{index}", revision=1),
                now_ms=1000 + index,
            )

        retired = registry._retired_provider_lease_epochs["peer-1"]  # noqa: SLF001
        assert len(retired) == 16
        assert "epoch-0" not in retired
        assert "epoch-3" in retired

        await registry.remove_peer("peer-1")

        assert "peer-1" not in registry._provider_leases  # noqa: SLF001
        assert "peer-1" not in registry._retired_provider_lease_epochs  # noqa: SLF001

    @pytest.mark.asyncio
    async def test_provider_lease_current_tombstone_and_expiry_make_non_bindable(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        await registry.require_provider_lease("peer-1")
        assert await registry.apply_provider_lease(_lease(revision=1), now_ms=1000)

        assert await registry.apply_provider_lease(
            _lease(
                revision=2,
                issued_at_ms=2000,
                expires_at_ms=2000,
                available=False,
                reason_code="page_hidden",
            ),
            now_ms=2000,
        )
        assert registry.get_peer("peer-1").status == "provider_unavailable"
        assert registry.get_best_provider("TTS") is None

        assert await registry.apply_provider_lease(
            _lease(epoch="epoch-2", revision=1, issued_at_ms=3000, expires_at_ms=63000),
            now_ms=3000,
        )
        assert registry.get_peer("peer-1").status == "negotiated"
        assert await registry.expire_provider_lease(
            "peer-1",
            connection_epoch="epoch-2",
            availability_revision=1,
            now_ms=63000,
        )
        assert registry.get_peer("peer-1").status == "provider_unavailable"

    @pytest.mark.asyncio
    async def test_provider_unavailable_is_not_resurrected_by_pong_latency(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        await registry.require_provider_lease("peer-1")
        await registry.apply_provider_lease(
            _lease(available=False, expires_at_ms=1000, reason_code="paused"),
            now_ms=1000,
        )

        await registry.update_latency("peer-1", 4.0)

        assert registry.get_peer("peer-1").status == "provider_unavailable"
        assert registry.get_best_provider("TTS") is None

    @pytest.mark.asyncio
    async def test_increment_active_calls(self, registry):
        await registry.register_peer("peer-1")
        result = await registry.increment_active_calls("peer-1")
        assert result is True
        assert registry.get_peer("peer-1").active_calls == 1

    @pytest.mark.asyncio
    async def test_increment_stale_peer_rejected(self, registry):
        await registry.register_peer("peer-1")
        state = registry.get_peer("peer-1")
        state.status = "stale"
        result = await registry.increment_active_calls("peer-1")
        assert result is False

    @pytest.mark.asyncio
    async def test_increment_nonexistent_peer(self, registry):
        result = await registry.increment_active_calls("ghost")
        assert result is False

    @pytest.mark.asyncio
    async def test_decrement_active_calls(self, registry):
        await registry.register_peer("peer-1")
        await registry.increment_active_calls("peer-1")
        await registry.decrement_active_calls("peer-1")
        assert registry.get_peer("peer-1").active_calls == 0

    @pytest.mark.asyncio
    async def test_decrement_does_not_go_negative(self, registry):
        await registry.register_peer("peer-1")
        await registry.decrement_active_calls("peer-1")
        assert registry.get_peer("peer-1").active_calls == 0

    @pytest.mark.asyncio
    async def test_capacity_lease_is_idempotent_per_peer_module(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest(
            "peer-1",
            _verified_manifest("peer-1", [_make_service("TTS", max_concurrent=1)]),
        )

        first = await registry.acquire_capacity_lease("peer-1", "TTS", lease_id="call-1")
        same = await registry.acquire_capacity_lease("peer-1", "TTS", lease_id="call-1")
        blocked = await registry.acquire_capacity_lease("peer-1", "TTS", lease_id="call-2")

        assert first == same
        assert blocked is None
        assert registry.get_peer("peer-1").active_calls_by_module == {"TTS": 1}
        assert registry.get_peer("peer-1").active_calls == 1

        await registry.release_capacity_lease(first)
        await registry.release_capacity_lease(first)

        assert registry.get_peer("peer-1").active_calls_by_module == {}
        assert registry.get_peer("peer-1").active_calls == 0

    @pytest.mark.asyncio
    async def test_release_capacity_lease_requires_exact_lease_id(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest(
            "peer-1",
            _verified_manifest("peer-1", [_make_service("TTS", max_concurrent=2)]),
        )

        first = await registry.acquire_capacity_lease("peer-1", "TTS", lease_id="call-1")
        second = await registry.acquire_capacity_lease("peer-1", "TTS", lease_id="call-2")
        assert first is not None
        assert second is not None

        await registry.release_capacity_lease(peer_id="peer-1", module="TTS")
        assert registry.get_peer("peer-1").active_calls_by_module == {"TTS": 2}
        assert registry.get_peer("peer-1").active_calls == 2

        await registry.release_capacity_lease(peer_id="peer-1", module="TTS", lease_id="call-1")
        await registry.release_capacity_lease(peer_id="peer-1", module="TTS", lease_id="call-1")
        assert registry.get_peer("peer-1").active_calls_by_module == {"TTS": 1}
        assert registry.get_peer("peer-1").active_calls == 1

        await registry.release_capacity_lease(second)
        assert registry.get_peer("peer-1").active_calls_by_module == {}
        assert registry.get_peer("peer-1").active_calls == 0


class TestStaleTimeoutPolicy:
    @pytest.mark.asyncio
    async def test_check_stale_peers_timeout_zero_is_noop(self, mesh_config):
        registry = PeerRegistry(mesh_config.model_copy(update={"stale_peer_timeout_s": 0}))
        registry.on_peer_status_changed = AsyncMock()
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        registry.on_peer_status_changed.reset_mock()
        _, registry.get_peer("peer-1").last_ping = _stale_timeout_and_ping()

        await registry._check_stale_peers()

        assert registry.get_peer("peer-1").status == "negotiated"
        registry.on_peer_status_changed.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_positive_to_zero_live_loop_idles_then_future_positive_reactivates(
        self,
        mesh_config,
        monkeypatch,
    ):
        positive_timeout, stale_last_ping = _stale_timeout_and_ping()
        store = MeshPolicyStore()
        store.replace(mesh_config.model_copy(update={"stale_peer_timeout_s": positive_timeout}))
        registry = PeerRegistry(store.current().mesh_config, store.provider())
        registry.on_peer_status_changed = AsyncMock()
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        registry.on_peer_status_changed.reset_mock()
        registry.get_peer("peer-1").last_ping = stale_last_ping
        observed_status_after_zero_check = []
        sleep_calls = 0

        async def fake_sleep(_interval):
            nonlocal sleep_calls
            sleep_calls += 1
            if sleep_calls == 1:
                store.replace(mesh_config.model_copy(update={"stale_peer_timeout_s": 0}))
            elif sleep_calls == 2:
                observed_status_after_zero_check.append(registry.get_peer("peer-1").status)
                store.replace(
                    mesh_config.model_copy(
                        update={"stale_peer_timeout_s": positive_timeout},
                    )
                )
            else:
                raise asyncio.CancelledError

        monkeypatch.setattr(registry, "_sleep", fake_sleep)

        await registry._stale_check_loop()

        assert observed_status_after_zero_check == ["negotiated"]
        assert registry.get_peer("peer-1").status == "stale"
        registry.on_peer_status_changed.assert_awaited_once_with("peer-1", "node-peer-1", "stale")

    @pytest.mark.asyncio
    async def test_initial_zero_live_loop_activates_after_positive_reload(
        self,
        mesh_config,
        monkeypatch,
    ):
        positive_timeout, stale_last_ping = _stale_timeout_and_ping()
        store = MeshPolicyStore()
        store.replace(mesh_config.model_copy(update={"stale_peer_timeout_s": 0}))
        provider_reads = 0

        def provider():
            nonlocal provider_reads
            provider_reads += 1
            return store.current()

        registry = PeerRegistry(store.current().mesh_config, provider)
        registry.on_peer_status_changed = AsyncMock()
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        registry.on_peer_status_changed.reset_mock()
        registry.get_peer("peer-1").last_ping = stale_last_ping

        idle_iteration_completed = asyncio.Event()
        activate_positive_timeout = asyncio.Event()
        stale_peer_detected = asyncio.Event()
        sleep_calls = 0

        async def status_changed(_peer_id, _node_name, status):
            if status == "stale":
                stale_peer_detected.set()

        registry.on_peer_status_changed.side_effect = status_changed

        async def fake_sleep(_interval):
            nonlocal sleep_calls
            sleep_calls += 1
            if sleep_calls == 1:
                return
            if sleep_calls == 2:
                idle_iteration_completed.set()
                await activate_positive_timeout.wait()
                return
            await asyncio.Future()

        monkeypatch.setattr(registry, "_sleep", fake_sleep)

        await registry.start()
        stale_check_task = registry._stale_check_task
        try:
            await asyncio.wait_for(idle_iteration_completed.wait(), timeout=5)
            assert stale_check_task is not None
            assert not stale_check_task.done()
            assert registry.get_peer("peer-1").status == "negotiated"
            assert provider_reads == 1
            registry.on_peer_status_changed.assert_not_awaited()

            await registry.start()
            assert registry._stale_check_task is stale_check_task

            store.replace(
                mesh_config.model_copy(
                    update={"stale_peer_timeout_s": positive_timeout},
                )
            )
            activate_positive_timeout.set()
            await asyncio.wait_for(stale_peer_detected.wait(), timeout=5)

            assert registry.get_peer("peer-1").status == "stale"
            assert provider_reads == 2
            registry.on_peer_status_changed.assert_awaited_once_with(
                "peer-1", "node-peer-1", "stale"
            )
        finally:
            await registry.stop()

        assert registry._stale_check_task is None

    @pytest.mark.asyncio
    async def test_supplied_stale_snapshot_avoids_nested_provider_read(self, mesh_config):
        reads = 0

        def provider():
            nonlocal reads
            reads += 1
            return store.current()

        store = MeshPolicyStore()
        store.replace(mesh_config.model_copy(update={"stale_peer_timeout_s": 0}))
        registry = PeerRegistry(store.current().mesh_config, provider)
        await registry.register_peer("peer-1")
        _, registry.get_peer("peer-1").last_ping = _stale_timeout_and_ping()

        await registry._check_stale_peers(store.current().mesh_config)

        assert reads == 0
        assert registry.get_peer("peer-1").status == "authenticated"


class TestProviderQueries:
    """Tests for get_providers and get_best_provider."""

    @pytest.mark.asyncio
    async def test_get_providers(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS", "DB"]))

        await registry.register_peer("peer-2")
        await registry.update_manifest("peer-2", _make_manifest("peer-2", ["TTS"]))

        providers = registry.get_providers("TTS")
        assert len(providers) == 2

        providers = registry.get_providers("DB")
        assert len(providers) == 1

        providers = registry.get_providers("Unknown")
        assert len(providers) == 0

    @pytest.mark.asyncio
    async def test_get_providers_excludes_non_negotiated(self, registry):
        await registry.register_peer("peer-1")
        # Peer is 'authenticated', not 'negotiated', so not a provider
        providers = registry.get_providers("TTS")
        assert len(providers) == 0

    @pytest.mark.asyncio
    async def test_get_best_provider_lowest_latency(self, registry):
        for pid, lat in [("p1", 100.0), ("p2", 20.0), ("p3", 50.0)]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, lat)

        best = registry.get_best_provider("TTS")
        assert best is not None
        assert best.peer_id == "p2"

    @pytest.mark.asyncio
    async def test_get_best_provider_excludes(self, registry):
        for pid, lat in [("p1", 10.0), ("p2", 20.0)]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, lat)

        best = registry.get_best_provider("TTS", exclude=["p1"])
        assert best is not None
        assert best.peer_id == "p2"

    @pytest.mark.asyncio
    async def test_get_best_provider_capacity_check(self, registry):
        await registry.register_peer("p1")
        manifest = PeerManifest(
            peer_id="p1",
            shared_services=[PeerServiceInfo(module="TTS", version="1.0.0", max_concurrent=1)],
        )
        await registry.update_manifest("p1", manifest)
        # Use up the capacity
        state = registry.get_peer("p1")
        state.active_calls = 1

        best = registry.get_best_provider("TTS")
        assert best is None  # At capacity

    @pytest.mark.asyncio
    async def test_get_best_provider_no_candidates(self, registry):
        best = registry.get_best_provider("TTS")
        assert best is None

    @pytest.mark.asyncio
    async def test_get_negotiated_peers(self, registry):
        await registry.register_peer("p1")
        await registry.update_manifest("p1", _make_manifest("p1", ["TTS"]))
        await registry.register_peer("p2")  # Only authenticated

        negotiated = registry.get_negotiated_peers()
        assert len(negotiated) == 1
        assert negotiated[0].peer_id == "p1"

    @pytest.mark.asyncio
    async def test_get_peer_service(self, registry):
        await registry.register_peer("p1")
        await registry.update_manifest("p1", _make_manifest("p1", ["TTS", "DB"]))

        svc = registry.get_peer_service("p1", "TTS")
        assert svc is not None
        assert svc.module == "TTS"

        svc = registry.get_peer_service("p1", "Unknown")
        assert svc is None

        svc = registry.get_peer_service("ghost", "TTS")
        assert svc is None

    @pytest.mark.asyncio
    async def test_get_provider_candidates_reports_multiple_overlapping_providers(self, registry):
        for pid, latency in [("p1", 30.0), ("p2", 20.0), ("p3", 10.0)]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, latency)

        candidates = registry.get_provider_candidates("TTS")

        assert [candidate.peer.peer_id for candidate in candidates] == ["p1", "p2", "p3"]
        assert all(candidate.eligible for candidate in candidates)
        assert {candidate.reason_code for candidate in candidates} == {"eligible"}

    @pytest.mark.asyncio
    async def test_local_peer_authority_reduction_blocks_exact_remote_route(self, mesh_config):
        """A known remote selector cannot outlive the local Auth grant."""

        tooling_config = _with_service(
            mesh_config,
            "Tooling",
            mesh_policy(share=True, prefer="network", fallback="error"),
        )
        registry = PeerRegistry(tooling_config)
        await registry.register_peer("peer-a")
        await registry.update_manifest(
            "peer-a",
            _verified_manifest(
                "peer-a",
                [
                    _make_service(
                        module="Tooling",
                        method_topic="Tooling.ExecuteTool",
                    )
                ],
            ),
        )

        registry.apply_local_peer_authority(
            MeshPeerAuthoritySnapshot(
                peer_id="peer-a",
                auth_grant_revision=1,
                disposition="present",
                state="active",
                effective_permissions=("Tooling.ExecuteTool",),
            )
        )
        allowed = registry.get_provider_candidates("Tooling", topic="Tooling.ExecuteTool")[0]

        registry.apply_local_peer_authority(
            MeshPeerAuthoritySnapshot(
                peer_id="peer-a",
                auth_grant_revision=2,
                disposition="present",
                state="active",
                effective_permissions=("Gateway.GetMeshStatus",),
            )
        )
        denied = registry.get_provider_candidates("Tooling", topic="Tooling.ExecuteTool")[0]

        assert allowed.eligible is True
        assert denied.eligible is False
        assert denied.reason_code == "permission_denied"

    @pytest.mark.asyncio
    async def test_local_preference_keeps_explicit_remote_provider_selectable(
        self,
        mesh_config,
    ):
        local_preferred = _with_service(
            mesh_config,
            "TTS",
            mesh_policy(share=True, prefer="local", fallback="local"),
        )
        registry = PeerRegistry(local_preferred)
        await registry.register_peer("peer-a")
        await registry.update_manifest("peer-a", _make_manifest("peer-a", ["TTS"]))
        peer = registry.get_peer("peer-a")
        service = registry.get_peer_service("peer-a", "TTS")

        assert peer is not None
        assert service is not None
        assert (
            registry.get_service_route_blockers(
                peer=peer,
                service=service,
                routing_config=local_preferred.services["TTS"],
            )
            == []
        )

    @pytest.mark.asyncio
    async def test_get_provider_candidates_reports_absent_service_without_selecting_it(
        self,
        registry,
    ):
        await registry.register_peer("peer-a")
        await registry.update_manifest("peer-a", _make_manifest("peer-a", ["DB"]))

        candidates = registry.get_provider_candidates("TTS")
        eligible_candidates = registry.get_provider_candidates("TTS", include_ineligible=False)

        assert [(candidate.peer.peer_id, candidate.service) for candidate in candidates] == [
            ("peer-a", None)
        ]
        assert candidates[0].eligible is False
        assert candidates[0].reason_code == "service_not_advertised"
        assert eligible_candidates == []

    @pytest.mark.asyncio
    async def test_module_only_candidates_reuse_supplied_policy_snapshot_without_nested_read(
        self,
        mesh_config,
        monkeypatch,
    ):
        provider_reads = 0

        def provider():
            nonlocal provider_reads
            provider_reads += 1
            raise AssertionError("policy provider must not be called")

        registry = PeerRegistry(mesh_config, policy_provider=provider)
        await registry.register_peer("peer-a")
        await registry.update_manifest("peer-a", _make_manifest("peer-a", ["TTS"]))
        snapshot = MeshPolicySnapshot(revision=123, source_revision="test", mesh_config=mesh_config)
        observed_snapshots = []
        original = registry.evaluate_provider_for_topic

        def evaluate_spy(*args, **kwargs):
            observed_snapshots.append(kwargs["policy_snapshot"])
            return original(*args, **kwargs)

        monkeypatch.setattr(registry, "evaluate_provider_for_topic", evaluate_spy)

        candidates = registry.get_provider_candidates("TTS", policy_snapshot=snapshot)

        assert provider_reads == 0
        assert observed_snapshots == [snapshot]
        assert candidates[0].decision.policy_revision == 123
        assert candidates[0].eligible is True

    @pytest.mark.parametrize(
        ("allowed_peers", "expected_reasons"),
        [
            pytest.param(
                None,
                {"p1": "eligible", "p2": "eligible"},
                id="null-allows-all-providers",
            ),
            pytest.param(
                [],
                {"p1": "provider_not_allowed", "p2": "provider_not_allowed"},
                id="empty-denies-all-providers",
            ),
            pytest.param(
                ["p1"],
                {"p1": "eligible", "p2": "provider_not_allowed"},
                id="populated-allows-only-members",
            ),
        ],
    )
    @pytest.mark.asyncio
    async def test_automatic_outbound_legacy_allowed_peers_semantics_are_locked(
        self,
        mesh_config,
        allowed_peers,
        expected_reasons,
    ):
        """Automatic provider eligibility preserves legacy allowlist distinctions."""

        mesh_config = _with_service(
            mesh_config,
            "Tooling",
            mesh_policy(
                prefer="network",
                allowed_peers=allowed_peers,
            ),
        )
        registry = PeerRegistry(mesh_config)
        for peer_id in ("p1", "p2"):
            await registry.register_peer(peer_id)
            await registry.update_manifest(peer_id, _make_manifest(peer_id, ["Tooling"]))

        candidates = registry.get_provider_candidates("Tooling")

        assert {
            candidate.peer.peer_id: candidate.reason_code for candidate in candidates
        } == expected_reasons

    @pytest.mark.asyncio
    async def test_required_provider_feature_ids_block_candidates(self, mesh_config):
        mesh_config = _with_service(
            mesh_config,
            "Tooling",
            mesh_policy(
                prefer="network",
                required_provider_feature_ids=["future-feature"],
            ),
        )
        registry = PeerRegistry(mesh_config)
        await registry.register_peer("p1")
        await registry.update_manifest("p1", _make_manifest("p1", ["Tooling"]))

        candidates = registry.get_provider_candidates("Tooling")
        best = registry.get_best_provider("Tooling")

        assert mesh_config.services["Tooling"].routing.required_provider_feature_ids == (
            "future-feature",
        )
        assert candidates[0].reason_code == "missing_required_features"
        assert best is None

    @pytest.mark.asyncio
    async def test_get_provider_candidates_reports_exclusion_reason_codes(self, mesh_config):
        mesh_config = _with_service(
            mesh_config,
            "Tooling",
            mesh_policy(
                prefer="network",
                fallback="local",
                allowed_peers=["allowed"],
                min_version="1.0.0",
                required_capabilities=["tools"],
            ),
        )
        registry = PeerRegistry(mesh_config)

        peer_specs = [
            ("allowed", _make_service("Tooling", version="1.2.0", capabilities=["tools"])),
            ("old", _make_service("Tooling", version="0.9.0", capabilities=["tools"])),
            ("missing-cap", _make_service("Tooling", version="1.2.0", capabilities=["basic"])),
            ("full", _make_service("Tooling", version="1.2.0", capabilities=["tools"])),
            ("excluded", _make_service("Tooling", version="1.2.0", capabilities=["tools"])),
        ]
        for peer_id, service in peer_specs:
            await registry.register_peer(peer_id)
            await registry.update_manifest(
                peer_id,
                _verified_manifest(peer_id, [service]),
            )

        stale = registry.get_peer("full")
        stale.status = "stale"

        candidates = registry.get_provider_candidates("Tooling", exclude=["excluded"])
        reason_codes = {candidate.peer.peer_id: candidate.reason_code for candidate in candidates}

        assert reason_codes == {
            "allowed": "eligible",
            "old": "provider_not_allowed",
            "missing-cap": "provider_not_allowed",
            "full": "provider_not_allowed",
            "excluded": "excluded_peer",
        }

    @pytest.mark.asyncio
    async def test_get_provider_candidates_version_and_capability_filters_without_allowlist(
        self, mesh_config
    ):
        mesh_config = _with_service(
            mesh_config,
            "Tooling",
            mesh_policy(
                prefer="network",
                fallback="local",
                min_version="1.0.0",
                required_capabilities=["tools"],
            ),
        )
        registry = PeerRegistry(mesh_config)

        peer_specs = [
            ("eligible", _make_service("Tooling", version="1.2.0", capabilities=["tools"])),
            ("old", _make_service("Tooling", version="0.9.0", capabilities=["tools"])),
            ("missing-cap", _make_service("Tooling", version="1.2.0", capabilities=["basic"])),
        ]
        for peer_id, service in peer_specs:
            await registry.register_peer(peer_id)
            await registry.update_manifest(
                peer_id,
                _verified_manifest(peer_id, [service]),
            )

        candidates = registry.get_provider_candidates("Tooling")
        reason_codes = {candidate.peer.peer_id: candidate.reason_code for candidate in candidates}

        assert reason_codes == {
            "eligible": "eligible",
            "old": "incompatible_version",
            "missing-cap": "missing_required_capability_tags",
        }

    @pytest.mark.asyncio
    async def test_get_provider_candidates_capacity_and_include_ineligible(self, registry):
        await registry.register_peer("full")
        await registry.update_manifest(
            "full",
            _verified_manifest("full", [_make_service("TTS", max_concurrent=1)]),
        )
        registry.get_peer("full").active_calls = 1

        all_candidates = registry.get_provider_candidates("TTS")
        eligible_candidates = registry.get_provider_candidates("TTS", include_ineligible=False)

        assert all_candidates[0].reason_code == "provider_at_capacity"
        assert eligible_candidates == []

    @pytest.mark.asyncio
    async def test_get_provider_candidates_selector_narrows_provider(self, registry):
        for pid in ["p1", "p2", "p3"]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))

        selector = MeshAddressSelector(provider_id="p2")
        candidates = registry.get_provider_candidates("TTS", selector=selector)
        reason_codes = {candidate.peer.peer_id: candidate.reason_code for candidate in candidates}

        assert reason_codes == {
            "p1": "selector_mismatch",
            "p2": "eligible",
            "p3": "selector_mismatch",
        }

    @pytest.mark.asyncio
    async def test_get_best_provider_uses_eligible_candidates_only(self, mesh_config):
        mesh_config = _with_service(
            mesh_config,
            "Tooling",
            mesh_policy(
                prefer="network",
                fallback="local",
                min_version="1.0.0",
                required_capabilities=["tools"],
            ),
        )
        registry = PeerRegistry(mesh_config)

        peer_specs = [
            (
                "fast-ineligible",
                1.0,
                _make_service("Tooling", version="0.9.0", capabilities=["tools"]),
            ),
            (
                "slow-eligible",
                50.0,
                _make_service("Tooling", version="1.2.0", capabilities=["tools"]),
            ),
            (
                "fast-eligible",
                10.0,
                _make_service("Tooling", version="1.2.0", capabilities=["tools"]),
            ),
        ]
        for peer_id, latency, service in peer_specs:
            await registry.register_peer(peer_id)
            await registry.update_manifest(
                peer_id,
                _verified_manifest(peer_id, [service]),
            )
            await registry.update_latency(peer_id, latency)

        best = registry.get_best_provider("Tooling")

        assert best is not None
        assert best.peer_id == "fast-eligible"


class TestPeerSelection:
    """Tests for peer selection strategies."""

    @pytest.mark.asyncio
    async def test_round_robin(self, mesh_config):
        mesh_config = mesh_config.model_copy(update={"peer_selection": "round_robin"})
        registry = PeerRegistry(mesh_config)

        for pid in ["p1", "p2", "p3"]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, 50.0)

        # Round-robin should cycle through peers
        seen = set()
        for _ in range(6):
            best = registry.get_best_provider("TTS")
            if best:
                seen.add(best.peer_id)
        assert len(seen) >= 2  # Should hit multiple peers

    @pytest.mark.asyncio
    async def test_random_selection(self, mesh_config):
        mesh_config = mesh_config.model_copy(update={"peer_selection": "random"})
        registry = PeerRegistry(mesh_config)

        for pid in ["p1", "p2"]:
            await registry.register_peer(pid)
            await registry.update_manifest(pid, _make_manifest(pid, ["TTS"]))
            await registry.update_latency(pid, 50.0)

        best = registry.get_best_provider("TTS")
        assert best is not None
        assert best.peer_id in ("p1", "p2")


class TestStaleDetection:
    """Tests for stale peer detection."""

    @pytest.mark.asyncio
    async def test_stale_check_marks_peers(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        state = registry.get_peer("peer-1")
        # Set last_ping beyond this registry's stale threshold.
        state.last_ping = time.monotonic() - registry._config.stale_peer_timeout_s - 1.0

        await registry._check_stale_peers()
        assert registry.get_peer("peer-1").status == "stale"

    @pytest.mark.asyncio
    async def test_stale_check_notifies_status_callback(self, registry):
        registry.on_peer_status_changed = AsyncMock()
        await registry.register_peer("peer-1", "node-1")
        state = registry.get_peer("peer-1")
        state.last_ping = time.monotonic() - registry._config.stale_peer_timeout_s - 1.0

        await registry._check_stale_peers()

        registry.on_peer_status_changed.assert_awaited_once_with("peer-1", "node-1", "stale")

    @pytest.mark.asyncio
    async def test_recent_ping_not_stale(self, registry):
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))

        # Recent ping
        state = registry.get_peer("peer-1")
        state.last_ping = time.monotonic()

        await registry._check_stale_peers()
        assert registry.get_peer("peer-1").status == "negotiated"

    @pytest.mark.asyncio
    async def test_stale_check_uses_one_live_policy_snapshot(self, mesh_config):
        store = MeshPolicyStore()
        store.replace(mesh_config.model_copy(update={"stale_peer_timeout_s": 1.0}))
        calls = 0

        def provider():
            nonlocal calls
            calls += 1
            return store.current()

        registry = PeerRegistry(mesh_config, policy_provider=provider)
        await registry.register_peer("peer-1")
        await registry.update_manifest("peer-1", _make_manifest("peer-1", ["TTS"]))
        state = registry.get_peer("peer-1")
        state.last_ping = time.monotonic() - 2.0

        await registry._check_stale_peers()

        assert calls == 1
        assert registry.get_peer("peer-1").status == "stale"

    @pytest.mark.asyncio
    async def test_start_stop_lifecycle(self, registry):
        await registry.start()
        assert registry._stale_check_task is not None
        await registry.stop()
        assert registry._stale_check_task is None


@pytest.mark.asyncio
async def test_manifest_ack_persists_structured_metadata_and_rejects_stale_revision():
    registry = PeerRegistry(MeshConfig())
    await registry.register_peer("peer-a", "Peer A")
    current = ManifestAck(
        compatible_services=["TTS"],
        protocol_revision="v2",
        export_policy_revision="export-2",
        services=[
            ManifestServiceCompatibility(
                service_id="TTS",
                status="compatible",
                reason_codes=[],
            )
        ],
    )
    await registry.update_manifest_ack("peer-a", current)

    await registry.update_manifest_ack(
        "peer-a",
        ManifestAck(incompatible_services=["TTS"], protocol_revision="v1"),
    )

    peer = registry.get_peer("peer-a")
    assert peer is not None
    assert peer.remote_compatible == ["TTS"]
    assert peer.remote_incompatible == []
    assert peer.remote_manifest_ack == current

    await registry.update_manifest_ack(
        "peer-a",
        ManifestAck(unused_services=["TTS"]),
    )
    peer = registry.get_peer("peer-a")
    assert peer is not None
    assert peer.remote_unused == ["TTS"]
    assert peer.remote_manifest_ack == current
