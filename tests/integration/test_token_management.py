"""Integration tests for token management API."""

from __future__ import annotations

import os
import tempfile

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.messaging.local_bus import LocalBus
from app.services.auth.auth_manager import AuthManager as AuthService
from app.services.gateway.dependencies import set_gateway_auth
from app.services.gateway.fastapi_app import create_gateway_app
from app.services.gateway.registry_aggregator import RegistryAggregator

pytestmark = pytest.mark.skip(
    reason="Token endpoints migrated to Auth service contracts (auto-generated)"
)


@pytest_asyncio.fixture
async def test_env():
    """Setup test app with real DB and admin client."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    bus = LocalBus()
    await bus.start()

    auth_service = AuthService(bus=bus)
    await auth_service.initialize()

    registry = RegistryAggregator(bus=bus)

    app = create_gateway_app(
        bus=bus,
        registry=registry,
        auth_enabled=True,
        auth_service=auth_service,
    )

    system_token = "GATEWAY_INTERNAL_TOKEN"
    headers = {"Authorization": f"Bearer {system_token}"}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, headers, auth_service

    await bus.stop()
    if os.path.exists(db_path):
        os.unlink(db_path)


@pytest.mark.asyncio
async def test_create_and_list_tokens(test_env):
    """Create a token for a principal, then list tokens."""
    client, headers, auth_service = test_env

    # Create principal first
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "tokenuser", "permissions": ["TTS.*"]},
        headers=headers,
    )
    assert resp.status_code == 201
    user_id = resp.json()["id"]

    # Create token
    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": user_id, "scopes": ["TTS.Say"], "expires_in_days": 30},
        headers=headers,
    )
    assert resp.status_code == 201
    token_data = resp.json()
    assert token_data["token"] is not None
    assert token_data["scopes"] == ["TTS.Say"]
    token_id = token_data["id"]

    # List tokens
    resp = await client.get("/api/admin/tokens", headers=headers)
    assert resp.status_code == 200
    tokens = resp.json()
    assert any(t["id"] == token_id for t in tokens)


@pytest.mark.asyncio
async def test_update_token_scopes(test_env):
    """Create a token, update its scopes, verify change."""
    client, headers, _ = test_env

    # Create principal
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "scopeuser", "permissions": ["TTS.*", "STT.*"]},
        headers=headers,
    )
    user_id = resp.json()["id"]

    # Create token
    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": user_id, "scopes": ["TTS.Say"]},
        headers=headers,
    )
    token_id = resp.json()["id"]

    # Update scopes
    resp = await client.patch(
        f"/api/admin/tokens/{token_id}/scopes",
        json={"scopes": ["TTS.*", "STT.*"]},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_revoke_token(test_env):
    """Create and revoke a token, verify it no longer works."""
    client, headers, _ = test_env

    # Create principal
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "revokeuser", "permissions": ["TTS.*"]},
        headers=headers,
    )
    user_id = resp.json()["id"]

    # Create token
    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": user_id, "scopes": ["*"]},
        headers=headers,
    )
    token_str = resp.json()["token"]
    token_id = resp.json()["id"]

    # Token should work
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {token_str}"},
    )
    assert resp.status_code == 200

    # Revoke token
    resp = await client.delete(f"/api/admin/tokens/{token_id}", headers=headers)
    assert resp.status_code == 204

    # Token should no longer work
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {token_str}"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_token_scope_restriction(test_env):
    """Token scopes narrow effective perms (intersection with user perms)."""
    client, headers, _ = test_env

    # Create principal with broad perms
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "broaduser", "permissions": ["TTS.*", "STT.*", "DB.*"]},
        headers=headers,
    )
    user_id = resp.json()["id"]

    # Create token with narrow scopes
    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": user_id, "scopes": ["TTS.Say"]},
        headers=headers,
    )
    token_str = resp.json()["token"]

    # Verify effective perms are narrowed
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {token_str}"},
    )
    assert resp.status_code == 200
    verify = resp.json()
    # Effective perms should only include TTS.Say (intersection of user perms and token scopes)
    assert "TTS.Say" in verify["effective_perms"]
    assert "STT.*" not in verify["effective_perms"]
    assert "DB.*" not in verify["effective_perms"]


@pytest.mark.asyncio
async def test_create_token_for_nonexistent_principal(test_env):
    """Creating a token for a nonexistent principal fails."""
    client, headers, _ = test_env

    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": "nonexistent-id", "scopes": ["*"]},
        headers=headers,
    )
    assert resp.status_code == 400


# ── Token Scope Validation (C.3) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_token_exceeding_scopes_rejected(test_env):
    """Token scopes exceeding user permissions returns 400."""
    client, headers, _ = test_env

    # Create a principal with narrow permissions
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "narrowuser", "permissions": ["TTS.Say"]},
        headers=headers,
    )
    assert resp.status_code == 201
    user_id = resp.json()["id"]

    # Try to create a token with scopes exceeding the user's permissions
    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": user_id, "scopes": ["DB.Write"]},
        headers=headers,
    )
    assert resp.status_code == 400
    assert "exceeds" in resp.json()["error"].lower()


@pytest.mark.asyncio
async def test_create_token_matching_scopes_succeeds(test_env):
    """Token with scopes within user permissions succeeds."""
    client, headers, _ = test_env

    resp = await client.post(
        "/api/admin/principals",
        json={"username": "matchuser", "permissions": ["TTS.*", "STT.*"]},
        headers=headers,
    )
    user_id = resp.json()["id"]

    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": user_id, "scopes": ["TTS.Say"]},
        headers=headers,
    )
    assert resp.status_code == 201
    assert resp.json()["scopes"] == ["TTS.Say"]


@pytest.mark.asyncio
async def test_update_token_scopes_exceeding_rejected(test_env):
    """Updating token scopes to exceed user permissions returns 400."""
    client, headers, _ = test_env

    # Create principal with narrow perms
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "scopeupdate", "permissions": ["TTS.*"]},
        headers=headers,
    )
    user_id = resp.json()["id"]

    # Create token with valid scopes
    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": user_id, "scopes": ["TTS.Say"]},
        headers=headers,
    )
    token_id = resp.json()["id"]

    # Try to update scopes beyond user's permissions
    resp = await client.patch(
        f"/api/admin/tokens/{token_id}/scopes",
        json={"scopes": ["DB.Write"]},
        headers=headers,
    )
    assert resp.status_code == 400
    assert "exceeds" in resp.json()["error"].lower()


@pytest.mark.asyncio
async def test_revoke_nonexistent_token_returns_404(test_env):
    """Revoking a non-existent token returns 404."""
    client, headers, _ = test_env

    resp = await client.delete(
        "/api/admin/tokens/nonexistent-token-id",
        headers=headers,
    )
    assert resp.status_code == 404
