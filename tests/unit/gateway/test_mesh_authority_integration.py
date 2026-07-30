from __future__ import annotations

import asyncio
import contextlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import Envelope, QueryResult
from app.services.db.models import Token
from app.services.gateway.acl.identity import ANONYMOUS, OPEN_PEER, SYSTEM, Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.negotiation import (
    generate_manifest_ack,
    manifest_ack_to_dict,
    parse_manifest_with_evidence,
)
from app.services.gateway.mesh.provider_export import ACTIVE_MANIFEST_PROTOCOL, ProjectionResult
from app.services.gateway.service import (
    GatewayService,
    _mesh_connection_status,
    _MeshStartOutcome,
)
from app.services.gateway.webrtc.pairing_sas import PairingProtocolError
from app.services.gateway.webrtc.peer_protocol import (
    CAP_PROVIDER_LEASE_V1,
    build_protocol_hello,
    negotiate_protocol,
)
from app.services.gateway.webrtc.rpc import RPCHandler
from app.services.gateway.webrtc.rtc_client import (
    PeerAuthorityApplyResult,
    PeerAuthorityApplyStatus,
    RTCClient,
    _ReconnectChallengeRecord,
)
from app.shared.contracts.mesh_surface import (
    feature_contracts_for_module,
    feature_contracts_for_topic,
)
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
from app.shared.contracts.models.mesh import (
    MeshEvents,
    MeshPeerAuthorityChangedEvent,
    MeshPeerAuthoritySnapshot,
    MeshPeerAuthoritySnapshotResponse,
)

from .mesh_policy_helpers import mesh_policy


class FakeDataChannel:
    def __init__(self) -> None:
        self.readyState = "open"
        self.sent: list[str | bytes] = []

    def send(self, payload: str | bytes) -> None:
        self.sent.append(payload)


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


def _identity(perms: set[str] | None = None, *, source: str = "webrtc_peer") -> Identity:
    permissions = frozenset(perms or {"Gateway.GetServices"})
    return Identity(
        principal_id="principal-1",
        principal_name="peer",
        is_admin="*" in permissions,
        permissions=permissions,
        effective_perms=permissions,
        device_id="device-1",
        source=source,
    )


def _client() -> RTCClient:
    registry = SimpleNamespace(snapshot_registry=lambda: None)
    client = RTCClient(_settings(), MagicMock(), registry, AsyncMock())
    client.set_mesh_identity("provider-peer", "provider")
    client._mesh_enabled = True
    client._mesh_config = MeshConfig(enabled=True)
    client._stable_peer_sessions["peer-a"] = "session-a"
    client._peer_stable_ids["session-a"] = "peer-a"
    pc = MagicMock()
    pc.connectionState = "connected"
    pc.close = AsyncMock()
    client._pcs["session-a"] = pc
    client._peer_data_channels["session-a"] = FakeDataChannel()
    identity = _identity({"Gateway.GetServices"})
    client._peer_acl["peer-a"] = identity
    client._peer_acl["session-a"] = identity
    token = Token(
        id="token-1",
        user_id="principal-1",
        token_hash="hash",
        prefix="tok",
        scopes=["Gateway.GetServices"],
    )
    client._peer_tokens["peer-a"] = token
    client._peer_tokens["session-a"] = token
    return client


def _mesh_module(
    module: str,
    topic: str,
    *,
    feature_id: str,
    permission: str,
    method_name: str,
) -> SimpleNamespace:
    return SimpleNamespace(
        version="1.2.0",
        capabilities=["streaming"],
        callable_features=list(feature_contracts_for_module(module)),
        methods=[
            SimpleNamespace(
                name=method_name,
                summary=f"{module} method",
                bus_topic=topic,
                exposure="external",
                required_perms=[permission],
                callable_feature_ids=[feature_id],
                callable_features=list(feature_contracts_for_topic(topic)),
                input_model=type(f"{module}Request", (), {"__name__": f"{module}Request"}),
                output_model=type(f"{module}Response", (), {"__name__": f"{module}Response"}),
                method_type="use",
            )
        ],
    )


def _event(
    peer_id: str = "peer-a", revision: int = 1, perms: tuple[str, ...] = ("Gateway.GetServices",)
):
    return MeshPeerAuthorityChangedEvent(
        peer_id=peer_id,
        auth_grant_revision=revision,
        disposition="present",
        state="active",
        effective_permissions=perms,
        reason="approved",
    )


def _install_reconnect_transport(client: RTCClient, peer: str, pc: object) -> str:
    client._pairing_transports[peer] = {
        "pc": pc,
        "offerer_signaling_id": client._peer_id,
        "answerer_signaling_id": peer,
        "offer_sdp": "v=0\r\na=fingerprint:sha-256 11:22\r\n",
        "answer_sdp": "v=0\r\na=fingerprint:sha-256 33:44\r\n",
        "remote_stable_peer_id": "peer-a",
        "remote_node_name": "peer",
    }
    return client._channel_binding_for_peer(peer, pc)


def _install_reconnect_record(
    client: RTCClient, peer: str, pc: object
) -> _ReconnectChallengeRecord:
    channel_binding = _install_reconnect_transport(client, peer, pc)
    record = _ReconnectChallengeRecord(
        pc=pc,
        challenge="ab" * 32,
        channel_binding=channel_binding,
        claimant_peer_id="peer-a",
        verifier_peer_id=client._local_mesh_peer_id(),
        claimant_signaling_peer_id=peer,
        verifier_signaling_peer_id=client._peer_id,
        room_name=str(client._settings.webrtc.room),
        issued_at_ms=1_000,
        expires_at_ms=21_000,
    )
    client._peer_auth_challenges[peer] = record
    return record


def _reconnect_proof(record: _ReconnectChallengeRecord) -> dict[str, str]:
    return {
        "type": "mesh_auth_proof_v1",
        "token_id": "token-1",
        "challenge": record.challenge,
        "proof": "cd" * 32,
        "channel_binding": record.channel_binding,
        "claimant_peer_id": record.claimant_peer_id,
        "verifier_peer_id": record.verifier_peer_id,
        "claimant_signaling_peer_id": record.claimant_signaling_peer_id,
        "verifier_signaling_peer_id": record.verifier_signaling_peer_id,
        "room_name": record.room_name,
    }


class _FakeBus:
    def __init__(self, result: QueryResult | None = None):
        self.subscribed: list[tuple[str, object]] = []
        self.unsubscribed: list[tuple[str, object]] = []
        self.request = AsyncMock(
            return_value=result or QueryResult(ok=True, data={"authorities": []})
        )
        self.publish = AsyncMock()

    def subscribe(self, topic: str, handler: object) -> None:
        self.subscribed.append((topic, handler))

    def unsubscribe(self, topic: str, handler: object) -> None:
        self.unsubscribed.append((topic, handler))


@pytest.mark.parametrize(
    ("registry_status", "persisted_status"),
    [
        ("authenticated", "connected"),
        ("negotiated", "connected"),
        ("provider_unavailable", "connected"),
        ("disconnected", "disconnected"),
        ("stale", "disconnected"),
        ("failed", "disconnected"),
    ],
)
def test_mesh_registry_status_maps_to_connection_contract(
    registry_status: str,
    persisted_status: str,
) -> None:
    assert _mesh_connection_status(registry_status) == persisted_status


@pytest.fixture(autouse=True)
def gateway_service_uses_instance_bus(monkeypatch) -> None:
    monkeypatch.setattr(GatewayService, "bus", property(lambda self: self._bus))


@pytest.mark.asyncio
async def test_canonical_subscribe_unsubscribe_only(monkeypatch) -> None:
    service = GatewayService()
    bus = _FakeBus()
    service._bus = bus
    service._start_gateway = AsyncMock()
    service._start_webrtc = AsyncMock()
    service._start_mesh = AsyncMock()
    service._audio_session_service.start = AsyncMock()

    await service.on_start()

    topics = [topic for topic, _handler in bus.subscribed]
    assert MeshEvents.PEER_AUTHORITY_CHANGED in topics
    assert MeshEvents.PEER_APPROVED not in topics
    assert MeshEvents.PEER_PERMISSIONS_UPDATED not in topics

    service._audio_session_service.stop = AsyncMock()
    await service.on_stop()
    unsubscribed = [topic for topic, _handler in bus.unsubscribed]
    assert MeshEvents.PEER_AUTHORITY_CHANGED in unsubscribed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "updates",
    [
        {"origin": "external"},
        {"caller_peer_id": "remote"},
        {"caller_peer_id": ""},
        {"identity_source": "mesh"},
        {"identity_source": ""},
        {"principal_id": "principal"},
        {"principal_id": ""},
        {"effective_perms": ["*"]},
        {"effective_perms": []},
        {"method_type": "use"},
        {"method_type": ""},
    ],
)
async def test_untrusted_authority_events_do_not_mutate_or_send(updates: dict[str, object]) -> None:
    service = GatewayService()
    rtc = MagicMock()
    rtc.apply_peer_authority_changed_detailed = MagicMock()
    rtc.reannounce_manifest_for_peer = AsyncMock()
    service._rtc_client = rtc
    kwargs = {"origin": "internal", **updates}
    envelope = Envelope(type=MeshEvents.PEER_AUTHORITY_CHANGED, payload=_event(), **kwargs)

    await service._handle_mesh_peer_authority_changed(envelope)

    rtc.apply_peer_authority_changed_detailed.assert_not_called()
    rtc.reannounce_manifest_for_peer.assert_not_awaited()


@pytest.mark.asyncio
async def test_legacy_permission_events_no_longer_mutate_authority() -> None:
    service = GatewayService()
    assert not hasattr(service, "_refresh_live_mesh_peer_permissions")


def test_event_state_machine_next_duplicate_stale_gap_conflict_and_invalid() -> None:
    client = _client()

    first = client.apply_peer_authority_changed_detailed(_event(revision=1))
    assert first.status is PeerAuthorityApplyStatus.APPLIED
    assert client._peer_acl["peer-a"].effective_perms == frozenset({"Gateway.GetServices"})

    duplicate = client.apply_peer_authority_changed_detailed(_event(revision=1))
    assert duplicate.status is PeerAuthorityApplyStatus.DUPLICATE

    second = client.apply_peer_authority_changed_detailed(_event(revision=2))
    assert second.status is PeerAuthorityApplyStatus.APPLIED

    stale = client.apply_peer_authority_changed_detailed(_event(revision=1))
    assert stale.status is PeerAuthorityApplyStatus.STALE

    gap = client.apply_peer_authority_changed_detailed(_event(revision=3))
    assert gap.status is PeerAuthorityApplyStatus.APPLIED

    gap = client.apply_peer_authority_changed_detailed(_event(revision=5))
    assert gap.status is PeerAuthorityApplyStatus.GAP
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()

    ordinary_duplicate_while_gap_pending = client.apply_peer_authority_changed_detailed(
        _event(revision=3)
    )
    assert ordinary_duplicate_while_gap_pending.status is PeerAuthorityApplyStatus.PENDING
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()

    resolved = client.apply_trusted_peer_authority_snapshot(
        MeshPeerAuthoritySnapshot(
            peer_id="peer-a",
            auth_grant_revision=5,
            disposition="present",
            state="active",
            effective_permissions=("Gateway.GetServices",),
        )
    )
    assert resolved.status is PeerAuthorityApplyStatus.APPLIED
    assert "peer-a" not in client._provider_export_authority_pending

    conflict = client.apply_peer_authority_changed_detailed(
        _event(revision=5, perms=("Tooling.GetTools",))
    )
    assert conflict.status is PeerAuthorityApplyStatus.CONFLICT
    assert client._peer_acl["peer-a"].effective_perms == frozenset()

    ordinary_duplicate_while_conflict_pending = client.apply_peer_authority_changed_detailed(
        _event(revision=5)
    )
    assert ordinary_duplicate_while_conflict_pending.status is PeerAuthorityApplyStatus.PENDING
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()

    invalid = client.apply_peer_authority_changed_detailed({"peer_id": "peer-a"})
    assert invalid.status is PeerAuthorityApplyStatus.INVALID


def test_pending_peer_rejects_sequential_ordinary_event_and_compat_wrapper() -> None:
    client = _client()
    client.apply_peer_authority_changed_detailed(_event(revision=1))

    gap = client.apply_peer_authority_changed_detailed(_event(revision=3))
    assert gap.status is PeerAuthorityApplyStatus.GAP
    assert client._provider_export_authority["peer-a"].revision == 1
    assert client._peer_acl["peer-a"].effective_perms == frozenset()

    sequential = client.apply_peer_authority_changed_detailed(_event(revision=2))
    assert sequential.status is PeerAuthorityApplyStatus.PENDING
    assert client._provider_export_authority["peer-a"].revision == 1
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()
    assert client._peer_tokens["peer-a"].scopes == []

    assert client.apply_peer_authority_changed(_event(revision=2)) is False
    assert client._provider_export_authority["peer-a"].revision == 1
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()


def test_empty_current_gap_pending_blocks_compat_wrapper_trusted_seed() -> None:
    client = _client()

    gap = client.apply_peer_authority_changed_detailed(_event(revision=3))
    assert gap.status is PeerAuthorityApplyStatus.GAP
    assert "peer-a" not in client._provider_export_authority
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()

    assert client.apply_peer_authority_changed(_event(revision=3)) is False
    assert "peer-a" not in client._provider_export_authority
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()
    assert client._peer_tokens["peer-a"].scopes == []


def test_trusted_absence_and_revision_floor_prevent_stale_resurrection() -> None:
    client = _client()
    assert client.apply_peer_authority_changed(_event(revision=1))
    absence = client.apply_trusted_peer_authority_absence("peer-a")
    assert absence.status is PeerAuthorityApplyStatus.ABSENT

    stale_restore = client.apply_peer_authority_changed_detailed(_event(revision=1))
    assert stale_restore.status is PeerAuthorityApplyStatus.STALE
    assert "peer-a" not in client._provider_export_authority

    restore = client.apply_peer_authority_changed_detailed(_event(revision=2))
    assert restore.status is PeerAuthorityApplyStatus.APPLIED


def test_revoked_removed_and_revision_zero_clear_aliases_and_token_scopes() -> None:
    client = _client()
    assert client.apply_peer_authority_changed(_event(revision=1, perms=("*",)))
    assert client._peer_acl["peer-a"].is_admin is True
    revoked = MeshPeerAuthorityChangedEvent(
        peer_id="peer-a",
        auth_grant_revision=2,
        disposition="removed",
        state="revoked",
        effective_permissions=(),
        reason="removed",
    )

    result = client.apply_peer_authority_changed_detailed(revoked)

    assert result.status is PeerAuthorityApplyStatus.APPLIED
    assert client._peer_acl["peer-a"].is_admin is False
    assert client._peer_acl["session-a"].effective_perms == frozenset()
    assert client._peer_tokens["peer-a"].scopes == []
    assert client._peer_tokens["session-a"].scopes == []

    zero = client.apply_trusted_peer_authority_snapshot(
        MeshPeerAuthoritySnapshot(
            peer_id="peer-a",
            auth_grant_revision=0,
            disposition="present",
            state="revoked",
            effective_permissions=(),
        )
    )
    assert zero.status is PeerAuthorityApplyStatus.ABSENT
    assert client._peer_acl["peer-a"].effective_perms == frozenset()


@pytest.mark.asyncio
async def test_revoked_authority_event_disconnects_active_peer_and_subscriptions() -> None:
    service = GatewayService()
    client = _client()
    service._rtc_client = client
    service._bus = _FakeBus()
    client.reannounce_manifest_for_peer = AsyncMock(return_value=True)
    assert client.apply_peer_authority_changed(_event(revision=1, perms=("*",)))
    subscription = client.event_subscriptions.subscribe(
        peer_id="peer-a",
        subscription_id="sub-1",
        requested_topics=("Gateway.GetServices",),
        allowed_topics=("Gateway.GetServices",),
    )
    pending_call = asyncio.get_running_loop().create_future()
    client._pending_rpc["call-1"] = pending_call
    client._pending_rpc_peers["call-1"] = "session-a"
    assert subscription.accepted is True
    assert client.get_diagnostics().authenticated_peer_count == 1

    await service._handle_mesh_peer_authority_changed(
        Envelope(
            type=MeshEvents.PEER_AUTHORITY_CHANGED,
            payload=MeshPeerAuthorityChangedEvent(
                peer_id="peer-a",
                auth_grant_revision=2,
                disposition="removed",
                state="revoked",
                effective_permissions=(),
                reason="removed",
            ),
            origin="internal",
        )
    )

    assert "session-a" not in client._pcs
    assert "peer-a" not in client._stable_peer_sessions
    assert pending_call.done() and pending_call.result() is None
    assert client._pending_rpc == {}
    assert client._pending_rpc_peers == {}
    assert client.get_diagnostics().authenticated_peer_count == 0
    assert client.event_subscriptions.snapshot().subscription_count == 0
    client.reannounce_manifest_for_peer.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconnect_challenge_revoked_removed_and_trusted_absence_reject_before_auth() -> None:
    client = _client()
    client._peer_id = "local-session"
    client._provider_lease_clock_ms = lambda: 2_000
    client._auth_service.verify_mesh_reconnect_proof = AsyncMock()
    pc = client._pcs["session-a"]
    record = _install_reconnect_record(client, "session-a", pc)

    assert client.apply_peer_authority_changed(_event(revision=1))
    revoked = MeshPeerAuthorityChangedEvent(
        peer_id="peer-a",
        auth_grant_revision=2,
        disposition="removed",
        state="revoked",
        effective_permissions=(),
        reason="removed",
    )
    assert client.apply_peer_authority_changed_detailed(revoked).status is (
        PeerAuthorityApplyStatus.APPLIED
    )
    assert "session-a" not in client._peer_auth_challenges

    with pytest.raises(PairingProtocolError, match="active challenge"):
        await client._handle_reconnect_proof(
            "session-a",
            pc,
            FakeDataChannel(),
            _reconnect_proof(record),
        )
    client._auth_service.verify_mesh_reconnect_proof.assert_not_awaited()

    assert client.apply_peer_authority_changed(_event(revision=3))
    record = _install_reconnect_record(client, "session-a", pc)
    assert client.apply_trusted_peer_authority_absence("peer-a").status is (
        PeerAuthorityApplyStatus.ABSENT
    )
    assert "session-a" not in client._peer_auth_challenges

    with pytest.raises(PairingProtocolError, match="active challenge"):
        await client._handle_reconnect_proof(
            "session-a",
            pc,
            FakeDataChannel(),
            _reconnect_proof(record),
        )
    client._auth_service.verify_mesh_reconnect_proof.assert_not_awaited()


@pytest.mark.parametrize(
    "identity",
    [
        SYSTEM,
        OPEN_PEER,
        ANONYMOUS,
        _identity({"Gateway.GetServices"}, source="http_bearer"),
    ],
)
def test_non_webrtc_or_sentinel_identities_are_never_granted(identity: Identity) -> None:
    client = _client()
    client._peer_acl["peer-a"] = identity
    client._peer_acl["session-a"] = identity

    assert client.apply_peer_authority_changed(_event(revision=1))

    assert client._peer_acl["peer-a"] == identity


@pytest.mark.asyncio
async def test_targeted_snapshot_resolves_gap_and_malformed_empty_is_not_absence() -> None:
    service = GatewayService()
    client = _client()
    service._rtc_client = client
    service._bus = _FakeBus(
        QueryResult(
            ok=True,
            data={
                "authorities": [
                    {
                        "peer_id": "peer-a",
                        "auth_grant_revision": 3,
                        "disposition": "present",
                        "state": "active",
                        "effective_permissions": ["Gateway.GetServices"],
                    }
                ]
            },
        )
    )
    client.apply_peer_authority_changed_detailed(_event(revision=3))

    assert await service._reconcile_mesh_authority_snapshot(stable_peer_id="peer-a", complete=False)
    assert client._provider_export_authority["peer-a"].revision == 3

    service._bus = _FakeBus(QueryResult(ok=True, data={}))
    assert not await service._reconcile_mesh_authority_snapshot(
        stable_peer_id="peer-a",
        complete=False,
    )
    assert client._provider_export_authority["peer-a"].revision == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("event_payload", "snapshot_revision", "snapshot_permissions"),
    [
        (_event(revision=3), 3, ("Gateway.GetServices",)),
        (_event(revision=1, perms=("Tooling.GetTools",)), 1, ("Gateway.GetServices",)),
    ],
)
async def test_gap_and_conflict_events_perform_targeted_snapshot_recovery_once(
    event_payload: MeshPeerAuthorityChangedEvent,
    snapshot_revision: int,
    snapshot_permissions: tuple[str, ...],
) -> None:
    service = GatewayService()
    client = _client()
    client.apply_peer_authority_changed_detailed(_event(revision=1))
    client.reannounce_manifest_for_peer = AsyncMock(return_value=True)
    client.reannounce_manifest = AsyncMock()
    service._rtc_client = client
    service._bus = _FakeBus(
        QueryResult(
            ok=True,
            data={
                "authorities": [
                    {
                        "peer_id": "peer-a",
                        "auth_grant_revision": snapshot_revision,
                        "disposition": "present",
                        "state": "active",
                        "effective_permissions": list(snapshot_permissions),
                    }
                ]
            },
        )
    )

    await service._handle_mesh_peer_authority_changed(
        Envelope(type=MeshEvents.PEER_AUTHORITY_CHANGED, payload=event_payload, origin="internal")
    )

    service._bus.request.assert_awaited_once()
    request = service._bus.request.await_args.args[1]
    assert request.peer_id == "peer-a"
    assert "peer-a" not in client._provider_export_authority_pending
    client.reannounce_manifest_for_peer.assert_awaited_once_with("peer-a")
    client.reannounce_manifest.assert_not_called()


@pytest.mark.asyncio
async def test_gap_event_failed_targeted_snapshot_stays_pending_zero_and_sends_none() -> None:
    service = GatewayService()
    client = _client()
    client.apply_peer_authority_changed_detailed(_event(revision=1))
    client.reannounce_manifest_for_peer = AsyncMock(return_value=True)
    service._rtc_client = client
    service._bus = _FakeBus(QueryResult(ok=True, data={}))

    await service._handle_mesh_peer_authority_changed(
        Envelope(
            type=MeshEvents.PEER_AUTHORITY_CHANGED,
            payload=_event(revision=3),
            origin="internal",
        )
    )

    service._bus.request.assert_awaited_once()
    assert "peer-a" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset()
    client.reannounce_manifest_for_peer.assert_not_awaited()


@pytest.mark.asyncio
async def test_snapshot_malformed_defaulted_and_canonical_row_validation() -> None:
    service = GatewayService()
    service._rtc_client = _client()

    malformed_payloads: list[object] = [
        {},
        MeshPeerAuthoritySnapshotResponse(),
        SimpleNamespace(authorities=[]),
        {
            "authorities": [
                {
                    "peer_id": "peer-b",
                    "auth_grant_revision": 1,
                    "disposition": "present",
                    "state": "active",
                    "effective_permissions": [],
                },
                {
                    "peer_id": "peer-a",
                    "auth_grant_revision": 1,
                    "disposition": "present",
                    "state": "active",
                    "effective_permissions": [],
                },
            ]
        },
        {
            "authorities": [
                {
                    "peer_id": "peer-a",
                    "auth_grant_revision": 1,
                    "disposition": "present",
                    "state": "active",
                    "effective_permissions": [],
                },
                {
                    "peer_id": "peer-a",
                    "auth_grant_revision": 2,
                    "disposition": "present",
                    "state": "active",
                    "effective_permissions": [],
                },
            ]
        },
        {
            "authorities": [
                {
                    "peer_id": " peer-a",
                    "auth_grant_revision": 1,
                    "disposition": "present",
                    "state": "active",
                    "effective_permissions": [],
                }
            ]
        },
        {
            "authorities": [
                {
                    "peer_id": "peer-a",
                    "auth_grant_revision": 1,
                    "disposition": "present",
                    "state": "active",
                    "effective_permissions": ["B", "A"],
                }
            ]
        },
    ]
    for payload in malformed_payloads:
        service._bus = _FakeBus(QueryResult(ok=True, data=payload))
        assert not await service._reconcile_mesh_authority_snapshot(complete=True)

    service._bus = _FakeBus(
        QueryResult(
            ok=True,
            data={
                "authorities": [
                    {
                        "peer_id": "peer-b",
                        "auth_grant_revision": 1,
                        "disposition": "present",
                        "state": "active",
                        "effective_permissions": [],
                    }
                ]
            },
        )
    )
    assert not await service._reconcile_mesh_authority_snapshot(
        stable_peer_id="peer-a",
        complete=False,
    )

    explicit_empty = MeshPeerAuthoritySnapshotResponse(authorities=())
    service._bus = _FakeBus(QueryResult(ok=True, data=explicit_empty))
    assert await service._reconcile_mesh_authority_snapshot(
        stable_peer_id="peer-a",
        complete=False,
    )


@pytest.mark.asyncio
async def test_full_snapshot_validation_happens_before_any_mutation() -> None:
    service = GatewayService()
    client = _client()
    client._stable_peer_sessions["peer-b"] = "session-b"
    client._peer_stable_ids["session-b"] = "peer-b"
    peer_b_identity = _identity({"Tooling.GetTools"})
    client._peer_acl["peer-b"] = peer_b_identity
    client._peer_acl["session-b"] = peer_b_identity
    peer_b_token = Token(
        id="token-2",
        user_id="principal-2",
        token_hash="hash-2",
        prefix="tok",
        scopes=["Tooling.GetTools"],
    )
    client._peer_tokens["peer-b"] = peer_b_token
    client._peer_tokens["session-b"] = peer_b_token
    client.apply_peer_authority_changed_detailed(_event(revision=1))
    client.apply_peer_authority_changed_detailed(_event(revision=2))
    client.apply_peer_authority_changed_detailed(_event(revision=3))
    client.apply_peer_authority_changed_detailed(_event(revision=4))
    client.apply_peer_authority_changed_detailed(_event(revision=5))
    client.apply_peer_authority_changed_detailed(
        _event(peer_id="peer-b", revision=1, perms=("Tooling.GetTools",))
    )
    client.apply_peer_authority_changed_detailed(
        _event(peer_id="peer-b", revision=2, perms=("Tooling.GetTools",))
    )
    client.apply_peer_authority_changed_detailed(
        _event(peer_id="peer-b", revision=3, perms=("Tooling.GetTools",))
    )
    client.apply_peer_authority_changed_detailed(
        _event(peer_id="peer-b", revision=4, perms=("Tooling.GetTools",))
    )
    client.apply_peer_authority_changed_detailed(
        _event(peer_id="peer-b", revision=5, perms=("Tooling.GetTools",))
    )
    peer_a_generation = client._provider_export_peer_generations["peer-a"]
    client.reannounce_manifest_for_peer = AsyncMock(return_value=True)
    service._rtc_client = client
    service._bus = _FakeBus(
        QueryResult(
            ok=True,
            data={
                "authorities": [
                    {
                        "peer_id": "peer-a",
                        "auth_grant_revision": 6,
                        "disposition": "present",
                        "state": "active",
                        "effective_permissions": ["Gateway.GetServices"],
                    },
                    {
                        "peer_id": "peer-b",
                        "auth_grant_revision": 4,
                        "disposition": "present",
                        "state": "active",
                        "effective_permissions": ["Tooling.GetTools"],
                    },
                ]
            },
        )
    )

    assert not await service._reconcile_mesh_authority_snapshot(complete=True)
    client.reannounce_manifest_for_peer.assert_not_awaited()
    assert client._provider_export_authority["peer-a"].revision == 5
    assert client._provider_export_authority["peer-b"].revision == 5
    assert "peer-a" not in client._provider_export_authority_pending
    assert "peer-b" in client._provider_export_authority_pending
    assert client._peer_acl["peer-a"].effective_perms == frozenset({"Gateway.GetServices"})
    assert client._peer_acl["peer-b"].effective_perms == frozenset()
    assert client._peer_tokens["peer-b"].scopes == []
    assert client._provider_export_peer_generations["peer-a"] == peer_a_generation


@pytest.mark.asyncio
async def test_invalid_trusted_application_fails_reconciliation() -> None:
    service = GatewayService()
    client = _client()
    service._rtc_client = client
    service._bus = _FakeBus(
        QueryResult(
            ok=True,
            data={
                "authorities": [
                    {
                        "peer_id": "peer-a",
                        "auth_grant_revision": 1,
                        "disposition": "present",
                        "state": "active",
                        "effective_permissions": [],
                    }
                ]
            },
        )
    )
    client.apply_trusted_peer_authority_snapshot = MagicMock(
        return_value=PeerAuthorityApplyResult(PeerAuthorityApplyStatus.INVALID, peer_id="peer-a")
    )

    assert not await service._reconcile_mesh_authority_snapshot(
        stable_peer_id="peer-a",
        complete=False,
    )


@pytest.mark.asyncio
async def test_full_and_targeted_trusted_absence() -> None:
    service = GatewayService()
    client = _client()
    service._rtc_client = client
    client.apply_peer_authority_changed_detailed(_event(revision=1))

    service._bus = _FakeBus(QueryResult(ok=True, data={"authorities": []}))
    assert await service._reconcile_mesh_authority_snapshot(stable_peer_id="peer-a", complete=False)
    assert "peer-a" not in client._provider_export_authority
    assert client._provider_export_authority_absent["peer-a"] == 1

    client.apply_peer_authority_changed_detailed(_event(revision=2))
    assert await service._reconcile_mesh_authority_snapshot(complete=True)
    assert "peer-a" not in client._provider_export_authority


@pytest.mark.asyncio
async def test_trusted_absence_resolution_returns_targeted_send_intent() -> None:
    service = GatewayService()
    client = _client()
    client.apply_peer_authority_changed_detailed(_event(revision=1))
    client.apply_peer_authority_changed_detailed(_event(revision=3))
    service._rtc_client = client
    service._bus = _FakeBus(QueryResult(ok=True, data={"authorities": []}))

    result = await service._reconcile_mesh_authority_snapshot(
        stable_peer_id="peer-a",
        complete=False,
    )

    assert result.success is True
    assert result.reannounce_peers == ("peer-a",)
    assert "peer-a" not in client._provider_export_authority
    assert client._provider_export_authority_absent["peer-a"] == 1


@pytest.mark.asyncio
async def test_targeted_manifest_send_rules(monkeypatch) -> None:
    client = _client()
    client._peer_registry = MagicMock()
    client._peer_send_fns["session-a"] = MagicMock()
    client._current_mesh_policy_pair = MagicMock(return_value=(MeshConfig(enabled=True), None))
    client._send_manifest = AsyncMock(return_value=True)

    assert await client.reannounce_manifest_for_peer("peer-a")
    client._send_manifest.assert_awaited_once()

    client._send_manifest.reset_mock()
    client._peer_send_fns.clear()
    assert not await client.reannounce_manifest_for_peer("peer-a")
    client._send_manifest.assert_not_called()


@pytest.mark.asyncio
async def test_authority_event_sends_targeted_once_and_never_broad() -> None:
    service = GatewayService()
    rtc = _client()
    rtc.reannounce_manifest_for_peer = AsyncMock(return_value=True)
    rtc.reannounce_manifest = AsyncMock()
    service._rtc_client = rtc
    envelope = Envelope(
        type=MeshEvents.PEER_AUTHORITY_CHANGED,
        payload=_event(),
        origin="internal",
    )

    await service._handle_mesh_peer_authority_changed(envelope)
    await service._handle_mesh_peer_authority_changed(envelope)

    rtc.reannounce_manifest_for_peer.assert_awaited_once_with("peer-a")
    rtc.reannounce_manifest.assert_not_called()


@pytest.mark.asyncio
async def test_reconnect_installs_zero_before_refresh_and_register_send_after() -> None:
    client = _client()
    auth = AsyncMock()
    auth.build_identity_from_token.return_value = _identity({"Stale.Permission", "*"})
    client._auth_service = auth
    client._mesh_enabled = True
    client._peer_registry = MagicMock()
    client._peer_registry.register_peer = AsyncMock()
    client._send_manifest = AsyncMock(return_value=True)
    observed: list[frozenset[str]] = []

    async def refresh(peer_id: str) -> bool:
        observed.append(client._peer_acl[peer_id].effective_perms)
        return False

    client.set_authority_refresh_callback(refresh)

    await client._authenticate_peer(
        peer="session-b",
        token=Token(
            id="token-b",
            user_id="principal-1",
            token_hash="hash",
            prefix="tok",
            scopes=["*"],
        ),
        stable_peer_id="peer-b",
        peer_name="Peer B",
        clear_pairing_inbound=False,
    )

    assert observed == [frozenset()]
    assert client._peer_acl["peer-b"].effective_perms == frozenset()
    client._peer_registry.register_peer.assert_awaited_once_with("peer-b", "Peer B")
    client._send_manifest.assert_awaited_once_with("peer-b")


@pytest.mark.asyncio
async def test_reconnect_success_reconciles_before_register_and_sends_once_after() -> None:
    client = _client()
    auth = AsyncMock()
    auth.build_identity_from_token.return_value = _identity({"Stale.Permission", "*"})
    client._auth_service = auth
    client._mesh_enabled = True
    client._peer_registry = MagicMock()
    client._peer_registry.register_peer = AsyncMock()
    client._send_manifest = AsyncMock(return_value=True)
    sequence: list[str] = []

    async def refresh(peer_id: str) -> bool:
        sequence.append("refresh")
        assert client._peer_acl[peer_id].effective_perms == frozenset()
        client.apply_trusted_peer_authority_snapshot(
            MeshPeerAuthoritySnapshot(
                peer_id=peer_id,
                auth_grant_revision=1,
                disposition="present",
                state="active",
                effective_permissions=("Gateway.GetServices",),
            )
        )
        client._send_manifest.assert_not_awaited()
        client._peer_registry.register_peer.assert_not_awaited()
        return True

    async def register(peer_id: str, name: str) -> None:
        sequence.append("register")

    async def send_manifest(peer_id: str) -> bool:
        sequence.append("send")
        return True

    client._peer_registry.register_peer.side_effect = register
    client._send_manifest.side_effect = send_manifest
    client.set_authority_refresh_callback(refresh)

    await client._authenticate_peer(
        peer="session-c",
        token=Token(
            id="token-c",
            user_id="principal-1",
            token_hash="hash",
            prefix="tok",
            scopes=["*"],
        ),
        stable_peer_id="peer-c",
        peer_name="Peer C",
        clear_pairing_inbound=False,
    )

    assert sequence == ["refresh", "register", "send"]
    assert client._peer_acl["peer-c"].effective_perms == frozenset({"Gateway.GetServices"})
    client._send_manifest.assert_awaited_once_with("peer-c")


@pytest.mark.asyncio
async def test_startup_snapshot_before_configure_and_failure_blocks_join(monkeypatch) -> None:
    service = GatewayService()
    bus = _FakeBus()
    service._bus = bus
    service._rtc_client = MagicMock()
    service._rtc_client.set_mesh_identity = MagicMock()
    service._rtc_client.set_authority_refresh_callback = MagicMock()
    service._rtc_client.configure_mesh = MagicMock()
    service._rtc_client.refresh_presence = AsyncMock()
    service._get_gateway_config = AsyncMock(
        return_value=SimpleNamespace(
            mesh=MeshConfig(enabled=True),
            webrtc=SimpleNamespace(room="room"),
        )
    )
    service._wait_for_auth_pairing_service = AsyncMock(return_value=True)
    service._get_or_create_peer_id = AsyncMock(return_value="local-peer")
    service._reconcile_mesh_authority_snapshot = AsyncMock(return_value=False)

    outcome = await service._start_mesh_once()

    assert outcome is _MeshStartOutcome.RETRY
    service._rtc_client.set_mesh_identity.assert_called_once()
    service._reconcile_mesh_authority_snapshot.assert_awaited_once_with(complete=True)
    service._rtc_client.configure_mesh.assert_not_called()
    service._rtc_client.refresh_presence.assert_not_awaited()


@pytest.mark.asyncio
async def test_startup_success_snapshot_precedes_configure_credentials_presence() -> None:
    service = GatewayService()
    bus = _FakeBus()
    service._bus = bus
    sequence: list[str] = []
    service._rtc_client = MagicMock()
    service._rtc_client.set_mesh_identity = MagicMock(
        side_effect=lambda *_, **__: sequence.append("id")
    )
    service._rtc_client.set_authority_refresh_callback = MagicMock()
    service._rtc_client.configure_mesh = MagicMock(
        side_effect=lambda **_: sequence.append("config")
    )
    service._rtc_client.refresh_presence = AsyncMock(
        side_effect=lambda: sequence.append("presence")
    )
    service._get_gateway_config = AsyncMock(
        return_value=SimpleNamespace(
            mesh=MeshConfig(enabled=True),
            webrtc=SimpleNamespace(room="room"),
        )
    )
    service._wait_for_auth_pairing_service = AsyncMock(return_value=True)
    service._get_or_create_peer_id = AsyncMock(return_value="local-peer")
    service._reconcile_mesh_authority_snapshot = AsyncMock(
        side_effect=lambda **_: sequence.append("snapshot") or True
    )
    service._load_mesh_inbound_credentials = AsyncMock(
        side_effect=lambda *_: sequence.append("credentials")
    )

    outcome = await service._start_mesh_once()

    assert outcome is _MeshStartOutcome.STARTED
    assert sequence[:5] == ["id", "snapshot", "config", "credentials", "presence"]

    bus.request.reset_mock()
    await service._mesh_peer_registry.register_peer("browser-peer", "Browser Thin")

    assert [call.args[0] for call in bus.request.await_args_list] == [
        AuthMethods.MESH_UPSERT_PEER,
        AuthMethods.MESH_UPDATE_PEER_CONNECTION,
    ]
    connection_update = bus.request.await_args_list[1].args[1]
    assert connection_update.peer_id == "browser-peer"
    assert connection_update.connection_status == "connected"

    from app.services.gateway.mesh.tooling_projection_transport import (
        TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
    )
    from app.shared.contracts.models.tooling import ToolingProjectionSyncRequested

    bus.request.reset_mock()
    bus.publish.reset_mock()
    await service._mesh_peer_registry.on_peer_status_changed(
        "browser-peer",
        "Browser Thin",
        "provider_unavailable",
    )

    unavailable_update = bus.request.await_args.args[1]
    assert bus.request.await_args.args[0] == AuthMethods.MESH_UPDATE_PEER_CONNECTION
    assert unavailable_update.peer_id == "browser-peer"
    assert unavailable_update.connection_status == "connected"
    topic, refresh = bus.publish.await_args.args[:2]
    assert topic == TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC
    assert isinstance(refresh, ToolingProjectionSyncRequested)
    assert refresh.provider_peer_id == "browser-peer"
    assert refresh.reason_code == "provider_status_provider_unavailable"
    assert refresh.force_full_snapshot is True
    assert bus.publish.await_args.kwargs["mesh"] is False

    bus.request.reset_mock()
    await service._mesh_peer_registry.remove_peer("browser-peer")
    disconnect_update = bus.request.await_args.args[1]
    assert bus.request.await_args.args[0] == AuthMethods.MESH_UPDATE_PEER_CONNECTION
    assert disconnect_update.peer_id == "browser-peer"
    assert disconnect_update.connection_status == "disconnected"


def test_disconnect_retains_committed_evidence_and_close_clears_runtime_authority() -> None:
    client = _client()
    client.apply_peer_authority_changed_detailed(_event(revision=1))
    client._stable_peer_sessions.pop("peer-a")
    client._peer_stable_ids.pop("session-a")
    client._invalidate_provider_export_peer("peer-a")
    assert client._provider_export_authority["peer-a"].revision == 1


@pytest.mark.asyncio
async def test_close_clears_authority_retry_cache_and_runtime_aliases() -> None:
    client = _client()
    client.apply_peer_authority_changed_detailed(_event(revision=1))
    client.apply_peer_authority_changed_detailed(_event(revision=3))
    client.apply_trusted_peer_authority_absence("peer-b", revision_floor=4)
    client._manifest_reannounce_retry_tasks["peer-a"] = asyncio.create_task(asyncio.sleep(60))
    client._authority_refresh_callback = AsyncMock()
    client._peer_registry = MagicMock()
    client._peer_bridge = MagicMock()

    await client.close()

    assert client._provider_export_authority == {}
    assert client._provider_export_authority_pending == set()
    assert client._provider_export_authority_absent == {}
    assert client._manifest_reannounce_retry_tasks == {}
    assert client._provider_export_diagnostics == {}
    assert client._authority_refresh_callback is None
    assert client._peer_acl == {}
    assert client._peer_tokens == {}
    assert client._stable_peer_sessions == {}
    assert client._peer_stable_ids == {}
    assert client._mesh_enabled is False
    assert client._peer_registry is None


@pytest.mark.asyncio
async def test_targeted_retry_coalesces_bounds_stops_and_cleans_up(monkeypatch) -> None:
    client = _client()
    client._peer_registry = MagicMock()
    client._peer_send_fns["session-a"] = MagicMock()
    client._current_mesh_policy_pair = MagicMock(return_value=(MeshConfig(enabled=True), None))
    client._send_manifest = AsyncMock(return_value=False)

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "sleep", no_sleep)

    assert not await client.reannounce_manifest_for_peer("peer-a")
    first_task = client._manifest_reannounce_retry_tasks["peer-a"]
    assert not await client.reannounce_manifest_for_peer("peer-a")
    assert client._manifest_reannounce_retry_tasks["peer-a"] is first_task

    await first_task

    assert "peer-a" not in client._manifest_reannounce_retry_tasks
    assert client._send_manifest.await_count == 5

    client._send_manifest.reset_mock()
    client._send_manifest.return_value = False
    assert not await client.reannounce_manifest_for_peer("peer-a")
    stop_task = client._manifest_reannounce_retry_tasks["peer-a"]
    client._peer_send_fns.clear()
    await stop_task
    assert client._send_manifest.await_count == 1
    assert "peer-a" not in client._manifest_reannounce_retry_tasks


@pytest.mark.asyncio
async def test_targeted_retry_success_cleans_up_existing_task(monkeypatch) -> None:
    client = _client()
    client._peer_registry = MagicMock()
    client._peer_send_fns["session-a"] = MagicMock()
    client._current_mesh_policy_pair = MagicMock(return_value=(MeshConfig(enabled=True), None))
    client._send_manifest = AsyncMock(side_effect=[False, True])

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "sleep", no_sleep)

    assert not await client.reannounce_manifest_for_peer("peer-a")
    task = client._manifest_reannounce_retry_tasks["peer-a"]
    await task

    assert "peer-a" not in client._manifest_reannounce_retry_tasks
    assert client._send_manifest.await_count == 2


@pytest.mark.asyncio
async def test_disable_mesh_cancels_reannounce_retry_without_post_disable_send(
    monkeypatch,
) -> None:
    client = _client()
    client._peer_registry = MagicMock()
    client._peer_send_fns["session-a"] = MagicMock()
    client._current_mesh_policy_pair = MagicMock(return_value=(MeshConfig(enabled=True), None))
    client._send_manifest = AsyncMock(return_value=False)
    sleep_started = asyncio.Event()
    sleep_blocker: asyncio.Future[None] = asyncio.Future()

    async def blocked_sleep(_delay: float) -> None:
        sleep_started.set()
        await sleep_blocker

    monkeypatch.setattr(asyncio, "sleep", blocked_sleep)

    assert not await client.reannounce_manifest_for_peer("peer-a")
    task = client._manifest_reannounce_retry_tasks["peer-a"]
    await sleep_started.wait()

    client.disable_mesh()
    assert client._manifest_reannounce_retry_tasks == {}
    await asyncio.gather(task, return_exceptions=True)

    assert task.cancelled()
    assert client._send_manifest.await_count == 1


@pytest.mark.asyncio
async def test_send_manifest_wire_path_uses_ready_projection_filtered_to_recipient(
    monkeypatch,
) -> None:
    client = _client()
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="peer-a",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("TTS.*",),
            reason="approved",
        )
    )
    channel = client._peer_data_channels["session-a"]
    client._registry = None
    monkeypatch.setattr(
        "app.shared.contracts.registry.list_modules",
        lambda: {
            "TTS": SimpleNamespace(
                version="1.2.0",
                capabilities=["streaming"],
                callable_features=list(feature_contracts_for_module("TTS")),
                methods=[
                    SimpleNamespace(
                        name="Synthesize",
                        summary="Text to speech",
                        bus_topic="TTS.Synthesize",
                        exposure="both",
                        required_perms=["TTS.*"],
                        callable_feature_ids=["speech_synthesis"],
                        callable_features=list(feature_contracts_for_topic("TTS.Synthesize")),
                        input_model=type("TTSRequest", (), {"__name__": "TTSRequest"}),
                        output_model=type("TTSResponse", (), {"__name__": "TTSResponse"}),
                        method_type="use",
                    ),
                    SimpleNamespace(
                        name="Request",
                        summary="Text to speech request",
                        bus_topic="TTS.Request",
                        exposure="external",
                        required_perms=["TTS.Request"],
                        callable_feature_ids=["speech_playback"],
                        callable_features=list(feature_contracts_for_topic("TTS.Request")),
                        input_model=type("TTSRequest", (), {"__name__": "TTSRequest"}),
                        output_model=type("TTSResponse", (), {"__name__": "TTSResponse"}),
                        method_type="use",
                    ),
                ],
            )
        },
    )
    monkeypatch.setattr("app.shared.contracts.registry._get_package_version", lambda: "1.0.0")
    client._schedule_provider_export_shadow = MagicMock()
    client.retry_tooling_projection_invalidation = MagicMock(return_value=True)
    mesh_config = MeshConfig(
        enabled=True,
        services={
            "TTS": mesh_policy(
                share=True,
                unshared_feature_ids=["playback"],
                unshared_method_ids=["TTS.Request"],
            )
        },
    )

    assert await client._send_manifest("peer-a", mesh_config=mesh_config)

    assert channel.sent
    payload = json.loads(channel.sent[0])
    assert payload["type"] == "manifest"
    assert payload.get("active_protocol") == "projection-v1"
    assert payload.get("projection_active") is True
    assert payload.get("recipient_projection_evidence")["recipient_peer_id"] == "peer-a"
    shared_services = payload["shared_services"]
    method_ids = {
        method["bus_topic"] for service in shared_services for method in service.get("methods", [])
    }
    assert "TTS.Synthesize" in method_ids
    assert "TTS.Request" not in method_ids
    client._schedule_provider_export_shadow.assert_called_once()
    client.retry_tooling_projection_invalidation.assert_called_once_with("peer-a")
    projection = ProjectionResult(
        cache_key=MagicMock(),
        services=(),
        diff=MagicMock(),
        canonical=b"{}",
        digest="a" * 64,
        readiness="ready",
    )
    assert projection.routable is False


@pytest.mark.asyncio
async def test_partial_manifest_ack_opens_only_compatible_provider_rpc(monkeypatch) -> None:
    client = _client()
    identity = _identity({"TTS.Synthesize", "Scheduler.ListJobs"})
    client._peer_acl["session-a"] = identity
    client._peer_acl["peer-a"] = identity
    client._registry = None
    hello = build_protocol_hello(role="hybrid", capabilities=(CAP_PROVIDER_LEASE_V1,))
    protocol = negotiate_protocol(hello, hello)
    client._peer_protocols["session-a"] = protocol
    client._peer_protocols["peer-a"] = protocol
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="peer-a",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("*",),
            reason="approved",
        )
    )
    monkeypatch.setattr(
        "app.shared.contracts.registry.list_modules",
        lambda: {
            "TTS": _mesh_module(
                "TTS",
                "TTS.Synthesize",
                feature_id="speech_synthesis",
                permission="TTS.Synthesize",
                method_name="Synthesize",
            ),
            "Scheduler": _mesh_module(
                "Scheduler",
                "Scheduler.ListJobs",
                feature_id="job_discovery",
                permission="Scheduler.ListJobs",
                method_name="ListJobs",
            ),
        },
    )
    monkeypatch.setattr("app.shared.contracts.registry._get_package_version", lambda: "1.0.0")
    client._schedule_provider_export_shadow = MagicMock()
    client.retry_tooling_projection_invalidation = MagicMock(return_value=True)
    provider_mesh_config = MeshConfig(
        enabled=True,
        services={
            "TTS": mesh_policy(share=True),
            "Scheduler": mesh_policy(share=True),
        },
    )
    consumer_mesh_config = MeshConfig(
        enabled=True,
        services={"TTS": mesh_policy(prefer="network")},
    )
    frames: list[dict[str, object]] = []
    sleeps: list[float] = []
    sleep_release = asyncio.Event()

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)
        await sleep_release.wait()

    client._provider_lease_clock_ms = lambda: 1000
    client._provider_lease_sleep = fake_sleep

    async def send_and_ack(_peer_id: str, text: str) -> bool:
        payload = json.loads(text)
        frames.append(payload)
        if payload.get("type") == "manifest":
            manifest = parse_manifest_with_evidence(payload).manifest
            assert manifest is not None
            ack = generate_manifest_ack(manifest, consumer_mesh_config)
            assert ack.compatible_services == ["TTS"]
            assert ack.unused_services == ["Scheduler"]
            await client._on_manifest_ack("session-a", manifest_ack_to_dict(ack))
        return True

    client.send_to_peer_async = AsyncMock(side_effect=send_and_ack)  # type: ignore[method-assign]

    assert await client._send_manifest("peer-a", mesh_config=provider_mesh_config)

    assert client._is_local_provider_ready_for_session("session-a", "TTS") is True
    assert client._is_local_provider_ready_for_session("session-a", "Scheduler") is False
    assert any(frame.get("type") == "provider_lease" for frame in frames)
    for _ in range(5):
        if sleeps:
            break
        await asyncio.sleep(0)
    assert sleeps == [20.0]

    registry = MagicMock()

    async def get_service(module: str) -> ServiceAnnouncement:
        return ServiceAnnouncement(
            module=module,
            version="1.0",
            methods=[
                MethodInfo(
                    name="Synthesize" if module == "TTS" else "ListJobs",
                    bus_topic="TTS.Synthesize" if module == "TTS" else "Scheduler.ListJobs",
                    exposure="external",
                    required_perms=[
                        f"{module}.Synthesize" if module == "TTS" else "Scheduler.ListJobs"
                    ],
                )
            ],
        )

    registry.get_service = AsyncMock(side_effect=get_service)
    bus = AsyncMock()
    bus.request.return_value = QueryResult(ok=True, data={"status": "ok"})
    sent_rpc: list[dict[str, object]] = []
    handler = RPCHandler(
        bus,
        registry,
        lambda text: sent_rpc.append(json.loads(text)),
        lambda: identity,
        mesh_config=provider_mesh_config,
        stable_peer_id_provider=lambda: "peer-a",
        active_projection_provider=lambda: client._current_provider_export_projection(
            "peer-a", mesh_config=provider_mesh_config
        ),
        provider_readiness_provider=lambda service_id: client._is_local_provider_ready_for_session(
            "session-a", service_id
        ),
    )

    await handler.on_message(
        json.dumps({"type": "call", "id": "tts-ok", "method": "TTS.Synthesize"})
    )
    assert sent_rpc[-1]["type"] == "result", sent_rpc[-1]
    bus.request.assert_awaited_once()

    await handler.on_message(
        json.dumps({"type": "call", "id": "scheduler-blocked", "method": "Scheduler.ListJobs"})
    )
    assert sent_rpc[-1]["type"] == "error"
    assert sent_rpc[-1]["error"]["code"] == 425
    bus.request.assert_awaited_once()

    sleep_release.set()
    renewal_task = client._local_provider_lease_tasks["peer-a"][3]
    renewal_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await renewal_task


@pytest.mark.asyncio
async def test_manifest_ack_without_compatible_services_does_not_open_provider_lease(
    monkeypatch,
) -> None:
    client = _client()
    identity = _identity({"TTS.Synthesize", "Scheduler.ListJobs"})
    client._peer_acl["session-a"] = identity
    client._peer_acl["peer-a"] = identity
    client._registry = None
    hello = build_protocol_hello(role="hybrid", capabilities=(CAP_PROVIDER_LEASE_V1,))
    protocol = negotiate_protocol(hello, hello)
    client._peer_protocols["session-a"] = protocol
    client._peer_protocols["peer-a"] = protocol
    assert client.apply_peer_authority_changed(
        MeshPeerAuthorityChangedEvent(
            peer_id="peer-a",
            auth_grant_revision=1,
            disposition="present",
            state="active",
            effective_permissions=("*",),
            reason="approved",
        )
    )
    monkeypatch.setattr(
        "app.shared.contracts.registry.list_modules",
        lambda: {
            "TTS": _mesh_module(
                "TTS",
                "TTS.Synthesize",
                feature_id="speech_synthesis",
                permission="TTS.Synthesize",
                method_name="Synthesize",
            ),
            "Scheduler": _mesh_module(
                "Scheduler",
                "Scheduler.ListJobs",
                feature_id="job_discovery",
                permission="Scheduler.ListJobs",
                method_name="ListJobs",
            ),
        },
    )
    monkeypatch.setattr("app.shared.contracts.registry._get_package_version", lambda: "1.0.0")
    provider_mesh_config = MeshConfig(
        enabled=True,
        services={
            "TTS": mesh_policy(share=True),
            "Scheduler": mesh_policy(share=True),
        },
    )
    consumer_mesh_config = MeshConfig(
        enabled=True,
        services={
            "TTS": mesh_policy(prefer="network", allowed_provider_peer_ids=["other-peer"]),
            "Scheduler": mesh_policy(prefer="network", allowed_provider_peer_ids=["other-peer"]),
        },
    )
    frames: list[dict[str, object]] = []
    client._peer_registry = MagicMock()
    client._peer_registry.update_manifest_ack = AsyncMock()

    async def send_and_ack(_peer_id: str, text: str) -> bool:
        payload = json.loads(text)
        frames.append(payload)
        if payload.get("type") == "manifest":
            manifest = parse_manifest_with_evidence(payload).manifest
            assert manifest is not None
            ack = generate_manifest_ack(manifest, consumer_mesh_config)
            assert ack.compatible_services == []
            assert sorted(ack.incompatible_services) == ["Scheduler", "TTS"]
            await client._on_manifest_ack("session-a", manifest_ack_to_dict(ack))
        return True

    client.send_to_peer_async = AsyncMock(side_effect=send_and_ack)  # type: ignore[method-assign]

    assert await client._send_manifest("peer-a", mesh_config=provider_mesh_config)

    client._peer_registry.update_manifest_ack.assert_awaited_once()
    assert client._peer_registry.update_manifest_ack.await_args.args[0] == "peer-a"
    assert client._is_local_provider_ready_for_session("session-a", "TTS") is False
    assert client._is_local_provider_ready_for_session("session-a", "Scheduler") is False
    assert not any(frame.get("type") == "provider_lease" for frame in frames)


def test_g007_projection_protocol_is_active() -> None:
    result = ProjectionResult(
        cache_key=MagicMock(),
        services=(),
        diff=MagicMock(),
        canonical=b"{}",
        digest="a" * 64,
        readiness="ready",
    )
    assert result.routable is False
    assert result.effective_manifest_protocol == ACTIVE_MANIFEST_PROTOCOL
    assert result.effective_manifest_protocol == "projection-v1"
