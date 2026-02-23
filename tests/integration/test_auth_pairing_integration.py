"""Integration tests for Auth pairing flow."""

import asyncio
import os
import tempfile

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.messaging.local_bus import LocalBus
from app.services.auth.auth_manager import AuthManager as AuthService
from app.services.gateway.dependencies import set_gateway_auth
from app.services.gateway.fastapi_app import create_gateway_app
from app.services.gateway.registry_aggregator import RegistryAggregator

pytestmark = pytest.mark.skip(reason="Pairing endpoints migrated to Auth service contracts (auto-generated)")


@pytest_asyncio.fixture
async def test_app_and_client():
    """Setup test app and client with in-memory DB."""
    fd, db_path = tempfile.mkstemp()
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

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield app, client, auth_service, db_path

    await bus.stop()
    if os.path.exists(db_path):
        os.unlink(db_path)


@pytest.mark.asyncio
async def test_full_pairing_flow(test_app_and_client):
    """Test the complete pairing flow from start to token verification."""
    app, client, auth_service, db_path = test_app_and_client

    response = await client.post("/api/auth/pairing/start", json={"device_name": "Test Device"})
    assert response.status_code == 200
    data = response.json()
    pairing_code = data["code"]
    assert len(pairing_code) == 6

    response = await client.get(f"/api/auth/pairing/connect/{pairing_code}")
    assert response.status_code == 200
    assert response.json()["status"] == "pending"

    system_token = "GATEWAY_INTERNAL_TOKEN"
    response = await client.post(
        "/api/auth/pairing/approve",
        json={"code": pairing_code},
        headers={"Authorization": f"Bearer {system_token}"},
    )
    assert response.status_code == 200
    assert response.json()["success"] is True

    response = await client.get(f"/api/auth/pairing/connect/{pairing_code}")
    assert response.status_code == 200
    assert response.json()["status"] == "approved"

    response = await client.post("/api/auth/pairing/exchange", json={"code": pairing_code})
    assert response.status_code == 200
    data = response.json()
    new_token = data["token"]
    assert new_token is not None

    response = await client.get(
        "/api/auth/verify", headers={"Authorization": f"Bearer {new_token}"}
    )
    assert response.status_code == 200
    verify_data = response.json()
    assert verify_data["status"] == "valid"
    assert verify_data["principal_id"] is not None
    assert verify_data["source"] == "http_bearer"


@pytest.mark.asyncio
async def test_pairing_invalid_code(test_app_and_client):
    """Test pairing with an invalid code."""
    _, client, _, _ = test_app_and_client

    response = await client.get("/api/auth/pairing/connect/000000")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_pairing_unapproved_exchange(test_app_and_client):
    """Test exchanging a pairing code before it's approved."""
    _, client, _, _ = test_app_and_client

    response = await client.post("/api/auth/pairing/start", json={"device_name": "Test Device"})
    pairing_code = response.json()["code"]

    response = await client.post("/api/auth/pairing/exchange", json={"code": pairing_code})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_protected_endpoint_no_auth(test_app_and_client):
    """Test that protected endpoints require authentication."""
    _, client, _, _ = test_app_and_client

    response = await client.get("/api/auth/verify")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_pairing_approve_unauthorized(test_app_and_client):
    """Test that only admins can approve pairing."""
    _, client, _, _ = test_app_and_client

    response = await client.post("/api/auth/pairing/start", json={"device_name": "Test Device"})
    pairing_code = response.json()["code"]

    response = await client.post("/api/auth/pairing/approve", json={"code": pairing_code})
    assert response.status_code == 401
