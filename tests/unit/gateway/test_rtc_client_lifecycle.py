"""Unit tests for RTCClient peer lifecycle management methods."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.db.models import Token, User
from app.services.gateway.acl.identity import ANONYMOUS, Identity
from app.services.gateway.webrtc.rtc_client import RTCClient


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


# ── disconnect_peer ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_disconnect_peer_success(client):
    pc = AsyncMock()
    identity = _make_identity("user-1")
    token = _make_token("user-1", ["TTS.*"])
    timeout_task = MagicMock()
    timeout_task.cancel = MagicMock()

    client._pcs = {"peer-a": pc}
    client._peer_acl = {"peer-a": identity}
    client._peer_tokens = {"peer-a": token}
    client._peer_timeout_tasks = {"peer-a": timeout_task}

    result = await client.disconnect_peer("peer-a", by_principal_id="admin")
    assert result is True
    assert "peer-a" not in client._pcs
    assert "peer-a" not in client._peer_acl
    assert "peer-a" not in client._peer_tokens
    assert "peer-a" not in client._peer_timeout_tasks
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
