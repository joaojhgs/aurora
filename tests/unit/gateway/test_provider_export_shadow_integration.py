from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.db.models import User
from app.services.gateway.acl.identity import OPEN_PEER, SYSTEM, Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.provider_export import (
    NormalizedMethodSnapshot,
    NormalizedServiceSnapshot,
    RegistrySnapshot,
)
from app.services.gateway.webrtc.rtc_client import RTCClient
from app.shared.contracts.models.mesh import (
    MeshPeerAuthorityChangedEvent,
    MeshPeerAuthoritySnapshot,
)
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


def _settings() -> MagicMock:
    settings = MagicMock()
    settings.webrtc.password = "password"
    settings.webrtc.app_id = "app"
    settings.webrtc.room = "room"
    settings.webrtc.stun_servers = []
    settings.webrtc.turn_servers = []
    settings.webrtc.enable_app_layer_e2ee = False
    settings.webrtc.encrypt_signaling = False
    settings.webrtc.enabled = True
    settings.webrtc.strategy = "mqtt"
    settings.signaling_mqtt.brokers = []
    return settings


def _registry_snapshot() -> RegistrySnapshot:
    return RegistrySnapshot(
        revision="1",
        services=(
            NormalizedServiceSnapshot(
                service_id="Gateway",
                version="1.0.0",
                tags=("alpha",),
                methods=(
                    NormalizedMethodSnapshot(
                        topic="Gateway.GetServices",
                        exposure="both",
                        method_type="use",
                        required_permissions=("Gateway.GetServices",),
                        input_model="Input",
                        output_model="Output",
                        input_schema={"title": "Input", "type": "object"},
                        output_schema={"title": "Output", "type": "object"},
                    ),
                ),
            ),
        ),
    )


def _mesh_config() -> MeshConfig:
    return MeshConfig(
        enabled=True,
        services={"Gateway": mesh_policy(share=True, max_concurrent=2)},
    )


def _authenticated_identity() -> Identity:
    return Identity(
        principal_id="user-1",
        principal_name="mesh-peer",
        permissions=frozenset({"Gateway.GetServices"}),
        effective_perms=frozenset({"Gateway.GetServices"}),
        source="webrtc_peer",
    )


def _client() -> RTCClient:
    registry = SimpleNamespace(snapshot_registry=_registry_snapshot)
    client = RTCClient(_settings(), MagicMock(), registry, AsyncMock())
    client.set_mesh_identity("provider-peer", "provider")
    client._mesh_config = _mesh_config()
    client._stable_peer_sessions["recipient-peer"] = "signaling-peer"
    client._peer_stable_ids["signaling-peer"] = "recipient-peer"
    identity = _authenticated_identity()
    client._peer_acl["signaling-peer"] = identity
    client._peer_acl["recipient-peer"] = identity
    return client


async def _drain_shadow(client: RTCClient) -> None:
    tasks = list(client._provider_export_tasks)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("seed_authority", [False, True])
async def test_shadow_success_does_not_change_effective_manifest_wire(
    monkeypatch,
    seed_authority: bool,
) -> None:
    import app.services.gateway.mesh.negotiation as negotiation

    fixed_clock = SimpleNamespace(now=lambda tz: SimpleNamespace(isoformat=lambda: "fixed-time"))
    monkeypatch.setattr(negotiation, "datetime", fixed_clock)

    disabled = _client()
    disabled._peer_registry = MagicMock()
    disabled._peer_bridge = MagicMock()
    disabled_sent: list[str] = []
    disabled._peer_send_fns["signaling-peer"] = disabled_sent.append
    monkeypatch.setattr(disabled, "_schedule_provider_export_shadow", lambda *args, **kwargs: None)

    enabled = _client()
    enabled._peer_registry = MagicMock()
    enabled._peer_bridge = MagicMock()
    enabled_sent: list[str] = []
    enabled._peer_send_fns["signaling-peer"] = enabled_sent.append
    if seed_authority:
        assert enabled.apply_peer_authority_changed(
            MeshPeerAuthorityChangedEvent(
                peer_id="recipient-peer",
                auth_grant_revision=1,
                disposition="present",
                state="active",
                effective_permissions=("Gateway.GetServices",),
                reason="approved",
            )
        )

    disabled_result = await disabled._send_manifest("recipient-peer")
    enabled_result = await enabled._send_manifest("recipient-peer")
    await _drain_shadow(enabled)

    assert disabled_result is True
    assert enabled_result is True
    if not seed_authority:
        assert disabled_sent == enabled_sent
    frame = json.loads(enabled_sent[0])
    assert frame["active_protocol"] == "projection-v1"
    assert frame["projection_active"] is True
    assert frame["recipient_projection_evidence"] is not None
    assert frame["granted_permissions"] is None
    assert not disabled._peer_registry.mock_calls
    assert not disabled._peer_bridge.mock_calls
    assert not enabled._peer_registry.mock_calls
    assert not enabled._peer_bridge.mock_calls
    assert not disabled._bus.mock_calls
    assert not enabled._bus.mock_calls


@pytest.mark.asyncio
async def test_unknown_authority_shadow_is_fail_closed_and_uses_stable_peer_id() -> None:
    client = _client()
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append

    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)

    diagnostics = client.get_provider_export_shadow_diagnostics()
    assert "recipient-peer" in diagnostics
    assert "signaling-peer" not in diagnostics
    assert diagnostics["recipient-peer"]["status"] == "ok"
    assert diagnostics["recipient-peer"]["readiness"] == "unknown"
    assert diagnostics["recipient-peer"]["routable"] is False
    assert diagnostics["recipient-peer"]["included_method_count"] == 0


@pytest.mark.asyncio
async def test_seeded_authority_populates_peer_isolated_shadow_cache() -> None:
    client = _client()
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append
    event = MeshPeerAuthorityChangedEvent(
        peer_id="recipient-peer",
        auth_grant_revision=1,
        disposition="present",
        state="active",
        effective_permissions=("Gateway.GetServices",),
        reason="approved",
    )

    assert client.apply_peer_authority_changed(event) is True
    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)

    diagnostics = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert diagnostics["readiness"] == "ready"
    assert diagnostics["included_method_count"] == 1
    assert client._provider_export_cache.peer_entry_count("recipient-peer") == 1


@pytest.mark.asyncio
async def test_shadow_skips_without_durable_local_mesh_identity_but_send_still_matches() -> None:
    client = _client()
    client._mesh_peer_id = None
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append

    assert await client._send_manifest("recipient-peer") is False
    assert sent == []


@pytest.mark.asyncio
async def test_shadow_requires_authenticated_acl_proof_not_bare_stable_map() -> None:
    client = _client()
    client._peer_acl.clear()
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append

    assert await client._send_manifest("recipient-peer") is False
    assert sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize("acl_shape", ["open", "stable_only", "mismatched"])
async def test_shadow_rejects_untrusted_or_asymmetric_acl_mapping(acl_shape: str) -> None:
    client = _client()
    if acl_shape == "open":
        client._peer_acl["signaling-peer"] = OPEN_PEER
        client._peer_acl["recipient-peer"] = OPEN_PEER
    elif acl_shape == "stable_only":
        client._peer_acl.pop("signaling-peer")
    else:
        client._peer_acl["recipient-peer"] = Identity(
            principal_id="forged-user",
            source="webrtc_peer",
        )
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append

    assert await client._send_manifest("recipient-peer") is False
    assert sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "identity",
    [
        SYSTEM,
        Identity(
            principal_id="user-1",
            principal_name="mesh-peer",
            permissions=frozenset({"Gateway.GetServices"}),
            effective_perms=frozenset({"Gateway.GetServices"}),
            source="http_bearer",
        ),
    ],
)
async def test_shadow_rejects_equal_non_webrtc_acl_identity(identity: Identity) -> None:
    client = _client()
    client._peer_acl["signaling-peer"] = identity
    client._peer_acl["recipient-peer"] = identity
    client._peer_send_fns["signaling-peer"] = lambda _: None

    assert await client._send_manifest("recipient-peer") is False
    assert client._provider_export_cache.total_entry_count() == 0


def test_authenticated_stable_peer_requires_bidirectional_webrtc_identity() -> None:
    client = _client()

    assert client._has_authenticated_stable_peer("recipient-peer") is True

    client._peer_acl["recipient-peer"] = Identity(
        principal_id="user-1",
        principal_name="mesh-peer",
        permissions=frozenset({"Gateway.GetServices"}),
        effective_perms=frozenset({"Gateway.GetServices"}),
        source="custom_authority",
    )
    assert client._has_authenticated_stable_peer("recipient-peer") is False


@pytest.mark.asyncio
async def test_shadow_policy_uses_one_atomic_live_snapshot() -> None:
    client = _client()
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    first = SimpleNamespace(revision=7, source_revision=70, mesh_config=_mesh_config())
    second = SimpleNamespace(
        revision=8,
        source_revision=80,
        mesh_config=MeshConfig(enabled=True, services={"Gateway": mesh_policy(share=False)}),
    )
    calls: list[int] = []

    def provider():
        calls.append(1)
        return first if len(calls) == 1 else second

    client._mesh_policy_provider = provider

    assert await client._send_manifest("recipient-peer") is True
    first.mesh_config = second.mesh_config
    await _drain_shadow(client)

    diagnostics = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert len(calls) == 1
    assert diagnostics["policy_revision"] == "7"
    assert diagnostics["included_method_count"] == 1


def test_detached_policy_snapshot_revision_is_bound_to_content() -> None:
    client = _client()
    shared = client._provider_export_policy_snapshot(_mesh_config())
    unshared = client._provider_export_policy_snapshot(
        MeshConfig(enabled=True, services={"Gateway": mesh_policy(share=False)})
    )
    changed_capacity = client._provider_export_policy_snapshot(
        MeshConfig(enabled=True, services={"Gateway": mesh_policy(share=True, max_concurrent=3)})
    )
    zero_capacity = client._provider_export_policy_snapshot(
        MeshConfig(enabled=True, services={"Gateway": mesh_policy(share=True, max_concurrent=0)})
    )

    assert shared.revision.startswith("detached:")
    assert unshared.revision.startswith("detached:")
    assert shared.revision != unshared.revision
    assert shared.digest != unshared.digest
    assert changed_capacity.revision.startswith("detached:")
    assert changed_capacity.revision != shared.revision
    assert changed_capacity.digest != shared.digest
    assert zero_capacity.services[0].max_concurrent == 0
    assert zero_capacity.to_canonical()["services"][0]["max_concurrent"] == 0


def test_rtc_policy_snapshot_capacity_changes_shadow_cache_and_output() -> None:
    client = _client()
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    registry = client._registry.snapshot_registry()
    recipient = client._provider_export_recipient_evidence("recipient-peer")
    policy_two = client._provider_export_policy_snapshot(_mesh_config())
    policy_zero = client._provider_export_policy_snapshot(
        MeshConfig(enabled=True, services={"Gateway": mesh_policy(share=True, max_concurrent=0)})
    )
    first = client._provider_export_cache.project(
        provider_peer_id="provider-peer",
        registry=registry,
        policy=policy_two,
        recipient=recipient,
    )
    second = client._provider_export_cache.project(
        provider_peer_id="provider-peer",
        registry=registry,
        policy=policy_zero,
        recipient=recipient,
    )

    assert first.services[0].capacity == {"max_concurrent": 2}
    assert second.services[0].capacity == {"max_concurrent": 0}
    assert first.cache_key.policy_digest != second.cache_key.policy_digest
    assert first.cache_key.digest != second.cache_key.digest
    assert first.canonical != second.canonical
    assert first.digest != second.digest
    assert client._provider_export_cache.peer_entry_count("recipient-peer") == 2


def test_live_policy_revision_change_produces_distinct_shadow_entry() -> None:
    client = _client()
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    registry = client._registry.snapshot_registry()
    recipient = client._provider_export_recipient_evidence("recipient-peer")
    mesh_config = _mesh_config()
    rev7 = client._provider_export_policy_snapshot(
        mesh_config,
        live_snapshot=SimpleNamespace(revision=7, mesh_config=mesh_config),
    )
    rev8 = client._provider_export_policy_snapshot(
        mesh_config,
        live_snapshot=SimpleNamespace(revision=8, mesh_config=mesh_config),
    )

    first = client._provider_export_cache.project(
        provider_peer_id="provider-peer",
        registry=registry,
        policy=rev7,
        recipient=recipient,
    )
    second = client._provider_export_cache.project(
        provider_peer_id="provider-peer",
        registry=registry,
        policy=rev8,
        recipient=recipient,
    )

    assert first.services[0].capacity == {"max_concurrent": 2}
    assert second.services[0].capacity == {"max_concurrent": 2}
    assert first.cache_key.policy_revision == "7"
    assert second.cache_key.policy_revision == "8"
    assert first.cache_key.digest != second.cache_key.digest
    assert first.digest != second.digest
    assert client._provider_export_cache.peer_entry_count("recipient-peer") == 2


@pytest.mark.asyncio
async def test_policy_invalidation_cannot_be_repopulated_by_captured_task() -> None:
    client = _client()
    client._peer_send_fns["signaling-peer"] = lambda _: None
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    old_digest = client.get_provider_export_shadow_diagnostics()["recipient-peer"][
        "projection_digest"
    ]

    assert await client._send_manifest("recipient-peer") is True
    client.update_mesh_config(
        MeshConfig(enabled=True, services={"Gateway": mesh_policy(share=False)})
    )
    await _drain_shadow(client)
    assert client._provider_export_cache.total_entry_count() == 0

    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    current = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert current["projection_digest"] != old_digest
    assert current["included_method_count"] == 0


def test_stale_and_conflicting_authority_updates_are_safe() -> None:
    client = _client()
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=2,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    assert not client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="permissions_updated",
        )
    )
    assert not client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=2,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetRoutes",),
            reason="permissions_updated",
        )
    )

    diagnostics = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert diagnostics["reason_code"] == "authority_revision_conflict"


@pytest.mark.asyncio
async def test_disconnect_preserves_authority_for_reconnect() -> None:
    client = _client()
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=3,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    client._peer_send_fns["signaling-peer"] = lambda _: None
    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    assert client._provider_export_cache.peer_entry_count("recipient-peer") == 1
    authority_watermarks = dict(client._provider_export_cache._authority)

    await client._handle_signaling_departure("signaling-peer", reason="test departure")

    assert "recipient-peer" in client._provider_export_authority
    assert client._provider_export_authority["recipient-peer"].revision == 3
    assert client._provider_export_cache.peer_entry_count("recipient-peer") == 0
    assert client._provider_export_cache._authority == authority_watermarks


@pytest.mark.asyncio
async def test_active_signaling_departure_invalidates_entries_without_authority_reset() -> None:
    client = _client()
    client._peer_send_fns["signaling-peer"] = lambda _: None
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=6,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    authority_watermarks = dict(client._provider_export_cache._authority)
    pc = AsyncMock()
    client._pcs["signaling-peer"] = pc

    await client._handle_signaling_departure("signaling-peer", reason="test departure")

    pc.close.assert_awaited_once()
    assert client._provider_export_cache.peer_entry_count("recipient-peer") == 0
    assert client._provider_export_cache._authority == authority_watermarks
    assert client._provider_export_authority["recipient-peer"].revision == 6


@pytest.mark.asyncio
async def test_permission_refresh_is_pending_until_committed_authority_recovers() -> None:
    client = _client()
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append
    client._peer_acl["signaling-peer"] = _authenticated_identity()
    client._peer_acl["recipient-peer"] = client._peer_acl["signaling-peer"]
    client._auth_service.get_principal.return_value = User(
        id="user-1",
        username="mesh-peer",
        password_hash="hash",
        role="user",
        permissions=["Gateway.GetServices"],
        is_admin=False,
    )
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=4,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    authority_watermarks = dict(client._provider_export_cache._authority)

    assert await client.update_peer_permissions("recipient-peer", ["Gateway.GetServices"])
    assert client._provider_export_authority["recipient-peer"].state == "active"
    assert client._provider_export_authority["recipient-peer"].revision == 4
    assert "recipient-peer" in client._provider_export_authority_pending
    assert client._provider_export_cache._authority == authority_watermarks
    assert not client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=3,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="permissions_updated",
        )
    )

    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    diagnostics = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert diagnostics["reason_code"] == "authority_refresh_pending"
    assert diagnostics["readiness"] == "pending"
    assert diagnostics["routable"] is False
    assert diagnostics["included_method_count"] == 0

    assert not client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=5,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="permissions_updated",
        )
    )
    assert "recipient-peer" in client._provider_export_authority_pending
    assert client._peer_acl["recipient-peer"].effective_perms == frozenset()

    trusted = client.apply_trusted_peer_authority_snapshot(
        MeshPeerAuthoritySnapshot(
            peer_id="recipient-peer",
            auth_grant_revision=5,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
        )
    )
    assert trusted.applied
    assert "recipient-peer" not in client._provider_export_authority_pending
    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    recovered = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert recovered["readiness"] == "ready"
    assert recovered["included_method_count"] == 1


@pytest.mark.asyncio
async def test_local_mesh_identity_change_invalidates_shadow_entries() -> None:
    client = _client()
    client._peer_send_fns["signaling-peer"] = lambda _: None
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    assert await client._send_manifest("recipient-peer") is True
    await _drain_shadow(client)
    assert client._provider_export_cache.total_entry_count() == 1

    client.set_mesh_identity("replacement-provider", "replacement")

    assert client._provider_export_cache.total_entry_count() == 0
    assert client._provider_export_authority["recipient-peer"].revision == 1


def test_shadow_diagnostics_are_bounded_redacted_and_copied() -> None:
    client = _client()
    for index in range(55):
        client._set_provider_export_diagnostic(
            f"peer-{index:02d}",
            {
                "status": "error",
                "reason_code": "shadow_projection_failed",
                "permissions": ["Gateway.GetServices"],
                "grants": ["Gateway.GetServices"],
                "schema": {"token": "secret"},
                "exception": "token secret raw method schema",
                "node_name": "private-name",
                "payload": {"methods": ["Gateway.GetServices"]},
                "free_form": "must not be retained",
            },
        )

    diagnostics = client.get_provider_export_shadow_diagnostics()
    assert len(diagnostics) == 50
    assert "peer-00" not in diagnostics
    assert "peer-05" in diagnostics
    assert diagnostics["peer-54"] == {
        "status": "error",
        "reason_code": "shadow_projection_failed",
    }

    diagnostics["peer-54"]["status"] = "mutated"
    assert client.get_provider_export_shadow_diagnostics()["peer-54"]["status"] == "error"


@pytest.mark.asyncio
async def test_shadow_evaluator_raise_is_redacted_and_nonblocking(monkeypatch) -> None:
    import app.services.gateway.mesh.negotiation as negotiation

    fixed_clock = SimpleNamespace(now=lambda tz: SimpleNamespace(isoformat=lambda: "fixed-time"))
    monkeypatch.setattr(negotiation, "datetime", fixed_clock)

    baseline = _client()
    baseline_sent: list[str] = []
    baseline._peer_send_fns["signaling-peer"] = baseline_sent.append
    monkeypatch.setattr(baseline, "_schedule_provider_export_shadow", lambda *args, **kwargs: None)
    baseline.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    baseline_result = await baseline._send_manifest("recipient-peer")

    client = _client()
    sent: list[str] = []
    client._peer_send_fns["signaling-peer"] = sent.append

    def raise_secret(self, **kwargs):
        del self, kwargs
        raise RuntimeError("token secret raw method schema")

    monkeypatch.setattr(
        "app.services.gateway.webrtc.rtc_client.PeerProviderExportCache.project",
        raise_secret,
    )

    client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="recipient-peer",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
            reason="approved",
        )
    )
    result = await client._send_manifest("recipient-peer")
    await _drain_shadow(client)

    assert baseline_result is True
    assert result is False
    assert sent == []
    diagnostics = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert diagnostics == {"status": "error", "reason_code": "active_projection_failed"}


@pytest.mark.asyncio
async def test_manifest_send_failure_does_not_schedule_shadow(monkeypatch) -> None:
    client = _client()
    project = MagicMock()
    monkeypatch.setattr(
        "app.services.gateway.webrtc.rtc_client.PeerProviderExportCache.project",
        project,
    )

    assert await client._send_manifest("recipient-peer") is False
    await _drain_shadow(client)

    project.assert_not_called()
    assert not client._provider_export_tasks
    diagnostics = client.get_provider_export_shadow_diagnostics()["recipient-peer"]
    assert diagnostics["reason_code"] == "active_projected"
    assert diagnostics["routable"] is False
