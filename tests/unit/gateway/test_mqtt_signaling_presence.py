"""Regression tests for crash-safe MQTT presence cleanup."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gateway.utils.crypto import aead_open, derive_room_keys
from app.services.gateway.webrtc.signaling.mqtt_client import MQTTSignaling


def test_presence_last_will_clears_exact_retained_session_topic():
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        app_id="private-app",
        room="private-room",
        peer_id="signaling-session",
    )
    signaling._client = MagicMock()

    signaling._configure_presence_last_will()

    signaling._client.will_set.assert_called_once_with(
        "aurora/private-app/private-room/presence/signaling-session",
        payload=b"",
        qos=1,
        retain=True,
    )


def test_encrypted_presence_last_will_is_authenticated_departure():
    keys = derive_room_keys("room-password", "private-app", "private-room")
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        encrypt_presence=True,
        sig_key=keys.k_sig,
        app_id="private-app",
        room="private-room",
        peer_id="signaling-session",
    )
    signaling._client = MagicMock()

    signaling._configure_presence_last_will()

    call = signaling._client.will_set.call_args
    assert call.args[0] == "aurora/private-app/private-room/presence/signaling-session"
    assert call.kwargs["payload"]
    assert aead_open(keys.k_sig, call.kwargs["payload"]) == {
        "type": "presence_departed",
        "app_id": "private-app",
        "room": "private-room",
        "peer_id": "signaling-session",
    }
    assert call.kwargs["qos"] == 1
    assert call.kwargs["retain"] is True
    assert call.kwargs["properties"].MessageExpiryInterval == 300


def test_encrypted_presence_requires_a_signaling_key():
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        encrypt_presence=True,
        app_id="private-app",
        room="private-room",
        peer_id="signaling-session",
    )
    signaling._client = MagicMock()

    with pytest.raises(RuntimeError, match="requires a signaling key"):
        signaling._configure_presence_last_will()


@pytest.mark.asyncio
async def test_encrypted_presence_ignores_empty_retained_payload():
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        encrypt_presence=True,
    )
    signaling._loop = asyncio.get_running_loop()
    handler = AsyncMock()
    signaling.on_message("presence", handler)

    signaling._on_message(
        None,
        None,
        SimpleNamespace(
            topic="aurora/private-app/private-room/presence/dead-session",
            payload=b"",
        ),
    )
    await asyncio.sleep(0)

    handler.assert_not_awaited()


@pytest.mark.asyncio
async def test_empty_retained_presence_reports_departed_peer_from_topic():
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        app_id="private-app",
        room="private-room",
        peer_id="local-peer",
    )
    signaling._loop = asyncio.get_running_loop()
    received = asyncio.Event()
    payloads: list[dict[str, str]] = []

    async def handle_presence(payload: bytes) -> None:
        payloads.append(json.loads(payload))
        received.set()

    signaling.on_message("presence", handle_presence)
    signaling._on_message(
        None,
        None,
        SimpleNamespace(
            topic="aurora/private-app/private-room/presence/dead-session",
            payload=b"",
        ),
    )

    await asyncio.wait_for(received.wait(), timeout=1.0)
    assert payloads == [
        {
            "type": "presence_departed",
            "app_id": "private-app",
            "room": "private-room",
            "peer_id": "dead-session",
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "topic",
    [
        "other/private-app/private-room/broadcast",
        "aurora/other-app/private-room/broadcast",
        "aurora/private-app/other-room/broadcast",
        "aurora/private-app/private-room/offer/other-peer",
        "aurora/private-app/private-room/answer/local-peer/extra",
        "aurora/private-app/private-room/presence/peer/extra",
    ],
)
async def test_mqtt_signaling_rejects_messages_outside_exact_room_route(topic):
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        app_id="private-app",
        room="private-room",
        peer_id="local-peer",
    )
    signaling._loop = asyncio.get_running_loop()
    handler = AsyncMock()
    for channel in ("presence", "offer", "answer", "candidate", "broadcast"):
        signaling.on_message(channel, handler)

    signaling._on_message(None, None, SimpleNamespace(topic=topic, payload=b"frame"))
    await asyncio.sleep(0)

    handler.assert_not_awaited()


@pytest.mark.asyncio
async def test_mqtt_signaling_accepts_exact_direct_recipient_route():
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        topic_root="custom/root",
        app_id="private-app",
        room="private-room",
        peer_id="local-peer",
    )
    signaling._loop = asyncio.get_running_loop()
    received = asyncio.Event()

    async def handler(payload: bytes) -> None:
        assert payload == b"frame"
        received.set()

    signaling.on_message("offer", handler)

    signaling._on_message(
        None,
        None,
        SimpleNamespace(
            topic="custom/root/private-app/private-room/offer/local-peer",
            payload=b"frame",
        ),
    )
    await asyncio.wait_for(received.wait(), timeout=1.0)


@pytest.mark.asyncio
async def test_signaling_departure_during_negotiation_closes_and_suppresses_pc_retry():
    rtc_client = MagicMock()
    rtc_client._peer_reconnect_tasks = {}
    rtc_client._negotiation_watchdogs = {}
    rtc_client._offer_in_progress = set()
    rtc_client._pcs = {}
    rtc_client._reconnect_suppressed_pcs = set()
    rtc_client._cancel_negotiation_watchdog = MagicMock()
    rtc_client._stable_peer_id_for_session = MagicMock(return_value="stable-dead")
    events: list[str] = []
    rtc_client._send_local_provider_unavailable = AsyncMock(
        side_effect=lambda *_args, **_kwargs: events.append("unavailable") or True
    )
    rtc_client._invalidate_provider_export_peer = MagicMock(
        side_effect=lambda *_args, **_kwargs: events.append("invalidate")
    )

    async def close_peer_connection(connection):
        await connection.close()

    rtc_client._close_peer_connection = AsyncMock(side_effect=close_peer_connection)

    # Exercise the real unbound helper without constructing aiortc state.
    from app.services.gateway.webrtc.rtc_client import RTCClient

    peer = "dead-session"
    pc = MagicMock()
    pc.close = AsyncMock()
    rtc_client._pcs[peer] = pc
    retry_task = asyncio.create_task(asyncio.sleep(60))
    rtc_client._peer_reconnect_tasks[peer] = retry_task

    await RTCClient._handle_signaling_departure(
        rtc_client,
        peer,
        reason="test departure",
    )

    assert retry_task.cancelled()
    assert pc in rtc_client._reconnect_suppressed_pcs
    rtc_client._send_local_provider_unavailable.assert_awaited_once_with(
        "stable-dead",
        reason_code="peer_departed",
        session_peer_id=peer,
    )
    rtc_client._invalidate_provider_export_peer.assert_called_once_with(
        "stable-dead",
        notify_provider_unavailable=False,
    )
    assert events == ["unavailable", "invalidate"]
    rtc_client._close_peer_connection.assert_awaited_once_with(pc)
    pc.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_signaling_departure_preserves_open_data_channel():
    rtc_client = MagicMock()
    rtc_client._peer_reconnect_tasks = {}
    rtc_client._negotiation_watchdogs = {}
    rtc_client._offer_in_progress = set()
    rtc_client._pcs = {}
    rtc_client._peer_data_channels = {}
    rtc_client._reconnect_suppressed_pcs = set()
    rtc_client._cancel_negotiation_watchdog = MagicMock()
    rtc_client._stable_peer_id_for_session = MagicMock(return_value="stable-live")
    rtc_client._send_local_provider_unavailable = AsyncMock()
    rtc_client._invalidate_provider_export_peer = MagicMock()
    rtc_client._close_peer_connection = AsyncMock()

    from app.services.gateway.webrtc.rtc_client import RTCClient

    peer = "live-session"
    pc = MagicMock()
    channel = MagicMock()
    channel.readyState = "open"
    rtc_client._pcs[peer] = pc
    rtc_client._peer_data_channels[peer] = channel
    retry_task = asyncio.create_task(asyncio.sleep(60))
    rtc_client._peer_reconnect_tasks[peer] = retry_task

    await RTCClient._handle_signaling_departure(
        rtc_client,
        peer,
        reason="broker will",
    )

    assert retry_task.cancelled()
    assert pc not in rtc_client._reconnect_suppressed_pcs
    rtc_client._send_local_provider_unavailable.assert_not_awaited()
    rtc_client._invalidate_provider_export_peer.assert_not_called()
    rtc_client._close_peer_connection.assert_not_awaited()


@pytest.mark.asyncio
async def test_mqtt_reconnect_restores_room_subscriptions_and_live_presence():
    """A broker reconnect must make an already-joined peer discoverable again."""
    keys = derive_room_keys("room-password", "private-app", "private-room")
    mqtt_client = MagicMock()

    def complete_connect(*_args, **_kwargs):
        mqtt_client.on_connect(mqtt_client, None, None, 0)

    mqtt_client.connect.side_effect = complete_connect

    with patch(
        "app.services.gateway.webrtc.signaling.mqtt_client.mqtt.Client",
        return_value=mqtt_client,
    ):
        signaling = MQTTSignaling(
            ["mqtt://localhost:1883"],
            encrypt_presence=True,
            sig_key=keys.k_sig,
            app_id="private-app",
            room="private-room",
            peer_id="signaling-session",
        )
        await signaling.connect()

        # Connecting alone must not publish room membership before join_room.
        mqtt_client.subscribe.assert_not_called()
        mqtt_client.publish.assert_not_called()

        await signaling.join_room(
            "private-app",
            "private-room",
            "signaling-session",
            {"stable_peer_id": "stable-peer", "node_name": "Aurora 2"},
        )

        mqtt_client.subscribe.reset_mock()
        mqtt_client.publish.reset_mock()

        # Paho invokes the same callback after an automatic network reconnect.
        mqtt_client.on_connect(mqtt_client, None, None, 0)

    assert mqtt_client.subscribe.call_count == 5
    mqtt_client.publish.assert_called_once()
    publish_call = mqtt_client.publish.call_args
    assert publish_call.args[0] == ("aurora/private-app/private-room/presence/signaling-session")
    assert aead_open(keys.k_sig, publish_call.args[1]) == {
        "type": "presence",
        "app_id": "private-app",
        "room": "private-room",
        "peer_id": "signaling-session",
        "stable_peer_id": "stable-peer",
        "node_name": "Aurora 2",
    }
    assert publish_call.kwargs == {"qos": 1, "retain": True}


@pytest.mark.asyncio
async def test_presence_refresh_reconnects_a_dropped_client_before_republishing():
    """The periodic refresh must recover when Paho stays disconnected."""
    keys = derive_room_keys("room-password", "private-app", "private-room")
    mqtt_client = MagicMock()
    mqtt_client.is_connected.return_value = True

    def complete_connect(*_args, **_kwargs):
        mqtt_client.on_connect(mqtt_client, None, None, 0)

    mqtt_client.connect.side_effect = complete_connect

    with patch(
        "app.services.gateway.webrtc.signaling.mqtt_client.mqtt.Client",
        return_value=mqtt_client,
    ):
        signaling = MQTTSignaling(
            ["mqtt://localhost:1883"],
            encrypt_presence=True,
            sig_key=keys.k_sig,
            app_id="private-app",
            room="private-room",
            peer_id="signaling-session",
        )
        await signaling.connect()
        await signaling.join_room(
            "private-app",
            "private-room",
            "signaling-session",
            {"stable_peer_id": "stable-peer", "node_name": "Aurora 2"},
        )
        mqtt_client.subscribe.reset_mock()
        mqtt_client.publish.reset_mock()

        mqtt_client.is_connected.return_value = False
        mqtt_client.on_disconnect(mqtt_client, None, 1)

        def complete_reconnect():
            mqtt_client.is_connected.return_value = True
            mqtt_client.on_connect(mqtt_client, None, None, 0)
            return 0

        mqtt_client.reconnect.side_effect = complete_reconnect
        await signaling.join_room(
            "private-app",
            "private-room",
            "signaling-session",
            {"stable_peer_id": "stable-peer", "node_name": "Aurora 2"},
        )

    mqtt_client.reconnect.assert_called_once_with()
    assert mqtt_client.subscribe.call_count == 5
    mqtt_client.publish.assert_called_once()
    publish_call = mqtt_client.publish.call_args
    assert publish_call.args[0] == ("aurora/private-app/private-room/presence/signaling-session")
    assert aead_open(keys.k_sig, publish_call.args[1])["stable_peer_id"] == "stable-peer"
    assert publish_call.kwargs == {"qos": 1, "retain": True}


@pytest.mark.asyncio
async def test_graceful_leave_waits_for_tombstone_before_unsubscribe_and_disconnect():
    """The authenticated retained departure must be acknowledged before shutdown."""
    keys = derive_room_keys("room-password", "private-app", "private-room")
    signaling = MQTTSignaling(
        ["mqtt://localhost:1883"],
        encrypt_presence=True,
        sig_key=keys.k_sig,
        app_id="private-app",
        room="private-room",
        peer_id="signaling-session",
    )
    mqtt_client = MagicMock()
    publish_info = MagicMock()
    events: list[str] = []
    mqtt_client.publish.return_value = publish_info
    publish_info.wait_for_publish.side_effect = lambda timeout=None: events.append("published")
    mqtt_client.unsubscribe.side_effect = lambda *_args, **_kwargs: events.append("unsubscribed")
    mqtt_client.disconnect.side_effect = lambda *_args, **_kwargs: events.append("disconnected")
    mqtt_client.loop_stop.side_effect = lambda *_args, **_kwargs: events.append("loop-stopped")
    signaling._client = mqtt_client
    signaling._room_joined = True
    signaling._subscribed = True

    await signaling.leave()
    await signaling.close()

    assert events[0] == "published"
    assert events.index("published") < events.index("unsubscribed")
    assert events.index("disconnected") < events.index("loop-stopped")
    publish_info.wait_for_publish.assert_called_once()
