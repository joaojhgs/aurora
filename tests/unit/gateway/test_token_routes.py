"""Unit tests for token management API routes."""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.db.models import Token

pytestmark = pytest.mark.skip(
    reason="Token endpoints migrated to Auth service contracts (auto-generated)"
)

# ── Helpers ──────────────────────────────────────────────────────────────


def _make_token(
    id: str = "tok-1",
    user_id: str = "user-1",
    device_id: str | None = None,
    scopes: list[str] | None = None,
) -> Token:
    return Token(
        id=id,
        token_hash="hash",
        prefix="aaaa",
        device_id=device_id,
        user_id=user_id,
        scopes=scopes or ["*"],
        created_at=datetime(2025, 1, 1),
        expires_at=datetime.now() + timedelta(days=365),
    )


@pytest.fixture
def mock_auth_service():
    svc = AsyncMock()
    svc.db_manager = AsyncMock()
    svc.db_manager.store_audit_event = AsyncMock()
    svc.db_manager.revoke_token = AsyncMock(return_value=True)
    return svc


@pytest.fixture
def app(mock_auth_service):
    """Create a FastAPI test app with auth disabled."""
    import app.services.gateway.dependencies as deps
    from app.services.gateway.auth import GatewayAuth
    from app.services.gateway.fastapi_app import create_gateway_app

    bus = AsyncMock()
    registry = AsyncMock()
    registry.start = AsyncMock()
    registry.stop = AsyncMock()
    registry.get_services = AsyncMock(return_value=[])
    registry.get_registry_export = AsyncMock(
        return_value={
            "modules": [],
            "digest": "",
            "service_count": 0,
            "method_count": 0,
        }
    )

    gateway_auth = GatewayAuth(auth_service=mock_auth_service, enabled=False)

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

    deps._auth_service = old_auth_service
    deps._gateway_auth = old_gateway_auth


# ── Tests ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_tokens(app, mock_auth_service):
    mock_auth_service.list_tokens.return_value = [
        _make_token("tok-1", "user-1"),
        _make_token("tok-2", "user-2", scopes=["TTS.*"]),
    ]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/admin/tokens")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0]["id"] == "tok-1"


@pytest.mark.asyncio
async def test_list_tokens_filtered_by_principal(app, mock_auth_service):
    mock_auth_service.list_tokens.return_value = [_make_token("tok-1", "user-1")]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/admin/tokens?principal_id=user-1")

    assert resp.status_code == 200
    mock_auth_service.list_tokens.assert_called_once_with(principal_id="user-1", device_id=None)


@pytest.mark.asyncio
async def test_create_token(app, mock_auth_service):
    token_obj = _make_token("tok-new", "user-1", scopes=["TTS.*"])
    mock_auth_service.create_token_for_principal.return_value = (token_obj, "raw-token-string")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/admin/tokens",
            json={
                "principal_id": "user-1",
                "scopes": ["TTS.*"],
                "expires_in_days": 30,
            },
        )

    assert resp.status_code == 201
    data = resp.json()
    assert data["token"] == "raw-token-string"
    assert data["scopes"] == ["TTS.*"]


@pytest.mark.asyncio
async def test_create_token_failure(app, mock_auth_service):
    mock_auth_service.create_token_for_principal.return_value = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/admin/tokens",
            json={"principal_id": "nonexistent"},
        )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_update_token_scopes(app, mock_auth_service):
    mock_auth_service.update_token_scopes.return_value = True

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            "/api/admin/tokens/tok-1/scopes",
            json={"scopes": ["TTS.Say", "STT.*"]},
        )

    assert resp.status_code == 200
    assert resp.json()["success"] is True


@pytest.mark.asyncio
async def test_update_token_scopes_not_found(app, mock_auth_service):
    mock_auth_service.update_token_scopes.return_value = False

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.patch(
            "/api/admin/tokens/tok-missing/scopes",
            json={"scopes": ["TTS.*"]},
        )

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_revoke_token(app, mock_auth_service):
    mock_auth_service.db_manager.revoke_token.return_value = True

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.delete("/api/admin/tokens/tok-1")

    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_revoke_token_not_found(app, mock_auth_service):
    mock_auth_service.db_manager.revoke_token.return_value = False

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.delete("/api/admin/tokens/tok-missing")

    assert resp.status_code == 404
