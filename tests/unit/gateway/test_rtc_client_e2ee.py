import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gateway.acl.identity import ANONYMOUS
from app.services.gateway.utils.crypto import aead_open, aead_seal
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
            return self.events[event_name](*args, **kwargs)
        return None


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
async def test_send_to_peer_plaintext_when_e2ee_disabled(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=False)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

    assert client.send_to_peer("peer1", json.dumps({"type": "ping"})) is True
    assert mock_channel.sent_messages == ['{"type": "ping"}']


@pytest.mark.asyncio
async def test_send_to_peer_seals_binary_when_e2ee_enabled(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    settings.webrtc.enable_app_layer_e2ee = True
    client = RTCClient(settings, bus, registry, auth_service, require_auth=False)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

    assert client.send_to_peer("peer1", json.dumps({"type": "ping", "id": "abc"})) is True
    sent = mock_channel.sent_messages[0]
    assert isinstance(sent, bytes)
    assert aead_open(client._keys.k_data, sent) == {"type": "ping", "id": "abc"}


@pytest.mark.asyncio
async def test_inbound_encrypted_message_processed_when_e2ee_enabled(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    settings.webrtc.enable_app_layer_e2ee = True
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    auth_service.authenticate_token.return_value = None

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

    encrypted = aead_seal(client._keys.k_data, {"type": "auth", "token": "valid-token"})
    task = mock_channel.emit("message", encrypted)
    if task is not None:
        await task
    await asyncio.sleep(0.05)

    assert auth_service.authenticate_token.called


@pytest.mark.asyncio
async def test_inbound_plaintext_dropped_when_e2ee_enabled(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    settings.webrtc.enable_app_layer_e2ee = True
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

    task = mock_channel.emit("message", json.dumps({"type": "auth", "token": "valid-token"}))
    if task is not None:
        await task
    await asyncio.sleep(0.05)

    assert not auth_service.authenticate_token.called
    assert client._peer_acl.get("peer1", ANONYMOUS) == ANONYMOUS
