import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable

import paho.mqtt.client as mqtt

from .base import OnMessage


class MQTTSignaling:
    def __init__(
        self,
        brokers: list[str],
        topic_root: str = "aurora",
        username: str | None = None,
        password: str | None = None,
    ):
        self._brokers = brokers
        self._topic_root = topic_root
        self._username = username
        self._password = password

        try:
            from paho.mqtt.enums import CallbackAPIVersion

            self._client = mqtt.Client(CallbackAPIVersion.VERSION2, protocol=mqtt.MQTTv5)
        except (ImportError, AttributeError):
            self._client = mqtt.Client(protocol=mqtt.MQTTv5)

        self._loop: asyncio.AbstractEventLoop | None = None
        self._handlers: dict[str, OnMessage] = {}
        self._app_id = ""
        self._room = ""
        self._peer_id = ""
        self._connected = asyncio.Event()
        self._subscribed = False

    def _topic(self, channel: str, to_peer: str | None = None) -> str:
        base = f"{self._topic_root}/{self._app_id}/{self._room}/{channel}"
        return f"{base}/{to_peer}" if to_peer else base

    async def connect(self) -> None:
        # Store the running event loop for thread-safe callbacks
        self._loop = asyncio.get_running_loop()

        def on_connect(client, userdata, flags, rc, props=None):
            # Normalize rc to handle both int and MQTTv5 ReasonCode-style values
            rc_value = getattr(rc, "value", rc)
            if int(rc_value) == 0 and self._loop:
                self._loop.call_soon_threadsafe(self._connected.set)

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

                self._client.on_connect = on_connect
                self._client.on_message = self._on_message

                if transport == "websockets":
                    # Paho 2.0+ requires valid port for connect() even with URL, or use connect_uri if available
                    # Since connect_uri is missing, we must parse manually or use default ports
                    parsed_url = url.replace("wss://", "").replace("ws://", "")
                    if ":" in parsed_url:
                        host, port_str = parsed_url.split(":")
                        port = int(port_str.split("/")[0])
                    else:
                        host = parsed_url.split("/")[0]
                        port = 443 if url.startswith("wss://") else 80

                    # For WSS, we need to set the path if it exists
                    path = "/"
                    if "/" in parsed_url:
                        parts = parsed_url.split("/", 1)
                        if len(parts) > 1:
                            path = "/" + parts[1]

                    if url.startswith("wss://"):
                        self._client.tls_set()

                    self._client.ws_set_options(path=path)
                    self._client.connect(host=host, port=port, keepalive=30)
                else:
                    clean_url = url.replace("mqtt://", "")
                    if ":" in clean_url:
                        host, port_str = clean_url.split(":")
                        port = int(port_str)
                    else:
                        host = clean_url
                        port = 1883
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

    async def join_room(self, app_id: str, room: str, peer_id: str) -> None:
        self._app_id = app_id
        self._room = room
        self._peer_id = peer_id

        topics = [
            (self._topic("presence"), 0),
            (self._topic("offer", to_peer=peer_id), 0),
            (self._topic("answer", to_peer=peer_id), 0),
            (self._topic("candidate", to_peer=peer_id), 0),
            (self._topic("broadcast"), 0),
        ]

        for t, qos in topics:
            self._client.subscribe(t, qos=qos)

        self._subscribed = True

        presence_msg = {"type": "presence", "app_id": app_id, "room": room, "peer_id": peer_id}
        self._client.publish(
            self._topic("presence"), json.dumps(presence_msg).encode(), qos=0, retain=False
        )

    def on_message(self, channel: str, handler: OnMessage) -> None:
        self._handlers[channel] = handler

    def _on_message(self, client, userdata, msg):
        topic = msg.topic
        parts = topic.split("/")
        if len(parts) >= 4:
            channel = parts[3]
            handler = self._handlers.get(channel)
            if handler and self._loop:
                asyncio.run_coroutine_threadsafe(handler(msg.payload), self._loop)

    async def send(self, channel: str, payload: bytes, to_peer: str | None = None) -> None:
        self._client.publish(self._topic(channel, to_peer), payload, qos=0, retain=False)

    async def leave(self) -> None:
        if self._subscribed:
            channels = ["presence", "offer", "answer", "candidate", "broadcast"]
            for ch in channels:
                to_peer = self._peer_id if ch in ("offer", "answer", "candidate") else None
                self._client.unsubscribe(self._topic(ch, to_peer=to_peer))
            self._subscribed = False

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            self._client.loop_stop()
        with contextlib.suppress(Exception):
            self._client.disconnect()
