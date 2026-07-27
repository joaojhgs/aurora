"""Tests for the auth enforcement gate in RTCClient.

Covers Gap 1 (require_auth wiring), Gap 2 (auth gate in on_message),
Enhancement B (pairing timeout), and Enhancement C (pairing RPC allowlist).
"""

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gateway.acl.identity import ANONYMOUS, OPEN_PEER, Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.webrtc.rtc_client import RTCClient
from app.shared.contracts.models.tooling import ToolingMethods
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


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


class MockPeerConnectionWithEvents:
    def __init__(self, channel: MockDataChannel):
        self.connectionState = "new"
        self.events = {}
        self.createDataChannel = MagicMock(return_value=channel)
        self.close = AsyncMock(side_effect=self._close)

    def on(self, event_name):
        def decorator(callback):
            self.events[event_name] = callback
            return callback

        return decorator

    async def _close(self):
        self.connectionState = "closed"
        callback = self.events.get("connectionstatechange")
        if callback:
            await callback()


def install_pairing_transport(
    client: RTCClient,
    peer: str,
    pc: Any,
    *,
    remote_stable_peer_id: str = "stable-remote-peer",
) -> None:
    """Install the complete SDP transcript required before channel auth opens."""
    client._pairing_transports[peer] = {
        "pc": pc,
        "offerer_signaling_id": client._peer_id,
        "answerer_signaling_id": peer,
        "offer_sdp": "v=0\r\na=fingerprint:sha-256 11:22\r\n",
        "answer_sdp": "v=0\r\na=fingerprint:sha-256 33:44\r\n",
        "remote_stable_peer_id": remote_stable_peer_id,
        "remote_node_name": "Remote Aurora",
    }
    client._remember_claimed_peer_identity(peer, remote_stable_peer_id, "Remote Aurora")


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
        await client._ensure_pc("peer1", is_offer_initiator=True)

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
        await client._ensure_pc("peer1", is_offer_initiator=True)

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

        await client._ensure_pc("peer1", is_offer_initiator=True)

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

        await client._ensure_pc("peer1", is_offer_initiator=True)

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
        await client._ensure_pc("peer1", is_offer_initiator=True)

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
    client._saved_auth_tokens["peer1"] = "unanswered-saved-token"

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel
    mock_pc.close = AsyncMock()

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", mock_pc)

        # Trigger 'open' event to start the timeout
        mock_channel.emit("open")
        await asyncio.sleep(0.3)  # Wait past auth timeout

        # The whole peer connection must close so lifecycle cleanup can run.
        mock_pc.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_on_open_challenges_saved_peer_without_sending_bearer(mock_deps):
    """Saved credentials remain local until an SDP-bound challenge arrives."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    client._saved_auth_tokens["stable-remote-peer"] = {
        "token": "my-saved-pairing-token",
        "token_id": "token-selector",
    }

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", mock_pc)
        mock_channel.emit("open")
        await asyncio.sleep(0.05)

        assert len(mock_channel.sent_messages) == 1
        msg = json.loads(mock_channel.sent_messages[0])
        assert msg["type"] == "mesh_auth_challenge_v1"
        assert "token" not in msg
        assert "my-saved-pairing-token" not in mock_channel.sent_messages[0]


@pytest.mark.asyncio
async def test_on_open_challenges_new_peer_without_granting_identity(mock_deps):
    """New peers receive a challenge and remain anonymous until proof/pairing."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._system_token = "system-token"
    # No saved token — peer must go through pairing flow

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", mock_pc)
        mock_channel.emit("open")
        await asyncio.sleep(0.05)

        assert len(mock_channel.sent_messages) == 1
        assert json.loads(mock_channel.sent_messages[0])["type"] == "mesh_auth_challenge_v1"
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
        await client._ensure_pc("peer1", is_offer_initiator=True)

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
async def test_forwarded_tooling_catalog_uses_authenticated_stable_peer_id(mock_deps):
    """Forwarded catalog keys must use stable mesh identity, not signaling session id."""

    settings, bus, registry, auth_service = mock_deps
    bus.publish = AsyncMock()
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)

    signaling_peer_id = "ephemeral-signaling-session"
    stable_peer_id = "stable-mesh-peer"
    identity = Identity(
        principal_id="remote-user",
        principal_name="remote-user",
        is_admin=False,
        effective_perms=frozenset(["Tooling.use"]),
        source="webrtc_peer",
    )

    channel = MockDataChannel()
    peer_connection = MockPeerConnectionWithEvents(channel)

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=peer_connection,
    ):
        await client._ensure_pc(signaling_peer_id, is_offer_initiator=True)
        client._remember_stable_peer_id(signaling_peer_id, stable_peer_id, "Remote Aurora")
        client._peer_acl[signaling_peer_id] = identity
        client._peer_acl[stable_peer_id] = identity
        client._rpc_handlers[signaling_peer_id]._mesh_config = MeshConfig(
            enabled=True,
            services={"Tooling": mesh_policy(share=True)},
        )
        peer_connection.connectionState = "connected"

        task = channel.emit(
            "message",
            json.dumps(
                {
                    "type": "event",
                    "topic": ToolingMethods.PROJECTION_INVALIDATED,
                    "params": {
                        "provider_peer_id": "forged-peer",
                        "service_instance_id": "remote:forged-peer:Tooling",
                        "authority_revision": {
                            "catalog_revision": 1,
                            "export_policy_revision": 2,
                            "auth_grant_revision": 3,
                            "manifest_revision": 4,
                            "switch_revision": 5,
                        },
                        "reason_code": "policy_changed",
                        "correlation_id": "catalog-sync-1",
                    },
                    "correlation_id": "catalog-sync-1",
                }
            ),
        )
        if task is not None:
            await task
        await asyncio.sleep(0.05)

    bus.publish.assert_awaited_once()
    topic, payload = bus.publish.await_args.args[:2]
    assert topic == ToolingMethods.PROJECTION_INVALIDATED
    assert payload["service_instance_id"] == f"remote:{stable_peer_id}:Tooling"
    assert payload["provider_peer_id"] == stable_peer_id
    assert payload["authority_revision"]["auth_grant_revision"] == 3
    assert bus.publish.await_args.kwargs["caller_peer_id"] == stable_peer_id


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
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", mock_pc)

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
    client._run_bilateral_pairing = AsyncMock()

    mock_pc = MagicMock()
    mock_channel = MockDataChannel()
    mock_pc.createDataChannel.return_value = mock_channel
    mock_pc.close = AsyncMock()

    with patch("app.services.gateway.webrtc.rtc_client.RTCPeerConnection", return_value=mock_pc):
        await client._ensure_pc("peer1", is_offer_initiator=True)
        install_pairing_transport(client, "peer1", mock_pc)

        mock_channel.emit("open")
        client._peer_pairing_active.add("peer1")

        # Wait past both timeouts
        await asyncio.sleep(0.6)

        # The whole peer connection must close, not only the DataChannel.
        mock_pc.close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("local_peer_id", "should_retry"),
    [("a-local-initiator", True), ("z-local-responder", False)],
)
async def test_pairing_timeout_cleans_transport_and_retries_from_tie_breaker(
    mock_deps,
    local_peer_id,
    should_retry,
):
    """Pairing expiry removes the stale PC and lets one side issue a fresh offer."""
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service, require_auth=True)
    client._peer_id = local_peer_id
    client._auth_timeout = 0.01
    client._pairing_timeout = 0.03
    client._pairing_retry_delay = 0.0
    client._adapter = MagicMock()
    client._audit = AsyncMock()
    client.connect_to = AsyncMock()
    client._run_bilateral_pairing = AsyncMock()

    channel = MockDataChannel()
    peer_connection = MockPeerConnectionWithEvents(channel)

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=peer_connection,
    ):
        await client._ensure_pc("m-remote-peer", is_offer_initiator=True)
        install_pairing_transport(client, "m-remote-peer", peer_connection)
        channel.emit("open")
        client._peer_pairing_active.add("m-remote-peer")

        await asyncio.sleep(0.2)

    peer_connection.close.assert_awaited_once()
    assert "m-remote-peer" not in client._pcs
    assert "m-remote-peer" not in client._peer_data_channels
    assert "m-remote-peer" not in client._peer_pairing_active
    if should_retry:
        client.connect_to.assert_awaited_once_with("m-remote-peer")
    else:
        client.connect_to.assert_not_awaited()


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
