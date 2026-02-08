"""Integration tests for principal (user/device) management API."""
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
    """Setup test app with real DB and authenticated admin client."""
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

    # System token for admin access
    system_token = "GATEWAY_INTERNAL_TOKEN"
    headers = {"Authorization": f"Bearer {system_token}"}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, headers, auth_service

    await bus.stop()
    if os.path.exists(db_path):
        os.unlink(db_path)


@pytest.mark.asyncio
async def test_create_and_list_principals(test_env):
    """Create a principal, then list all principals to verify."""
    client, headers, _ = test_env

    # Create
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "alice", "password": "secret", "permissions": ["TTS.*", "STT.*"]},
        headers=headers,
    )
    assert resp.status_code == 201
    alice = resp.json()
    assert alice["username"] == "alice"
    assert "TTS.*" in alice["permissions"]

    # List
    resp = await client.get("/api/admin/principals", headers=headers)
    assert resp.status_code == 200
    principals = resp.json()
    usernames = [p["username"] for p in principals]
    assert "alice" in usernames


@pytest.mark.asyncio
async def test_get_update_delete_principal(test_env):
    """Full CRUD lifecycle for a principal."""
    client, headers, _ = test_env

    # Create
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "bob", "permissions": ["DB.Read"]},
        headers=headers,
    )
    assert resp.status_code == 201
    bob_id = resp.json()["id"]

    # Get
    resp = await client.get(f"/api/admin/principals/{bob_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["username"] == "bob"

    # Update
    resp = await client.patch(
        f"/api/admin/principals/{bob_id}",
        json={"username": "bob_updated"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["username"] == "bob_updated"

    # Delete
    resp = await client.delete(f"/api/admin/principals/{bob_id}", headers=headers)
    assert resp.status_code == 204

    # Verify deleted
    resp = await client.get(f"/api/admin/principals/{bob_id}", headers=headers)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_set_and_patch_permissions(test_env):
    """Set and patch permissions on a principal."""
    client, headers, _ = test_env

    # Create principal
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "charlie", "permissions": ["TTS.Say"]},
        headers=headers,
    )
    assert resp.status_code == 201
    cid = resp.json()["id"]

    # Set permissions (full replace)
    resp = await client.put(
        f"/api/admin/principals/{cid}/permissions",
        json={"permissions": ["DB.Read", "DB.Write"]},
        headers=headers,
    )
    assert resp.status_code == 200
    perms = resp.json()["permissions"]
    assert "DB.Read" in perms
    assert "DB.Write" in perms
    assert "TTS.Say" not in perms  # Was replaced

    # Patch: grant + revoke
    resp = await client.patch(
        f"/api/admin/principals/{cid}/permissions",
        json={"grant": ["TTS.*"], "revoke": ["DB.Write"]},
        headers=headers,
    )
    assert resp.status_code == 200
    perms = resp.json()["permissions"]
    assert "TTS.*" in perms
    assert "DB.Read" in perms
    assert "DB.Write" not in perms


@pytest.mark.asyncio
async def test_principal_permissions_enforced(test_env):
    """Create principal with limited perms, issue token, verify enforcement."""
    client, headers, auth_service = test_env

    # Create a non-admin principal with limited perms
    resp = await client.post(
        "/api/admin/principals",
        json={"username": "limited_user", "password": "pass123", "permissions": ["TTS.Say"]},
        headers=headers,
    )
    assert resp.status_code == 201
    limited_id = resp.json()["id"]

    # Create a token for the limited user
    resp = await client.post(
        "/api/admin/tokens",
        json={"principal_id": limited_id, "scopes": ["*"]},
        headers=headers,
    )
    assert resp.status_code == 201
    limited_token = resp.json()["token"]

    # Verify the token works
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {limited_token}"},
    )
    assert resp.status_code == 200
    verify = resp.json()
    assert verify["principal_id"] == limited_id
    # Effective perms should be just TTS.Say (user perms ∩ token scopes with wildcard)
    assert "TTS.Say" in verify["effective_perms"]

    # Try accessing admin endpoint → should get 403 (insufficient perms)
    resp = await client.get(
        "/api/admin/principals",
        headers={"Authorization": f"Bearer {limited_token}"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_pairing_with_permissions_integration(test_env):
    """Integration: pair device with specific permissions, verify enforcement."""
    client, headers, auth_service = test_env

    # Start pairing
    resp = await client.post(
        "/api/auth/pairing/start",
        json={"device_name": "TestDevice"},
    )
    assert resp.status_code == 200
    code = resp.json()["code"]

    # Approve with specific permissions
    resp = await client.post(
        "/api/auth/pairing/approve",
        json={"code": code, "permissions": ["TTS.*", "STT.Transcribe"]},
        headers=headers,
    )
    assert resp.status_code == 200

    # Exchange
    resp = await client.post(
        "/api/auth/pairing/exchange",
        json={"code": code},
    )
    assert resp.status_code == 200
    device_token = resp.json()["token"]

    # Verify device identity
    resp = await client.get(
        "/api/auth/verify",
        headers={"Authorization": f"Bearer {device_token}"},
    )
    assert resp.status_code == 200
    verify = resp.json()
    # Device should have the granted permissions
    assert "TTS.*" in verify["effective_perms"] or any(
        p.startswith("TTS") for p in verify["effective_perms"]
    )
