import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.db.models import Token
from app.services.gateway.acl.identity import ANONYMOUS, Identity
from app.services.gateway.mesh.models import PeerManifest
from app.services.gateway.webrtc.rtc_client import RTCClient


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
            else:
                return self.events[event_name](*args, **kwargs)


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
async def test_rtc_client_handshake_on_open(mock_deps):
    """With require_auth=True and a saved token, on_open sends DB token for auth."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._saved_auth_tokens["peer1"] = "saved-pairing-token-from-prior-exchange"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        # Trigger 'open' event on the channel
        mock_channel.emit("open")

        # Check if auth message was sent with the saved token
        assert len(mock_channel.sent_messages) == 1
        msg = json.loads(mock_channel.sent_messages[0])
        assert msg["type"] == "auth"
        assert msg["token"] == "saved-pairing-token-from-prior-exchange"
        assert msg["peer_name"] == client._peer_id
        # No auto-auth mechanism — token is a standard DB token from pairing
        assert msg.get("mechanism") != "mesh_shared_secret"


@pytest.mark.asyncio
async def test_rtc_client_sends_stable_mesh_identity_in_saved_token_auth(mock_deps):
    """Reconnect auth advertises stable mesh identity, not signaling session id."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client.set_mesh_identity("stable-local-peer", "local-node")
    client._remember_stable_peer_id("session-peer", "stable-remote-peer", "remote-node")
    client._saved_auth_tokens["stable-remote-peer"] = "stable-peer-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("session-peer")
        mock_channel.emit("open")

        msg = json.loads(mock_channel.sent_messages[0])
        assert msg["type"] == "auth"
        assert msg["token"] == "stable-peer-token"
        assert msg["peer_id"] == "stable-local-peer"
        assert msg["peer_name"] == "local-node"
        assert msg["signaling_peer_id"] == client._peer_id


@pytest.mark.asyncio
async def test_rtc_client_presence_identity_selects_saved_token_for_new_session(mock_deps):
    """Presence stable ID lets a new signaling session reuse the right peer token."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = "local-session"
    client.set_mesh_identity("stable-local-peer", "local-node")
    client._system_token = "system-token"
    client._saved_auth_tokens = {
        "stable-remote-peer-a": "token-for-remote-a",
        "stable-remote-peer-b": "token-for-remote-b",
    }
    client.connect_to = AsyncMock()

    remote_session = "new-session-peer"
    assert remote_session not in client._peer_stable_ids

    await client._on_presence(
        json.dumps(
            {
                "type": "presence",
                "app_id": settings.webrtc.app_id,
                "room": settings.webrtc.room,
                "peer_id": remote_session,
                "stable_peer_id": "stable-remote-peer-a",
                "node_name": "remote-node-a",
            }
        ).encode()
    )

    assert client._peer_stable_ids[remote_session] == "stable-remote-peer-a"
    client.connect_to.assert_awaited_once_with(remote_session)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc(remote_session, is_offer_initiator=True)
        mock_channel.emit("open")

        assert remote_session not in client._pairing_tasks
        assert len(mock_channel.sent_messages) == 1
        msg = json.loads(mock_channel.sent_messages[0])
        assert msg["type"] == "auth"
        assert msg["token"] == "token-for-remote-a"
        assert msg["peer_id"] == "stable-local-peer"
        assert msg["peer_name"] == "local-node"
        assert msg["signaling_peer_id"] == "local-session"


@pytest.mark.asyncio
async def test_rtc_client_manifest_uses_stable_local_identity(mock_deps):
    """Manifest exchange exposes stable local mesh identity."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client.set_mesh_identity("stable-local-peer", "local-node")
    client._mesh_config = MagicMock(node_name="local-node", services={})

    sent_messages: list[dict[str, Any]] = []
    client._peer_send_fns["session-peer"] = lambda text: sent_messages.append(json.loads(text))
    client._stable_peer_sessions["stable-remote-peer"] = "session-peer"

    await client._send_manifest("stable-remote-peer")

    assert sent_messages[0]["type"] == "manifest"
    assert sent_messages[0]["peer_id"] == "stable-local-peer"


@pytest.mark.asyncio
async def test_rtc_client_incoming_manifest_registers_stable_remote_peer(mock_deps):
    """Remote manifest peer_id becomes the registry/policy key."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._mesh_config = MagicMock(services={}, version_policy="compatible")
    client._peer_registry = AsyncMock()
    client._peer_send_fns["session-peer"] = MagicMock()

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
    assert client._peer_stable_ids["session-peer"] == "stable-remote-peer"
    assert client._stable_peer_sessions["stable-remote-peer"] == "session-peer"


@pytest.mark.asyncio
async def test_rtc_client_no_saved_token_no_auto_send(mock_deps):
    """With require_auth=True and no saved token, initiator sends nothing
    but starts the pairing flow in the background."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    # No saved_auth_token — peer must authenticate via pairing flow

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)

        mock_channel.emit("open")

        # No auth messages should have been sent (no auto-auth)
        assert len(mock_channel.sent_messages) == 0
        # But pairing task should have been created (we're initiator via _ensure_pc)
        assert "peer1" in client._pairing_tasks


@pytest.mark.asyncio
async def test_rtc_client_offer_receiver_no_pairing_from_local_channel(mock_deps):
    """When _ensure_pc is called without is_offer_initiator (offer receiver),
    the local DataChannel should NOT start the pairing flow."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    # No saved_auth_token

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        # Default is_offer_initiator=False (offer receiver path)
        await client._ensure_pc("peer1")

        mock_channel.emit("open")

        # No auth messages sent
        assert len(mock_channel.sent_messages) == 0
        # No pairing task — offer receiver waits for initiator's PairingStart RPC
        assert "peer1" not in client._pairing_tasks


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
async def test_rtc_client_responder_no_pairing_initiation(mock_deps):
    """Responder (received DataChannel) should NOT start pairing — waits for
    the initiator's PairingStart RPC instead."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    # No saved_auth_token

    mock_pc = MockPeerConnectionWithEvents()
    resp_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = MockDataChannel()  # initiator channel (ignored)

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=mock_pc,
    ):
        await client._ensure_pc("peer1")

        # Clear any pairing task that the initiator channel may have created
        # when we emitted open on the locally-created channel
        client._pairing_tasks.clear()

        # Simulate a remote DataChannel arriving (responder path)
        datachannel_handler = mock_pc._handlers.get("datachannel")
        assert datachannel_handler is not None, "on_datachannel handler not registered"
        datachannel_handler(resp_channel)

        # Trigger open on the responder channel
        resp_channel.emit("open")

        # Responder should NOT have started a pairing task
        assert "peer1" not in client._pairing_tasks
        # No auth messages sent either
        assert len(resp_channel.sent_messages) == 0


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
        await client._ensure_pc("peer1")

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
async def test_rtc_client_auth_failure(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    # Mock invalid token
    auth_service.authenticate_token.return_value = None

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

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

        # Failed auth sets ANONYMOUS
        identity = client._peer_acl["peer1"]
        assert identity == ANONYMOUS
        assert mock_channel.readyState == "closed"
