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
    # user_id is the new device-principal's ID (auto-generated UUID), not the approver's
    assert exchange_result["user_id"] is not None
    assert "device_id" in exchange_result
    assert "permissions" in exchange_result
    assert auth_service.db_manager.create_user.called
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
async def test_pairing_with_explicit_permissions(auth_service):
    """Pairing with explicit permissions → device-principal inherits them."""
    pairing_code = await auth_service.start_pairing("PermDevice", "127.0.0.1")
    assert pairing_code is not None

    granted_perms = ["TTS.*", "STT.Transcribe"]
    success = await auth_service.approve_pairing(pairing_code, "admin-id", permissions=granted_perms)
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == granted_perms
    assert auth_service.pairing_requests[pairing_code]["granted_is_admin"] is False

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None
    assert result["permissions"] == granted_perms


@pytest.mark.asyncio
async def test_pairing_with_default_permissions(auth_service):
    """Pairing without explicit permissions → device gets empty list."""
    pairing_code = await auth_service.start_pairing("DefaultDevice", "127.0.0.1")
    assert pairing_code is not None

    # Approve without providing permissions
    success = await auth_service.approve_pairing(pairing_code, "admin-id")
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == []

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None
    assert result["permissions"] == []


@pytest.mark.asyncio
async def test_pairing_with_empty_permissions(auth_service):
    """Pairing with explicit empty permissions → device gets no access."""
    pairing_code = await auth_service.start_pairing("NoAccessDevice", "127.0.0.1")
    assert pairing_code is not None

    success = await auth_service.approve_pairing(pairing_code, "admin-id", permissions=[])
    assert success is True

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None
    assert result["permissions"] == []


@pytest.mark.asyncio
async def test_pairing_permissions_reflected_in_identity(auth_service):
    """After pairing exchange, Identity built from the token reflects granted permissions."""
    from app.services.gateway.acl.identity import build_identity

    pairing_code = await auth_service.start_pairing("IdDevice", "127.0.0.1")
    granted_perms = ["TTS.Say", "DB.Read"]
    await auth_service.approve_pairing(pairing_code, "admin-id", permissions=granted_perms)

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None

    # Simulate what build_identity_from_token would produce
    identity = build_identity(
        user_id=result["user_id"],
        username="device_IdDevice_xxx",
        user_permissions=result["permissions"],
        user_is_admin=False,
        token_scopes=result["permissions"],  # exchange scopes = permissions
    )
    assert identity.can("TTS.Say")
    assert identity.can("DB.Read")
    assert not identity.can("STT.Transcribe")


@pytest.mark.asyncio
async def test_pairing_admin_device(auth_service):
    """Pairing with is_admin=True → device gets admin identity."""
    pairing_code = await auth_service.start_pairing("AdminDevice", "127.0.0.1")
    await auth_service.approve_pairing(pairing_code, "admin-id", permissions=["*"], is_admin=True)

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None
    assert result["permissions"] == ["*"]


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


# ── Token Scope Validation ───────────────────────────────────────────────


class TestValidateScopesSubset:
    """Tests for AuthService._validate_scopes_subset."""

    def _make_user(
        self,
        permissions: list[str] | None = None,
        is_admin: bool = False,
    ) -> User:
        return User(
            id="u1",
            username="test",
            password_hash="hash",
            permissions=permissions or [],
            is_admin=is_admin,
        )

    def test_admin_any_scopes_allowed(self):
        """Admin users can have any scopes without raising."""
        user = self._make_user(permissions=["TTS.*"], is_admin=True)
        # Should not raise
        AuthService._validate_scopes_subset(["*"], user)
        AuthService._validate_scopes_subset(["DB.Write", "Config.Set"], user)

    def test_non_admin_matching_scopes(self):
        """Non-admin user with matching scopes passes validation."""
        user = self._make_user(permissions=["TTS.*", "STT.Transcribe"])
        # Exact matches should not raise
        AuthService._validate_scopes_subset(["TTS.*", "STT.Transcribe"], user)

    def test_non_admin_subset_scopes(self):
        """Non-admin user with a subset of their permissions passes."""
        user = self._make_user(permissions=["TTS.*", "STT.*", "DB.Read"])
        AuthService._validate_scopes_subset(["TTS.*"], user)

    def test_non_admin_wildcard_covers_specific(self):
        """User with 'TTS.*' permission allows scope 'TTS.Say'."""
        user = self._make_user(permissions=["TTS.*"])
        AuthService._validate_scopes_subset(["TTS.Say"], user)

    def test_non_admin_exceeding_scopes_raises(self):
        """Scopes outside user permissions raise ValueError."""
        user = self._make_user(permissions=["TTS.*"])
        with pytest.raises(ValueError, match="exceeds principal's permissions"):
            AuthService._validate_scopes_subset(["DB.Write"], user)

    def test_non_admin_partial_exceed_raises(self):
        """Even one invalid scope among valid ones raises."""
        user = self._make_user(permissions=["TTS.*", "STT.*"])
        with pytest.raises(ValueError, match="exceeds principal's permissions"):
            AuthService._validate_scopes_subset(["TTS.*", "DB.Write"], user)

    def test_non_admin_empty_scopes_allowed(self):
        """Empty scopes list is always allowed."""
        user = self._make_user(permissions=["TTS.*"])
        AuthService._validate_scopes_subset([], user)

    def test_non_admin_wildcard_scopes_allowed(self):
        """Wildcard ['*'] scopes for non-admin are allowed (resolved at intersection)."""
        user = self._make_user(permissions=["TTS.*"])
        # This is allowed — effective perms will be the intersection anyway
        AuthService._validate_scopes_subset(["*"], user)


@pytest.mark.asyncio
async def test_create_token_scope_validation(auth_service):
    """create_token_for_principal raises ValueError for invalid scopes."""
    user = User(
        id="u1",
        username="scopetest",
        password_hash="hash",
        permissions=["TTS.*"],
        is_admin=False,
    )
    auth_service.db_manager.get_user_by_id = AsyncMock(return_value=user)

    with pytest.raises(ValueError, match="exceeds principal's permissions"):
        await auth_service.create_token_for_principal(
            principal_id="u1",
            scopes=["DB.Write"],
        )


@pytest.mark.asyncio
async def test_create_token_valid_scopes_succeeds(auth_service):
    """create_token_for_principal succeeds with valid scopes."""
    user = User(
        id="u1",
        username="scopetest",
        password_hash="hash",
        permissions=["TTS.*", "STT.*"],
        is_admin=False,
    )
    auth_service.db_manager.get_user_by_id = AsyncMock(return_value=user)
    auth_service.db_manager.create_token = AsyncMock(return_value=True)

    result = await auth_service.create_token_for_principal(
        principal_id="u1",
        scopes=["TTS.*"],
    )
    assert result is not None
    token, token_str = result
    assert token.scopes == ["TTS.*"]


@pytest.mark.asyncio
async def test_update_token_scopes_validation(auth_service):
    """update_token_scopes raises ValueError for invalid scopes."""
    user = User(
        id="u1",
        username="scopetest",
        password_hash="hash",
        permissions=["TTS.*"],
        is_admin=False,
    )
    token = Token(
        id="tok-1",
        token_hash="hash",
        prefix="aaaa",
        user_id="u1",
        scopes=["TTS.*"],
    )
    auth_service.db_manager.get_token_by_id = AsyncMock(return_value=token)
    auth_service.db_manager.get_user_by_id = AsyncMock(return_value=user)

    with pytest.raises(ValueError, match="exceeds principal's permissions"):
        await auth_service.update_token_scopes("tok-1", ["DB.Write"])


@pytest.mark.asyncio
async def test_update_token_scopes_valid(auth_service):
    """update_token_scopes succeeds with valid scopes."""
    user = User(
        id="u1",
        username="scopetest",
        password_hash="hash",
        permissions=["TTS.*", "STT.*"],
        is_admin=False,
    )
    token = Token(
        id="tok-1",
        token_hash="hash",
        prefix="aaaa",
        user_id="u1",
        scopes=["TTS.*"],
    )
    auth_service.db_manager.get_token_by_id = AsyncMock(return_value=token)
    auth_service.db_manager.get_user_by_id = AsyncMock(return_value=user)
    auth_service.db_manager.update_token_scopes = AsyncMock(return_value=True)

    result = await auth_service.update_token_scopes("tok-1", ["TTS.*", "STT.*"])
    assert result is True


# ── Default Pairing Permissions ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_pairing_uses_config_default_permissions(auth_service):
    """When permissions=None, approve_pairing uses _default_device_permissions."""
    auth_service.update_permission_defaults(["TTS.Say", "STT.Transcribe"])

    pairing_code = await auth_service.start_pairing("DefaultDevice", "127.0.0.1")
    assert pairing_code is not None

    # Approve without explicit permissions
    success = await auth_service.approve_pairing(pairing_code, "admin-id")
    assert success is True

    # Should use the configured defaults
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == [
        "TTS.Say",
        "STT.Transcribe",
    ]


@pytest.mark.asyncio
async def test_pairing_explicit_permissions_override_defaults(auth_service):
    """Explicit permissions override _default_device_permissions."""
    auth_service.update_permission_defaults(["TTS.Say"])

    pairing_code = await auth_service.start_pairing("ExplicitDevice", "127.0.0.1")
    assert pairing_code is not None

    explicit_perms = ["DB.Read", "STT.*"]
    success = await auth_service.approve_pairing(
        pairing_code, "admin-id", permissions=explicit_perms
    )
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == explicit_perms


@pytest.mark.asyncio
async def test_pairing_empty_list_overrides_defaults(auth_service):
    """Passing permissions=[] explicitly gives empty, not defaults."""
    auth_service.update_permission_defaults(["TTS.Say"])

    pairing_code = await auth_service.start_pairing("EmptyDevice", "127.0.0.1")
    success = await auth_service.approve_pairing(pairing_code, "admin-id", permissions=[])
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == []


def test_update_permission_defaults(auth_service):
    """update_permission_defaults changes stored defaults."""
    assert auth_service._default_device_permissions == []
    auth_service.update_permission_defaults(["TTS.*", "STT.*"])
    assert auth_service._default_device_permissions == ["TTS.*", "STT.*"]


# ── Login / Refresh ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_success(auth_service):
    """login() returns (Token, str, User) on valid credentials."""
    from app.services.gateway.auth_service import pwd_context

    password = "mypassword"
    user = User(
        id="u1",
        username="loginuser",
        password_hash=pwd_context.hash(password),
        permissions=["TTS.*"],
        is_admin=False,
    )
    auth_service.db_manager.get_user_by_username = AsyncMock(return_value=user)
    auth_service.db_manager.get_user_by_id = AsyncMock(return_value=user)
    auth_service.db_manager.create_token = AsyncMock(return_value=True)

    result = await auth_service.login("loginuser", password)
    assert result is not None
    token, token_str, returned_user = result
    assert returned_user.id == "u1"
    assert token_str  # non-empty


@pytest.mark.asyncio
async def test_login_failure(auth_service):
    """login() returns None on invalid credentials."""
    auth_service.db_manager.get_user_by_username = AsyncMock(return_value=None)
    result = await auth_service.login("nobody", "wrong")
    assert result is None


@pytest.mark.asyncio
async def test_refresh_token(auth_service):
    """refresh_token() revokes old and issues new."""
    token_str = "old-token-string"
    token_hash = hashlib.sha256(token_str.encode()).hexdigest()
    old_token = Token(
        id="tok-old",
        token_hash=token_hash,
        prefix=token_str[:8],
        user_id="u1",
        scopes=["TTS.*"],
        expires_at=datetime.now() + timedelta(days=1),
    )
    auth_service.db_manager.get_token_by_hash = AsyncMock(return_value=old_token)
    auth_service.db_manager.revoke_token = AsyncMock(return_value=True)
    auth_service.db_manager.create_token = AsyncMock(return_value=True)

    result = await auth_service.refresh_token(token_str)
    assert result is not None
    new_token, new_token_str = result
    assert new_token.id != old_token.id
    assert new_token.scopes == old_token.scopes
    auth_service.db_manager.revoke_token.assert_called_once_with(old_token.id)
