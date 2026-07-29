"""Unit tests for RTCClient peer lifecycle management methods."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.db.models import Token, User
from app.services.gateway.acl.identity import ANONYMOUS, Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.policy_store import MeshPolicyStore
from app.services.gateway.utils.crypto import aead_open
from app.services.gateway.webrtc.rpc import RPCHandler
from app.services.gateway.webrtc.rtc_client import RTCClient, _ManifestAckExpectation


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
    auth_service.db_manager = AsyncMock()
    auth_service.db_manager.store_audit_event = AsyncMock()

    return settings, bus, registry, auth_service


@pytest.fixture
def client(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    return RTCClient(settings, bus, registry, auth_service)


def _make_token(
    user_id: str = "user-1",
    scopes: list[str] | None = None,
) -> Token:
    return Token(
        id="tok-1",
        token_hash="hash",
        prefix="aaaa",
        device_id=None,
        user_id=user_id,
        scopes=scopes or ["*"],
        expires_at=datetime.now() + timedelta(days=365),
    )


def _make_identity(
    principal_id: str = "user-1",
    perms: list[str] | None = None,
    is_admin: bool = False,
) -> Identity:
    return Identity(
        principal_id=principal_id,
        principal_name=f"name-{principal_id}",
        is_admin=is_admin,
        permissions=frozenset(perms or ["TTS.*"]),
        effective_perms=frozenset(perms or ["TTS.*"]),
        source="webrtc_peer",
    )


# ── get_connected_peers ──────────────────────────────────────────────────


def test_get_connected_peers_empty(client):
    assert client.get_connected_peers() == []


def test_get_connected_peers_with_peers(client):
    pc1 = MagicMock()
    pc1.connectionState = "connected"
    pc2 = MagicMock()
    pc2.connectionState = "connected"

    identity1 = _make_identity("user-1", ["TTS.*"])
    identity2 = _make_identity("user-2", ["STT.*"], is_admin=True)

    client._pcs = {"peer-a": pc1, "peer-b": pc2}
    client._peer_acl = {"peer-a": identity1, "peer-b": identity2}

    peers = client.get_connected_peers()
    assert len(peers) == 2
    names = {p["principal_name"] for p in peers}
    assert "name-user-1" in names
    assert "name-user-2" in names

    admin_peer = next(p for p in peers if p["principal_name"] == "name-user-2")
    assert admin_peer["is_admin"] is True


def test_get_connected_peers_anonymous(client):
    """Unauthenticated peer → shows as ANONYMOUS."""
    pc = MagicMock()
    pc.connectionState = "connecting"
    client._pcs = {"peer-x": pc}
    client._peer_acl = {"peer-x": ANONYMOUS}

    peers = client.get_connected_peers()
    assert len(peers) == 1
    assert peers[0]["principal_name"] == "anonymous"
    assert peers[0]["effective_perms"] == []


def test_outbound_ice_filter_is_default_off(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(settings, bus, registry, auth_service)
    sdp = (
        "v=0\r\n"
        "a=candidate:1 1 udp 1 192.0.2.10 5000 typ host\r\n"
        "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
    )

    assert client._filter_outbound_session_description(sdp) == sdp


def test_outbound_ice_filter_removes_only_disallowed_candidate_lines(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(
        settings,
        bus,
        registry,
        auth_service,
        outbound_ice_candidate_allowed=lambda candidate: " typ host" not in candidate,
    )
    sdp = (
        "v=0\r\n"
        "a=mid:0\r\n"
        "a=candidate:1 1 udp 1 192.0.2.10 5000 typ host\r\n"
        "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
        "a=end-of-candidates\r\n"
    )

    assert client._filter_outbound_session_description(sdp) == (
        "v=0\r\n"
        "a=mid:0\r\n"
        "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
        "a=end-of-candidates\r\n"
    )


@pytest.mark.asyncio
async def test_outbound_ice_filter_applies_to_sdp_and_trickle_candidates(mock_deps):
    settings, bus, registry, auth_service = mock_deps
    client = RTCClient(
        settings,
        bus,
        registry,
        auth_service,
        outbound_ice_candidate_allowed=lambda candidate: " typ host" not in candidate,
    )
    client._adapter = MagicMock()
    client._adapter.send = AsyncMock()
    client._start_negotiation_watchdog = MagicMock()
    peer = "remote-peer"
    pc = MagicMock()
    pc.connectionState = "new"
    pc.createDataChannel.return_value = MagicMock(label="aurora-rpc", readyState="connecting")
    pc.createOffer = AsyncMock(return_value=MagicMock(type="offer", sdp="unfiltered-offer"))
    pc.setLocalDescription = AsyncMock()
    pc.close = AsyncMock()
    pc.localDescription = MagicMock(
        sdp=(
            "v=0\r\n"
            "a=candidate:1 1 udp 1 192.0.2.10 5000 typ host\r\n"
            "a=candidate:2 1 udp 1 198.51.100.10 6000 typ srflx\r\n"
        )
    )
    handlers: dict[str, Any] = {}

    def on(event_name):
        def decorator(callback):
            handlers[event_name] = callback
            return callback

        return decorator

    pc.on = on

    with patch(
        "app.services.gateway.webrtc.rtc_client.RTCPeerConnection",
        return_value=pc,
    ):
        await client.connect_to(peer)

    client._adapter.send.assert_awaited_once()
    channel, sealed = client._adapter.send.await_args.args
    offer = aead_open(client._keys.k_sig, sealed)
    assert channel == "offer"
    assert " typ host" not in offer["sdp"]
    assert " typ srflx" in offer["sdp"]
    assert client._pairing_transports[peer]["offer_sdp"] == offer["sdp"]

    client._adapter.send.reset_mock()
    host_candidate = MagicMock()
    host_candidate.to_sdp.return_value = "candidate:1 1 udp 1 192.0.2.10 5000 typ host"
    await handlers["icecandidate"](MagicMock(candidate=host_candidate))
    client._adapter.send.assert_not_awaited()

    reflexive_candidate = MagicMock()
    reflexive_candidate.to_sdp.return_value = "candidate:2 1 udp 1 198.51.100.10 6000 typ srflx"
    await handlers["icecandidate"](MagicMock(candidate=reflexive_candidate))
    client._adapter.send.assert_awaited_once()
    candidate_channel, candidate_sealed = client._adapter.send.await_args.args
    candidate = aead_open(client._keys.k_sig, candidate_sealed)
    assert candidate_channel == "candidate"
    assert candidate["candidate"].endswith("typ srflx")


# ── disconnect_peer ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_disconnect_peer_success(client):
    pc = AsyncMock()
    pc.connectionState = "connected"
    identity = _make_identity("user-1")
    token = _make_token("user-1", ["TTS.*"])
    timeout_task = MagicMock()
    timeout_task.cancel = MagicMock()
    channel = MagicMock()
    channel.readyState = "open"
    channel.sent = []
    channel.send.side_effect = channel.sent.append

    client._pcs = {"peer-a": pc}
    client._peer_acl = {"peer-a": identity}
    client._peer_tokens = {"peer-a": token}
    client._peer_timeout_tasks = {"peer-a": timeout_task}
    client._mesh_peer_id = "local-provider"
    client._remember_stable_peer_id("peer-a", "stable-peer-a", "remote")
    client._peer_data_channels["peer-a"] = channel
    client._local_provider_ready["stable-peer-a"] = _ManifestAckExpectation(
        session_peer_id="peer-a",
        connection_epoch="local-epoch-1",
        projection_digest="projection-digest",
        active_protocol="projection-v1",
        active_version="v1",
        active_tier="projection",
        protocol_revision="v1",
        registry_revision="registry-1",
        export_policy_revision="policy-1",
        auth_grant_revision=1,
        advertised_services=("TTS",),
        compatible_services=("TTS",),
    )
    client._peer_registry = MagicMock()
    client._peer_registry.remove_peer = AsyncMock()

    result = await client.disconnect_peer("peer-a", by_principal_id="admin")
    assert result is True
    assert "peer-a" not in client._pcs
    assert "peer-a" not in client._peer_acl
    assert "peer-a" not in client._peer_tokens
    assert "peer-a" not in client._peer_timeout_tasks
    client._peer_registry.remove_peer.assert_awaited_once_with("stable-peer-a")
    tombstone = json.loads(channel.sent[0])
    assert tombstone["type"] == "provider_unavailable"
    assert tombstone["peer_id"] == "local-provider"
    assert tombstone["connection_epoch"] == "local-epoch-1"
    pc.close.assert_called_once()
    timeout_task.cancel.assert_called_once()


@pytest.mark.asyncio
async def test_disconnect_peer_not_found(client):
    result = await client.disconnect_peer("nonexistent")
    assert result is False


# ── update_peer_permissions ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_peer_permissions_success(client, mock_deps):
    _, _, _, auth_service = mock_deps

    old_identity = _make_identity("user-1", ["TTS.*"])
    token = _make_token("user-1", ["*"])  # Wildcard token scopes
    client._peer_acl = {"peer-a": old_identity}
    client._peer_tokens = {"peer-a": token}

    updated_user = User(
        id="user-1",
        username="alice",
        password_hash="hashed",
        role="user",
        permissions=["TTS.*", "STT.*", "DB.Read"],
        is_admin=False,
    )
    auth_service.get_principal.return_value = updated_user

    result = await client.update_peer_permissions("peer-a")
    assert result is True

    new_identity = client._peer_acl["peer-a"]
    assert isinstance(new_identity, Identity)
    assert new_identity.principal_id == "user-1"
    # With wildcard token scopes, all user perms should be effective
    assert "TTS.*" in new_identity.effective_perms
    assert "STT.*" in new_identity.effective_perms
    assert "DB.Read" in new_identity.effective_perms


@pytest.mark.asyncio
async def test_update_peer_permissions_anonymous(client):
    """Cannot refresh permissions for an anonymous peer."""
    client._peer_acl = {"peer-a": ANONYMOUS}
    result = await client.update_peer_permissions("peer-a")
    assert result is False


@pytest.mark.asyncio
async def test_update_peer_permissions_unknown_peer(client):
    result = await client.update_peer_permissions("nonexistent")
    assert result is False


@pytest.mark.asyncio
async def test_update_peer_permissions_user_deleted(client, mock_deps):
    _, _, _, auth_service = mock_deps

    identity = _make_identity("user-deleted")
    client._peer_acl = {"peer-a": identity}
    auth_service.get_principal.return_value = None

    result = await client.update_peer_permissions("peer-a")
    assert result is False


@pytest.mark.asyncio
async def test_update_peer_permissions_uses_original_token_scopes(client, mock_deps):
    """Verify re-resolution uses stored token scopes, not old effective_perms."""
    _, _, _, auth_service = mock_deps

    # Old identity has narrow effective_perms
    old_identity = _make_identity("user-1", ["TTS.*"])
    # But original token has broader scopes
    token = _make_token("user-1", ["TTS.*", "STT.*"])
    client._peer_acl = {"peer-a": old_identity}
    client._peer_tokens = {"peer-a": token}

    updated_user = User(
        id="user-1",
        username="alice",
        password_hash="hashed",
        role="user",
        permissions=["TTS.*", "STT.*", "DB.Read"],
        is_admin=False,
    )
    auth_service.get_principal.return_value = updated_user

    result = await client.update_peer_permissions("peer-a")
    assert result is True

    new_identity = client._peer_acl["peer-a"]
    # Token scopes ["TTS.*", "STT.*"] ∩ user perms ["TTS.*", "STT.*", "DB.Read"]
    # = ["TTS.*", "STT.*"]
    assert "TTS.*" in new_identity.effective_perms
    assert "STT.*" in new_identity.effective_perms
    assert "DB.Read" not in new_identity.effective_perms  # Not in token scopes


@pytest.mark.asyncio
async def test_update_peer_permissions_no_stored_token_fallback(client, mock_deps):
    """Without stored token, falls back to identity.effective_perms as token_scopes."""
    _, _, _, auth_service = mock_deps

    old_identity = _make_identity("user-1", ["TTS.*"])
    client._peer_acl = {"peer-a": old_identity}
    # Intentionally no token stored

    updated_user = User(
        id="user-1",
        username="alice",
        password_hash="hashed",
        role="user",
        permissions=["TTS.*", "STT.*"],
        is_admin=False,
    )
    auth_service.get_principal.return_value = updated_user

    result = await client.update_peer_permissions("peer-a")
    assert result is True

    new_identity = client._peer_acl["peer-a"]
    # Falls back to old effective_perms as token_scopes = ["TTS.*"]
    assert "TTS.*" in new_identity.effective_perms


@pytest.mark.asyncio
async def test_update_peer_permissions_restores_bus_validated_mesh_scopes(client, mock_deps):
    """Proxy tokens without a row id use the freshly synchronized mesh principal."""

    _, _, _, auth_service = mock_deps
    old_identity = _make_identity("user-1", ["Orchestrator.use"])
    token = _make_token("user-1", ["Orchestrator.use"])
    token.id = "bus-validated"
    client._peer_acl = {"peer-a": old_identity}
    client._peer_tokens = {"peer-a": token}
    auth_service.get_principal.return_value = User(
        id="user-1",
        username="mesh-peer-a",
        password_hash="hashed",
        role="user",
        permissions=["Orchestrator.use", "Tooling.use"],
        is_admin=False,
    )

    result = await client.update_peer_permissions("peer-a")

    assert result is True
    assert client._peer_acl["peer-a"].effective_perms == frozenset(
        {"Orchestrator.use", "Tooling.use"}
    )
    assert token.scopes == ["Orchestrator.use", "Tooling.use"]
    auth_service.get_token_scopes.assert_not_awaited()


# ── close() cleanup ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_close_cancels_timeout_tasks(client):
    """close() cancels all pending auth timeout tasks and clears tokens."""
    pc1 = AsyncMock()
    pc2 = AsyncMock()
    task1 = MagicMock()
    task1.cancel = MagicMock()
    task2 = MagicMock()
    task2.cancel = MagicMock()

    client._pcs = {"peer-a": pc1, "peer-b": pc2}
    client._peer_acl = {"peer-a": _make_identity("u1"), "peer-b": _make_identity("u2")}
    client._peer_tokens = {"peer-a": _make_token("u1"), "peer-b": _make_token("u2")}
    client._peer_timeout_tasks = {"peer-a": task1, "peer-b": task2}

    # Mock adapter
    client._adapter = AsyncMock()

    await client.close()

    task1.cancel.assert_called_once()
    task2.cancel.assert_called_once()
    assert len(client._peer_timeout_tasks) == 0
    assert len(client._peer_tokens) == 0
    assert len(client._pcs) == 0
    assert len(client._peer_acl) == 0


@pytest.mark.asyncio
async def test_set_rpc_bus_rewires_existing_rpc_handler_to_mesh_stream_path(client):
    """Mesh startup updates existing inbound handlers off the process bus."""
    import json

    from app.services.gateway.webrtc.rpc import RPCHandler
    from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement
    from app.shared.contracts.models.orchestrator import OrchestratorMethods

    process_bus = AsyncMock()
    process_bus.request = AsyncMock()
    if hasattr(process_bus, "stream_request"):
        delattr(process_bus, "stream_request")

    class _MeshBus:
        def __init__(self) -> None:
            self.stream_calls = []

        async def stream_request(self, topic, payload, **kwargs):
            self.stream_calls.append((topic, payload, kwargs))
            yield {"delta": "mesh"}

    class _Registry:
        async def get_service(self, service: str):
            assert service == "Orchestrator"
            return ServiceAnnouncement(
                module="Orchestrator",
                version="1.0",
                methods=[
                    MethodInfo(
                        name="StreamInferChat",
                        bus_topic=OrchestratorMethods.STREAM_INFER_CHAT,
                        exposure="external",
                        required_perms=["Orchestrator.use"],
                        method_type="use",
                    )
                ],
            )

        async def get_external_methods(self):
            return []

    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"Orchestrator.use"}),
        source="webrtc_peer",
    )
    send = MagicMock()
    handler = RPCHandler(process_bus, _Registry(), send, lambda: identity)
    client._rpc_handlers = {"remote-peer": handler}

    mesh_bus = _MeshBus()
    client.set_rpc_bus(mesh_bus)  # type: ignore[arg-type]

    await handler.on_message(
        json.dumps(
            {
                "type": "call",
                "id": "stream-1",
                "method": OrchestratorMethods.STREAM_INFER_CHAT,
                "params": {"messages": [{"role": "user", "content": "hi"}]},
            }
        )
    )

    assert client._bus is mesh_bus
    assert len(mesh_bus.stream_calls) == 1
    process_bus.request.assert_not_called()
    responses = [json.loads(call.args[0]) for call in send.call_args_list]
    assert [response["type"] for response in responses] == ["chunk", "eof"]


@pytest.mark.asyncio
async def test_disable_mesh_clears_runtime_fields_and_preserves_handler_fail_closed_policy(client):
    import json

    store = MeshPolicyStore()
    store.replace(MeshConfig(enabled=False), source_revision=1)
    bus = AsyncMock()
    send = MagicMock()
    identity = Identity(
        principal_id="peer-user",
        principal_name="peer-user",
        is_admin=False,
        effective_perms=frozenset({"TTS.use"}),
        source="webrtc_peer",
    )
    handler = RPCHandler(
        bus,
        AsyncMock(),
        send,
        lambda: identity,
        mesh_config=MeshConfig(enabled=True),
        peer_id="session-peer",
        stable_peer_id_provider=lambda: "stable-peer",
    )
    client._rpc_handlers = {"session-peer": handler}
    client._mesh_enabled = True
    client._mesh_config = MeshConfig(enabled=True)
    client._peer_registry = MagicMock()
    client._peer_bridge = MagicMock()
    client._mesh_peer_id = "local-peer"
    client._mesh_node_name = "local-node"

    client.disable_mesh(policy_provider=store.provider())

    assert client._mesh_enabled is False
    assert client._mesh_config is None
    assert client._peer_registry is None
    assert client._peer_bridge is None
    assert client._mesh_peer_id is None
    assert client._mesh_node_name == ""

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": "TTS.Started",
                "params": {"utterance_id": "u1"},
            }
        )
    )
    bus.publish.assert_not_called()
