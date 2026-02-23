"""Unit tests for principal management API routes."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.db.models import User
from app.services.gateway.acl.identity import SYSTEM, Identity

pytestmark = pytest.mark.skip(reason="Principal endpoints migrated to Auth service contracts (auto-generated)")

# ── Helpers ──────────────────────────────────────────────────────────────

def _make_user(
    id: str = "user-1",
    username: str = "alice",
    permissions: list[str] | None = None,
    is_admin: bool = False,
) -> User:
    return User(
        id=id,
        username=username,
        password_hash="hashed",
        role="admin" if is_admin else "user",
        permissions=permissions or [],
        is_admin=is_admin,
        created_at=datetime(2025, 1, 1),
    )


@pytest.fixture
def admin_identity():
    return SYSTEM


@pytest.fixture
def limited_identity():
    return Identity(
        principal_id="limited-user",
        principal_name="limited",
        is_admin=False,
        effective_perms=frozenset(["TTS.Say"]),
        source="http_bearer",
    )


@pytest.fixture
def mock_auth_service():
    svc = AsyncMock()
    svc.db_manager = AsyncMock()
    svc.db_manager.store_audit_event = AsyncMock()
    return svc


@pytest.fixture
def app(mock_auth_service, admin_identity):
    """Create a FastAPI test app with auth *disabled* (SYSTEM identity for all requests)."""
    import app.services.gateway.dependencies as deps
    from app.services.gateway.auth import GatewayAuth
    from app.services.gateway.fastapi_app import create_gateway_app

    bus = AsyncMock()
    registry = AsyncMock()
    registry.start = AsyncMock()
    registry.stop = AsyncMock()
    registry.get_services = AsyncMock(return_value=[])
    registry.get_registry_export = AsyncMock(return_value={
        "modules": [], "digest": "", "service_count": 0, "method_count": 0,
    })

    gateway_auth = GatewayAuth(auth_service=mock_auth_service, enabled=False)

    # Set module globals directly so they persist during test execution
    old_auth_service = deps._auth_service
    old_gateway_auth = deps._gateway_auth
    deps._auth_service = mock_auth_service
    deps._gateway_auth = gateway_auth

    application = create_gateway_app(
        bus=bus,
        registry=registry,
        auth_enabled=False,
        auth_service=mock_auth_service,
    )
    yield application

    # Cleanup
    deps._auth_service = old_auth_service
    deps._gateway_auth = old_gateway_auth


# ── Tests ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_principals(app, mock_auth_service):
    mock_auth_service.list_principals.return_value = [
        _make_user("u1", "alice", ["TTS.*"]),
        _make_user("u2", "bob", ["*"], is_admin=True),
    ]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/admin/principals")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0]["username"] == "alice"
    assert data[1]["is_admin"] is True


@pytest.mark.asyncio
async def test_create_principal(app, mock_auth_service):
    created_user = _make_user("u3", "charlie", ["DB.Read"])
    mock_auth_service.create_principal.return_value = created_user

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/admin/principals",
            json={"username": "charlie", "password": "secret", "permissions": ["DB.Read"]},
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["username"] == "charlie"
    assert data["permissions"] == ["DB.Read"]


@pytest.mark.asyncio
async def test_create_principal_failure(app, mock_auth_service):
    mock_auth_service.create_principal.return_value = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/admin/principals",
            json={"username": "fail"},
        )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_get_principal(app, mock_auth_service):
    mock_auth_service.get_principal.return_value = _make_user("u1", "alice")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/admin/principals/u1")

    assert resp.status_code == 200
    assert resp.json()["id"] == "u1"


@pytest.mark.asyncio
async def test_get_principal_not_found(app, mock_auth_service):
    mock_auth_service.get_principal.return_value = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/admin/principals/nonexistent")

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_update_principal(app, mock_auth_service):
    updated = _make_user("u1", "alice_updated")
    mock_auth_service.update_principal.return_value = updated

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            "/api/admin/principals/u1",
            json={"username": "alice_updated"},
        )

    assert resp.status_code == 200
    assert resp.json()["username"] == "alice_updated"


@pytest.mark.asyncio
async def test_delete_principal(app, mock_auth_service):
    mock_auth_service.delete_principal.return_value = True

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.delete("/api/admin/principals/u1")

    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_principal_not_found(app, mock_auth_service):
    mock_auth_service.delete_principal.return_value = False

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.delete("/api/admin/principals/nonexistent")

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_set_permissions(app, mock_auth_service):
    mock_auth_service.set_permissions.return_value = True
    mock_auth_service.get_principal.return_value = _make_user("u1", "alice", ["TTS.*", "STT.*"])

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.put(
            "/api/admin/principals/u1/permissions",
            json={"permissions": ["TTS.*", "STT.*"]},
        )

    assert resp.status_code == 200
    assert "TTS.*" in resp.json()["permissions"]


@pytest.mark.asyncio
async def test_patch_permissions(app, mock_auth_service):
    mock_auth_service.patch_permissions.return_value = True
    mock_auth_service.get_principal.return_value = _make_user("u1", "alice", ["TTS.*", "DB.Read"])

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            "/api/admin/principals/u1/permissions",
            json={"grant": ["DB.Read"], "revoke": ["STT.*"]},
        )

    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_change_password(app, mock_auth_service):
    mock_auth_service.change_password.return_value = True

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/auth/change-password",
            json={"old_password": "old", "new_password": "new"},
        )

    assert resp.status_code == 200
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_change_password_fail(app, mock_auth_service):
    mock_auth_service.change_password.return_value = False

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/auth/change-password",
            json={"old_password": "wrong", "new_password": "new"},
        )

    assert resp.status_code == 400
