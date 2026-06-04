"""Tests for the auth enforcement gate in RTCClient.

Covers Gap 1 (require_auth wiring), Gap 2 (auth gate in on_message),
Enhancement B (pairing timeout), and Enhancement C (pairing RPC allowlist).
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gateway.acl.identity import ANONYMOUS, OPEN_PEER, Identity
from app.services.gateway.webrtc.rtc_client import RTCClient


class MockDataChannel:
    def __init__(self, label="aurora-rpc"):
        self.label = label
        self.readyState = "open"
        self.events = {}
        self.sent_messages = []
        self._closed = False

    def on(self, event_name):
        def decorator(callback):
            self.events[event_name] = callback
            return callback

        return decorator

    def send(self, message):
        self.sent_messages.append(message)

    def close(self):
        self.readyState = "closed"
        self._closed = True

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
async def test_require_auth_blocks_anonymous_messages(mock_deps):
    """With require_auth=True, non-auth messages from ANONYMOUS are dropped."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        # Peer is ANONYMOUS (default) — send a manifest message
        manifest_msg = json.dumps({"type": "manifest", "services": []})
        task = mock_channel.emit("message", manifest_msg)
        if task is not None:
            await task
        await asyncio.sleep(0.05)

        # Manifest should have been dropped — peer stays ANONYMOUS
        assert client._peer_acl.get("peer1", ANONYMOUS) == ANONYMOUS


@pytest.mark.asyncio
async def test_require_auth_allows_auth_messages(mock_deps):
    """With require_auth=True, auth messages from ANONYMOUS reach validate_peer."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    from app.services.db.models import Token

    valid_token = Token(
        id="token-id",
        token_hash="hash",
        prefix="prefix",
        device_id="device-id",
        user_id="user-id",
        scopes=["read"],
    )
    auth_service.authenticate_token.return_value = valid_token
    auth_service.build_identity_from_token.return_value = Identity(
        principal_id="user-id",
        principal_name="remote",
        is_admin=False,
        effective_perms=frozenset(["read"]),
        device_id="device-id",
        source="webrtc_peer",
    )

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        auth_payload = json.dumps({"type": "auth", "token": "valid-token"})
        task = mock_channel.emit("message", auth_payload)
        if task is not None:
            await task
        await asyncio.sleep(0.05)

        assert auth_service.authenticate_token.called
        identity = client._peer_acl.get("peer1")
        assert identity is not None
        assert identity != ANONYMOUS


@pytest.mark.asyncio
async def test_require_auth_allows_pairing_rpc(mock_deps):
    """With require_auth=True, PairingStart RPC from ANONYMOUS is allowed through."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    rpc_handler_on_message = AsyncMock()

    with (
        patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc),
        patch("app.services.gateway.webrtc.rtc_client.RPCHandler") as mock_rpc_cls,
    ):
        mock_rpc_instance = MagicMock()
        mock_rpc_instance.on_message = rpc_handler_on_message
        mock_rpc_cls.return_value = mock_rpc_instance

        await client._ensure_pc("peer1")

        # ANONYMOUS peer sends pairing RPC call
        call_msg = json.dumps(
            {
                "type": "call",
                "id": "1",
                "method": "Auth.PairingStart",
                "params": {"device_name": "test"},
            }
        )
        task = mock_channel.emit("message", call_msg)
        if task is not None:
            await task
        await asyncio.sleep(0.05)

        # The RPC handler should have received the message
        assert rpc_handler_on_message.called


@pytest.mark.asyncio
async def test_require_auth_blocks_non_pairing_rpc(mock_deps):
    """With require_auth=True, non-pairing RPC from ANONYMOUS is dropped."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    rpc_handler_on_message = AsyncMock()

    with (
        patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc),
        patch("app.services.gateway.webrtc.rtc_client.RPCHandler") as mock_rpc_cls,
    ):
        mock_rpc_instance = MagicMock()
        mock_rpc_instance.on_message = rpc_handler_on_message
        mock_rpc_cls.return_value = mock_rpc_instance

        await client._ensure_pc("peer1")

        # ANONYMOUS peer sends non-pairing RPC
        call_msg = json.dumps(
            {
                "type": "call",
                "id": "1",
                "method": "TTS.Say",
                "params": {"text": "hello"},
            }
        )
        task = mock_channel.emit("message", call_msg)
        if task is not None:
            await task
        await asyncio.sleep(0.05)

        # The RPC handler should NOT have received the message
        assert not rpc_handler_on_message.called


@pytest.mark.asyncio
async def test_no_auth_grants_open_peer(mock_deps):
    """With require_auth=False, peer gets OPEN_PEER identity on DataChannel open."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=False)
    client._system_token = "system-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        # Trigger 'open' event
        mock_channel.emit("open")
        await asyncio.sleep(0.05)

        identity = client._peer_acl.get("peer1")
        assert identity == OPEN_PEER
        # No auth message should have been sent
        auth_msgs = [m for m in mock_channel.sent_messages if json.loads(m).get("type") == "auth"]
        assert len(auth_msgs) == 0


@pytest.mark.asyncio
async def test_auth_timeout_disconnects_anonymous(mock_deps):
    """With require_auth=True, anonymous peer is disconnected after auth timeout."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._auth_timeout = 0.1  # Short timeout for testing
    client._system_token = "system-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        # Trigger 'open' event to start the timeout
        mock_channel.emit("open")
        await asyncio.sleep(0.3)  # Wait past auth timeout

        # Channel should be closed
        assert mock_channel._closed


@pytest.mark.asyncio
async def test_on_open_sends_saved_token_if_available(mock_deps):
    """With require_auth=True and a saved token, on_open sends it for auth."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._saved_auth_tokens["peer1"] = "my-saved-pairing-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")
        mock_channel.emit("open")
        await asyncio.sleep(0.05)

        # Should have sent exactly one auth message with the saved token
        auth_msgs = [
            json.loads(m) for m in mock_channel.sent_messages if json.loads(m).get("type") == "auth"
        ]
        assert len(auth_msgs) == 1
        msg = auth_msgs[0]
        assert msg["token"] == "my-saved-pairing-token"
        assert msg["peer_name"] == client._peer_id
        # No mechanism field — it's a standard DB-token auth
        assert "mechanism" not in msg or msg.get("mechanism") != "mesh_shared_secret"


@pytest.mark.asyncio
async def test_on_open_no_auto_auth_without_saved_token(mock_deps):
    """With require_auth=True and no saved token, on_open sends nothing."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    # No saved token — peer must go through pairing flow

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")
        mock_channel.emit("open")
        await asyncio.sleep(0.05)

        # No auth messages should have been sent
        auth_msgs = [
            json.loads(m) for m in mock_channel.sent_messages if json.loads(m).get("type") == "auth"
        ]
        assert len(auth_msgs) == 0
        # Peer should still be ANONYMOUS
        assert client._peer_acl.get("peer1", ANONYMOUS) == ANONYMOUS


@pytest.mark.asyncio
async def test_db_token_auth_grants_scoped_identity(mock_deps):
    """Peer sending a valid DB token from pairing gets a scoped Identity."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    from app.services.db.models import Token

    valid_token = Token(
        id="token-id",
        token_hash="hash",
        prefix="prefix",
        device_id="device-id",
        user_id="user-id",
        scopes=["TTS.Request", "STT.UserSpeechCaptured"],
    )
    auth_service.authenticate_token.return_value = valid_token
    auth_service.build_identity_from_token.return_value = Identity(
        principal_id="user-id",
        principal_name="device_aurora-remote_abc123",
        is_admin=False,
        effective_perms=frozenset(["TTS.Request", "STT.UserSpeechCaptured"]),
        device_id="device-id",
        source="webrtc_peer",
    )

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        # Peer sends DB-token auth (from a prior pairing exchange)
        auth_msg = json.dumps(
            {
                "type": "auth",
                "peer_name": "remote-peer",
                "token": "valid-pairing-token",
            }
        )
        task = mock_channel.emit("message", auth_msg)
        if task is not None:
            await task
        await asyncio.sleep(0.05)

        identity = client._peer_acl.get("peer1")
        assert identity is not None
        assert identity != ANONYMOUS
        assert identity.principal_name == "device_aurora-remote_abc123"
        assert identity.is_admin is False
        assert "TTS.Request" in identity.effective_perms
        assert "STT.UserSpeechCaptured" in identity.effective_perms


@pytest.mark.asyncio
async def test_pairing_timeout_extends_window(mock_deps):
    """When peer starts pairing, timeout is extended to pairing timeout."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._auth_timeout = 0.1
    client._pairing_timeout = 0.5
    client._system_token = "system-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        # Trigger 'open' event
        mock_channel.emit("open")

        # Simulate pairing flow starting (peer added to _peer_pairing_active)
        client._peer_pairing_active.add("peer1")

        # Wait past auth timeout but within pairing timeout
        await asyncio.sleep(0.2)

        # Channel should still be open
        assert not mock_channel._closed


@pytest.mark.asyncio
async def test_pairing_timeout_eventually_disconnects(mock_deps):
    """Even with pairing, peer is disconnected if pairing timeout expires."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._auth_timeout = 0.1
    client._pairing_timeout = 0.3
    client._system_token = "system-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1")

        mock_channel.emit("open")
        client._peer_pairing_active.add("peer1")

        # Wait past both timeouts
        await asyncio.sleep(0.6)

        # Channel should be closed
        assert mock_channel._closed


@pytest.mark.asyncio
async def test_empty_password_blocks_start_when_auth_enabled(mock_deps):
    """With require_auth=True and empty password, start() returns early."""
    settings, bus, registry, auth_service = mock_deps
    settings.webrtc.password = ""
    settings.webrtc.encrypt_signaling = False
    settings.signaling_mqtt.brokers = ["wss://broker.emqx.io:8084/mqtt"]
    settings.signaling_mqtt.topic_root = "aurora"
    settings.signaling_mqtt.username = None
    settings.signaling_mqtt.password = None

    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    with patch("app.services.gateway.webrtc.rtc_client.derive_room_keys") as mock_derive:
        await client.start()

        # derive_room_keys should NOT have been called — start aborted early
        assert not mock_derive.called


@pytest.mark.asyncio
async def test_empty_password_warns_no_auth(mock_deps):
    """With require_auth=False and empty password, start() logs warning but proceeds."""
    settings, bus, registry, auth_service = mock_deps
    settings.webrtc.password = ""
    settings.webrtc.encrypt_signaling = False
    settings.webrtc.strategy = "mqtt"
    settings.signaling_mqtt.brokers = ["wss://broker.emqx.io:8084/mqtt"]
    settings.signaling_mqtt.topic_root = "aurora"
    settings.signaling_mqtt.username = None
    settings.signaling_mqtt.password = None

    client = RTCClient(settings, bus, registry, auth_service, require_auth=False)

    with patch("app.services.gateway.webrtc.rtc_client.MQTTSignaling") as mock_mqtt:
        mock_adapter = AsyncMock()
        mock_mqtt.return_value = mock_adapter

        with patch("app.services.gateway.webrtc.rtc_client.log_warning") as mock_warn:
            await client.start()

            # Warning should have been logged about empty password
            warn_calls = [str(c) for c in mock_warn.call_args_list]
            assert any("empty" in str(c).lower() for c in warn_calls)

        # start() should have proceeded — MQTTSignaling was instantiated
        assert mock_mqtt.called


@pytest.mark.asyncio
async def test_public_broker_warning_when_auth_enabled(mock_deps):
    """With require_auth=True and public brokers, a warning is logged."""
    settings, bus, registry, auth_service = mock_deps
    settings.webrtc.password = "strong-password"
    settings.webrtc.encrypt_signaling = False
    settings.webrtc.strategy = "mqtt"
    settings.signaling_mqtt.brokers = ["wss://broker.emqx.io:8084/mqtt"]
    settings.signaling_mqtt.topic_root = "aurora"
    settings.signaling_mqtt.username = None
    settings.signaling_mqtt.password = None

    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    with (
        patch("app.services.gateway.webrtc.rtc_client.derive_room_keys"),
        patch("app.services.gateway.webrtc.rtc_client.MQTTSignaling") as mock_mqtt,
    ):
        mock_adapter = AsyncMock()
        mock_mqtt.return_value = mock_adapter

        with patch("app.services.gateway.webrtc.rtc_client.log_warning") as mock_warn:
            await client.start()

            # Check that a public broker warning was logged
            warn_calls = [str(c) for c in mock_warn.call_args_list]
            assert any("PUBLIC MQTT" in str(c) for c in warn_calls)
