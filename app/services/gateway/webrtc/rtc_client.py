from __future__ import annotations

import asyncio
import json
import uuid
from typing import TYPE_CHECKING, Any

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp

from app.helpers.aurora_logger import log_debug, log_error, log_info
from ..utils.crypto import aead_open, aead_seal, derive_room_keys
from .rpc import RPCHandler
from .signaling.mqtt_client import MQTTSignaling

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.config import Settings
    from app.services.gateway.registry_aggregator import RegistryAggregator
    from .signaling.base import SignalingAdapter


class RTCClient:
    def __init__(self, settings: Settings, bus: MessageBus, registry: RegistryAggregator):
        self._settings = settings
        self._bus = bus
        self._registry = registry
        self._peer_id = str(uuid.uuid4())
        self._keys = derive_room_keys(
            settings.webrtc.password, settings.webrtc.app_id, settings.webrtc.room
        )
        self._adapter: SignalingAdapter | None = None
        self._pcs: dict[str, RTCPeerConnection] = {}
        self._peer_acl: dict[str, dict[str, Any]] = {}

    async def start(self) -> None:
        s = self._settings
        if s.webrtc.strategy == "mqtt":
            self._adapter = MQTTSignaling(
                brokers=s.signaling_mqtt.brokers,
                topic_root=s.signaling_mqtt.topic_root,
                username=s.signaling_mqtt.username,
                password=s.signaling_mqtt.password,
            )
        else:
            raise RuntimeError(f"Unsupported signaling strategy: {s.webrtc.strategy}")

        await self._adapter.connect()
        self._adapter.on_message("presence", self._on_presence)
        self._adapter.on_message("offer", self._on_offer)
        self._adapter.on_message("answer", self._on_answer)
        self._adapter.on_message("candidate", self._on_candidate)
        self._adapter.on_message("broadcast", self._on_broadcast)

        await self._adapter.join_room(s.webrtc.app_id, s.webrtc.room, self._peer_id)
        log_info(f"RTCClient joined room {s.webrtc.room} as {self._peer_id}")

    async def close(self) -> None:
        for pc in list(self._pcs.values()):
            await pc.close()
        self._pcs.clear()

        if self._adapter:
            await self._adapter.leave()
            await self._adapter.close()
            self._adapter = None
        log_info("RTCClient closed")

    async def _on_presence(self, payload: bytes) -> None:
        pass

    def _ice_servers(self) -> list[RTCIceServer]:
        ice_servers = [RTCIceServer(urls=self._settings.webrtc.stun_servers)]
        if self._settings.webrtc.turn_servers:
            ice_servers.append(
                RTCIceServer(
                    urls=self._settings.webrtc.turn_servers,
                    username=self._settings.webrtc.turn_username,
                    credential=self._settings.webrtc.turn_password,
                )
            )
        return ice_servers

    async def _ensure_pc(self, peer: str) -> RTCPeerConnection:
        if peer in self._pcs:
            return self._pcs[peer]

        log_debug(f"Creating new RTCPeerConnection for {peer}")
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=self._ice_servers()))
        self._pcs[peer] = pc

        self._peer_acl.setdefault(peer, {"peer_name": None, "roles": [], "perms": []})

        channel = pc.createDataChannel("aurora-rpc")

        def send_fn(text: str) -> None:
            if channel.readyState == "open":
                channel.send(text)

        handler = RPCHandler(self._bus, self._registry, send_fn, lambda: self._peer_acl[peer])

        def setup_channel(chan: Any) -> None:
            @chan.on("open")
            def on_open() -> None:
                log_info(f"DataChannel '{chan.label}' open with peer {peer}")

            @chan.on("message")
            def on_message(message: str | bytes) -> None:
                if isinstance(message, bytes):
                    try:
                        if self._settings.webrtc.enable_app_layer_e2ee:
                            obj = aead_open(self._keys.k_data, message)
                            text = json.dumps(obj)
                        else:
                            text = message.decode()
                    except Exception as e:
                        log_error(f"Failed to decrypt/decode message from {peer}: {e}")
                        return
                else:
                    text = message

                try:
                    obj = json.loads(text)
                    if obj.get("type") == "auth":
                        log_debug(f"Updating ACL for peer {peer}: {obj}")
                        self._peer_acl[peer] = {
                            "peer_name": obj.get("peer_name"),
                            "roles": obj.get("roles", []),
                            "perms": obj.get("perms", []),
                        }
                    else:
                        asyncio.create_task(handler.on_message(text))
                except Exception as e:
                    log_error(f"Error handling message from {peer}: {e}")

        setup_channel(channel)

        @pc.on("datachannel")
        def on_datachannel(chan: Any) -> None:
            log_debug(f"Received remote DataChannel '{chan.label}' from {peer}")
            if chan.label == "aurora-rpc":
                setup_channel(chan)

        @pc.on("icecandidate")
        async def on_icecandidate(event: Any) -> None:
            candidate = event.candidate
            if candidate is None or not self._adapter:
                return

            msg = {
                "type": "candidate",
                "app_id": self._settings.webrtc.app_id,
                "room": self._settings.webrtc.room,
                "from": self._peer_id,
                "to": peer,
                "candidate": candidate.to_sdp(),
            }
            sealed = aead_seal(self._keys.k_sig, msg)
            await self._adapter.send("candidate", sealed, to_peer=peer)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            log_debug(f"Connection state with {peer}: {pc.connectionState}")
            if pc.connectionState in ("failed", "closed"):
                if peer in self._pcs:
                    del self._pcs[peer]
                if peer in self._peer_acl:
                    del self._peer_acl[peer]

        return pc

    async def connect_to(self, peer: str) -> None:
        if not self._adapter:
            return

        pc = await self._ensure_pc(peer)
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        msg = {
            "type": "offer",
            "app_id": self._settings.webrtc.app_id,
            "room": self._settings.webrtc.room,
            "from": self._peer_id,
            "to": peer,
            "sdp": pc.localDescription.sdp,
        }
        sealed = aead_seal(self._keys.k_sig, msg)
        await self._adapter.send("offer", sealed, to_peer=peer)

    async def _on_offer(self, payload: bytes) -> None:
        if not self._adapter:
            return

        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_error(f"Failed to unseal offer: {e}")
            return

        peer = msg.get("from")
        if not peer:
            return

        log_debug(f"Received offer from {peer}")
        pc = await self._ensure_pc(peer)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="offer"))

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        out = {
            "type": "answer",
            "app_id": self._settings.webrtc.app_id,
            "room": self._settings.webrtc.room,
            "from": self._peer_id,
            "to": peer,
            "sdp": pc.localDescription.sdp,
        }
        sealed = aead_seal(self._keys.k_sig, out)
        await self._adapter.send("answer", sealed, to_peer=peer)

    async def _on_answer(self, payload: bytes) -> None:
        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_error(f"Failed to unseal answer: {e}")
            return

        peer = msg.get("from")
        if not peer:
            return

        log_debug(f"Received answer from {peer}")
        if peer in self._pcs:
            pc = self._pcs[peer]
            await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="answer"))

    async def _on_candidate(self, payload: bytes) -> None:
        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_error(f"Failed to unseal candidate: {e}")
            return

        peer = msg.get("from")
        cand_sdp = msg.get("candidate")
        if not peer or not cand_sdp:
            return

        try:
            candidate = candidate_from_sdp(cand_sdp)
            if peer in self._pcs:
                pc = self._pcs[peer]
                await pc.addIceCandidate(candidate)
        except Exception as e:
            log_error(f"Error adding ICE candidate from {peer}: {e}")

    async def _on_broadcast(self, payload: bytes) -> None:
        pass
