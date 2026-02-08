import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.db.models import Token
from app.services.gateway.acl.identity import ANONYMOUS, Identity
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

    bus = MagicMock()
    registry = MagicMock()
    auth_service = AsyncMock()
    auth_service.get_system_token.return_value = "system-token"

    return settings, bus, registry, auth_service


@pytest.mark.asyncio
async def test_rtc_client_handshake_on_open(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    client._system_token = "system-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        # Trigger 'open' event on the channel
        mock_channel.emit("open")

        # Check if auth message was sent
        assert len(mock_channel.sent_messages) == 1
        msg = json.loads(mock_channel.sent_messages[0])
        assert msg["type"] == "auth"
        assert msg["token"] == "system-token"
        assert msg["peer_name"] == client._peer_id


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

        mock_channel.emit("message", auth_payload)

        # Wait for async validation task
        await asyncio.sleep(0.1)

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

        mock_channel.emit("message", auth_payload)

        # Wait for async validation task
        await asyncio.sleep(0.1)

        assert auth_service.authenticate_token.called

        # Failed auth sets ANONYMOUS
        identity = client._peer_acl["peer1"]
        assert identity == ANONYMOUS
        assert mock_channel.readyState == "closed"
