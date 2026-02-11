from __future__ import annotations

import asyncio
import json
import uuid
from typing import TYPE_CHECKING, Any

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.services.db.models import Token
from app.services.gateway.acl.audit import audit_event
from app.services.gateway.acl.identity import ANONYMOUS, Identity

from ..utils.crypto import aead_open, aead_seal, derive_room_keys
from .rpc import RPCHandler
from .signaling.mqtt_client import MQTTSignaling

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.auth_service import AuthService
    from app.services.gateway.config import MeshConfig, Settings
    from app.services.gateway.mesh.peer_bridge import PeerBridge
    from app.services.gateway.mesh.peer_registry import PeerRegistry
    from app.services.gateway.registry_aggregator import RegistryAggregator

    from .signaling.base import SignalingAdapter


class RTCClient:
    def __init__(
        self,
        settings: Settings,
        bus: MessageBus,
        registry: RegistryAggregator,
        auth_service: AuthService,
    ):
        self._settings = settings
        self._bus = bus
        self._registry = registry
        self._auth_service = auth_service
        self._peer_id = str(uuid.uuid4())
        self._keys = derive_room_keys(
            settings.webrtc.password, settings.webrtc.app_id, settings.webrtc.room
        )
        self._adapter: SignalingAdapter | None = None
        self._pcs: dict[str, RTCPeerConnection] = {}
        self._peer_acl: dict[str, Identity] = {}
        self._peer_tokens: dict[str, Token] = {}  # Original tokens for re-resolution
        self._peer_timeout_tasks: dict[str, asyncio.Task] = {}  # Auth timeout tasks
        self._system_token: str | None = None
        self._auth_timeout: float = 10.0  # seconds

        # Mesh P2P attributes (set externally by GatewayService when mesh is enabled)
        self._mesh_enabled: bool = False
        self._mesh_config: MeshConfig | None = None
        self._peer_registry: PeerRegistry | None = None
        self._peer_bridge: PeerBridge | None = None
        # Per-peer DataChannel send functions for outbound messaging
        self._peer_send_fns: dict[str, Any] = {}

    async def start(self) -> None:
        self._system_token = await self._auth_service.get_system_token()
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
        # Cancel all pending auth timeout tasks
        for task in self._peer_timeout_tasks.values():
            task.cancel()
        self._peer_timeout_tasks.clear()

        for pc in list(self._pcs.values()):
            await pc.close()
        self._pcs.clear()
        self._peer_acl.clear()
        self._peer_tokens.clear()
        self._peer_send_fns.clear()

        if self._adapter:
            await self._adapter.leave()
            await self._adapter.close()
            self._adapter = None
        log_info("RTCClient closed")

    # ── Peer lifecycle helpers ───────────────────────────────────────────

    def get_connected_peers(self) -> list[dict[str, Any]]:
        """Return info about connected peers with their Identity summary."""
        peers = []
        for peer_id, pc in self._pcs.items():
            identity = self._peer_acl.get(peer_id, ANONYMOUS)
            peers.append({
                "peer_id": peer_id,
                "connection_state": pc.connectionState,
                "principal_name": identity.principal_name,
                "is_admin": identity.is_admin,
                "effective_perms": list(identity.effective_perms),
                "source": identity.source,
            })
        return peers

    async def disconnect_peer(self, peer_id: str, by_principal_id: str | None = None) -> bool:
        """Force disconnect a peer."""
        pc = self._pcs.get(peer_id)
        if not pc:
            return False
        identity = self._peer_acl.get(peer_id, ANONYMOUS)
        # Cancel auth timeout task if pending
        timeout_task = self._peer_timeout_tasks.pop(peer_id, None)
        if timeout_task:
            timeout_task.cancel()
        await pc.close()
        self._pcs.pop(peer_id, None)
        self._peer_acl.pop(peer_id, None)
        self._peer_tokens.pop(peer_id, None)
        log_info(f"Force disconnected peer {peer_id}")

        # Audit: peer force-disconnected
        await self._audit("peer.force_disconnected", identity.principal_id, {
            "peer_id": peer_id,
            "by_principal_id": by_principal_id,
        })
        return True

    async def update_peer_permissions(self, peer_id: str) -> bool:
        """Re-resolve Identity for a peer from DB (after permission change).

        Uses the *original* token scopes (not the previously resolved
        effective_perms) so that expanding user permissions correctly
        propagates through the intersection.
        """
        identity = self._peer_acl.get(peer_id)
        if not identity or identity == ANONYMOUS:
            return False
        # Re-load user and rebuild identity
        user = await self._auth_service.get_principal(identity.principal_id)
        if not user:
            return False
        from app.services.gateway.acl.identity import build_identity

        # Use the original token scopes, falling back to effective_perms
        # only if no token was stored (shouldn't happen in normal flow).
        token = self._peer_tokens.get(peer_id)
        token_scopes = token.scopes or [] if token else list(identity.effective_perms)

        new_identity = build_identity(
            user_id=user.id,
            username=user.username,
            user_permissions=user.permissions or [],
            user_is_admin=user.is_admin,
            token_scopes=token_scopes,
            device_id=identity.device_id,
            source="webrtc_peer",
        )
        self._peer_acl[peer_id] = new_identity
        return True

    # ── Internal ─────────────────────────────────────────────────────────

    async def _audit(
        self,
        event: str,
        principal_id: str | None = None,
        details: dict | None = None,
    ) -> None:
        """Fire-and-forget audit event."""
        import contextlib

        with contextlib.suppress(Exception):
            await audit_event(
                self._auth_service.db_manager,
                event,
                principal_id=principal_id,
                details=details,
            )

    # ── Mesh P2P helpers ─────────────────────────────────────────────────

    def send_to_peer(self, peer_id: str, text: str) -> bool:
        """Send a text message to a specific peer via their DataChannel.

        Args:
            peer_id: Target peer identifier
            text: JSON string to send

        Returns:
            True if the message was sent, False if peer not connected
        """
        send_fn = self._peer_send_fns.get(peer_id)
        if send_fn:
            send_fn(text)
            return True
        log_warning(f"RTCClient: No send function for peer {peer_id}")
        return False

    def configure_mesh(
        self,
        mesh_config: MeshConfig,
        peer_registry: PeerRegistry,
        peer_bridge: PeerBridge,
    ) -> None:
        """Configure mesh components on the RTCClient.

        Called by GatewayService after mesh initialization.

        Args:
            mesh_config: Mesh network configuration
            peer_registry: Registry tracking connected peers
            peer_bridge: Bridge for outbound RPC calls
        """
        self._mesh_enabled = mesh_config.enabled
        self._mesh_config = mesh_config
        self._peer_registry = peer_registry
        self._peer_bridge = peer_bridge
        log_info("RTCClient: Mesh P2P configured")

    async def _send_manifest(self, peer_id: str) -> None:
        """Send our local manifest to a peer after authentication.

        Args:
            peer_id: Target peer to send manifest to
        """
        if not self._mesh_config:
            return

        from app.services.gateway.mesh.negotiation import generate_manifest, manifest_to_dict

        manifest = generate_manifest(
            peer_id=self._peer_id,
            mesh_config=self._mesh_config,
            registry=self._registry,
        )
        msg = manifest_to_dict(manifest)
        self.send_to_peer(peer_id, json.dumps(msg))
        log_debug(f"RTCClient: Sent manifest to peer {peer_id}")

    async def _on_peer_manifest(self, peer_id: str, data: dict) -> None:
        """Process an incoming manifest from a peer.

        Updates the PeerRegistry and sends back a manifest ACK.

        Args:
            peer_id: Peer that sent the manifest
            data: Parsed manifest message
        """
        from app.services.gateway.mesh.negotiation import (
            generate_manifest_ack,
            manifest_ack_to_dict,
            parse_manifest,
        )

        manifest = parse_manifest(data)
        if not manifest:
            log_warning(f"RTCClient: Invalid manifest from peer {peer_id}")
            return

        # Update peer registry
        if self._peer_registry:
            await self._peer_registry.update_manifest(peer_id, manifest)

        # Send ACK
        if self._mesh_config:
            ack = generate_manifest_ack(manifest, self._mesh_config)
            ack_msg = manifest_ack_to_dict(ack)
            self.send_to_peer(peer_id, json.dumps(ack_msg))
            log_debug(f"RTCClient: Sent manifest ACK to peer {peer_id}")

    async def _on_manifest_ack(self, peer_id: str, data: dict) -> None:
        """Process an incoming manifest ACK from a peer.

        Logs compatibility status for diagnostics.

        Args:
            peer_id: Peer that sent the ACK
            data: Parsed manifest ACK message
        """
        from app.services.gateway.mesh.negotiation import parse_manifest_ack

        ack = parse_manifest_ack(data)
        if not ack:
            return

        log_info(
            f"RTCClient: Manifest ACK from {peer_id} — "
            f"compatible={ack.compatible_services}, "
            f"incompatible={ack.incompatible_services}, "
            f"unused={ack.unused_services}"
        )

    def _send_ping(self, peer_id: str) -> None:
        """Send a ping message to a peer for latency measurement.

        Args:
            peer_id: Target peer
        """
        import time

        msg = {
            "type": "ping",
            "id": uuid.uuid4().hex[:8],
            "ts": time.monotonic(),
        }
        self.send_to_peer(peer_id, json.dumps(msg))

    def _send_pong(self, peer_id: str, ping_data: dict) -> None:
        """Send a pong response to a peer's ping.

        Args:
            peer_id: Peer that sent the ping
            ping_data: The original ping message
        """
        msg = {
            "type": "pong",
            "id": ping_data.get("id", ""),
            "ts": ping_data.get("ts", 0),
        }
        self.send_to_peer(peer_id, json.dumps(msg))

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

        # Default to ANONYMOUS until authenticated
        self._peer_acl.setdefault(peer, ANONYMOUS)

        channel = pc.createDataChannel("aurora-rpc")

        def send_fn(text: str) -> None:
            if channel.readyState == "open":
                channel.send(text)
        # Store the send function for mesh P2P outbound messaging
        self._peer_send_fns[peer] = send_fn
        async def _rpc_audit(event: str, pid: str | None = None, details: dict | None = None) -> None:
            await self._audit(event, pid, details)

        handler = RPCHandler(
            self._bus,
            self._registry,
            send_fn,
            lambda: self._peer_acl.get(peer, ANONYMOUS),
            audit_fn=_rpc_audit,
            mesh_config=self._mesh_config,
        )

        def setup_channel(chan: Any) -> None:
            @chan.on("open")
            def on_open() -> None:
                log_info(f"DataChannel '{chan.label}' open with peer {peer}")

                # Audit: peer connected
                asyncio.create_task(self._audit("peer.connected", details={"peer_id": peer}))

                if self._system_token:
                    auth_msg = {
                        "type": "auth",
                        "peer_name": self._peer_id,
                        "token": self._system_token,
                    }
                    chan.send(json.dumps(auth_msg))

                # Auth timeout: close channel if peer doesn't authenticate in time
                async def _auth_timeout_check() -> None:
                    await asyncio.sleep(self._auth_timeout)
                    if peer not in self._pcs:
                        return  # Already disconnected
                    identity = self._peer_acl.get(peer, ANONYMOUS)
                    if identity == ANONYMOUS:
                        log_warning(f"Peer {peer} did not authenticate within {self._auth_timeout}s — disconnecting")
                        await self._audit("peer.auth_timeout", details={"peer_id": peer})
                        chan.close()

                self._peer_timeout_tasks[peer] = asyncio.create_task(_auth_timeout_check())

            @chan.on("message")
            def on_message(message: str | bytes | bytearray | memoryview) -> None:
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
                elif isinstance(message, (bytearray, memoryview)):
                    try:
                        if self._settings.webrtc.enable_app_layer_e2ee:
                            obj = aead_open(self._keys.k_data, bytes(message))
                            text = json.dumps(obj)
                        else:
                            text = bytes(message).decode()
                    except Exception as e:
                        log_error(f"Failed to decrypt/decode message from {peer}: {e}")
                        return
                else:
                    text = message

                try:
                    obj = json.loads(text)
                    if obj.get("type") == "auth":
                        token_str = obj.get("token")
                        if not token_str:
                            log_warning(f"Peer {peer} sent auth without token")
                            return

                        async def validate_peer() -> None:
                            token = await self._auth_service.authenticate_token(token_str)
                            if token:
                                identity = await self._auth_service.build_identity_from_token(
                                    token, source="webrtc_peer"
                                )
                                log_info(
                                    f"Peer {peer} authenticated as {identity.principal_name} "
                                    f"(perms={list(identity.effective_perms)})"
                                )
                                self._peer_acl[peer] = identity
                                self._peer_tokens[peer] = token  # Store for re-resolution
                                # Cancel auth timeout on successful auth
                                timeout_task = self._peer_timeout_tasks.pop(peer, None)
                                if timeout_task:
                                    timeout_task.cancel()
                                await self._audit(
                                    "peer.authenticated",
                                    identity.principal_id,
                                    {"peer_id": peer, "principal_name": identity.principal_name},
                                )

                                # Mesh: Register peer and initiate manifest exchange
                                if self._mesh_enabled and self._peer_registry:
                                    node_name = obj.get("peer_name", "")
                                    await self._peer_registry.register_peer(peer, node_name)
                                    await self._send_manifest(peer)
                                    self._send_ping(peer)
                            else:
                                log_warning(
                                    f"Peer {peer} failed authentication with token: {token_str[:8]}..."
                                )
                                await self._audit(
                                    "peer.auth_failed",
                                    details={"peer_id": peer, "token_prefix": token_str[:8]},
                                )
                                self._peer_acl[peer] = ANONYMOUS
                                chan.close()

                        asyncio.create_task(validate_peer())
                    elif obj.get("type") == "reauth":
                        # Re-authentication with a new token
                        token_str = obj.get("token")
                        if not token_str:
                            return

                        async def reauth_peer() -> None:
                            token = await self._auth_service.authenticate_token(token_str)
                            if token:
                                identity = await self._auth_service.build_identity_from_token(
                                    token, source="webrtc_peer"
                                )
                                self._peer_acl[peer] = identity
                                self._peer_tokens[peer] = token  # Update stored token
                                log_info(f"Peer {peer} re-authenticated as {identity.principal_name}")
                            else:
                                log_warning(f"Peer {peer} failed re-authentication")

                        asyncio.create_task(reauth_peer())
                    elif obj.get("type") == "manifest":
                        # Mesh: Incoming manifest from peer
                        asyncio.create_task(self._on_peer_manifest(peer, obj))
                    elif obj.get("type") == "manifest_request":
                        # Mesh: Peer is requesting our manifest
                        asyncio.create_task(self._send_manifest(peer))
                    elif obj.get("type") == "manifest_ack":
                        # Mesh: Acknowledgment of our manifest
                        asyncio.create_task(self._on_manifest_ack(peer, obj))
                    elif obj.get("type") == "ping":
                        # Mesh: Latency measurement ping
                        self._send_pong(peer, obj)
                    elif obj.get("type") == "pong":
                        # Mesh: Latency measurement pong — route to latency monitor
                        if self._peer_bridge:
                            self._peer_bridge.on_pong(peer, obj)
                    elif obj.get("type") in ("result", "error"):
                        # Mesh: Response to an outbound RPC call — route to PeerBridge
                        if self._peer_bridge:
                            self._peer_bridge.on_response(peer, obj)
                        else:
                            log_debug(f"RTCClient: Received {obj.get('type')} but no PeerBridge configured")
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
                identity = self._peer_acl.get(peer, ANONYMOUS)
                # Cancel pending auth timeout task
                timeout_task = self._peer_timeout_tasks.pop(peer, None)
                if timeout_task:
                    timeout_task.cancel()
                self._pcs.pop(peer, None)
                self._peer_acl.pop(peer, None)
                self._peer_tokens.pop(peer, None)
                self._peer_send_fns.pop(peer, None)
                # Remove from mesh peer registry
                if self._peer_registry:
                    await self._peer_registry.remove_peer(peer)
                await self._audit(
                    "peer.disconnected",
                    identity.principal_id if identity != ANONYMOUS else None,
                    {"peer_id": peer, "reason": pc.connectionState},
                )

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
