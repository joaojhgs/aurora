import asyncio
import hashlib
import hmac
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.db.models import Token
from app.services.gateway.acl.identity import ANONYMOUS, Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.policy_store import MeshPolicyStore
from app.services.gateway.utils.crypto import aead_seal
from app.services.gateway.webrtc.pairing_sas import (
    PAIRING_COMMIT_TYPE,
    PAIRING_TERMINAL_TYPE,
    PairingProtocolError,
    PairingSAS,
)
from app.services.gateway.webrtc.peer_protocol import (
    CAP_FRAGMENTATION_V1,
    CAP_PROVIDER_LEASE_V1,
    build_protocol_hello,
    negotiate_protocol,
)
from app.services.gateway.webrtc.rtc_client import (
    RTCClient,
    _ManifestAckExpectation,
    _PairingDeniedError,
    _ReconnectChallengeRecord,
)
from app.shared.contracts.models.auth import AuthMethods, build_mesh_reconnect_proof_message
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.models.tooling import ToolingMethods
from tests.unit.gateway.mesh_policy_helpers import mesh_policy
from tests.unit.gateway.verified_manifest_helpers import verified_peer_manifest


class MockDataChannel:
    def __init__(self, label="aurora-rpc"):
        self.label = label
        self.readyState = "open"
        self.events = {}
        self.sent_messages = []

    def on(self, event_name):
        def decorator(callback):
            self.events[event_name] = callback
            return callback

        return decorator

    def send(self, message):
        self.sent_messages.append(message)

    def close(self):
        self.readyState = "closed"

    def emit(self, event_name, *args, **kwargs):
        if event_name in self.events:
            if asyncio.iscoroutinefunction(self.events[event_name]):
                return asyncio.create_task(self.events[event_name](*args, **kwargs))
            return self.events[event_name](*args, **kwargs)
        return None


def _verified_tooling_service() -> PeerServiceInfo:
    return PeerServiceInfo(
        module="Tooling",
        methods=[
            MethodInfo(
                name="ExecuteTool",
                bus_topic=ToolingMethods.EXECUTE_TOOL,
                exposure="external",
                required_perms=[ToolingMethods.EXECUTE_TOOL],
            )
        ],
    )


def pairing_sas_result(
    *,
    remote_peer_id: str = "stable-remote-peer",
    remote_node_name: str = "Remote Aurora",
    pairing_session_id: str = "a" * 64,
    verification_code: str = "48271935",
) -> PairingSAS:
    return PairingSAS(
        pairing_session_id=pairing_session_id,
        verification_code=verification_code,
        transcript_sha256="b" * 64,
        channel_binding_sha256="c" * 64,
        remote_stable_peer_id=remote_peer_id,
        remote_node_name=remote_node_name,
    )


def install_pairing_transport(
    client: RTCClient,
    peer: str,
    pc: Any,
    *,
    remote_stable_peer_id: str = "stable-remote-peer",
    remote_node_name: str = "Remote Aurora",
) -> str:
    """Install the complete SDP transcript required by reconnect auth."""
    client._pairing_transports[peer] = {
        "pc": pc,
        "offerer_signaling_id": client._peer_id,
        "answerer_signaling_id": peer,
        "offer_sdp": "v=0\r\na=fingerprint:sha-256 11:22\r\n",
        "answer_sdp": "v=0\r\na=fingerprint:sha-256 33:44\r\n",
        "remote_stable_peer_id": remote_stable_peer_id,
        "remote_node_name": remote_node_name,
    }
    client._remember_claimed_peer_identity(peer, remote_stable_peer_id, remote_node_name)
    return client._channel_binding_for_peer(peer, pc)


def reconnect_challenge_for(
    client: RTCClient,
    peer: str,
    pc: Any,
    *,
    challenge: str = "56" * 32,
) -> dict[str, str]:
    transport = client._pairing_transports[peer]
    return {
        "type": "mesh_auth_challenge_v1",
        "challenge": challenge,
        "channel_binding": client._channel_binding_for_peer(peer, pc),
        "claimant_peer_id": client._local_mesh_peer_id(),
        "verifier_peer_id": str(transport["remote_stable_peer_id"]),
        "claimant_signaling_peer_id": client._peer_id,
        "verifier_signaling_peer_id": peer,
        "room_name": str(client._settings.webrtc.room),
    }


def install_reconnect_challenge(
    client: RTCClient,
    peer: str,
    pc: Any,
    *,
    challenge: str = "56" * 32,
    issued_at_ms: int | None = None,
) -> _ReconnectChallengeRecord:
    client._pcs[peer] = pc
    if not isinstance(getattr(pc, "close", None), AsyncMock):
        pc.close = AsyncMock()
    transport = client._pairing_transports[peer]
    issued_ms = client._provider_lease_clock_ms() if issued_at_ms is None else issued_at_ms
    record = _ReconnectChallengeRecord(
        pc=pc,
        challenge=challenge,
        channel_binding=client._channel_binding_for_peer(peer, pc),
        claimant_peer_id=str(transport["remote_stable_peer_id"]),
        verifier_peer_id=client._local_mesh_peer_id(),
        claimant_signaling_peer_id=peer,
        verifier_signaling_peer_id=client._peer_id,
        room_name=str(client._settings.webrtc.room),
        issued_at_ms=issued_ms,
        expires_at_ms=issued_ms + 20_000,
    )
    client._peer_auth_challenges[peer] = record
    return record


def reconnect_proof_for(
    record: _ReconnectChallengeRecord,
    *,
    token_id: str = "token-id-123",
    proof: str = "ef" * 32,
) -> dict[str, str]:
    return {
        "type": "mesh_auth_proof_v1",
        "token_id": token_id,
        "challenge": record.challenge,
        "proof": proof,
        "channel_binding": record.channel_binding,
        "claimant_peer_id": record.claimant_peer_id,
        "verifier_peer_id": record.verifier_peer_id,
        "claimant_signaling_peer_id": record.claimant_signaling_peer_id,
        "verifier_signaling_peer_id": record.verifier_signaling_peer_id,
        "room_name": record.room_name,
    }


async def cancel_auth_timeouts(client: RTCClient) -> None:
    tasks = list(client._peer_timeout_tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@pytest.fixture
def mock_deps():
    settings = MagicMock()
    settings.webrtc.password = "test-password"
    settings.webrtc.app_id = "test-app"
    settings.webrtc.room = "test-room"
    settings.webrtc.stun_servers = ["stun:stun.l.google.com:19302"]
    settings.webrtc.turn_servers = []
    settings.webrtc.enable_app_layer_e2ee = False
    settings.webrtc.encrypt_signaling = False

    bus = MagicMock()
    registry = MagicMock()
    auth_service = AsyncMock()
    auth_service.get_system_token.return_value = "system-token"

    return settings, bus, registry, auth_service


@pytest.mark.asyncio
async def test_on_open_never_sends_saved_bearer_for_spoofed_stable_identity(mock_deps):
    """Unauthenticated signaling metadata never releases a saved bearer."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-signaling-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._saved_auth_tokens["trusted-stable-peer"] = {
        "token": "saved-bearer-must-not-cross-the-channel",
        "token_id": "public-token-selector",
    }

    mock_pc = MagicMock()
    mock_pc.close = AsyncMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("attacker-session", is_offer_initiator=True)
        # A room member can claim a trusted stable ID in presence/offer metadata.
        # That claim must only shape the challenge, never select a bearer to send.
        install_pairing_transport(
            client,
            "attacker-session",
            mock_pc,
            remote_stable_peer_id="trusted-stable-peer",
            remote_node_name="Spoofed Aurora",
        )
        mock_channel.emit("open")
        await asyncio.sleep(0)

        assert len(mock_channel.sent_messages) == 1
        msg = json.loads(mock_channel.sent_messages[0])
        assert msg["type"] == "mesh_auth_challenge_v1"
        assert msg["claimant_peer_id"] == "trusted-stable-peer"
        assert "token" not in msg
        assert "saved-bearer-must-not-cross-the-channel" not in mock_channel.sent_messages[0]

    await cancel_auth_timeouts(client)


@pytest.mark.asyncio
async def test_matching_channel_bound_challenge_sends_hmac_proof_not_token(mock_deps):
    """A returning peer proves possession using token_id plus an SDP-bound HMAC."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._saved_auth_tokens["stable-remote-peer"] = {
        "token": "saved-peer-bearer",
        "token_id": "token-id-123",
    }
    peer = "remote-session"
    pc = MagicMock()
    channel = MockDataChannel()
    channel_binding = install_pairing_transport(client, peer, pc)
    challenge = "ab" * 32

    client._handle_reconnect_challenge(
        peer,
        pc,
        channel,
        {
            "type": "mesh_auth_challenge_v1",
            "challenge": challenge,
            "channel_binding": channel_binding,
            "claimant_peer_id": "stable-local-peer",
            "verifier_peer_id": "stable-remote-peer",
            "claimant_signaling_peer_id": "local-session",
            "verifier_signaling_peer_id": peer,
            "room_name": "test-room",
        },
    )

    assert len(channel.sent_messages) == 1
    proof = json.loads(channel.sent_messages[0])
    assert proof["type"] == "mesh_auth_proof_v1"
    assert proof["token_id"] == "token-id-123"
    assert "token" not in proof
    proof_message = build_mesh_reconnect_proof_message(
        token_id="token-id-123",
        challenge=challenge,
        channel_binding=channel_binding,
        claimant_peer_id="stable-local-peer",
        verifier_peer_id="stable-remote-peer",
        room_name="test-room",
    )
    expected = hmac.new(
        hashlib.sha256(b"saved-peer-bearer").digest(),
        proof_message,
        hashlib.sha256,
    ).hexdigest()
    assert hmac.compare_digest(proof["proof"], expected)


def test_reconnect_challenge_records_ttl_and_preserves_wire_shape(mock_deps):
    """Verifier keeps expiry locally while sending the stable v1 challenge frame."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._provider_lease_clock_ms = lambda: 44_000
    peer = "remote-session"
    pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, pc)

    with patch("app.services.gateway.webrtc.rtc_client.secrets.token_hex", return_value="9a" * 32):
        client._send_reconnect_challenge(peer, pc, channel)

    sent = json.loads(channel.sent_messages[0])
    assert sent == {
        "type": "mesh_auth_challenge_v1",
        "challenge": "9a" * 32,
        "channel_binding": client._channel_binding_for_peer(peer, pc),
        "claimant_peer_id": "stable-remote-peer",
        "verifier_peer_id": "stable-local-peer",
        "claimant_signaling_peer_id": peer,
        "verifier_signaling_peer_id": "local-session",
        "room_name": "test-room",
    }
    assert "token_id" not in sent
    assert "issued_at_ms" not in sent
    assert "expires_at_ms" not in sent
    record = client._peer_auth_challenges[peer]
    assert record.issued_at_ms == 44_000
    assert record.expires_at_ms == 64_000


@pytest.mark.asyncio
async def test_reconnect_proof_replay_rejects_before_auth(mock_deps):
    """A consumed challenge cannot invoke Auth again before its original expiry."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._provider_lease_clock_ms = lambda: 1_000
    client._run_bilateral_pairing = AsyncMock()
    peer = "remote-session"
    pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, pc)
    record = install_reconnect_challenge(client, peer, pc, challenge="aa" * 32)
    auth_service.verify_mesh_reconnect_proof.return_value = None

    await client._handle_reconnect_proof(peer, pc, channel, reconnect_proof_for(record))
    await asyncio.sleep(0)
    client._clear_pairing_state(peer, pc)
    assert client._used_peer_auth_challenges[record.challenge] == record.expires_at_ms
    with pytest.raises(PairingProtocolError, match="replayed"):
        await client._handle_reconnect_proof(peer, pc, channel, reconnect_proof_for(record))

    auth_service.verify_mesh_reconnect_proof.assert_awaited_once()
    client._run_bilateral_pairing.assert_awaited_once_with(peer, channel, pc)
    assert client._used_peer_auth_challenges[record.challenge] == record.expires_at_ms
    await client.close()
    assert not client._peer_auth_challenges
    assert not client._used_peer_auth_challenges


@pytest.mark.asyncio
async def test_reconnect_proof_expiry_rejects_before_auth(mock_deps):
    """Expired challenges are dropped locally instead of reaching Auth."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._provider_lease_clock_ms = lambda: 21_000
    peer = "remote-session"
    pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, pc)
    record = install_reconnect_challenge(
        client,
        peer,
        pc,
        challenge="bb" * 32,
        issued_at_ms=1_000,
    )

    with pytest.raises(PairingProtocolError, match="expired"):
        await client._handle_reconnect_proof(peer, pc, channel, reconnect_proof_for(record))

    auth_service.verify_mesh_reconnect_proof.assert_not_awaited()
    assert peer not in client._peer_auth_challenges


@pytest.mark.asyncio
async def test_reconnect_proof_wrong_pc_does_not_consume_challenge(mock_deps):
    """A stale connection cannot burn the active PC's challenge."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._run_bilateral_pairing = AsyncMock()
    peer = "remote-session"
    pc = MagicMock()
    wrong_pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, pc)
    record = install_reconnect_challenge(client, peer, pc, challenge="cc" * 32)

    install_pairing_transport(client, peer, wrong_pc)
    with pytest.raises(PairingProtocolError, match="active challenge"):
        await client._handle_reconnect_proof(peer, wrong_pc, channel, reconnect_proof_for(record))

    auth_service.verify_mesh_reconnect_proof.assert_not_awaited()
    assert client._peer_auth_challenges[peer] is record
    assert record.challenge not in client._used_peer_auth_challenges

    install_pairing_transport(client, peer, pc)
    auth_service.verify_mesh_reconnect_proof.return_value = None
    await client._handle_reconnect_proof(peer, pc, channel, reconnect_proof_for(record))
    await asyncio.sleep(0)
    auth_service.verify_mesh_reconnect_proof.assert_awaited_once()
    client._run_bilateral_pairing.assert_awaited_once_with(peer, channel, pc)


@pytest.mark.parametrize(
    ("field", "wrong_value"),
    [
        ("claimant_peer_id", "wrong-stable-peer"),
        ("verifier_peer_id", "wrong-local-peer"),
        ("claimant_signaling_peer_id", "wrong-remote-session"),
        ("verifier_signaling_peer_id", "wrong-local-session"),
        ("room_name", "wrong-room"),
        ("channel_binding", "ff" * 32),
    ],
)
@pytest.mark.asyncio
async def test_reconnect_proof_wrong_current_transport_context_is_rejected_without_consuming(
    mock_deps,
    field,
    wrong_value,
):
    """The active proof stays bound to every field of its current challenge."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    peer = "remote-session"
    pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, pc)
    record = install_reconnect_challenge(client, peer, pc, challenge="ce" * 32)
    message = reconnect_proof_for(record)
    message[field] = wrong_value

    with pytest.raises(PairingProtocolError, match="active challenge"):
        await client._handle_reconnect_proof(peer, pc, channel, message)

    auth_service.verify_mesh_reconnect_proof.assert_not_awaited()
    assert client._peer_auth_challenges[peer] is record
    assert record.challenge not in client._used_peer_auth_challenges


@pytest.mark.asyncio
async def test_valid_reconnect_proof_authenticates_and_promotes_stable_identity(mock_deps):
    """A verified proof promotes only the identity bound into the transport."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._audit = AsyncMock()
    peer = "remote-session"
    pc = MagicMock()
    channel = MockDataChannel()
    channel_binding = install_pairing_transport(
        client,
        peer,
        pc,
        remote_stable_peer_id="stable-remote-peer",
        remote_node_name="Remote Aurora",
    )
    challenge = "cd" * 32
    record = install_reconnect_challenge(client, peer, pc, challenge=challenge)
    token = Token(
        id="token-id-123",
        token_hash="hash",
        prefix="prefix",
        device_id="remote-device",
        user_id="remote-user",
        scopes=["read"],
    )
    identity = Identity(
        principal_id="remote-user",
        principal_name="Remote Aurora",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        device_id="remote-device",
        source="webrtc_peer",
    )
    auth_service.verify_mesh_reconnect_proof.return_value = token
    auth_service.build_identity_from_token.return_value = identity

    await client._handle_reconnect_proof(
        peer,
        pc,
        channel,
        reconnect_proof_for(record),
    )

    auth_service.verify_mesh_reconnect_proof.assert_awaited_once_with(
        token_id="token-id-123",
        challenge=challenge,
        proof="ef" * 32,
        channel_binding=channel_binding,
        claimant_peer_id="stable-remote-peer",
        verifier_peer_id="stable-local-peer",
        room_name="test-room",
    )
    assert client._peer_acl[peer] == identity
    assert client._peer_acl["stable-remote-peer"] == identity
    assert client._peer_stable_ids[peer] == "stable-remote-peer"
    assert client._stable_peer_sessions["stable-remote-peer"] == peer


@pytest.mark.asyncio
async def test_reconnect_proof_replaces_preserved_departed_session(mock_deps):
    """A proven successor retires the open channel preserved across MQTT departure."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._audit = AsyncMock()
    stable_peer = "stable-remote-peer"
    old_peer = "old-remote-session"
    new_peer = "new-remote-session"
    old_pc = MagicMock()
    old_pc.close = AsyncMock()
    old_channel = MockDataChannel()
    old_identity = Identity(
        principal_id="remote-user",
        principal_name="Remote Aurora",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        device_id="remote-device",
        source="webrtc_peer",
    )
    saved_credential = {
        "token": "saved-secret",
        "token_id": "saved-token-id",
    }
    client._pcs[old_peer] = old_pc
    client._peer_data_channels[old_peer] = old_channel
    client._peer_send_fns[old_peer] = MagicMock()
    client._peer_acl[old_peer] = old_identity
    client._peer_acl[stable_peer] = old_identity
    client._peer_stable_ids[old_peer] = stable_peer
    client._stable_peer_sessions[stable_peer] = old_peer
    client._saved_auth_tokens[stable_peer] = saved_credential

    await client._handle_signaling_departure(old_peer, reason="presence_departed")

    assert client._pcs[old_peer] is old_pc
    old_pc.close.assert_not_awaited()

    new_pc = MagicMock()
    new_channel = MockDataChannel()
    install_pairing_transport(
        client,
        new_peer,
        new_pc,
        remote_stable_peer_id=stable_peer,
        remote_node_name="Remote Aurora",
    )
    record = install_reconnect_challenge(client, new_peer, new_pc, challenge="ab" * 32)
    token = Token(
        id="token-id-123",
        token_hash="hash",
        prefix="prefix",
        device_id="remote-device",
        user_id="remote-user",
        scopes=["read"],
    )
    auth_service.verify_mesh_reconnect_proof.return_value = token
    auth_service.build_identity_from_token.return_value = old_identity

    await client._handle_reconnect_proof(
        new_peer,
        new_pc,
        new_channel,
        reconnect_proof_for(record),
    )

    old_pc.close.assert_awaited_once()
    assert old_peer not in client._pcs
    assert old_peer not in client._peer_data_channels
    assert old_peer not in client._peer_send_fns
    assert old_peer not in client._peer_stable_ids
    assert client._stable_peer_sessions[stable_peer] == new_peer
    assert client._peer_acl[new_peer] == old_identity
    assert client._peer_acl[stable_peer] == old_identity
    assert client._saved_auth_tokens[stable_peer] is saved_credential


@pytest.mark.asyncio
async def test_invalid_reconnect_proof_starts_bilateral_pairing(mock_deps):
    """A stale/revoked proof repairs trust through a fresh shared-SAS flow."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._run_bilateral_pairing = AsyncMock()
    peer = "remote-session"
    mock_pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, mock_pc)
    challenge = "12" * 32
    record = install_reconnect_challenge(client, peer, mock_pc, challenge=challenge)
    auth_service.verify_mesh_reconnect_proof.return_value = None

    await client._handle_reconnect_proof(
        peer,
        mock_pc,
        channel,
        reconnect_proof_for(record, token_id="stale-token-id", proof="34" * 32),
    )
    await asyncio.sleep(0)

    assert client._peer_acl.get(peer, ANONYMOUS) == ANONYMOUS
    client._run_bilateral_pairing.assert_awaited_once_with(peer, channel, mock_pc)


@pytest.mark.asyncio
async def test_reconnect_proof_outage_marks_exact_connection_for_retry(mock_deps):
    """A transient Auth outage must reconnect later without replacing trust."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    peer = "remote-session"
    pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, pc)
    challenge = "78" * 32
    record = install_reconnect_challenge(client, peer, pc, challenge=challenge)
    auth_service.verify_mesh_reconnect_proof.side_effect = RuntimeError("Auth unavailable")

    await client._handle_reconnect_proof(
        peer,
        pc,
        channel,
        reconnect_proof_for(record, proof="90" * 32),
    )

    assert pc in client._negotiation_retry_pcs
    assert peer not in client._pairing_tasks
    assert client._peer_acl.get(peer, ANONYMOUS) == ANONYMOUS


@pytest.mark.asyncio
async def test_inbound_auth_keeps_timeout_until_outbound_pairing_finishes(mock_deps):
    """One authenticated direction cannot unbound the other pending approval."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._audit = AsyncMock()
    peer = "remote-session"
    token = Token(
        id="token-id",
        token_hash="hash",
        prefix="prefix",
        device_id="remote-device",
        user_id="remote-user",
        scopes=["read"],
    )
    identity = Identity(
        principal_id="remote-user",
        principal_name="Remote Aurora",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        device_id="remote-device",
        source="webrtc_peer",
    )
    auth_service.build_identity_from_token.return_value = identity
    timeout_task = asyncio.create_task(asyncio.sleep(60))
    client._peer_timeout_tasks[peer] = timeout_task
    client._mark_pairing_direction(peer, "inbound")
    client._mark_pairing_direction(peer, "outbound")

    await client._authenticate_peer(
        peer=peer,
        token=token,
        stable_peer_id="stable-remote-peer",
        peer_name="Remote Aurora",
        clear_pairing_inbound=True,
    )

    assert client._peer_pairing_directions[peer] == {"outbound"}
    assert client._peer_timeout_tasks[peer] is timeout_task
    assert not timeout_task.done()

    client._clear_pairing_direction(peer, "outbound")
    await asyncio.sleep(0)

    assert peer not in client._peer_pairing_directions
    assert peer not in client._peer_timeout_tasks
    assert timeout_task.cancelled()


@pytest.mark.asyncio
async def test_authentication_requests_remote_manifest_after_local_registration(mock_deps):
    """The second bilateral approval immediately recovers the first dropped manifest."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._audit = AsyncMock()
    client._mesh_enabled = True
    client._peer_registry = MagicMock()
    client._peer_registry.register_peer = AsyncMock()
    client._peer_registry.update_manifest = AsyncMock()
    client._send_manifest = AsyncMock()
    client.send_to_peer = MagicMock(return_value=True)
    token = Token(
        id="token-id",
        token_hash="hash",
        prefix="prefix",
        device_id="remote-device",
        user_id="remote-user",
        scopes=["read"],
    )
    auth_service.build_identity_from_token.return_value = Identity(
        principal_id="remote-user",
        principal_name="Remote Aurora",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        device_id="remote-device",
        source="webrtc_peer",
    )

    await client._authenticate_peer(
        peer="remote-session",
        token=token,
        stable_peer_id="stable-remote-peer",
        peer_name="Remote Aurora",
        clear_pairing_inbound=True,
    )

    client._peer_registry.register_peer.assert_awaited_once_with(
        "stable-remote-peer",
        "Remote Aurora",
    )
    client._send_manifest.assert_awaited_once_with("stable-remote-peer")
    client.send_to_peer.assert_called_once()
    target, payload = client.send_to_peer.call_args.args
    assert target == "stable-remote-peer"
    assert json.loads(payload) == {"type": "manifest_request"}


@pytest.mark.asyncio
async def test_early_protocol_hello_is_replayed_only_after_exact_peer_authentication(
    mock_deps,
):
    """Async token validation must not lose or prematurely trust a native peer hello."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._audit = AsyncMock()
    client._mesh_enabled = True
    client._peer_registry = MagicMock()
    client._peer_registry.register_peer = AsyncMock()
    client._send_manifest = AsyncMock(return_value=True)
    client._request_manifest = MagicMock()
    pairing = pairing_sas_result()
    client._pairing_results["peer1"] = pairing
    client._mark_pairing_direction("peer1", "inbound")

    validation_started = asyncio.Event()
    release_validation = asyncio.Event()
    token = Token(
        id="token-id",
        token_hash="hash",
        prefix="prefix",
        device_id="remote-device",
        user_id="remote-user",
        scopes=["read"],
    )

    async def validate_after_hello(**_kwargs: Any) -> Token:
        validation_started.set()
        await release_validation.wait()
        return token

    auth_service.validate_mesh_pairing_token.side_effect = validate_after_hello
    auth_service.build_identity_from_token.return_value = Identity(
        principal_id="remote-user",
        principal_name=pairing.remote_node_name,
        is_admin=False,
        effective_perms=frozenset({"read"}),
        device_id="remote-device",
        source="webrtc_peer",
    )

    pc = MagicMock()
    channel = MockDataChannel()
    pc.createDataChannel.return_value = channel
    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", pc)
        channel.emit(
            "message",
            json.dumps(
                {
                    "type": "auth",
                    "peer_name": pairing.remote_node_name,
                    "peer_id": pairing.remote_stable_peer_id,
                    "signaling_peer_id": "peer1",
                    "pairing_session_id": pairing.pairing_session_id,
                    "token": "fresh-token",
                }
            ),
        )
        await asyncio.wait_for(validation_started.wait(), timeout=1.0)

        hello = build_protocol_hello(
            role="hybrid",
            capabilities=(CAP_FRAGMENTATION_V1,),
        )
        hello_task = channel.emit("message", json.dumps(hello))
        if hello_task is not None:
            await hello_task

        assert "peer1" in client._pending_peer_protocol_hellos
        assert "peer1" not in client._peer_protocols
        assert client._peer_acl["peer1"] == ANONYMOUS
        assert not any(
            error.code == "preauth_message_dropped" for error in client._diagnostic_errors
        )

        release_validation.set()
        async with asyncio.timeout(1.0):
            while pairing.remote_stable_peer_id not in client._peer_protocols:
                await asyncio.sleep(0.001)

    assert "peer1" not in client._pending_peer_protocol_hellos
    assert client.peer_supports_capability("peer1", CAP_FRAGMENTATION_V1)
    assert client.peer_supports_capability(
        pairing.remote_stable_peer_id,
        CAP_FRAGMENTATION_V1,
    )
    client._send_manifest.assert_awaited_once_with(pairing.remote_stable_peer_id)
    client._request_manifest.assert_called_once_with(
        pairing.remote_stable_peer_id,
        reason="authentication",
    )


def test_pending_protocol_hello_cleanup_is_scoped_to_exact_connection(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "peer1"
    active_pc = MagicMock()
    replacement_pc = MagicMock()
    hello = build_protocol_hello(capabilities=(CAP_FRAGMENTATION_V1,))

    assert client._buffer_pre_auth_protocol_hello(peer, active_pc, hello)
    client._clear_pairing_state(peer, replacement_pc)
    assert peer in client._pending_peer_protocol_hellos

    client._clear_pairing_state(peer, active_pc)
    assert peer not in client._pending_peer_protocol_hellos


@pytest.mark.asyncio
async def test_returning_peer_joins_remote_bilateral_pairing_commit(mock_deps):
    """One trusted direction cannot leave the other endpoint with the only request."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._saved_auth_tokens["stable-peer-a"] = "token-for-peer-a"
    client._run_bilateral_pairing = AsyncMock()

    peer = "session-peer-a"
    pc = MagicMock()
    channel = MockDataChannel()
    handshake = MagicMock(reveal_sent=True)
    client._send_pairing_commit = MagicMock(return_value=handshake)
    client._peer_acl[peer] = Identity(
        principal_id="already-trusted-peer",
        principal_name="already-trusted-peer",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        source="webrtc_peer",
    )

    handled = client._handle_pairing_control_message(
        peer,
        pc,
        channel,
        {"type": PAIRING_COMMIT_TYPE},
    )
    await asyncio.sleep(0)

    assert handled is True
    handshake.accept_commit.assert_called_once()
    client._run_bilateral_pairing.assert_awaited_once_with(peer, channel, pc)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "suppressed", "retryable"),
    [("denied", True, False), ("expired", False, True)],
)
async def test_pairing_terminal_controls_reconnect_policy(
    mock_deps,
    status,
    suppressed,
    retryable,
):
    """Explicit denial is terminal; expiry requests deterministic recovery."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "remote-session"
    pairing = pairing_sas_result()
    client._pairing_results[peer] = pairing
    pc = MagicMock()
    pc.close = AsyncMock()

    handled = client._handle_pairing_control_message(
        peer,
        pc,
        MockDataChannel(),
        {
            "type": PAIRING_TERMINAL_TYPE,
            "status": status,
            "pairing_session_id": pairing.pairing_session_id,
            "verification_code": pairing.verification_code,
            "peer_id": pairing.remote_stable_peer_id,
            "signaling_peer_id": peer,
        },
    )
    await asyncio.sleep(0)

    assert handled is True
    assert (pc in client._reconnect_suppressed_pcs) is suppressed
    assert (pc in client._negotiation_retry_pcs) is retryable
    pc.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_durable_remote_denial_stops_pairing_start_retry(mock_deps):
    """A denied PairingStart response is terminal, not a generic retry error."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "remote-session"
    pairing = pairing_sas_result()
    client._pairing_results[peer] = pairing
    client._pcs[peer] = MagicMock()
    client._mark_pairing_direction(peer, "outbound")
    client._rpc_call = AsyncMock(return_value={"error": "Pairing denied", "status": "denied"})
    channel = MockDataChannel()

    with pytest.raises(_PairingDeniedError):
        await client._initiate_pairing(peer, channel)

    client._rpc_call.assert_awaited_once()
    terminal = json.loads(channel.sent_messages[-1])
    assert terminal["type"] == PAIRING_TERMINAL_TYPE
    assert terminal["status"] == "denied"


@pytest.mark.asyncio
async def test_existing_remote_credential_skips_duplicate_direction_exchange(mock_deps):
    """A peer that just proved an existing credential must not be paired again."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "remote-session"
    pairing = pairing_sas_result()
    client._pairing_results[peer] = pairing
    client._pcs[peer] = MagicMock()
    client._mark_pairing_direction(peer, "outbound")
    client._rpc_call = AsyncMock(
        return_value={
            "code": "existing-credential",
            "status": "already_trusted",
            "pairing_session_id": pairing.pairing_session_id,
            "verification_code": pairing.verification_code,
        }
    )
    channel = MockDataChannel()

    await client._initiate_pairing(peer, channel)

    client._rpc_call.assert_awaited_once()
    rpc_peer, rpc_method, rpc_payload = client._rpc_call.await_args.args
    assert rpc_peer == peer
    assert rpc_method == AuthMethods.PAIRING_START
    assert rpc_payload["pairing_session_id"] == pairing.pairing_session_id
    assert rpc_payload["verification_code"] == pairing.verification_code
    assert channel.sent_messages == []


@pytest.mark.asyncio
async def test_existing_remote_credential_discovered_while_polling_skips_exchange(mock_deps):
    """A reconnect proof completed during approval polling must end pairing cleanly."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "remote-session"
    pairing = pairing_sas_result()
    client._pairing_results[peer] = pairing
    client._pcs[peer] = MagicMock()
    client._mark_pairing_direction(peer, "outbound")
    client._rpc_call = AsyncMock(
        side_effect=[
            {
                "code": "pending-pairing-handle",
                "status": "pending",
                "pairing_session_id": pairing.pairing_session_id,
                "verification_code": pairing.verification_code,
            },
            {
                "code": "existing-credential",
                "status": "already_trusted",
                "pairing_session_id": pairing.pairing_session_id,
                "verification_code": pairing.verification_code,
            },
        ]
    )
    channel = MockDataChannel()

    with patch(
        "app.services.gateway.webrtc.rtc_client.asyncio.sleep",
        new=AsyncMock(),
    ):
        await client._initiate_pairing(peer, channel)

    assert [call.args[1] for call in client._rpc_call.await_args_list] == [
        AuthMethods.PAIRING_START,
        AuthMethods.PAIRING_CONNECT,
    ]
    assert channel.sent_messages == []


@pytest.mark.asyncio
async def test_local_denier_suppresses_offer_owner_retry_without_terminal_frame(mock_deps):
    """Server-side durable denial is terminal even when the peer terminal is lost."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-requesting-peer"
    client._peer_id = "a-local-offer-owner"
    client._adapter = MagicMock()
    client._audit = AsyncMock()
    client.connect_to = AsyncMock()
    client._mark_pairing_direction(peer, "outbound")

    pc = MockPeerConnectionWithEvents()
    pc.connectionState = "connected"
    channel = MockDataChannel()
    pc.createDataChannel.return_value = channel

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        handler = client._rpc_handlers[peer]

        # The Auth.PairingStart result said denied. Simulate loss of the
        # requester's best-effort terminal frame and only a transport close.
        handler._pairing_denied_fn(peer)
        pc.connectionState = "closed"
        await pc._handlers["connectionstatechange"]()
        await asyncio.sleep(0)

    client.connect_to.assert_not_awaited()
    assert peer not in client._pcs


@pytest.mark.asyncio
async def test_bilateral_pairing_starts_for_new_peer_despite_other_saved_tokens(mock_deps):
    """Credentials for peer A must not suppress bilateral pairing with peer B."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._remember_stable_peer_id("session-peer-a", "stable-peer-a")
    client._remember_stable_peer_id("session-peer-b", "stable-peer-b")
    client._saved_auth_tokens["stable-peer-a"] = "token-for-peer-a"
    client._saved_auth_tokens["_default"] = "legacy-default-token"
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MockPeerConnectionWithEvents()
    channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = channel

    try:
        with patch(
            "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
            return_value=mock_pc,
        ):
            await client._ensure_pc("session-peer-b", is_offer_initiator=True)
            install_pairing_transport(
                client,
                "session-peer-b",
                mock_pc,
                remote_stable_peer_id="stable-peer-b",
            )
            channel.emit("open")
            client._handle_reconnect_challenge(
                "session-peer-b",
                mock_pc,
                channel,
                reconnect_challenge_for(client, "session-peer-b", mock_pc),
            )
            await asyncio.sleep(0)

        client._run_bilateral_pairing.assert_awaited_once_with("session-peer-b", channel, mock_pc)
        assert all("token-for-peer-a" not in message for message in channel.sent_messages)
    finally:
        tasks = list(client._peer_timeout_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_pairing_request_advertises_configured_local_node_name(mock_deps):
    """Incoming approval rows should identify the requesting Aurora node."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client.set_mesh_identity("stable-local-peer", "Aurora Studio")
    pairing_context = pairing_sas_result()
    client._pairing_results = {"session-peer": pairing_context}
    client._pcs["session-peer"] = MagicMock()
    client._mark_pairing_direction("session-peer", "outbound")

    async def return_pairing_start(*_args: Any) -> dict[str, str]:
        client._pcs.pop("session-peer", None)
        client._clear_pairing_direction("session-peer", "outbound")
        return {
            "code": "opaque-request-handle",
            "pairing_session_id": pairing_context.pairing_session_id,
            "verification_code": pairing_context.verification_code,
        }

    client._rpc_call = AsyncMock(side_effect=return_pairing_start)

    await client._initiate_pairing("session-peer", MockDataChannel())

    client._rpc_call.assert_awaited_once()
    rpc_peer, rpc_method, rpc_payload = client._rpc_call.await_args.args
    assert rpc_peer == "session-peer"
    assert rpc_method == "Auth.PairingStart"
    assert (
        rpc_payload.items()
        >= {
            "device_name": "Aurora Studio",
            "remote_peer_id": "stable-local-peer",
            "remote_node_name": "Aurora Studio",
        }.items()
    )


@pytest.mark.asyncio
async def test_bilateral_pairing_start_uses_precomputed_sas_context(mock_deps):
    """PairingStart transports the SAS already authenticated by commit/reveal."""
    settings, bus, registry, auth_service = mock_deps
    client_a = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client_b = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client_a.set_mesh_identity("stable-peer-a", "Aurora 1")
    client_b.set_mesh_identity("stable-peer-b", "Aurora 2")
    client_a._remember_stable_peer_id("session-b", "stable-peer-b", "Aurora 2")
    client_b._remember_stable_peer_id("session-a", "stable-peer-a", "Aurora 1")
    pairing_session_id = "d" * 64
    verification_code = "73519024"
    client_a._pairing_results = {
        "session-b": pairing_sas_result(
            remote_peer_id="stable-peer-b",
            remote_node_name="Aurora 2",
            pairing_session_id=pairing_session_id,
            verification_code=verification_code,
        )
    }
    client_b._pairing_results = {
        "session-a": pairing_sas_result(
            remote_peer_id="stable-peer-a",
            remote_node_name="Aurora 1",
            pairing_session_id=pairing_session_id,
            verification_code=verification_code,
        )
    }
    client_a._pcs["session-b"] = MagicMock()
    client_b._pcs["session-a"] = MagicMock()
    client_a._mark_pairing_direction("session-b", "outbound")
    client_b._mark_pairing_direction("session-a", "outbound")

    async def return_start_a(*_args: Any) -> dict[str, str]:
        client_a._pcs.pop("session-b", None)
        client_a._clear_pairing_direction("session-b", "outbound")
        return {
            "code": "opaque-request-handle-a",
            "pairing_session_id": pairing_session_id,
            "verification_code": verification_code,
        }

    async def return_start_b(*_args: Any) -> dict[str, str]:
        client_b._pcs.pop("session-a", None)
        client_b._clear_pairing_direction("session-a", "outbound")
        return {
            "code": "opaque-request-handle-b",
            "pairing_session_id": pairing_session_id,
            "verification_code": verification_code,
        }

    client_a._rpc_call = AsyncMock(side_effect=return_start_a)
    client_b._rpc_call = AsyncMock(side_effect=return_start_b)

    await asyncio.gather(
        client_a._initiate_pairing("session-b", MockDataChannel()),
        client_b._initiate_pairing("session-a", MockDataChannel()),
    )

    payload_a = client_a._rpc_call.await_args.args[2]
    payload_b = client_b._rpc_call.await_args.args[2]
    assert payload_a["pairing_session_id"] == pairing_session_id
    assert payload_b["pairing_session_id"] == pairing_session_id
    assert payload_a["verification_code"] == verification_code
    assert payload_b["verification_code"] == verification_code


@pytest.mark.asyncio
async def test_pairing_does_not_authenticate_when_credential_persistence_fails(mock_deps):
    """A new credential is usable only after the durable save succeeds."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client.set_mesh_identity("stable-local-peer", "Aurora 1")
    pairing = pairing_sas_result()
    client._pairing_results["session-peer"] = pairing
    client._pcs["session-peer"] = MagicMock()
    client._mark_pairing_direction("session-peer", "outbound")
    client._rpc_call = AsyncMock(
        side_effect=[
            {
                "code": "opaque-request-handle",
                "pairing_session_id": pairing.pairing_session_id,
                "verification_code": pairing.verification_code,
            },
            {
                "status": "approved",
                "pairing_session_id": pairing.pairing_session_id,
                "verification_code": pairing.verification_code,
            },
            {
                "token": "new-directional-token",
                "token_id": "new-directional-token-id",
                "peer_id": pairing.remote_stable_peer_id,
                "node_name": pairing.remote_node_name,
                "permissions": ["TTS.use"],
            },
        ]
    )
    client.set_on_token_saved(AsyncMock(side_effect=RuntimeError("database unavailable")))
    channel = MockDataChannel()

    with (
        patch("app.services.gateway.webrtc.rtc_client.asyncio.sleep", new=AsyncMock()),
        pytest.raises(RuntimeError, match="could not be saved durably"),
    ):
        await client._initiate_pairing("session-peer", channel)

    assert pairing.remote_stable_peer_id not in client._saved_auth_tokens
    messages = [json.loads(message) for message in channel.sent_messages]
    assert any(
        message.get("type") == PAIRING_TERMINAL_TYPE and message.get("status") == "failed"
        for message in messages
    )
    assert all(message.get("type") != "auth" for message in messages)
    assert client._diagnostic_errors[0].code == "pairing_credential_persistence_failed"


async def test_rtc_client_unknown_peer_does_not_receive_unrelated_saved_token(mock_deps):
    """Unknown sessions fail safe when multiple peer-scoped tokens are loaded."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._saved_auth_tokens = {
        "stable-remote-peer-a": "token-for-remote-a",
        "stable-remote-peer-b": "token-for-remote-b",
    }
    client._pairing_results["unknown-session-peer"] = pairing_sas_result()
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("unknown-session-peer", is_offer_initiator=True)
        install_pairing_transport(client, "unknown-session-peer", mock_pc)
        mock_channel.emit("open")
        client._handle_reconnect_challenge(
            "unknown-session-peer",
            mock_pc,
            mock_channel,
            reconnect_challenge_for(client, "unknown-session-peer", mock_pc),
        )
        await asyncio.sleep(0)

        assert all("token-for-remote" not in message for message in mock_channel.sent_messages)
        client._run_bilateral_pairing.assert_awaited_once_with(
            "unknown-session-peer", mock_channel, mock_pc
        )


@pytest.mark.asyncio
async def test_rtc_client_legacy_default_token_repairs_without_sending_bearer(mock_deps):
    """A legacy row without token_id migrates through pairing, never raw auth."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._saved_auth_tokens = {"_default": "legacy-room-token"}
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("unknown-session-peer", is_offer_initiator=True)
        install_pairing_transport(client, "unknown-session-peer", mock_pc)
        mock_channel.emit("open")
        client._handle_reconnect_challenge(
            "unknown-session-peer",
            mock_pc,
            mock_channel,
            reconnect_challenge_for(client, "unknown-session-peer", mock_pc),
        )
        await asyncio.sleep(0)

        assert all("legacy-room-token" not in message for message in mock_channel.sent_messages)
        client._run_bilateral_pairing.assert_awaited_once_with(
            "unknown-session-peer", mock_channel, mock_pc
        )


@pytest.mark.asyncio
async def test_rtc_client_default_token_not_used_when_peer_tokens_exist(mock_deps):
    """A legacy default plus peer tokens is ambiguous without an exact peer hit."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._saved_auth_tokens = {
        "_default": "legacy-room-token",
        "stable-remote-peer-a": "token-for-remote-a",
    }
    client._pairing_results["unknown-session-peer"] = pairing_sas_result()
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("unknown-session-peer", is_offer_initiator=True)
        install_pairing_transport(client, "unknown-session-peer", mock_pc)
        mock_channel.emit("open")
        client._handle_reconnect_challenge(
            "unknown-session-peer",
            mock_pc,
            mock_channel,
            reconnect_challenge_for(client, "unknown-session-peer", mock_pc),
        )
        await asyncio.sleep(0)

        assert all("legacy-room-token" not in message for message in mock_channel.sent_messages)
        assert all("token-for-remote-a" not in message for message in mock_channel.sent_messages)
        client._run_bilateral_pairing.assert_awaited_once_with(
            "unknown-session-peer", mock_channel, mock_pc
        )


@pytest.mark.asyncio
async def test_rtc_client_manifest_requires_authenticated_projection(mock_deps):
    """Manifest exchange fails closed until recipient projection evidence is available."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client.set_mesh_identity("stable-local-peer", "local-node")
    client._mesh_config = MagicMock(node_name="local-node", services={})

    sent_messages: list[dict[str, Any]] = []
    client._peer_send_fns["session-peer"] = lambda text: sent_messages.append(json.loads(text))
    client._stable_peer_sessions["stable-remote-peer"] = "session-peer"

    sent = await client._send_manifest("stable-remote-peer")

    assert sent is False
    assert sent_messages == []


@pytest.mark.asyncio
async def test_rtc_client_incoming_manifest_registers_stable_remote_peer(mock_deps):
    """Remote manifest peer_id becomes the registry/policy key."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_config = MagicMock(services={}, version_policy="compatible")
    client._peer_registry = MagicMock()
    client._peer_registry.register_peer = AsyncMock()
    client._peer_registry.update_manifest = AsyncMock()
    client._peer_registry.get_peer.return_value = MagicMock(latency_ms=float("inf"))
    client._peer_bridge = MagicMock()
    client._peer_send_fns["session-peer"] = MagicMock()
    client._remember_stable_peer_id(
        "session-peer",
        "stable-remote-peer",
        "remote-node",
    )

    manifest = PeerManifest(peer_id="stable-remote-peer", node_name="remote-node")
    await client._on_peer_manifest(
        "session-peer",
        {"type": "manifest", **manifest.model_dump(mode="json")},
    )

    client._peer_registry.register_peer.assert_awaited_with(
        "stable-remote-peer",
        "remote-node",
    )
    client._peer_registry.update_manifest.assert_awaited()
    client._peer_bridge.request_latency_sample.assert_called_once_with(
        "stable-remote-peer",
        sample_count=3,
        reset=True,
    )
    assert client._peer_stable_ids["session-peer"] == "stable-remote-peer"
    assert client._stable_peer_sessions["stable-remote-peer"] == "session-peer"


@pytest.mark.asyncio
async def test_rtc_client_incoming_manifest_ack_uses_stable_peer_identity(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._peer_registry = MagicMock()
    client._peer_registry.update_manifest_ack = AsyncMock()
    client._remember_stable_peer_id("session-peer", "stable-remote-peer", "remote-node")

    await client._on_manifest_ack(
        "session-peer",
        {
            "type": "manifest_ack",
            "compatible_services": ["TTS"],
            "protocol_revision": "v1",
        },
    )

    client._peer_registry.update_manifest_ack.assert_awaited_once()
    peer_id, ack = client._peer_registry.update_manifest_ack.await_args.args
    assert peer_id == "stable-remote-peer"
    assert ack.compatible_services == ["TTS"]
    assert ack.protocol_revision == "v1"


@pytest.mark.asyncio
async def test_rtc_client_structured_ack_must_match_last_sent_projection(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._peer_registry = MagicMock()
    client._peer_registry.update_manifest_ack = AsyncMock()
    client._remember_stable_peer_id("session-peer", "stable-remote-peer", "remote-node")
    hello = build_protocol_hello(role="hybrid", capabilities=(CAP_PROVIDER_LEASE_V1,))
    protocol = negotiate_protocol(hello, hello)
    client._peer_protocols["session-peer"] = protocol
    client._peer_protocols["stable-remote-peer"] = protocol
    client._manifest_ack_expectations["stable-remote-peer"] = _ManifestAckExpectation(
        session_peer_id="session-peer",
        connection_epoch="local-epoch-1",
        projection_digest="expected-projection",
        active_protocol="projection-v1",
        active_version="v1",
        active_tier="projection",
        protocol_revision="v1",
        registry_revision="expected-registry",
        export_policy_revision="expected-export",
        auth_grant_revision=7,
        advertised_services=("TTS",),
        compatible_services=(),
    )
    payload = {
        "type": "manifest_ack",
        "compatible_services": ["TTS"],
        "incompatible_services": [],
        "unused_services": [],
        "active_protocol": "projection-v1",
        "active_version": "v1",
        "active_tier": "projection",
        "protocol_revision": "v1",
        "registry_revision": "expected-registry",
        "export_policy_revision": "expected-export",
        "auth_grant_revision": 7,
        "projection_digest": "expected-projection",
        "services": [
            {
                "service_id": "TTS",
                "status": "compatible",
                "reason_codes": [],
            }
        ],
    }

    await client._on_manifest_ack("session-peer", payload)
    accepted = client._peer_registry.update_manifest_ack.await_args.args[1]
    assert accepted.services[0].service_id == "TTS"

    client._peer_registry.update_manifest_ack.reset_mock()
    await client._on_manifest_ack(
        "session-peer",
        {
            **payload,
            "projection_digest": "stale-projection",
            "registry_revision": "stale-registry",
            "export_policy_revision": "stale-export",
        },
    )
    client._peer_registry.update_manifest_ack.assert_not_awaited()


@pytest.mark.asyncio
async def test_rtc_incoming_manifest_captures_one_policy_snapshot(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    bus.publish = AsyncMock()
    store = MeshPolicyStore()
    store.replace(
        MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        source_revision=1,
    )
    calls = 0

    def provider():
        nonlocal calls
        calls += 1
        return store.current()

    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_policy_provider = provider
    client._peer_registry = MagicMock()
    client._peer_registry.get_peer.return_value = None
    client._peer_registry.register_peer = AsyncMock()
    client._peer_registry.update_manifest = AsyncMock()
    client._peer_send_fns["session-peer"] = MagicMock()
    client._remember_stable_peer_id("session-peer", "stable-remote-peer", "remote-node")

    manifest = verified_peer_manifest(
        "stable-remote-peer",
        [_verified_tooling_service()],
        node_name="remote-node",
        recipient_peer_id=client._local_mesh_peer_id(),
    )
    await client._on_peer_manifest(
        "session-peer",
        {"type": "manifest", **manifest.model_dump(mode="json")},
    )

    assert calls == 1


@pytest.mark.asyncio
async def test_rtc_client_manifest_with_shared_tooling_requests_catalog_sync(mock_deps):
    """A verified peer triggers one local, targeted full projection sync."""
    from app.services.gateway.mesh.tooling_projection_transport import (
        TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
    )
    from app.shared.contracts.models.tooling import ToolingProjectionSyncRequested

    settings, bus, registry, auth_service = mock_deps
    bus.publish = AsyncMock()
    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_config = MeshConfig(
        enabled=True,
        services={
            "Tooling": mesh_policy(
                share=True,
                prefer="network",
                min_version=None,
                required_capabilities=[],
                max_concurrent=10,
            )
        },
    )
    client._peer_registry = MagicMock()
    client._peer_registry.get_peer.return_value = None
    client._peer_registry.register_peer = AsyncMock()
    client._peer_registry.update_manifest = AsyncMock()
    client._peer_send_fns["session-peer"] = MagicMock()
    client._remember_stable_peer_id(
        "session-peer",
        "stable-remote-peer",
        "remote-node",
    )

    manifest = verified_peer_manifest(
        "stable-remote-peer",
        [_verified_tooling_service()],
        node_name="remote-node",
        recipient_peer_id=client._local_mesh_peer_id(),
    )
    await client._on_peer_manifest(
        "session-peer",
        {"type": "manifest", **manifest.model_dump(mode="json")},
    )

    bus.publish.assert_awaited_once()
    topic, refresh = bus.publish.await_args.args[:2]
    assert topic == TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC
    assert isinstance(refresh, ToolingProjectionSyncRequested)
    assert refresh.provider_peer_id == "stable-remote-peer"
    assert refresh.service_instance_id == "remote:stable-remote-peer:Tooling"
    assert refresh.reason_code == "peer_manifest_projection_ready"
    assert refresh.force_full_snapshot is True
    assert bus.publish.await_args.kwargs["mesh"] is False


@pytest.mark.asyncio
async def test_lease_aware_tooling_manifest_waits_for_provider_lease_before_sync(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    bus.publish = AsyncMock()
    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_config = MeshConfig(  # noqa: SLF001
        enabled=True,
        services={"Tooling": mesh_policy(share=True)},
    )
    client._peer_registry = MagicMock()  # noqa: SLF001
    client._peer_registry.get_peer.return_value = None  # noqa: SLF001
    client._peer_registry.register_peer = AsyncMock()  # noqa: SLF001
    client._peer_registry.require_provider_lease = AsyncMock()  # noqa: SLF001
    client._peer_registry.update_manifest = AsyncMock()  # noqa: SLF001
    client._peer_send_fns["session-peer"] = MagicMock()  # noqa: SLF001
    client._remember_stable_peer_id(  # noqa: SLF001
        "session-peer",
        "stable-remote-peer",
        "remote-node",
    )
    client.peer_supports_capability = MagicMock(return_value=True)  # type: ignore[method-assign]
    manifest = verified_peer_manifest(
        "stable-remote-peer",
        [_verified_tooling_service()],
        node_name="remote-node",
        recipient_peer_id=client._local_mesh_peer_id(),  # noqa: SLF001
    )

    await client._on_peer_manifest(  # noqa: SLF001
        "session-peer",
        {"type": "manifest", **manifest.model_dump(mode="json")},
    )

    bus.publish.assert_not_awaited()
    assert client._tooling_projection_sync_after_lease == {"stable-remote-peer"}  # noqa: SLF001


@pytest.mark.asyncio
async def test_rtc_policy_update_does_not_toggle_operational_mesh_state(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_enabled = True

    client.update_mesh_config(MeshConfig(enabled=False))

    assert client._mesh_enabled is True
    assert client._mesh_config is not None
    assert client._mesh_config.enabled is False


@pytest.mark.asyncio
async def test_rtc_reannounce_reports_partial_broadcast_failure(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_enabled = True
    client._mesh_config = MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)})
    peer_a = MagicMock(peer_id="peer-a")
    peer_b = MagicMock(peer_id="peer-b")
    client._peer_registry = MagicMock()
    client._peer_registry.get_negotiated_peers.return_value = [peer_a, peer_b]
    captured_configs = []
    captured_snapshots = []
    captured_force_send = []

    async def send_manifest(
        peer_id: str,
        *,
        mesh_config: MeshConfig | None = None,
        live_policy_snapshot: Any = None,
        force_send: bool = False,
    ) -> bool:
        captured_configs.append(mesh_config)
        captured_snapshots.append(live_policy_snapshot)
        captured_force_send.append(force_send)
        return peer_id == "peer-a"

    client._send_manifest = AsyncMock(side_effect=send_manifest)  # type: ignore[method-assign]

    assert await client.reannounce_manifest() is False
    assert client._send_manifest.await_count == 2
    assert captured_configs[0] is captured_configs[1]
    assert captured_snapshots == [None, None]
    assert captured_force_send == [True, True]


@pytest.mark.asyncio
async def test_rtc_reannounce_broadcast_captures_one_policy_snapshot(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    store = MeshPolicyStore()
    store.replace(MeshConfig(enabled=True, services={"TTS": mesh_policy(share=True)}))
    calls = 0

    def provider():
        nonlocal calls
        calls += 1
        return store.current()

    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_enabled = True
    client._mesh_policy_provider = provider
    peer_a = MagicMock(peer_id="peer-a")
    peer_b = MagicMock(peer_id="peer-b")
    client._peer_registry = MagicMock()
    client._peer_registry.get_negotiated_peers.return_value = [peer_a, peer_b]
    captured_configs = []
    captured_snapshots = []
    captured_force_send = []

    async def send_manifest(
        peer_id: str,
        *,
        mesh_config: MeshConfig | None = None,
        live_policy_snapshot: Any = None,
        force_send: bool = False,
    ) -> bool:
        captured_configs.append(mesh_config)
        captured_snapshots.append(live_policy_snapshot)
        captured_force_send.append(force_send)
        return True

    client._send_manifest = AsyncMock(side_effect=send_manifest)  # type: ignore[method-assign]

    assert await client.reannounce_manifest() is True
    assert calls == 1
    assert client._send_manifest.await_count == 2
    assert captured_configs[0] is captured_configs[1] is store.current().mesh_config
    assert captured_snapshots[0] is captured_snapshots[1] is store.current()
    assert captured_force_send == [True, True]


@pytest.mark.asyncio
async def test_rtc_client_no_saved_token_no_auto_send(mock_deps):
    """A new peer exchanges challenges before falling back to bilateral pairing."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._pairing_results["peer1"] = pairing_sas_result()
    client._run_bilateral_pairing = AsyncMock()
    # No saved_auth_token — peer must authenticate via pairing flow

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", mock_pc)

        mock_channel.emit("open")
        assert json.loads(mock_channel.sent_messages[0])["type"] == "mesh_auth_challenge_v1"
        client._handle_reconnect_challenge(
            "peer1",
            mock_pc,
            mock_channel,
            reconnect_challenge_for(client, "peer1", mock_pc),
        )
        await asyncio.sleep(0)

        assert all(
            json.loads(message).get("type") != "auth" for message in mock_channel.sent_messages
        )
        client._run_bilateral_pairing.assert_awaited_once_with("peer1", mock_channel, mock_pc)


@pytest.mark.asyncio
async def test_rtc_client_offer_receiver_bootstraps_already_open_remote_channel(
    mock_deps,
):
    """The answerer cannot miss auth when aiortc delivers an open channel."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._pairing_results["peer1"] = pairing_sas_result()
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MockPeerConnectionWithEvents()
    remote_channel = MockDataChannel()

    try:
        with patch(
            "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
            return_value=mock_pc,
        ):
            # Default is_offer_initiator=False (offer receiver path)
            await client._ensure_pc("peer1")

            mock_pc.createDataChannel.assert_not_called()
            install_pairing_transport(client, "peer1", mock_pc)
            datachannel_handler = mock_pc._handlers.get("datachannel")
            assert datachannel_handler is not None, "on_datachannel handler not registered"
            datachannel_handler(remote_channel)

            # aiortc may expose the answerer's remote channel as already open
            # before setup_channel can attach its open callback. Bootstrap must
            # happen from readyState, while a later duplicate event stays safe.
            assert json.loads(remote_channel.sent_messages[0])["type"] == ("mesh_auth_challenge_v1")
            assert "peer1" in client._peer_timeout_tasks
            client._mesh_enabled = True
            remote_channel.emit("message", json.dumps({"type": "manifest"}))
            assert not client._diagnostic_errors
            remote_channel.emit("open")
            client._handle_reconnect_challenge(
                "peer1",
                mock_pc,
                remote_channel,
                reconnect_challenge_for(client, "peer1", mock_pc),
            )
            await asyncio.sleep(0)

            assert (
                sum(
                    json.loads(message)["type"] == "mesh_auth_challenge_v1"
                    for message in remote_channel.sent_messages
                )
                == 1
            )
            client._run_bilateral_pairing.assert_awaited_once_with("peer1", remote_channel, mock_pc)
    finally:
        tasks = list(client._peer_timeout_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class MockPeerConnectionWithEvents:
    """Mock RTCPeerConnection that captures event handler decorators."""

    def __init__(self, **kwargs):
        self._handlers: dict[str, Any] = {}
        self.createDataChannel = MagicMock()
        self.addIceCandidate = AsyncMock()
        self.setRemoteDescription = AsyncMock()
        self.setLocalDescription = AsyncMock()
        self.createOffer = AsyncMock()
        self.createAnswer = AsyncMock()
        self.close = MagicMock()
        self.localDescription = None

    def on(self, event_name: str):
        def decorator(fn):
            self._handlers[event_name] = fn
            return fn

        return decorator


@pytest.mark.asyncio
async def test_slow_reconnect_proof_outlives_initial_auth_timeout(mock_deps):
    """A progressing exact-PC proof keeps the transport alive until Auth returns."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._auth_timeout = 0.01
    client._pairing_timeout = 0.3
    client._audit = AsyncMock()
    peer = "remote-session"
    channel = MockDataChannel()
    pc = MockPeerConnectionWithEvents()
    pc.connectionState = "connected"
    pc.signalingState = "stable"
    pc.createDataChannel.return_value = channel
    pc.close = AsyncMock()
    verification_started = asyncio.Event()
    release_verification = asyncio.Event()
    token = Token(
        id="token-id-123",
        token_hash="hash",
        prefix="prefix",
        device_id="remote-device",
        user_id="remote-user",
        scopes=["read"],
    )
    identity = Identity(
        principal_id="remote-user",
        principal_name="Remote Aurora",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        device_id="remote-device",
        source="webrtc_peer",
    )

    async def verify_slowly(**_kwargs: Any) -> Token:
        verification_started.set()
        await release_verification.wait()
        return token

    auth_service.verify_mesh_reconnect_proof.side_effect = verify_slowly
    auth_service.build_identity_from_token.return_value = identity

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        install_pairing_transport(client, peer, pc)
        channel.emit("open")
        record = client._peer_auth_challenges[peer]
        channel.emit("message", json.dumps(reconnect_proof_for(record)))
        await asyncio.wait_for(verification_started.wait(), timeout=1.0)
        client._mesh_enabled = True

        hello_task = channel.emit(
            "message",
            json.dumps(
                build_protocol_hello(
                    role="hybrid",
                    capabilities=(CAP_FRAGMENTATION_V1,),
                )
            ),
        )
        if hello_task is not None:
            await hello_task

        assert peer in client._pending_peer_protocol_hellos
        assert peer not in client._peer_protocols
        assert not any(
            error.code == "preauth_message_dropped" for error in client._diagnostic_errors
        )

        await asyncio.sleep(0.04)
        assert client._pcs[peer] is pc
        assert peer in client._reconnect_proof_tasks
        pc.close.assert_not_awaited()

        release_verification.set()
        async with asyncio.timeout(1.0):
            while client._peer_acl.get(peer, ANONYMOUS) == ANONYMOUS:
                await asyncio.sleep(0.001)

    assert client._peer_acl[peer] != ANONYMOUS
    assert client._peer_acl[peer].principal_id == identity.principal_id
    assert client._stable_peer_sessions["stable-remote-peer"] == peer
    assert peer not in client._pending_peer_protocol_hellos
    assert client.peer_supports_capability(peer, CAP_FRAGMENTATION_V1)
    assert peer not in client._reconnect_proof_tasks
    pc.close.assert_not_awaited()
    await cancel_auth_timeouts(client)


@pytest.mark.asyncio
async def test_late_reconnect_proof_cannot_authenticate_replacement_pc(mock_deps):
    """A proof result is discarded when its exact PC is no longer current."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "Local Aurora")
    client._audit = AsyncMock()
    peer = "remote-session"
    old_pc = MagicMock()
    old_pc.close = AsyncMock()
    replacement_pc = MagicMock()
    channel = MockDataChannel()
    install_pairing_transport(client, peer, old_pc)
    record = install_reconnect_challenge(client, peer, old_pc, challenge="de" * 32)
    verification_started = asyncio.Event()
    release_verification = asyncio.Event()
    token = Token(
        id="token-id-123",
        token_hash="hash",
        prefix="prefix",
        device_id="remote-device",
        user_id="remote-user",
        scopes=["read"],
    )

    async def verify_slowly(**_kwargs: Any) -> Token:
        verification_started.set()
        await release_verification.wait()
        return token

    auth_service.verify_mesh_reconnect_proof.side_effect = verify_slowly

    proof_task = asyncio.create_task(
        client._handle_reconnect_proof(peer, old_pc, channel, reconnect_proof_for(record))
    )
    await asyncio.wait_for(verification_started.wait(), timeout=1.0)
    client._pcs[peer] = replacement_pc
    release_verification.set()
    await proof_task

    assert client._peer_acl.get(peer, ANONYMOUS) == ANONYMOUS
    assert "stable-remote-peer" not in client._peer_acl
    assert "stable-remote-peer" not in client._stable_peer_sessions
    auth_service.build_identity_from_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminal_peer_close_cancels_exact_reconnect_proof_task(mock_deps):
    """Connection cleanup owns and cancels its pending proof validation."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._audit = AsyncMock()
    peer = "remote-session"
    channel = MockDataChannel()
    pc = MockPeerConnectionWithEvents()
    pc.connectionState = "connected"
    pc.createDataChannel.return_value = channel
    pc.close = AsyncMock()

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        install_pairing_transport(client, peer, pc)
        started = asyncio.Event()

        async def wait_forever() -> None:
            started.set()
            await asyncio.Event().wait()

        proof_task = asyncio.create_task(wait_forever())
        client._track_reconnect_proof_task(peer, pc, proof_task)
        await started.wait()
        pc.connectionState = "closed"
        await pc._handlers["connectionstatechange"]()
        await asyncio.sleep(0)

    assert proof_task.cancelled()
    assert peer not in client._reconnect_proof_tasks


@pytest.mark.asyncio
async def test_closed_datachannel_closes_and_cleans_owning_peer_connection(mock_deps):
    """A closed RPC channel cannot leave an authenticated session resident."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "a-local-peer"
    client._adapter = MagicMock()
    client._audit = AsyncMock()
    client.connect_to = AsyncMock()
    peer = "z-remote-peer"
    stable_peer = "stable-remote-peer"

    pc = MockPeerConnectionWithEvents()
    pc.connectionState = "connected"
    channel = MockDataChannel()
    pc.createDataChannel.return_value = channel

    async def close_pc() -> None:
        pc.connectionState = "closed"
        await pc._handlers["connectionstatechange"]()

    pc.close = AsyncMock(side_effect=close_pc)

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        identity = Identity(
            principal_id="remote-user",
            principal_name="Remote Aurora",
            effective_perms=frozenset({"read"}),
            source="webrtc_peer",
        )
        client._peer_acl[peer] = identity
        client._peer_acl[stable_peer] = identity
        client._remember_stable_peer_id(peer, stable_peer, "Remote Aurora")

        channel.readyState = "closed"
        close_task = channel.emit("close")
        assert close_task is not None
        await close_task

    pc.close.assert_awaited_once()
    assert peer not in client._pcs
    assert peer not in client._peer_data_channels
    assert peer not in client._peer_acl
    assert stable_peer not in client._peer_acl
    assert stable_peer not in client._stable_peer_sessions
    assert peer not in client._peer_reconnect_tasks
    client.connect_to.assert_not_awaited()


@pytest.mark.asyncio
async def test_rtc_client_disconnect_resolves_only_that_peers_rpc_calls(mock_deps):
    """Peer A cleanup must not abort an unrelated in-flight call to peer B."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._audit = AsyncMock()
    pc_a = MockPeerConnectionWithEvents()
    pc_b = MockPeerConnectionWithEvents()
    pc_a.connectionState = "connected"
    pc_b.connectionState = "connected"
    channel_a = MockDataChannel()
    channel_b = MockDataChannel()
    pc_a.createDataChannel.return_value = channel_a
    pc_b.createDataChannel.return_value = channel_b

    rpc_a: asyncio.Task[Any] | None = None
    rpc_b: asyncio.Task[Any] | None = None
    try:
        with patch(
            "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
            side_effect=[pc_a, pc_b],
        ):
            await client._ensure_pc("peer-a", is_offer_initiator=True)
            await client._ensure_pc("peer-b", is_offer_initiator=True)
            rpc_a = asyncio.create_task(
                client._rpc_call("peer-a", "Auth.PairingConnect", {"code": "opaque-a"})
            )
            rpc_b = asyncio.create_task(
                client._rpc_call("peer-b", "Auth.PairingConnect", {"code": "opaque-b"})
            )
            await asyncio.sleep(0)

            pc_a.connectionState = "closed"
            await pc_a._handlers["connectionstatechange"]()
            await asyncio.sleep(0)

            assert await rpc_a is None
            assert not rpc_b.done()
    finally:
        for task in (rpc_a, rpc_b):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (rpc_a, rpc_b) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_rtc_client_initiator_reconnects_when_responder_closes_during_pairing(
    mock_deps,
):
    """A remote timeout close must not cancel the initiator's only retry path.

    This reproduces the bilateral race where the responder reaches its pairing
    timeout first and closes the shared connection. The initiator observes that
    remote close before its own timeout task can mark a retry, so disconnect
    cleanup must preserve the fact that pairing was active and reconnect.
    """
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-responder"
    client._peer_id = "a-initiator"  # This side owns the deterministic offer retry.
    client._adapter = MagicMock()
    client._auth_timeout = 60.0
    client._pairing_retry_delay = 0.0
    client._audit = AsyncMock()
    client.connect_to = AsyncMock()
    client._pairing_results[peer] = pairing_sas_result()

    pairing_started = asyncio.Event()

    async def hold_pairing_open(
        pairing_peer: str,
        _channel: Any,
        _pc: Any,
    ) -> None:
        client._peer_pairing_active.add(pairing_peer)
        pairing_started.set()
        await asyncio.Future()

    client._run_bilateral_pairing = hold_pairing_open

    mock_pc = MockPeerConnectionWithEvents()
    mock_pc.connectionState = "connected"
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=mock_pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        install_pairing_transport(client, peer, mock_pc)
        mock_channel.emit("open")
        client._handle_reconnect_challenge(
            peer,
            mock_pc,
            mock_channel,
            reconnect_challenge_for(client, peer, mock_pc),
        )
        await asyncio.wait_for(pairing_started.wait(), timeout=1.0)

        timeout_task = client._peer_timeout_tasks[peer]
        pairing_task = client._pairing_tasks[peer]
        assert peer in client._peer_pairing_active

        # The responder timed out first; aiortc reports its remote close here.
        mock_pc.connectionState = "closed"
        await mock_pc._handlers["connectionstatechange"]()
        await asyncio.sleep(0)

    assert timeout_task.cancelled()
    assert pairing_task.cancelled()
    assert peer not in client._pcs
    assert peer not in client._peer_timeout_tasks
    assert peer not in client._pairing_tasks
    assert peer not in client._peer_pairing_active
    assert peer not in client._peer_data_channels
    client.connect_to.assert_awaited_once_with(peer)


@pytest.mark.asyncio
async def test_rtc_client_reconnects_after_authenticated_transport_loss(mock_deps):
    """A trusted peer connection must recover without a new presence event."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-returning-peer"
    stable_peer = "stable-returning-peer"
    client._peer_id = "a-offer-owner"
    client._adapter = MagicMock()
    client._pairing_retry_delay = 0.0
    client._audit = AsyncMock()
    client.connect_to = AsyncMock()

    mock_pc = MockPeerConnectionWithEvents()
    mock_pc.connectionState = "connected"
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel
    identity = Identity(
        principal_id="remote-user",
        principal_name="Remote Aurora",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        source="webrtc_peer",
    )

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=mock_pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        client._remember_stable_peer_id(peer, stable_peer, "Remote Aurora")
        client._peer_acl[peer] = identity

        mock_pc.connectionState = "failed"
        await mock_pc._handlers["connectionstatechange"]()
        await asyncio.sleep(0)

    client.connect_to.assert_awaited_once_with(peer)
    assert client._peer_claimed_stable_ids[peer] == stable_peer
    assert client._peer_claimed_names[peer] == "Remote Aurora"


@pytest.mark.asyncio
async def test_peer_reconnect_retries_after_connect_exception(mock_deps):
    """One signaling-send failure cannot permanently stop recovery."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-returning-peer"
    client._peer_id = "a-offer-owner"
    client._adapter = MagicMock()
    client._pairing_retry_delay = 0.0
    client.connect_to = AsyncMock(side_effect=[RuntimeError("broker unavailable"), None])

    client._schedule_peer_reconnect(peer, reason="test transport loss")
    deadline = asyncio.get_running_loop().time() + 1.5
    while client.connect_to.await_count < 2 and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.02)

    assert client.connect_to.await_count == 2
    assert peer not in client._peer_reconnect_tasks


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_mode", ["handshake_timeout", "generic_failure"])
async def test_transient_pairing_failure_retries_after_pairing_finally(
    mock_deps,
    failure_mode,
):
    """Pairing cleanup cannot erase the offer owner's only retry signal."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-remote-peer"
    client._peer_id = "a-local-offer-owner"
    client._adapter = MagicMock()
    client._audit = AsyncMock()
    client.connect_to = AsyncMock()
    client._pairing_handshake_timeout = 0.001
    client._pairing_retry_delay = 0.0

    pc = MockPeerConnectionWithEvents()
    pc.connectionState = "connected"
    pc.close = AsyncMock()
    channel = MockDataChannel()
    pc.createDataChannel.return_value = channel

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        install_pairing_transport(client, peer, pc)
        if failure_mode == "generic_failure":
            client._send_pairing_commit = MagicMock(
                side_effect=RuntimeError("transient DataChannel send failure")
            )

        await client._run_bilateral_pairing(peer, channel, pc)

        # aiortc dispatches this callback after close returns and the pairing
        # coroutine's finally block has already cleared its active direction.
        assert peer not in client._peer_pairing_active
        assert pc in client._negotiation_retry_pcs
        pc.connectionState = "closed"
        await pc._handlers["connectionstatechange"]()
        await asyncio.sleep(0)

    pc.close.assert_awaited_once()
    client.connect_to.assert_awaited_once_with(peer)


@pytest.mark.asyncio
async def test_lost_initial_auth_frames_retry_after_anonymous_timeout(mock_deps):
    """A lost challenge/proof must not require another retained presence event."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-remote-peer"
    client._peer_id = "a-local-offer-owner"
    client._adapter = MagicMock()
    client._audit = AsyncMock()
    client.connect_to = AsyncMock()
    client._auth_timeout = 0.001
    client._pairing_retry_delay = 0.0

    pc = MockPeerConnectionWithEvents()
    pc.connectionState = "connected"
    pc.close = AsyncMock()
    channel = MockDataChannel()
    pc.createDataChannel.return_value = channel

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client._ensure_pc(peer, is_offer_initiator=True)
        install_pairing_transport(client, peer, pc)
        channel.emit("open")

        async with asyncio.timeout(1.0):
            while not pc.close.await_count:
                await asyncio.sleep(0.001)

        assert pc in client._negotiation_retry_pcs
        pc.connectionState = "closed"
        await pc._handlers["connectionstatechange"]()
        await asyncio.sleep(0)

    client.connect_to.assert_awaited_once_with(peer)


@pytest.mark.asyncio
async def test_initial_offer_failure_discards_pc_and_schedules_retry(mock_deps):
    """An early createOffer failure must not strand a peer in `_pcs`."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-discovered-peer"
    client._peer_id = "a-offer-owner"
    client._adapter = MagicMock()
    client._adapter.send = AsyncMock()
    client._schedule_peer_reconnect = MagicMock()

    mock_pc = MockPeerConnectionWithEvents()
    mock_pc.connectionState = "new"
    mock_pc.createOffer.side_effect = RuntimeError("offer setup failed")
    mock_pc.close = AsyncMock()

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=mock_pc,
    ):
        await client._on_presence(json.dumps({"type": "presence", "peer_id": peer}).encode())

    assert peer not in client._pcs
    mock_pc.close.assert_awaited_once()
    client._schedule_peer_reconnect.assert_called_once_with(
        peer,
        reason="initial offer setup failed",
    )
    assert client._diagnostic_errors[0].code == "negotiation_start_failed"


@pytest.mark.asyncio
async def test_failed_offer_response_discards_pc_before_fresh_offer(mock_deps):
    """A responder failure clears the old SAS epoch before the owner's retry."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "z-responder"
    client._adapter = MagicMock()
    client._adapter.send = AsyncMock()
    peer = "a-offer-owner"
    client._pairing_results[peer] = pairing_sas_result()
    client._pairing_commits_sent.add(peer)
    client._pairing_bootstrapped.add(peer)
    client._peer_pairing_directions[peer] = {"inbound", "outbound"}
    client._peer_pairing_active.add(peer)

    failed_pc = MockPeerConnectionWithEvents()
    failed_pc.connectionState = "new"
    failed_pc.createAnswer.side_effect = RuntimeError("answer setup failed")
    failed_pc.close = AsyncMock()

    fresh_pc = MockPeerConnectionWithEvents()
    fresh_pc.connectionState = "new"
    answer = SimpleNamespace(type="answer", sdp="fresh-answer-sdp")
    fresh_pc.createAnswer.return_value = answer

    async def set_fresh_local_description(description: Any) -> None:
        fresh_pc.localDescription = description

    fresh_pc.setLocalDescription.side_effect = set_fresh_local_description

    offer = aead_seal(
        client._keys.k_sig,
        {
            "type": "offer",
            "app_id": settings.webrtc.app_id,
            "room": settings.webrtc.room,
            "from": peer,
            "to": client._peer_id,
            "sdp": "v=0\r\na=fingerprint:sha-256 11:22\r\n",
            "stable_peer_id": "stable-offer-owner",
            "node_name": "Aurora 1",
        },
    )

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        side_effect=[failed_pc, fresh_pc],
    ):
        await client._on_offer(offer)
        assert peer not in client._pcs
        failed_pc.close.assert_awaited_once()
        assert peer not in client._pairing_results
        assert peer not in client._pairing_commits_sent
        assert peer not in client._pairing_bootstrapped
        assert peer not in client._peer_pairing_directions
        assert peer not in client._peer_pairing_active

        await client._on_offer(offer)

    assert client._pcs[peer] is fresh_pc
    client._adapter.send.assert_awaited_once()
    assert client._adapter.send.await_args.args[0] == "answer"
    assert client._diagnostic_errors[0].code == "negotiation_response_failed"


@pytest.mark.asyncio
async def test_fresh_offer_replaces_stale_unconnected_answerer_transport(mock_deps):
    """A recovering offerer gets a clean answerer PC for each new SDP epoch."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "z-responder"
    client._adapter = MagicMock()
    client._adapter.send = AsyncMock()
    peer = "a-offer-owner"

    stale_pc = MockPeerConnectionWithEvents()
    stale_pc.connectionState = "new"
    stale_pc.close = AsyncMock()
    stale_answer = SimpleNamespace(type="answer", sdp="stale-answer-sdp")
    stale_pc.createAnswer.return_value = stale_answer

    fresh_pc = MockPeerConnectionWithEvents()
    fresh_pc.connectionState = "new"
    fresh_pc.close = AsyncMock()
    fresh_answer = SimpleNamespace(type="answer", sdp="fresh-answer-sdp")
    fresh_pc.createAnswer.return_value = fresh_answer

    async def set_stale_local_description(description: Any) -> None:
        stale_pc.localDescription = description

    async def set_fresh_local_description(description: Any) -> None:
        fresh_pc.localDescription = description

    stale_pc.setLocalDescription.side_effect = set_stale_local_description
    fresh_pc.setLocalDescription.side_effect = set_fresh_local_description

    def sealed_offer(sdp: str) -> bytes:
        return aead_seal(
            client._keys.k_sig,
            {
                "type": "offer",
                "app_id": settings.webrtc.app_id,
                "room": settings.webrtc.room,
                "from": peer,
                "to": client._peer_id,
                "sdp": sdp,
                "stable_peer_id": "stable-offer-owner",
                "node_name": "Aurora 1",
            },
        )

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        side_effect=[stale_pc, fresh_pc],
    ):
        await client._on_offer(sealed_offer("v=0\r\na=ice-ufrag:stale\r\n"))
        await client._on_offer(sealed_offer("v=0\r\na=ice-ufrag:fresh\r\n"))

    stale_pc.close.assert_awaited_once()
    assert client._pcs[peer] is fresh_pc
    assert client._pairing_transports[peer]["pc"] is fresh_pc
    assert client._pairing_transports[peer]["offer_sdp"].endswith("a=ice-ufrag:fresh\r\n")
    assert client._adapter.send.await_count == 2

    fresh_pc.connectionState = "connected"
    await client._on_offer(sealed_offer("v=0\r\na=ice-ufrag:unsolicited\r\n"))
    assert client._pcs[peer] is fresh_pc
    assert client._adapter.send.await_count == 2


@pytest.mark.asyncio
async def test_departed_presence_stops_reconnect_to_stale_signaling_uuid(mock_deps):
    """MQTT Last Will cleanup must retire a crashed peer's old session ID."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._handle_signaling_departure = AsyncMock()

    await client._on_presence(
        json.dumps(
            {
                "type": "presence_departed",
                "peer_id": "dead-signaling-session",
            }
        ).encode()
    )

    client._handle_signaling_departure.assert_awaited_once_with(
        "dead-signaling-session",
        reason="retained presence cleared",
    )


@pytest.mark.asyncio
async def test_rtc_client_unanswered_offer_times_out_and_retries(mock_deps):
    """The deterministic offer owner must recover when no answer ever arrives."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    peer = "z-unresponsive-peer"
    client._peer_id = "a-offer-owner"
    client._adapter = MagicMock()
    client._adapter.send = AsyncMock()
    client._auth_timeout = 0.01
    client._offer_timeout = 0.01
    client._pairing_retry_delay = 0.0
    client._audit = AsyncMock()

    mock_pc = MockPeerConnectionWithEvents()
    mock_pc.connectionState = "new"
    mock_pc.signalingState = "stable"
    offer = SimpleNamespace(type="offer", sdp="unanswered-offer-sdp")
    mock_pc.createOffer.return_value = offer

    async def set_local_description(description: Any) -> None:
        mock_pc.localDescription = description
        mock_pc.signalingState = "have-local-offer"

    mock_pc.setLocalDescription.side_effect = set_local_description

    async def close_peer_connection() -> None:
        mock_pc.connectionState = "closed"
        mock_pc.signalingState = "closed"
        await mock_pc._handlers["connectionstatechange"]()

    mock_pc.close = AsyncMock(side_effect=close_peer_connection)

    presence = json.dumps({"type": "presence", "peer_id": peer}).encode()
    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=mock_pc,
    ):
        await client._on_presence(presence)

        assert mock_pc.connectionState == "new"
        assert mock_pc.signalingState == "have-local-offer"
        client._adapter.send.assert_awaited_once()

        # Capture the retry without creating another real peer connection.
        client.connect_to = AsyncMock()
        await asyncio.sleep(0.1)

    mock_pc.close.assert_awaited_once()
    assert peer not in client._pcs
    client.connect_to.assert_awaited_once_with(peer)


@pytest.mark.asyncio
async def test_rtc_client_duplicate_channel_open_starts_one_pairing_request(mock_deps):
    """The offerer's canonical channel survives duplicate same-label events."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._pairing_results["peer1"] = pairing_sas_result()
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MockPeerConnectionWithEvents()
    local_channel = MockDataChannel()
    resp_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = local_channel

    try:
        with patch(
            "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
            return_value=mock_pc,
        ):
            await client._ensure_pc("peer1", is_offer_initiator=True)
            mock_pc.createDataChannel.assert_called_once_with("aurora-rpc")
            install_pairing_transport(client, "peer1", mock_pc)

            datachannel_handler = mock_pc._handlers.get("datachannel")
            assert datachannel_handler is not None, "on_datachannel handler not registered"

            local_channel.emit("open")
            local_channel.emit("open")
            datachannel_handler(resp_channel)
            resp_channel.emit("open")
            resp_channel.emit("open")
            client._handle_reconnect_challenge(
                "peer1",
                mock_pc,
                local_channel,
                reconnect_challenge_for(client, "peer1", mock_pc),
            )
            await asyncio.sleep(0)

            client._run_bilateral_pairing.assert_awaited_once_with("peer1", local_channel, mock_pc)
            assert client._peer_data_channels["peer1"] is local_channel
    finally:
        tasks = list(client._peer_timeout_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_rtc_client_auth_message_handling(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    # Mock valid token
    valid_token = Token(
        id="token-id",
        token_hash="hash",
        prefix="prefix",
        device_id="device-id",
        user_id="user-id",
        scopes=["read", "write"],
    )
    auth_service.authenticate_token.return_value = valid_token

    # Mock build_identity_from_token to return an Identity
    expected_identity = Identity(
        principal_id="user-id",
        principal_name="remote-peer",
        is_admin=False,
        effective_perms=frozenset(["read", "write"]),
        device_id="device-id",
        source="webrtc_peer",
    )
    auth_service.build_identity_from_token.return_value = expected_identity

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)

        # Peer sends auth message
        auth_payload = json.dumps(
            {"type": "auth", "peer_name": "remote-peer", "token": "valid-token"}
        )

        # emit() returns an asyncio.Task for coroutine handlers — await it
        # directly instead of using a timing-dependent sleep
        task = mock_channel.emit("message", auth_payload)
        if task is not None:
            await task
        else:
            await asyncio.sleep(0)

        assert auth_service.authenticate_token.called
        assert auth_service.build_identity_from_token.called

        # _peer_acl now stores Identity objects
        identity = client._peer_acl["peer1"]
        assert isinstance(identity, Identity)
        assert identity.principal_id == "user-id"
        assert "read" in identity.effective_perms
        assert "write" in identity.effective_perms


@pytest.mark.asyncio
async def test_saved_auth_is_not_misclassified_when_sas_finishes_first(mock_deps):
    """A concurrent bilateral transcript must not reject sessionless reconnect auth."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._pairing_results["peer1"] = pairing_sas_result()
    client._abort_pairing_protocol = AsyncMock()
    client._audit = AsyncMock()

    valid_token = Token(
        id="token-id",
        token_hash="hash",
        prefix="prefix",
        device_id="device-id",
        user_id="user-id",
        scopes=["read"],
    )
    expected_identity = Identity(
        principal_id="user-id",
        principal_name="remote-peer",
        is_admin=False,
        effective_perms=frozenset({"read"}),
        device_id="device-id",
        source="webrtc_peer",
    )
    auth_service.authenticate_token.return_value = valid_token
    auth_service.build_identity_from_token.return_value = expected_identity

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        mock_channel.emit(
            "message",
            json.dumps(
                {
                    "type": "auth",
                    "peer_name": "Remote Aurora",
                    "peer_id": "stable-remote-peer",
                    "token": "saved-token-without-session-id",
                }
            ),
        )
        await asyncio.sleep(0)

    assert client._peer_acl["peer1"] == expected_identity
    client._abort_pairing_protocol.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_fresh_pairing_token_is_protocol_fatal(mock_deps):
    """A token minted in the current approved session cannot downgrade to re-pairing."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    pairing = pairing_sas_result()
    client._pairing_results["peer1"] = pairing
    client._abort_pairing_protocol = AsyncMock()
    client._run_bilateral_pairing = AsyncMock()
    client._audit = AsyncMock()
    auth_service.validate_mesh_pairing_token.return_value = None

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", mock_pc)
        mock_channel.emit(
            "message",
            json.dumps(
                {
                    "type": "auth",
                    "peer_name": pairing.remote_node_name,
                    "peer_id": pairing.remote_stable_peer_id,
                    "signaling_peer_id": "peer1",
                    "pairing_session_id": pairing.pairing_session_id,
                    "token": "invalid-fresh-token",
                }
            ),
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    auth_service.validate_mesh_pairing_token.assert_awaited_once_with(
        token_str="invalid-fresh-token",
        pairing_session_id=pairing.pairing_session_id,
        claimant_peer_id=pairing.remote_stable_peer_id,
        room_name="test-room",
    )
    auth_service.authenticate_token.assert_not_awaited()
    client._abort_pairing_protocol.assert_awaited_once_with("peer1", mock_pc)
    client._run_bilateral_pairing.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"signaling_peer_id": "different-session"},
        {"pairing_session_id": "f" * 64},
    ],
)
async def test_fresh_pairing_auth_requires_exact_session_and_signaling_identity(
    mock_deps,
    overrides,
):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    pairing = pairing_sas_result()
    client._pairing_results["peer1"] = pairing
    client._abort_pairing_protocol = AsyncMock()

    pc = MagicMock()
    channel = MockDataChannel()
    pc.createDataChannel.return_value = channel
    payload = {
        "type": "auth",
        "peer_name": pairing.remote_node_name,
        "peer_id": pairing.remote_stable_peer_id,
        "signaling_peer_id": "peer1",
        "pairing_session_id": pairing.pairing_session_id,
        "token": "fresh-token",
        **overrides,
    }

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", pc)
        channel.emit("message", json.dumps(payload))
        await asyncio.sleep(0)

    client._abort_pairing_protocol.assert_awaited_once_with("peer1", pc)
    auth_service.validate_mesh_pairing_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_rejected_saved_auth_falls_back_to_bilateral_pairing(mock_deps):
    """A stale one-way credential repairs both sides instead of closing the channel."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    # Mock invalid token
    auth_service.authenticate_token.return_value = None

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)

        # Peer sends invalid auth message
        auth_payload = json.dumps(
            {"type": "auth", "peer_name": "remote-peer", "token": "invalid-token"}
        )

        # emit() returns an asyncio.Task for coroutine handlers — await it
        task = mock_channel.emit("message", auth_payload)
        if task is not None:
            await task
        else:
            await asyncio.sleep(0)

        assert auth_service.authenticate_token.called

        await asyncio.sleep(0)

        # Failed reconnect auth stays anonymous until the fresh two-sided
        # request is approved, but keeps the channel alive for shared-SAS flow.
        identity = client._peer_acl["peer1"]
        assert identity == ANONYMOUS
        assert mock_channel.readyState == "open"
        client._run_bilateral_pairing.assert_awaited_once_with("peer1", mock_channel, mock_pc)
