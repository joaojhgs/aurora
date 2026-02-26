from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from typing import TYPE_CHECKING, Any

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.services.gateway.acl.audit import audit_event
from app.services.gateway.acl.identity import ANONYMOUS, OPEN_PEER, Identity
from app.shared.models.db import Token

from ..utils.crypto import aead_open, aead_seal, derive_room_keys
from .rpc import RPCHandler
from .signaling.mqtt_client import MQTTSignaling

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
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
        auth_service: Any,
        require_auth: bool = False,
    ):
        self._settings = settings
        self._bus = bus
        self._registry = registry
        self._auth_service = auth_service
        self._require_auth: bool = require_auth
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
        self._peer_pairing_active: set[str] = set()  # Peers in active pairing flow
        self._pairing_timeout: float = 300.0  # Set from config
        # Per-peer saved tokens from prior pairing exchanges — sent on reconnect
        # to authenticate as a returning (previously approved) peer.
        # Keyed by stable mesh peer_id → token string.
        self._saved_auth_tokens: dict[str, str] = {}
        # Callback invoked with (token_str) when pairing succeeds
        self._on_token_saved: Any = None
        # Pending outbound RPC calls (for pairing flow)
        self._pending_rpc: dict[str, asyncio.Future] = {}
        # Active pairing tasks (peer_id → task) for cancellation on disconnect
        self._pairing_tasks: dict[str, asyncio.Task] = {}

        # Mesh P2P attributes (set externally by GatewayService when mesh is enabled)
        self._mesh_enabled: bool = False
        self._mesh_config: MeshConfig | None = None
        self._peer_registry: PeerRegistry | None = None
        self._peer_bridge: PeerBridge | None = None
        # Per-peer DataChannel send functions for outbound messaging
        self._peer_send_fns: dict[str, Any] = {}
        # Per-peer DataChannel objects (for reverse-pairing / bilateral auth)
        self._peer_data_channels: dict[str, Any] = {}
        # Per-peer human-readable names (Fix 6)
        self._peer_names: dict[str, str] = {}

    _PUBLIC_BROKERS = {"broker.emqx.io", "test.mosquitto.org"}

    def _peer_label(self, peer: str) -> str:
        """Human-readable label for a peer: 'node-name (a1b2c3d4)' or 'a1b2c3d4…'."""
        name = self._peer_names.get(peer, "")
        short = peer[:8]
        return f"{name} ({short})" if name else f"{short}…"

    def set_saved_auth_token(self, token: str | None) -> None:
        """Set a single saved auth token (legacy/fallback).

        Stores the token under a special ``_default`` key so it is sent
        on reconnect when we cannot identify the remote peer yet.

        Args:
            token: The plain-text token string, or None to clear.
        """
        if token:
            self._saved_auth_tokens["_default"] = token
        else:
            self._saved_auth_tokens.pop("_default", None)

    def set_saved_peer_tokens(self, creds: dict[str, str]) -> None:
        """Set per-peer saved tokens from a prior pairing exchange.

        Called on startup with credentials loaded from the DB.

        Args:
            creds: Mapping of stable mesh ``peer_id`` → token string.
        """
        self._saved_auth_tokens.update(creds)

    def set_on_token_saved(self, callback: Any) -> None:
        """Set a callback invoked when pairing completes and a token is received.

        The callback receives ``(token_str, remote_device_id, remote_user_id)``
        and should persist the token to the database so it can be reloaded on
        next startup.

        Args:
            callback: Async callable accepting token string and optional
                remote_device_id/remote_user_id.
        """
        self._on_token_saved = callback

    async def start(self) -> None:
        # Gap 3A: Validate room password when auth is required
        if self._require_auth and not self._settings.webrtc.password:
            log_error(
                "WebRTC room password is empty but auth is enabled. "
                "Set 'gateway.webrtc.password' in config.json to a strong random value. "
                "WebRTC client will NOT start."
            )
            return

        if not self._require_auth and not self._settings.webrtc.password:
            log_warning(
                "WebRTC room password is empty. Signaling encryption is weak. "
                "Consider setting 'gateway.webrtc.password' in config.json."
            )

        self._system_token = await self._auth_service.get_system_token()
        s = self._settings
        if s.webrtc.strategy == "mqtt":
            self._adapter = MQTTSignaling(
                brokers=s.signaling_mqtt.brokers,
                topic_root=s.signaling_mqtt.topic_root,
                username=s.signaling_mqtt.username,
                password=s.signaling_mqtt.password,
                encrypt_presence=s.webrtc.encrypt_signaling,
                sig_key=self._keys.k_sig,
            )
        else:
            raise RuntimeError(f"Unsupported signaling strategy: {s.webrtc.strategy}")

        await self._adapter.connect()

        # Gap 3D: Warn about public brokers when auth is enabled
        broker_hosts = {
            b.split("://")[-1].split(":")[0].split("/")[0] for b in s.signaling_mqtt.brokers
        }
        if self._require_auth and broker_hosts & self._PUBLIC_BROKERS:
            log_warning(
                "Auth is enabled but using PUBLIC MQTT brokers. "
                "Anyone can see signaling traffic. "
                "Use a private MQTT broker for production deployments."
            )

        self._adapter.on_message("presence", self._on_presence)
        self._adapter.on_message("offer", self._on_offer)
        self._adapter.on_message("answer", self._on_answer)
        self._adapter.on_message("candidate", self._on_candidate)
        self._adapter.on_message("broadcast", self._on_broadcast)

        await self._adapter.join_room(s.webrtc.app_id, s.webrtc.room, self._peer_id)
        log_info(f"RTCClient joined room {s.webrtc.room} as {self._peer_id}")

    async def close(self) -> None:
        # Broadcast graceful departure before tearing down connections
        if self._mesh_enabled and self._adapter:
            with contextlib.suppress(Exception):
                await self.send_broadcast("peer_leaving", {"peer_id": self._peer_id})

        # Cancel all pending auth timeout tasks
        for task in self._peer_timeout_tasks.values():
            task.cancel()
        self._peer_timeout_tasks.clear()

        for pc in list(self._pcs.values()):
            await pc.close()
        self._pcs.clear()
        self._peer_acl.clear()
        self._peer_tokens.clear()
        self._saved_auth_tokens.clear()
        self._peer_send_fns.clear()
        self._peer_data_channels.clear()
        self._peer_names.clear()

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
            peers.append(
                {
                    "peer_id": peer_id,
                    "connection_state": pc.connectionState,
                    "principal_name": identity.principal_name,
                    "is_admin": identity.is_admin,
                    "effective_perms": list(identity.effective_perms),
                    "source": identity.source,
                }
            )
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
        await self._audit(
            "peer.force_disconnected",
            identity.principal_id,
            {
                "peer_id": peer_id,
                "by_principal_id": by_principal_id,
            },
        )
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
            True if the message was sent, False if peer not connected or send failed
        """
        send_fn = self._peer_send_fns.get(peer_id)
        if send_fn:
            try:
                send_fn(text)
                return True
            except Exception as e:
                log_warning(f"RTCClient: Failed to send to peer {peer_id}: {e}")
                return False
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

        Stores compatibility data in the PeerRegistry for diagnostics
        and future routing optimization.

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

        # Store compatibility report in peer registry
        if self._peer_registry:
            await self._peer_registry.update_manifest_ack(peer_id, ack)

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

    async def _on_capacity_update(self, peer_id: str, data: dict) -> None:
        """Handle an incoming capacity update from a peer.

        Updates the peer's active call count in the registry so the
        routing table can make informed decisions.

        Args:
            peer_id: Peer that sent the update
            data: Parsed capacity_update message with 'module', 'available', 'max_concurrent'
        """
        if not self._peer_registry:
            return

        module = data.get("module", "")
        available = data.get("available", 0)
        max_concurrent = data.get("max_concurrent", 0)
        log_debug(f"RTCClient: Capacity update from {peer_id}: {module} available={available}")

        # Derive active calls: active = max - available
        if max_concurrent > 0:
            active_calls = max(0, max_concurrent - available)
            await self._peer_registry.set_active_calls(peer_id, active_calls)

    def send_capacity_update(
        self, peer_id: str, module: str, available: int, max_concurrent: int
    ) -> bool:
        """Send a capacity update to a peer.

        Args:
            peer_id: Target peer
            module: Service module whose capacity changed
            available: Current available capacity
            max_concurrent: Total max concurrent calls

        Returns:
            True if sent, False if peer not connected
        """
        msg = {
            "type": "capacity_update",
            "module": module,
            "available": available,
            "max_concurrent": max_concurrent,
        }
        return self.send_to_peer(peer_id, json.dumps(msg))

    def broadcast_capacity_update(self, module: str, available: int, max_concurrent: int) -> None:
        """Broadcast a capacity update to ALL connected mesh peers.

        Called when local service capacity changes (call started or finished).

        Args:
            module: Service module whose capacity changed
            available: Current available capacity
            max_concurrent: Total max concurrent calls
        """
        if not self._mesh_enabled or not self._peer_registry:
            return
        for peer in self._peer_registry.get_negotiated_peers():
            self.send_capacity_update(peer.peer_id, module, available, max_concurrent)

    async def send_broadcast(self, event: str, data: dict | None = None) -> None:
        """Send an encrypted broadcast to all peers in the signaling room.

        Broadcasts go through the MQTT signaling layer, not DataChannels,
        so they reach even peers we haven't finished WebRTC setup with yet.

        Args:
            event: Event name (e.g., "peer_leaving", "manifest_changed")
            data: Additional data to include in the broadcast
        """
        if not self._adapter:
            return

        msg: dict = {
            "type": "mesh_event",
            "from": self._peer_id,
            "event": event,
            **(data or {}),
        }
        sealed = aead_seal(self._keys.k_sig, msg)
        await self._adapter.send("broadcast", sealed)

    async def reannounce_manifest(self) -> None:
        """Re-send our manifest to all negotiated peers.

        Called periodically by MeshAnnouncer or when local contracts change.
        """
        if not self._mesh_enabled or not self._peer_registry:
            return

        peers = self._peer_registry.get_negotiated_peers()
        for peer in peers:
            await self._send_manifest(peer.peer_id)

        if peers:
            log_debug(f"RTCClient: Re-announced manifest to {len(peers)} peers")

    async def _on_presence(self, payload: bytes) -> None:
        """Handle an incoming presence announcement from the signaling room.

        When a new peer announces itself, we initiate a WebRTC connection
        to it. To avoid a "glare" condition (both peers sending offers
        simultaneously), only the peer with the lexicographically lower
        ID initiates the connection. The other peer will receive the
        offer and reply with an answer.

        Presence messages are published as MQTT retained messages on
        per-peer subtopics (``presence/{peer_id}``), so late joiners
        automatically receive them upon subscribing.

        An empty payload indicates a peer has left (retained message cleared).
        """
        # Empty payload = peer left (retained message cleared on disconnect)
        if not payload or payload == b"":
            return

        # Try decryption first (encrypted presence)
        if self._settings.webrtc.encrypt_signaling:
            try:
                msg = aead_open(self._keys.k_sig, payload)
            except Exception:
                # Fall back to plaintext for backward compat
                try:
                    msg = json.loads(payload)
                except Exception:
                    log_debug("RTCClient: Ignoring unreadable presence payload")
                    return
        else:
            try:
                msg = json.loads(payload)
            except Exception:
                log_debug("RTCClient: Ignoring non-JSON presence payload (likely cleared retain)")
                return

        remote_peer = msg.get("peer_id")
        if not remote_peer or remote_peer == self._peer_id:
            return  # Ignore our own presence

        # Skip peers we already have a connection to
        if remote_peer in self._pcs:
            log_debug(f"RTCClient: Already connected to peer {remote_peer}, ignoring presence")
            return

        log_info(f"RTCClient: Discovered peer {remote_peer} in room")

        # Tie-breaker: lower peer ID initiates the offer to avoid glare
        if self._peer_id < remote_peer:
            log_info(f"RTCClient: Initiating WebRTC connection to peer {remote_peer}")
            await self.connect_to(remote_peer)
        else:
            log_info(f"RTCClient: Waiting for offer from peer {remote_peer} (tie-breaker)")

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

    # Message types that ANONYMOUS peers can always send
    _ANON_ALLOWED_TYPES = {"auth", "reauth"}

    # RPC method prefixes that ANONYMOUS peers may call for pairing/auth
    _ANON_ALLOWED_RPC_PREFIXES = (
        "Auth.PairingStart",
        "Auth.PairingConnect",
        "Auth.PairingExchange",
        "Auth.Login",
    )

    async def _rpc_call(
        self,
        peer: str,
        method: str,
        params: dict,
        timeout: float = 10.0,
    ) -> dict | None:
        """Send an outbound RPC call to a remote peer and await the response.

        Args:
            peer: Target peer identifier.
            method: RPC method name (e.g., ``"Auth.PairingStart"``).
            params: Call parameters.
            timeout: Max seconds to wait for a response.

        Returns:
            Result dict on success, ``None`` on timeout or error.
        """
        call_id = uuid.uuid4().hex[:12]
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict | None] = loop.create_future()
        self._pending_rpc[call_id] = future

        msg = {"type": "call", "id": call_id, "method": method, "params": params}
        send_fn = self._peer_send_fns.get(peer)
        if not send_fn:
            self._pending_rpc.pop(call_id, None)
            return None
        try:
            send_fn(json.dumps(msg))
        except Exception as exc:
            self._pending_rpc.pop(call_id, None)
            log_error(f"RTCClient: Failed to send RPC {method} to {peer}: {exc}")
            return None

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self._pending_rpc.pop(call_id, None)
            log_warning(f"RTCClient: RPC {method} to {peer} timed out")
            return None

    async def _initiate_pairing(self, peer: str, chan: Any) -> None:
        """Initiate the pairing flow with a remote peer.

        Calls ``Auth.PairingStart`` on the remote peer, then polls
        ``Auth.PairingConnect`` until the remote admin approves (or
        the pairing timeout expires), then exchanges for a token via
        ``Auth.PairingExchange``.

        The resulting token is sent as an auth message and persisted
        via the ``_on_token_saved`` callback.

        Args:
            peer: The remote peer identifier.
            chan: The DataChannel to send messages on.
        """
        try:
            device_name = f"aurora-mesh-{self._peer_id[:8]}"
            result = await self._rpc_call(
                peer,
                "Auth.PairingStart",
                {
                    "device_name": device_name,
                    "remote_peer_id": self._peer_id,
                    "remote_node_name": device_name,
                },
            )
            if not result or not result.get("code"):
                log_warning(f"Pairing initiation failed for peer {peer}: {result}")
                return

            pairing_code = result["code"]
            self._peer_pairing_active.add(peer)
            log_info(
                f"\n"
                f"╔══════════════════════════════════════════════╗\n"
                f"║  PAIRING REQUEST SENT TO PEER {peer[:8]}…      ║\n"
                f"║  Remote admin must approve code: {pairing_code}      ║\n"
                f"║  Polling for approval…                       ║\n"
                f"╚══════════════════════════════════════════════╝"
            )

            # Poll for approval
            poll_interval = 3.0
            while peer in self._pcs and peer in self._peer_pairing_active:
                await asyncio.sleep(poll_interval)

                if peer not in self._pcs:
                    return  # Disconnected

                poll_result = await self._rpc_call(
                    peer,
                    "Auth.PairingConnect",
                    {"code": pairing_code},
                )
                if not poll_result:
                    continue  # Timeout / transient failure — retry

                status = poll_result.get("status", "")
                if status == "approved":
                    log_info(f"Pairing approved by peer {peer[:8]}… — exchanging token")
                    break
                elif status == "pending":
                    continue
                else:
                    log_warning(f"Unexpected pairing status from peer {peer[:8]}…: {status}")
                    return

            if peer not in self._pcs or peer not in self._peer_pairing_active:
                return  # Disconnected or timed out

            # Exchange for token
            exchange_result = await self._rpc_call(
                peer,
                "Auth.PairingExchange",
                {"code": pairing_code},
            )
            if not exchange_result or not exchange_result.get("token"):
                log_warning(f"Token exchange failed for peer {peer[:8]}…")
                return

            token = exchange_result["token"]
            remote_device_id = exchange_result.get("device_id")
            remote_user_id = exchange_result.get("user_id")

            # ── Grant local trust to the remote peer BEFORE sending
            # the auth message.  Peer2 will validate our token and
            # immediately send manifest / ping back — those messages
            # must pass the auth gate, so the ACL entry must exist
            # before they can arrive.
            remote_perms = exchange_result.get("permissions", [])
            peer_identity = Identity(
                principal_id=remote_user_id or "unknown",
                principal_name=f"device_{peer[:8]}",
                is_admin=("*" in remote_perms),
                permissions=frozenset(remote_perms),
                effective_perms=frozenset(remote_perms),
                device_id=remote_device_id,
                source="webrtc_pairing",
            )
            self._peer_acl[peer] = peer_identity

            # Cancel the auth timeout — the peer is now trusted
            timeout_task = self._peer_timeout_tasks.pop(peer, None)
            if timeout_task:
                timeout_task.cancel()

            # Send auth message with the new token
            auth_msg = {
                "type": "auth",
                "peer_name": self._peer_id,
                "token": token,
            }
            chan.send(json.dumps(auth_msg))

            # Register in mesh and exchange manifests (non-blocking)
            if self._mesh_enabled and self._peer_registry:
                await self._peer_registry.register_peer(peer, peer)
                await self._send_manifest(peer)
                self._send_ping(peer)

            # Save token for future reconnections (persisted to DB)
            # Use the stable mesh peer_id from the exchange response when
            # available — this is the responder's mesh_identity.peer_id.
            # Falls back to the signaling session ID if not provided.
            remote_stable_id = exchange_result.get("peer_id") or peer
            self._saved_auth_tokens[remote_stable_id] = token
            if self._on_token_saved:
                try:
                    cb_result = self._on_token_saved(
                        token,
                        remote_device_id=remote_device_id,
                        remote_user_id=remote_user_id,
                        remote_peer_id=remote_stable_id,
                        remote_node_name=device_name,
                        permissions=remote_perms,
                    )
                    if asyncio.iscoroutine(cb_result) or asyncio.isfuture(cb_result):
                        await cb_result
                except Exception as exc:
                    log_error(f"Failed to persist pairing token: {exc}")

            log_info(f"Pairing complete with peer {peer[:8]}… — authenticated")

        except asyncio.CancelledError:
            log_debug(f"Pairing task cancelled for peer {peer}")
        except Exception as exc:
            log_error(f"Pairing flow failed for peer {peer}: {exc}")
        finally:
            self._peer_pairing_active.discard(peer)
            self._pairing_tasks.pop(peer, None)

    async def _reverse_pairing(self, peer: str) -> None:
        """Phase 2 bilateral pairing: after a remote peer authenticates to us,
        we initiate the reverse direction so we also get a token from them.

        This makes the mesh truly bilateral — each side has a token
        (and therefore a principal) on the other side.
        """
        # Skip if we already have tokens from a prior pairing exchange
        # (we initiated pairing earlier, so both sides already trust each other).
        if self._saved_auth_tokens:
            log_debug(
                f"Reverse pairing skipped for {peer[:8]}… — "
                f"we already hold {len(self._saved_auth_tokens)} saved token(s)"
            )
            return

        # Don't start reverse pairing if we're already pairing with this peer
        if peer in self._peer_pairing_active:
            log_debug(f"Reverse pairing skipped for {peer[:8]}… — pairing already active")
            return

        chan = self._peer_data_channels.get(peer)
        if not chan:
            log_debug(f"Reverse pairing skipped for {peer[:8]}… — no DataChannel")
            return

        log_info(
            f"Phase 2: Initiating reverse pairing with peer {peer[:8]}… "
            f"(they authenticated to us, now we authenticate to them)"
        )

        # Reuse the standard pairing flow — it will call PairingStart on the
        # remote peer, poll for approval, exchange for a token, and persist it.
        task = asyncio.create_task(self._initiate_pairing(peer, chan))
        self._pairing_tasks[peer] = task

    async def _ensure_pc(self, peer: str, is_offer_initiator: bool = False) -> RTCPeerConnection:
        if peer in self._pcs:
            return self._pcs[peer]

        log_debug(f"Creating new RTCPeerConnection for {peer}")
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=self._ice_servers()))
        self._pcs[peer] = pc

        # Default to ANONYMOUS until authenticated
        self._peer_acl.setdefault(peer, ANONYMOUS)

        channel = pc.createDataChannel("aurora-rpc")

        def send_fn(text: str) -> None:
            try:
                if channel.readyState == "open":
                    channel.send(text)
            except Exception:
                log_debug(f"RTCClient: Failed to send to peer {peer} (channel closed)")

        # Store the send function for mesh P2P outbound messaging
        self._peer_send_fns[peer] = send_fn

        async def _rpc_audit(
            event: str, pid: str | None = None, details: dict | None = None
        ) -> None:
            await self._audit(event, pid, details)

        handler = RPCHandler(
            self._bus,
            self._registry,
            send_fn,
            lambda: self._peer_acl.get(peer, ANONYMOUS),
            audit_fn=_rpc_audit,
            mesh_config=self._mesh_config,
            peer_id=peer,
            capacity_notify_fn=lambda module, available, max_conc: (
                self.broadcast_capacity_update(module, available, max_conc)
            )
            if self._mesh_enabled
            else None,
            pairing_notify_fn=lambda pid: self._peer_pairing_active.add(peer),
        )

        def setup_channel(chan: Any, is_initiator: bool = False) -> None:
            # Store channel reference for bilateral pairing
            self._peer_data_channels[peer] = chan

            @chan.on("open")
            def on_open() -> None:
                log_info(f"DataChannel '{chan.label}' open with peer {peer}")

                # Audit: peer connected
                asyncio.create_task(self._audit("peer.connected", details={"peer_id": peer}))

                if self._require_auth:
                    # If we have a saved token from a previous pairing exchange,
                    # send it immediately to authenticate as a returning peer.
                    # Try the default token (works for single-peer mesh).
                    saved_token = next(iter(self._saved_auth_tokens.values()), None)
                    if saved_token:
                        auth_msg = {
                            "type": "auth",
                            "peer_name": self._peer_id,
                            "token": saved_token,
                        }
                        chan.send(json.dumps(auth_msg))
                        log_info(
                            f"Sent saved pairing token to peer {peer} "
                            "(returning peer — previously paired)"
                        )
                    elif is_initiator:
                        log_info(
                            f"Peer {peer} connected — no saved token. "
                            "Starting pairing flow (we are initiator)…"
                        )
                        # Only the connection initiator starts the pairing flow.
                        # The responder waits for the initiator's PairingStart RPC.
                        task = asyncio.create_task(self._initiate_pairing(peer, chan))
                        self._pairing_tasks[peer] = task
                    else:
                        log_info(
                            f"Peer {peer} connected — no saved token. "
                            "Waiting for remote peer to initiate pairing "
                            "(we are responder)…"
                        )

                    # Auth timeout with heartbeat-style pairing extension (Fix 5)
                    async def _auth_timeout_check() -> None:
                        await asyncio.sleep(self._auth_timeout)
                        if peer not in self._pcs:
                            return  # Already disconnected
                        identity = self._peer_acl.get(peer, ANONYMOUS)
                        if identity == ANONYMOUS:
                            # Heartbeat loop: keep extending while pairing is active
                            if peer in self._peer_pairing_active:
                                elapsed = self._auth_timeout
                                while (
                                    peer in self._pcs
                                    and peer in self._peer_pairing_active
                                    and elapsed < self._pairing_timeout
                                ):
                                    remaining = self._pairing_timeout - elapsed
                                    heartbeat_interval = min(10.0, max(0.1, remaining))
                                    log_debug(
                                        f"Peer {peer[:8]}… pairing heartbeat "
                                        f"({elapsed:.0f}s / {self._pairing_timeout}s)"
                                    )
                                    await asyncio.sleep(heartbeat_interval)
                                    elapsed += heartbeat_interval
                                    # Check if authenticated during heartbeat sleep
                                    if self._peer_acl.get(peer, ANONYMOUS) != ANONYMOUS:
                                        return  # Authenticated while waiting

                                if peer not in self._pcs:
                                    return
                                identity = self._peer_acl.get(peer, ANONYMOUS)
                                if identity == ANONYMOUS:
                                    log_warning(
                                        f"Peer {peer[:8]}… pairing timeout expired "
                                        f"({self._pairing_timeout}s) — disconnecting"
                                    )
                                    await self._audit(
                                        "peer.pairing_timeout", details={"peer_id": peer}
                                    )
                                    self._peer_pairing_active.discard(peer)
                                    chan.close()
                                return
                            log_warning(
                                f"Peer {peer} did not authenticate within "
                                f"{self._auth_timeout}s — disconnecting"
                            )
                            await self._audit("peer.auth_timeout", details={"peer_id": peer})
                            chan.close()

                    self._peer_timeout_tasks[peer] = asyncio.create_task(_auth_timeout_check())

                else:
                    # Auth disabled — grant open access immediately
                    self._peer_acl[peer] = OPEN_PEER
                    log_info(f"Peer {peer} granted open access (auth disabled)")

                    # Mesh: Auto-register and exchange manifests
                    if self._mesh_enabled and self._peer_registry:
                        asyncio.create_task(self._peer_registry.register_peer(peer, ""))
                        asyncio.create_task(self._send_manifest(peer))
                        self._send_ping(peer)

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
                    msg_type = obj.get("type")

                    # Intercept RPC responses for our outbound calls
                    # (e.g., pairing flow). Must run BEFORE the auth gate
                    # since our peer may still be ANONYMOUS during pairing.
                    if msg_type in ("result", "error"):
                        call_id = obj.get("id")
                        if call_id and call_id in self._pending_rpc:
                            future = self._pending_rpc.pop(call_id)
                            if not future.done():
                                if msg_type == "result":
                                    future.set_result(obj.get("result"))
                                else:
                                    future.set_result(None)
                            return

                    # Auth messages are always allowed
                    if msg_type in self._ANON_ALLOWED_TYPES:
                        if msg_type == "auth":
                            token_str = obj.get("token")
                            if not token_str:
                                log_warning(f"Peer {peer} sent auth without token")
                                return

                            # DB-token auth (for paired devices / API tokens)
                            # Token must have been obtained via the pairing flow
                            # (Auth.PairingStart → approve → PairingExchange)
                            # or via Auth.Login.
                            async def validate_peer() -> None:
                                token = await self._auth_service.authenticate_token(token_str)
                                if token:
                                    identity = await self._auth_service.build_identity_from_token(
                                        token, source="webrtc_peer"
                                    )
                                    # Store node name for human-readable logging
                                    peer_name = obj.get("peer_name", "")
                                    if peer_name:
                                        self._peer_names[peer] = peer_name
                                    log_info(
                                        f"Peer {self._peer_label(peer)} authenticated as "
                                        f"{identity.principal_name} "
                                        f"(perms={list(identity.effective_perms)})"
                                    )
                                    self._peer_acl[peer] = identity
                                    self._peer_tokens[peer] = token
                                    timeout_task = self._peer_timeout_tasks.pop(peer, None)
                                    if timeout_task:
                                        timeout_task.cancel()
                                    self._peer_pairing_active.discard(peer)
                                    await self._audit(
                                        "peer.authenticated",
                                        identity.principal_id,
                                        {
                                            "peer_id": peer,
                                            "principal_name": identity.principal_name,
                                        },
                                    )

                                    if self._mesh_enabled and self._peer_registry:
                                        node_name = obj.get("peer_name", "")
                                        await self._peer_registry.register_peer(peer, node_name)
                                        await self._send_manifest(peer)
                                        self._send_ping(peer)

                                        # Phase 2: bilateral pairing — now that they
                                        # authenticated to us, initiate reverse pairing
                                        # so we also get a token on their side.
                                        asyncio.create_task(self._reverse_pairing(peer))
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
                        elif msg_type == "reauth":
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
                                    self._peer_tokens[peer] = token
                                    log_info(
                                        f"Peer {peer} re-authenticated as {identity.principal_name}"
                                    )
                                else:
                                    log_warning(f"Peer {peer} failed re-authentication")

                            asyncio.create_task(reauth_peer())
                        return

                    # GATE: If auth is required, block non-auth messages from ANONYMOUS
                    # EXCEPT for RPC calls to auth/pairing endpoints (Enhancement C)
                    if self._require_auth:
                        identity = self._peer_acl.get(peer, ANONYMOUS)
                        if identity == ANONYMOUS:
                            if msg_type == "call":
                                method = obj.get("method", "")
                                if method.startswith(self._ANON_ALLOWED_RPC_PREFIXES):
                                    asyncio.create_task(handler.on_message(text))
                                    return
                            log_warning(
                                f"Peer {peer} sent '{msg_type}' before authenticating — dropping"
                            )
                            return

                    # Dispatch authenticated messages
                    if msg_type == "manifest":
                        asyncio.create_task(self._on_peer_manifest(peer, obj))
                    elif msg_type == "manifest_request":
                        asyncio.create_task(self._send_manifest(peer))
                    elif msg_type == "manifest_ack":
                        asyncio.create_task(self._on_manifest_ack(peer, obj))
                    elif msg_type == "capacity_update":
                        asyncio.create_task(self._on_capacity_update(peer, obj))
                    elif msg_type == "ping":
                        self._send_pong(peer, obj)
                    elif msg_type == "pong":
                        if self._peer_bridge:
                            self._peer_bridge.on_pong(peer, obj)
                    elif msg_type in ("result", "error"):
                        if self._peer_bridge:
                            self._peer_bridge.on_response(peer, obj)
                        else:
                            log_debug(
                                f"RTCClient: Received {msg_type} but no PeerBridge configured"
                            )
                    else:
                        asyncio.create_task(handler.on_message(text))
                except Exception as e:
                    log_error(f"Error handling message from {peer}: {e}")

        setup_channel(channel, is_initiator=is_offer_initiator)

        @pc.on("datachannel")
        def on_datachannel(chan: Any) -> None:
            log_debug(f"Received remote DataChannel '{chan.label}' from {peer}")
            if chan.label == "aurora-rpc":
                setup_channel(chan, is_initiator=False)

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
                # Cancel pending pairing task
                pairing_task = self._pairing_tasks.pop(peer, None)
                if pairing_task:
                    pairing_task.cancel()
                # Reject any pending outbound RPC futures for this peer
                for _cid, fut in list(self._pending_rpc.items()):
                    if not fut.done():
                        fut.set_result(None)
                self._pcs.pop(peer, None)
                self._peer_acl.pop(peer, None)
                self._peer_tokens.pop(peer, None)
                self._peer_send_fns.pop(peer, None)
                self._peer_data_channels.pop(peer, None)
                self._peer_names.pop(peer, None)
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

        pc = await self._ensure_pc(peer, is_offer_initiator=True)
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
        """Handle a room-wide broadcast message from the signaling channel.

        Broadcasts are encrypted signaling-layer messages visible to all
        peers in the room.  Current use-cases:

        * ``mesh_event`` — a peer notifying all others of a state change
          (e.g. service going offline, config reload, graceful shutdown).

        Unknown broadcast types are logged and ignored so the protocol
        remains forward-compatible.
        """
        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_warning(f"RTCClient: Failed to unseal broadcast: {e}")
            return

        btype = msg.get("type", "")
        from_peer = msg.get("from", "unknown")

        if from_peer == self._peer_id:
            return  # Ignore our own broadcasts

        log_debug(f"RTCClient: Broadcast received from {from_peer}, type={btype}")

        if btype == "mesh_event":
            event_name = msg.get("event", "")
            if event_name == "peer_leaving":
                # Peer is gracefully shutting down — proactively clean up
                leaving_peer = msg.get("peer_id", from_peer)
                if leaving_peer in self._pcs:
                    log_info(f"RTCClient: Peer {leaving_peer} announced departure")
                    pc = self._pcs.get(leaving_peer)
                    if pc:
                        await pc.close()
            elif event_name == "manifest_changed":
                # Peer's service manifest changed — request updated manifest
                if from_peer in self._pcs:
                    request_msg = {"type": "manifest_request"}
                    self.send_to_peer(from_peer, json.dumps(request_msg))
                    log_debug(f"RTCClient: Requested updated manifest from {from_peer}")
            else:
                log_debug(f"RTCClient: Unknown mesh_event '{event_name}' from {from_peer}")
        else:
            log_debug(f"RTCClient: Unknown broadcast type '{btype}' from {from_peer}")
