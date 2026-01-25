import hashlib
import secrets
import uuid
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.db.models import Device, Token, User
from app.services.gateway.auth_service import AuthService


@pytest.fixture
def auth_service():
    with patch("app.services.gateway.auth_service.DatabaseManager") as mock_db_manager_cls:
        mock_db_manager = mock_db_manager_cls.return_value
        mock_db_manager.initialize = AsyncMock()
        mock_db_manager.count_users = AsyncMock(return_value=1)
        mock_db_manager.get_user_by_username = AsyncMock()
        mock_db_manager.create_user = AsyncMock(return_value=True)
        mock_db_manager.get_device_by_id = AsyncMock()
        mock_db_manager.create_device = AsyncMock(return_value=True)
        mock_db_manager.get_token_by_hash = AsyncMock()
        mock_db_manager.create_token = AsyncMock(return_value=True)
        mock_db_manager.revoke_token = AsyncMock(return_value=True)

        service = AuthService(db_path=":memory:")
        return service


@pytest.mark.asyncio
async def test_initialize_and_bootstrap(auth_service):
    # Test bootstrap admin when no users exist
    auth_service.db_manager.count_users.return_value = 0
    auth_service.db_manager.get_user_by_username.return_value = None
    auth_service.db_manager.get_device_by_id.return_value = None
    auth_service.db_manager.get_token_by_hash.return_value = None

    await auth_service.initialize()

    assert auth_service.db_manager.initialize.called
    assert auth_service.db_manager.create_user.called
    # Check system token bootstrap
    assert auth_service.db_manager.create_device.called
    assert auth_service.db_manager.create_token.called


@pytest.mark.asyncio
async def test_authenticate_user(auth_service):
    username = "testuser"
    password = "testpassword"
    from app.services.gateway.auth_service import pwd_context

    hashed_password = pwd_context.hash(password)

    user = User(id="user-id", username=username, password_hash=hashed_password, role="user")
    auth_service.db_manager.get_user_by_username.return_value = user

    # Success
    result = await auth_service.authenticate_user(username, password)
    assert result == user

    # Failure - wrong password
    result = await auth_service.authenticate_user(username, "wrongpassword")
    assert result is None

    # Failure - user not found
    auth_service.db_manager.get_user_by_username.return_value = None
    result = await auth_service.authenticate_user("nonexistent", password)
    assert result is None


@pytest.mark.asyncio
async def test_authenticate_token(auth_service):
    token_str = "test-token"
    token_hash = hashlib.sha256(token_str.encode()).hexdigest()

    token = Token(
        id="token-id",
        token_hash=token_hash,
        prefix=token_str[:8],
        device_id="device-id",
        user_id="user-id",
        scopes=["all"],
        expires_at=datetime.now() + timedelta(days=1),
    )
    auth_service.db_manager.get_token_by_hash.return_value = token

    # Success
    result = await auth_service.authenticate_token(token_str)
    assert result == token

    # Expired token
    token.expires_at = datetime.now() - timedelta(seconds=1)
    result = await auth_service.authenticate_token(token_str)
    assert result is None
    assert auth_service.db_manager.revoke_token.called

    # Invalid token
    auth_service.db_manager.get_token_by_hash.return_value = None
    result = await auth_service.authenticate_token("invalid-token")
    assert result is None


@pytest.mark.asyncio
async def test_pairing_flow(auth_service):
    device_name = "Test Device"
    client_ip = "127.0.0.1"
    user_id = "user-id"

    # 1. Start pairing
    pairing_code = await auth_service.start_pairing(device_name, client_ip)
    assert pairing_code is not None
    assert len(pairing_code) == 6
    assert pairing_code in auth_service.pairing_requests

    # 2. Connect pairing (check status)
    request = await auth_service.connect_pairing(pairing_code)
    assert request is not None
    assert request["device_name"] == device_name
    assert request["status"] == "pending"

    # 3. Approve pairing
    success = await auth_service.approve_pairing(pairing_code, user_id)
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["status"] == "approved"
    assert auth_service.pairing_requests[pairing_code]["approved_by"] == user_id

    # 4. Exchange pairing
    exchange_result = await auth_service.exchange_pairing(pairing_code)
    assert exchange_result is not None
    assert "token" in exchange_result
    assert exchange_result["user_id"] == user_id
    assert auth_service.db_manager.create_device.called
    assert auth_service.db_manager.create_token.called
    assert pairing_code not in auth_service.pairing_requests


@pytest.mark.asyncio
async def test_pairing_rate_limiting(auth_service):
    client_ip = "192.168.1.1"

    # Trigger rate limit (5 attempts)
    for i in range(5):
        code = await auth_service.start_pairing(f"Device {i}", client_ip)
        assert code is not None

    # 6th attempt should fail
    code = await auth_service.start_pairing("Device 6", client_ip)
    assert code is None


@pytest.mark.asyncio
async def test_pairing_expiration(auth_service):
    pairing_code = await auth_service.start_pairing("Device", "127.0.0.1")

    # Mock expiration
    auth_service.pairing_requests[pairing_code]["expires_at"] = datetime.now() - timedelta(
        seconds=1
    )

    # Should fail connect
    assert await auth_service.connect_pairing(pairing_code) is None
    assert pairing_code not in auth_service.pairing_requests

    # Re-add and test approve expiration
    pairing_code = await auth_service.start_pairing("Device", "127.0.0.1")
    auth_service.pairing_requests[pairing_code]["expires_at"] = datetime.now() - timedelta(
        seconds=1
    )
    assert await auth_service.approve_pairing(pairing_code, "user-id") is False

    # Re-add and test exchange expiration
    pairing_code = await auth_service.start_pairing("Device", "127.0.0.1")
    await auth_service.approve_pairing(pairing_code, "user-id")
    auth_service.pairing_requests[pairing_code]["expires_at"] = datetime.now() - timedelta(
        seconds=1
    )
    assert await auth_service.exchange_pairing(pairing_code) is None
