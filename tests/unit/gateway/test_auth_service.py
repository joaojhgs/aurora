import hashlib
import secrets
import uuid
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.shared.contracts.models.db import DBMethods
from app.shared.models.db import Device, Token, User
from app.services.auth.auth_manager import AuthManager as AuthService


# ── Helpers ──────────────────────────────────────────────────────────────


def _ok(data=None):
    """Create a successful QueryResult."""
    return QueryResult(ok=True, data=data or {})


def _user_resp(user):
    return _ok({"user": user.to_dict() if user else None})


def _token_resp(token):
    return _ok({"token": token.to_dict() if token else None})


def _device_resp(device):
    return _ok({"device": device.to_dict() if device else None})


def _bool_resp(success=True):
    return _ok({"success": success})


def _count_resp(count):
    return _ok({"count": count})


def _bus_calls(mock_bus, topic):
    """Return all bus.request calls matching *topic*."""
    return [c for c in mock_bus.request.call_args_list if c[0][0] == topic]


class BusRouter:
    """Dispatch bus.request() calls by topic for deterministic test control."""

    def __init__(self):
        self._routes: dict = {}

    def on(self, topic, response):
        self._routes[topic] = response

    def __call__(self, topic, payload, **kwargs):
        if topic in self._routes:
            val = self._routes[topic]
            return val
        return _ok()


# ── Fixture ──────────────────────────────────────────────────────────────


@pytest.fixture
def auth_service():
    mock_bus = AsyncMock()
    router = BusRouter()

    # Defaults – prevent bootstrap side-effects unless a test overrides
    router.on(DBMethods.COUNT_USERS, _count_resp(1))
    router.on(DBMethods.GET_USER_BY_USERNAME, _user_resp(None))
    router.on(DBMethods.GET_USER_BY_ID, _user_resp(None))
    router.on(DBMethods.GET_DEVICE_BY_ID, _device_resp(None))
    router.on(DBMethods.GET_TOKEN_BY_HASH, _token_resp(None))
    router.on(DBMethods.CREATE_USER, _bool_resp(True))
    router.on(DBMethods.CREATE_DEVICE, _bool_resp(True))
    router.on(DBMethods.CREATE_TOKEN, _bool_resp(True))
    router.on(DBMethods.REVOKE_TOKEN, _bool_resp(True))
    router.on(DBMethods.DELETE_USER, _bool_resp(True))
    router.on(DBMethods.DELETE_DEVICE, _bool_resp(True))
    router.on(DBMethods.UPDATE_USER, _bool_resp(True))
    router.on(DBMethods.UPDATE_TOKEN_SCOPES, _bool_resp(True))
    router.on(DBMethods.LIST_TOKENS, _ok({"tokens": []}))
    router.on(DBMethods.LIST_USERS, _ok({"users": []}))
    router.on(DBMethods.LIST_DEVICES, _ok({"devices": []}))
    router.on(DBMethods.SAVE_MESH_CREDENTIAL, _bool_resp(True))
    router.on(DBMethods.DELETE_MESH_CREDENTIAL, _bool_resp(True))
    router.on(DBMethods.GET_MESH_CREDENTIAL_BY_ROOM, _ok({"credential": None}))
    router.on(DBMethods.GET_AUDIT_LOG, _ok({"events": [], "total": 0}))
    router.on(DBMethods.COUNT_AUDIT_EVENTS, _count_resp(0))

    mock_bus.request = AsyncMock(side_effect=router)

    service = AuthService(bus=mock_bus)
    service._bus_router = router  # exposed for per-test overrides
    return service


# ── Bootstrap / Initialize ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_initialize_and_bootstrap(auth_service):
    # Trigger admin + system token bootstrap
    auth_service._bus_router.on(DBMethods.COUNT_USERS, _count_resp(0))
    auth_service._bus_router.on(DBMethods.GET_USER_BY_USERNAME, _user_resp(None))
    auth_service._bus_router.on(DBMethods.GET_DEVICE_BY_ID, _device_resp(None))
    auth_service._bus_router.on(DBMethods.GET_TOKEN_BY_HASH, _token_resp(None))

    await auth_service.initialize()

    topics = [c[0][0] for c in auth_service.bus.request.call_args_list]
    assert DBMethods.CREATE_USER in topics
    assert DBMethods.CREATE_DEVICE in topics
    assert DBMethods.CREATE_TOKEN in topics


# ── Authentication ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_authenticate_user(auth_service):
    username = "testuser"
    password = "testpassword"
    from app.services.auth.auth_manager import pwd_context

    hashed_password = pwd_context.hash(password)
    user = User(id="user-id", username=username, password_hash=hashed_password, role="user")
    auth_service._bus_router.on(DBMethods.GET_USER_BY_USERNAME, _user_resp(user))

    # Success
    result = await auth_service.authenticate_user(username, password)
    assert result is not None
    assert result.id == user.id

    # Failure – wrong password
    result = await auth_service.authenticate_user(username, "wrongpassword")
    assert result is None

    # Failure – user not found
    auth_service._bus_router.on(DBMethods.GET_USER_BY_USERNAME, _user_resp(None))
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
    auth_service._bus_router.on(DBMethods.GET_TOKEN_BY_HASH, _token_resp(token))

    # Success
    result = await auth_service.authenticate_token(token_str)
    assert result is not None
    assert result.id == token.id

    # Expired token
    expired = Token(
        id="token-id",
        token_hash=token_hash,
        prefix=token_str[:8],
        device_id="device-id",
        user_id="user-id",
        scopes=["all"],
        expires_at=datetime.now() - timedelta(seconds=1),
    )
    auth_service._bus_router.on(DBMethods.GET_TOKEN_BY_HASH, _token_resp(expired))
    result = await auth_service.authenticate_token(token_str)
    assert result is None
    assert len(_bus_calls(auth_service.bus, DBMethods.REVOKE_TOKEN)) > 0

    # Invalid token
    auth_service._bus_router.on(DBMethods.GET_TOKEN_BY_HASH, _token_resp(None))
    result = await auth_service.authenticate_token("invalid-token")
    assert result is None


# ── Pairing Flow ─────────────────────────────────────────────────────────


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

    # 2. Connect pairing
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
    auth_service.bus.request.call_args_list.clear()
    exchange_result = await auth_service.exchange_pairing(pairing_code)
    assert exchange_result is not None
    assert "token" in exchange_result
    assert exchange_result["user_id"] is not None
    assert "device_id" in exchange_result
    assert "permissions" in exchange_result

    topics = [c[0][0] for c in auth_service.bus.request.call_args_list]
    assert DBMethods.CREATE_USER in topics
    assert DBMethods.CREATE_DEVICE in topics
    assert DBMethods.CREATE_TOKEN in topics
    assert pairing_code not in auth_service.pairing_requests


@pytest.mark.asyncio
async def test_pairing_rate_limiting(auth_service):
    client_ip = "192.168.1.1"
    for i in range(5):
        code = await auth_service.start_pairing(f"Device {i}", client_ip)
        assert code is not None
    code = await auth_service.start_pairing("Device 6", client_ip)
    assert code is None


@pytest.mark.asyncio
async def test_pairing_with_explicit_permissions(auth_service):
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
    pairing_code = await auth_service.start_pairing("DefaultDevice", "127.0.0.1")
    assert pairing_code is not None

    success = await auth_service.approve_pairing(pairing_code, "admin-id")
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == []

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None
    assert result["permissions"] == []


@pytest.mark.asyncio
async def test_pairing_with_empty_permissions(auth_service):
    pairing_code = await auth_service.start_pairing("NoAccessDevice", "127.0.0.1")
    assert pairing_code is not None

    success = await auth_service.approve_pairing(pairing_code, "admin-id", permissions=[])
    assert success is True

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None
    assert result["permissions"] == []


@pytest.mark.asyncio
async def test_pairing_permissions_reflected_in_identity(auth_service):
    from app.shared.auth.identity import build_identity

    pairing_code = await auth_service.start_pairing("IdDevice", "127.0.0.1")
    granted_perms = ["TTS.Say", "DB.Read"]
    await auth_service.approve_pairing(pairing_code, "admin-id", permissions=granted_perms)

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None

    identity = build_identity(
        user_id=result["user_id"],
        username="device_IdDevice_xxx",
        user_permissions=result["permissions"],
        user_is_admin=False,
        token_scopes=result["permissions"],
    )
    assert identity.can("TTS.Say")
    assert identity.can("DB.Read")
    assert not identity.can("STT.Transcribe")


@pytest.mark.asyncio
async def test_pairing_admin_device(auth_service):
    pairing_code = await auth_service.start_pairing("AdminDevice", "127.0.0.1")
    await auth_service.approve_pairing(pairing_code, "admin-id", permissions=["*"], is_admin=True)

    result = await auth_service.exchange_pairing(pairing_code)
    assert result is not None
    assert result["permissions"] == ["*"]


@pytest.mark.asyncio
async def test_pairing_expiration(auth_service):
    pairing_code = await auth_service.start_pairing("Device", "127.0.0.1")

    auth_service.pairing_requests[pairing_code]["expires_at"] = datetime.now() - timedelta(
        seconds=1
    )
    assert await auth_service.connect_pairing(pairing_code) is None
    assert pairing_code not in auth_service.pairing_requests

    pairing_code = await auth_service.start_pairing("Device", "127.0.0.1")
    auth_service.pairing_requests[pairing_code]["expires_at"] = datetime.now() - timedelta(
        seconds=1
    )
    assert await auth_service.approve_pairing(pairing_code, "user-id") is False

    pairing_code = await auth_service.start_pairing("Device", "127.0.0.1")
    await auth_service.approve_pairing(pairing_code, "user-id")
    auth_service.pairing_requests[pairing_code]["expires_at"] = datetime.now() - timedelta(
        seconds=1
    )
    assert await auth_service.exchange_pairing(pairing_code) is None


# ── Token Scope Validation ───────────────────────────────────────────────


class TestValidateScopesSubset:

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
        user = self._make_user(permissions=["TTS.*"], is_admin=True)
        AuthService._validate_scopes_subset(["*"], user)
        AuthService._validate_scopes_subset(["DB.Write", "Config.Set"], user)

    def test_non_admin_matching_scopes(self):
        user = self._make_user(permissions=["TTS.*", "STT.Transcribe"])
        AuthService._validate_scopes_subset(["TTS.*", "STT.Transcribe"], user)

    def test_non_admin_subset_scopes(self):
        user = self._make_user(permissions=["TTS.*", "STT.*", "DB.Read"])
        AuthService._validate_scopes_subset(["TTS.*"], user)

    def test_non_admin_wildcard_covers_specific(self):
        user = self._make_user(permissions=["TTS.*"])
        AuthService._validate_scopes_subset(["TTS.Say"], user)

    def test_non_admin_exceeding_scopes_raises(self):
        user = self._make_user(permissions=["TTS.*"])
        with pytest.raises(ValueError, match="exceeds principal's permissions"):
            AuthService._validate_scopes_subset(["DB.Write"], user)

    def test_non_admin_partial_exceed_raises(self):
        user = self._make_user(permissions=["TTS.*", "STT.*"])
        with pytest.raises(ValueError, match="exceeds principal's permissions"):
            AuthService._validate_scopes_subset(["TTS.*", "DB.Write"], user)

    def test_non_admin_empty_scopes_allowed(self):
        user = self._make_user(permissions=["TTS.*"])
        AuthService._validate_scopes_subset([], user)

    def test_non_admin_wildcard_scopes_allowed(self):
        user = self._make_user(permissions=["TTS.*"])
        AuthService._validate_scopes_subset(["*"], user)


@pytest.mark.asyncio
async def test_create_token_scope_validation(auth_service):
    user = User(
        id="u1",
        username="scopetest",
        password_hash="hash",
        permissions=["TTS.*"],
        is_admin=False,
    )
    auth_service._bus_router.on(DBMethods.GET_USER_BY_ID, _user_resp(user))

    with pytest.raises(ValueError, match="exceeds principal's permissions"):
        await auth_service.create_token_for_principal(
            principal_id="u1",
            scopes=["DB.Write"],
        )


@pytest.mark.asyncio
async def test_create_token_valid_scopes_succeeds(auth_service):
    user = User(
        id="u1",
        username="scopetest",
        password_hash="hash",
        permissions=["TTS.*", "STT.*"],
        is_admin=False,
    )
    auth_service._bus_router.on(DBMethods.GET_USER_BY_ID, _user_resp(user))

    result = await auth_service.create_token_for_principal(
        principal_id="u1",
        scopes=["TTS.*"],
    )
    assert result is not None
    token, token_str = result
    assert token.scopes == ["TTS.*"]


@pytest.mark.asyncio
async def test_update_token_scopes_validation(auth_service):
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
    auth_service._bus_router.on(DBMethods.GET_TOKEN_BY_ID, _token_resp(token))
    auth_service._bus_router.on(DBMethods.GET_USER_BY_ID, _user_resp(user))

    with pytest.raises(ValueError, match="exceeds principal's permissions"):
        await auth_service.update_token_scopes("tok-1", ["DB.Write"])


@pytest.mark.asyncio
async def test_update_token_scopes_valid(auth_service):
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
    auth_service._bus_router.on(DBMethods.GET_TOKEN_BY_ID, _token_resp(token))
    auth_service._bus_router.on(DBMethods.GET_USER_BY_ID, _user_resp(user))

    result = await auth_service.update_token_scopes("tok-1", ["TTS.*", "STT.*"])
    assert result is True


# ── Default Pairing Permissions ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_pairing_uses_config_default_permissions(auth_service):
    auth_service.update_permission_defaults(["TTS.Say", "STT.Transcribe"])

    pairing_code = await auth_service.start_pairing("DefaultDevice", "127.0.0.1")
    assert pairing_code is not None

    success = await auth_service.approve_pairing(pairing_code, "admin-id")
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == [
        "TTS.Say",
        "STT.Transcribe",
    ]


@pytest.mark.asyncio
async def test_pairing_explicit_permissions_override_defaults(auth_service):
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
    auth_service.update_permission_defaults(["TTS.Say"])

    pairing_code = await auth_service.start_pairing("EmptyDevice", "127.0.0.1")
    success = await auth_service.approve_pairing(pairing_code, "admin-id", permissions=[])
    assert success is True
    assert auth_service.pairing_requests[pairing_code]["granted_permissions"] == []


def test_update_permission_defaults(auth_service):
    assert auth_service._default_device_permissions == []
    auth_service.update_permission_defaults(["TTS.*", "STT.*"])
    assert auth_service._default_device_permissions == ["TTS.*", "STT.*"]


# ── Login / Refresh ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_success(auth_service):
    from app.services.auth.auth_manager import pwd_context

    password = "mypassword"
    user = User(
        id="u1",
        username="loginuser",
        password_hash=pwd_context.hash(password),
        permissions=["TTS.*"],
        is_admin=False,
    )
    auth_service._bus_router.on(DBMethods.GET_USER_BY_USERNAME, _user_resp(user))
    auth_service._bus_router.on(DBMethods.GET_USER_BY_ID, _user_resp(user))

    result = await auth_service.login("loginuser", password)
    assert result is not None
    token, token_str, returned_user = result
    assert returned_user.id == "u1"
    assert token_str


@pytest.mark.asyncio
async def test_login_failure(auth_service):
    auth_service._bus_router.on(DBMethods.GET_USER_BY_USERNAME, _user_resp(None))
    result = await auth_service.login("nobody", "wrong")
    assert result is None


@pytest.mark.asyncio
async def test_refresh_token(auth_service):
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
    auth_service._bus_router.on(DBMethods.GET_TOKEN_BY_HASH, _token_resp(old_token))

    auth_service.bus.request.call_args_list.clear()
    result = await auth_service.refresh_token(token_str)
    assert result is not None
    new_token, new_token_str = result
    assert new_token.id != old_token.id
    assert new_token.scopes == old_token.scopes

    revoke_calls = _bus_calls(auth_service.bus, DBMethods.REVOKE_TOKEN)
    assert len(revoke_calls) == 1
    assert revoke_calls[0][0][1].token_id == old_token.id


# ── Mesh credential persistence ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_save_mesh_credential(auth_service):
    result = await auth_service.save_mesh_credential(
        room_name="test-room",
        token="received-token-from-remote",
        remote_device_id="remote-dev-1",
        remote_user_id="remote-user-1",
    )

    assert result is True
    save_calls = _bus_calls(auth_service.bus, DBMethods.SAVE_MESH_CREDENTIAL)
    assert len(save_calls) == 1
    payload = save_calls[0][0][1]
    assert payload.room_name == "test-room"
    assert payload.token == "received-token-from-remote"
    assert payload.remote_device_id == "remote-dev-1"
    assert payload.remote_user_id == "remote-user-1"


@pytest.mark.asyncio
async def test_load_mesh_credential_found(auth_service):
    from app.shared.models.db import MeshCredential

    cred = MeshCredential(
        id="cred-1",
        room_name="test-room",
        token="saved-plaintext-token",
        remote_device_id="dev-1",
    )
    auth_service._bus_router.on(
        DBMethods.GET_MESH_CREDENTIAL_BY_ROOM,
        _ok({"credential": cred.to_dict()}),
    )

    result = await auth_service.load_mesh_credential("test-room")
    assert result == "saved-plaintext-token"
    calls = _bus_calls(auth_service.bus, DBMethods.GET_MESH_CREDENTIAL_BY_ROOM)
    assert len(calls) >= 1


@pytest.mark.asyncio
async def test_load_mesh_credential_not_found(auth_service):
    auth_service._bus_router.on(
        DBMethods.GET_MESH_CREDENTIAL_BY_ROOM, _ok({"credential": None})
    )
    result = await auth_service.load_mesh_credential("unknown-room")
    assert result is None


@pytest.mark.asyncio
async def test_delete_mesh_credential(auth_service):
    result = await auth_service.delete_mesh_credential("test-room")
    assert result is True
    calls = _bus_calls(auth_service.bus, DBMethods.DELETE_MESH_CREDENTIAL)
    assert len(calls) >= 1
    assert calls[0][0][1].room_name == "test-room"
