import asyncio
import contextlib
import json
import urllib.parse

import paho.mqtt.client as mqtt

from .base import OnMessage

_DEPARTURE_EXPIRY_SECONDS = 300
_PUBLISH_ACK_TIMEOUT_SECONDS = 2.0


class MQTTSignaling:
    def __init__(
        self,
        brokers: list[str],
        topic_root: str = "aurora",
        username: str | None = None,
        password: str | None = None,
        encrypt_presence: bool = False,
        sig_key: bytes | None = None,
        app_id: str = "",
        room: str = "",
        peer_id: str = "",
    ):
        self._brokers = brokers
        self._topic_root = topic_root
        self._username = username
        self._password = password
        self._encrypt_presence = encrypt_presence
        self._sig_key = sig_key

        try:
            from paho.mqtt.enums import CallbackAPIVersion

            self._client = mqtt.Client(CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv5)
        except (ImportError, AttributeError):
            self._client = mqtt.Client(protocol=mqtt.MQTTv5)

        self._loop: asyncio.AbstractEventLoop | None = None
        self._handlers: dict[str, OnMessage] = {}
        self._app_id = app_id
        self._room = room
        self._peer_id = peer_id
        self._connected = asyncio.Event()
        self._reconnect_lock = asyncio.Lock()
        self._subscribed = False
        self._room_joined = False
        self._room_metadata: dict = {}

    def _topic(self, channel: str, to_peer: str | None = None) -> str:
        base = f"{self._topic_root}/{self._app_id}/{self._room}/{channel}"
        return f"{base}/{to_peer}" if to_peer else base

    def _configure_presence_last_will(self) -> None:
        """Publish an authenticated departure when the process disappears."""
        if not all((self._app_id, self._room, self._peer_id)):
            return
        payload = b""
        properties = None
        if self._encrypt_presence:
            payload = self._encode_presence(
                {
                    "type": "presence_departed",
                    "app_id": self._app_id,
                    "room": self._room,
                    "peer_id": self._peer_id,
                }
            )
            properties = mqtt.Properties(mqtt.PacketTypes.WILLMESSAGE)
            properties.MessageExpiryInterval = _DEPARTURE_EXPIRY_SECONDS
        self._client.will_set(
            self._topic(f"presence/{self._peer_id}"),
            payload=payload,
            qos=1,
            retain=True,
            **({"properties": properties} if properties is not None else {}),
        )

    def _encode_presence(self, message: dict) -> bytes:
        if self._encrypt_presence:
            if not self._sig_key:
                raise RuntimeError("Encrypted MQTT presence requires a signaling key")
            from app.services.gateway.utils.crypto import aead_seal

            return aead_seal(self._sig_key, message)
        return json.dumps(message).encode()

    def _restore_joined_room(self, client: mqtt.Client | None = None) -> None:
        """Restore desired room state after an initial join or MQTT reconnect."""
        if not self._room_joined or not all((self._app_id, self._room, self._peer_id)):
            return

        active_client = client or self._client
        topics = [
            (self._topic("presence/+"), 1),
            (self._topic("offer", to_peer=self._peer_id), 0),
            (self._topic("answer", to_peer=self._peer_id), 0),
            (self._topic("candidate", to_peer=self._peer_id), 0),
            (self._topic("broadcast"), 0),
        ]
        for topic, qos in topics:
            active_client.subscribe(topic, qos=qos)

        presence_msg = {
            "type": "presence",
            "app_id": self._app_id,
            "room": self._room,
            "peer_id": self._peer_id,
            **self._room_metadata,
        }
        active_client.publish(
            self._topic(f"presence/{self._peer_id}"),
            self._encode_presence(presence_msg),
            qos=1,
            retain=True,
        )
        self._subscribed = True

    async def connect(self) -> None:
        # Store the running event loop for thread-safe callbacks
        self._loop = asyncio.get_running_loop()

        def on_connect(client, userdata, flags, rc, props=None):
            # Normalize rc to handle both int and MQTTv5 ReasonCode-style values
            rc_value = getattr(rc, "value", rc)
            if int(rc_value) == 0 and self._loop:
                # Paho automatically reconnects after transient broker/network
                # loss, but subscriptions and retained live presence must be
                # restored explicitly for clean_session-style clients.
                self._restore_joined_room(client)
                self._loop.call_soon_threadsafe(self._connected.set)

        def on_disconnect(client, userdata, *args):
            del client, userdata, args
            if self._loop:
                self._loop.call_soon_threadsafe(self._connected.clear)

        for url in self._brokers:
            # Ensure the connected event is cleared for each broker attempt
            self._connected.clear()
            try:
                # Determine transport based on URL scheme
                transport = "websockets" if url.startswith(("wss://", "ws://")) else "tcp"

                # Re-initialize client with correct transport
                try:
                    from paho.mqtt.enums import CallbackAPIVersion

                    self._client = mqtt.Client(
                        CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv5, transport=transport
                    )
                except (ImportError, AttributeError):
                    self._client = mqtt.Client(protocol=mqtt.MQTTv5, transport=transport)

                if self._username:
                    self._client.username_pw_set(self._username, self._password or "")

                # MQTT requires the Last Will to be configured before CONNECT.
                # The RTC client supplies its signaling identity at adapter
                # construction time even when room publication is deferred.
                self._configure_presence_last_will()

                self._client.on_connect = on_connect
                self._client.on_disconnect = on_disconnect
                self._client.on_message = self._on_message

                if transport == "websockets":
                    parsed = urllib.parse.urlparse(url)
                    host = parsed.hostname or "localhost"
                    default_port = 443 if parsed.scheme == "wss" else 80
                    port = parsed.port or default_port
                    path = parsed.path or "/"

                    if parsed.scheme == "wss":
                        self._client.tls_set()

                    self._client.ws_set_options(path=path)
                    self._client.connect(host=host, port=port, keepalive=30)
                else:
                    normalized = url if "://" in url else f"mqtt://{url}"
                    parsed = urllib.parse.urlparse(normalized)
                    host = parsed.hostname or "localhost"
                    port = parsed.port or 1883
                    self._client.connect(host, port, keepalive=30)

                self._client.loop_start()
                await asyncio.wait_for(self._connected.wait(), timeout=10)
                return
            except Exception as e:
                from app.helpers.aurora_logger import log_warning

                log_warning(f"Failed to connect to {url}: {e}")
                with contextlib.suppress(Exception):
                    self._client.loop_stop()
                continue
        raise RuntimeError(
            f"MQTTSignaling: failed to connect to any of the {len(self._brokers)} brokers: {self._brokers}"
        )

    async def join_room(
        self,
        app_id: str,
        room: str,
        peer_id: str,
        metadata: dict | None = None,
    ) -> None:
        self._app_id = app_id
        self._room = room
        self._peer_id = peer_id
        self._room_metadata = dict(metadata or {})
        self._room_joined = True
        reconnected = await self._ensure_connected()
        if not reconnected:
            self._restore_joined_room()

    async def _ensure_connected(self) -> bool:
        """Reconnect a dropped Paho client before refreshing room presence."""
        is_connected = getattr(self._client, "is_connected", None)
        if not callable(is_connected) or is_connected():
            return False
        async with self._reconnect_lock:
            if is_connected():
                return True
            self._connected.clear()
            result = await asyncio.to_thread(self._client.reconnect)
            if result not in (None, mqtt.MQTT_ERR_SUCCESS):
                raise RuntimeError(f"MQTT reconnect failed with result {result}")
            await asyncio.wait_for(self._connected.wait(), timeout=10)
            return True

    def on_message(self, channel: str, handler: OnMessage) -> None:
        self._handlers[channel] = handler

    def _on_message(self, client, userdata, msg):
        topic = msg.topic
        parts = topic.split("/")
        if len(parts) >= 4:
            channel = parts[3]
            # Presence subtopics (presence/{peer_id}) should route to
            # the "presence" handler via the wildcard subscription.
            if channel == "presence" and len(parts) >= 5:
                handler = self._handlers.get("presence")
                payload = msg.payload
                if not payload:
                    if self._encrypt_presence:
                        return
                    payload = json.dumps(
                        {
                            "type": "presence_departed",
                            "peer_id": parts[-1],
                        }
                    ).encode()
            else:
                handler = self._handlers.get(channel)
                payload = msg.payload
            if handler and self._loop:
                asyncio.run_coroutine_threadsafe(handler(payload), self._loop)

    async def send(self, channel: str, payload: bytes, to_peer: str | None = None) -> None:
        self._client.publish(self._topic(channel, to_peer), payload, qos=0, retain=False)

    async def leave(self) -> None:
        if self._subscribed:
            # Clear desired membership first so a concurrent automatic MQTT
            # reconnect cannot republish live presence while shutdown proceeds.
            self._room_joined = False
            # Encrypted rooms retain an authenticated tombstone. MQTT represents
            # deletion as an empty unauthenticated payload, which would let any
            # public-broker publisher forge a peer departure.
            departure_payload = (
                self._encode_presence(
                    {
                        "type": "presence_departed",
                        "app_id": self._app_id,
                        "room": self._room,
                        "peer_id": self._peer_id,
                    }
                )
                if self._encrypt_presence
                else b""
            )
            properties = None
            if self._encrypt_presence:
                properties = mqtt.Properties(mqtt.PacketTypes.PUBLISH)
                properties.MessageExpiryInterval = _DEPARTURE_EXPIRY_SECONDS
            publish_info = self._client.publish(
                self._topic(f"presence/{self._peer_id}"),
                departure_payload,
                qos=1,
                retain=True,
                **({"properties": properties} if properties is not None else {}),
            )
            wait_for_publish = getattr(publish_info, "wait_for_publish", None)
            if callable(wait_for_publish):
                try:
                    await asyncio.wait_for(
                        asyncio.to_thread(
                            wait_for_publish,
                            _PUBLISH_ACK_TIMEOUT_SECONDS,
                        ),
                        timeout=_PUBLISH_ACK_TIMEOUT_SECONDS + 0.5,
                    )
                except Exception as exc:
                    from app.helpers.aurora_logger import log_warning

                    log_warning(f"MQTT departure acknowledgement failed: {exc}")
            channels = ["presence/+", "offer", "answer", "candidate", "broadcast"]
            for ch in channels:
                to_peer = self._peer_id if ch in ("offer", "answer", "candidate") else None
                self._client.unsubscribe(self._topic(ch, to_peer=to_peer))
            self._subscribed = False
            self._room_metadata = {}

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            self._client.disconnect()
        with contextlib.suppress(Exception):
            self._client.loop_stop()
        self._connected.clear()
