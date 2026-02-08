"""Integration tests for login / logout / me / token-refresh endpoints."""
from __future__ import annotations

import os
import tempfile

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.messaging.local_bus import LocalBus
from app.services.gateway.auth_service import AuthService
from app.services.gateway.dependencies import set_auth_service, set_gateway_auth
from app.services.gateway.fastapi_app import create_gateway_app
from app.services.gateway.registry_aggregator import RegistryAggregator


@pytest_asyncio.fixture
async def test_env():
    """Setup test app with real DB, admin system token, and a regular user."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    bus = LocalBus()
    await bus.start()

    auth_service = AuthService(db_path=db_path)
    await auth_service.initialize()
    set_auth_service(auth_service)

    registry = RegistryAggregator(bus=bus)

    app = create_gateway_app(
        bus=bus,
        registry=registry,
        auth_enabled=True,
        auth_service=auth_service,
    )

    system_token = "GATEWAY_INTERNAL_TOKEN"
    admin_headers = {"Authorization": f"Bearer {system_token}"}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Create a regular user with a known password for login tests
        resp = await client.post(
            "/api/admin/principals",
            json={
                "username": "loginuser",
                "password": "correctpassword",
                "permissions": ["TTS.*", "STT.Transcribe"],
            },
            headers=admin_headers,
        )
        assert resp.status_code == 201
        user_id = resp.json()["id"]

        yield client, admin_headers, auth_service, user_id

    await bus.stop()
    if os.path.exists(db_path):
        os.unlink(db_path)


# ── Login ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_success(test_env):
    """Valid credentials return a session token and user info."""
    client, _, _, user_id = test_env

    resp = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "correctpassword"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["token"]
    assert data["user_id"] == user_id
    assert data["username"] == "loginuser"
    assert "TTS.*" in data["permissions"]
    assert data["is_admin"] is False
    assert data["expires_at"] is not None


@pytest.mark.asyncio
async def test_login_invalid_credentials(test_env):
    """Wrong password returns 401."""
    client, *_ = test_env

    resp = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "wrongpassword"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_login_nonexistent_user(test_env):
    """Unknown user returns 401."""
    client, *_ = test_env

    resp = await client.post(
        "/api/auth/login",
        json={"username": "nobody", "password": "anything"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_login_rate_limiting(test_env):
    """After 10 failed attempts from same IP, returns 429."""
    client, _, auth_service, _ = test_env

    # Simulate 10 failed attempts from the same IP
    for _ in range(10):
        resp = await client.post(
            "/api/auth/login",
            json={"username": "loginuser", "password": "wrong"},
        )
        assert resp.status_code == 401

    # 11th attempt should be rate-limited
    resp = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "wrong"},
    )
    assert resp.status_code == 429


# ── Me ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_me_authenticated(test_env):
    """GET /api/auth/me with valid token returns identity."""
    client, *_ = test_env

    # Login first
    resp = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "correctpassword"},
    )
    token = resp.json()["token"]

    # Get identity
    resp = await client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["principal_name"] == "loginuser"
    assert data["is_admin"] is False
    assert "TTS.*" in data["permissions"]
    assert len(data["effective_perms"]) > 0
    assert data["source"] == "http_bearer"


@pytest.mark.asyncio
async def test_me_unauthenticated(test_env):
    """GET /api/auth/me without token returns 401."""
    client, *_ = test_env

    resp = await client.get("/api/auth/me")
    assert resp.status_code == 401


# ── Logout ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_logout_revokes_token(test_env):
    """POST /api/auth/logout revokes the session token."""
    client, *_ = test_env

    # Login
    resp = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "correctpassword"},
    )
    token = resp.json()["token"]

    # Verify token works
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200

    # Logout
    resp = await client.post(
        "/api/auth/logout",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 204

    # Token should no longer work
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401


# ── Token Refresh ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_token_refresh(test_env):
    """POST /api/auth/token/refresh issues a new token and revokes the old one."""
    client, *_ = test_env

    # Login to get initial token
    resp = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "correctpassword"},
    )
    old_token = resp.json()["token"]

    # Refresh
    resp = await client.post(
        "/api/auth/token/refresh",
        headers={"Authorization": f"Bearer {old_token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    new_token = data["token"]
    assert new_token != old_token
    assert data["expires_at"] is not None

    # New token should work
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {new_token}"},
    )
    assert resp.status_code == 200

    # Old token should be revoked
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {old_token}"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_token_refresh_without_bearer(test_env):
    """Token refresh without Bearer header returns 401."""
    client, *_ = test_env

    resp = await client.post("/api/auth/token/refresh")
    assert resp.status_code == 401


# ── Verify endpoint includes permissions ─────────────────────────────────


@pytest.mark.asyncio
async def test_verify_includes_permissions(test_env):
    """GET /api/auth/verify returns both permissions and effective_perms."""
    client, *_ = test_env

    resp = await client.post(
        "/api/auth/login",
        json={"username": "loginuser", "password": "correctpassword"},
    )
    token = resp.json()["token"]

    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "permissions" in data
    assert "effective_perms" in data
    assert "TTS.*" in data["permissions"]
    assert "STT.Transcribe" in data["permissions"]
